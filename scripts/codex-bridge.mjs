#!/usr/bin/env node
/**
 * Local OpenAI-compatible bridge over the `codex` CLI.
 *
 * Lets the BNTrans extension (or any OpenAI-compatible client) translate
 * through the Codex CLI authenticated session (ChatGPT subscription)
 * instead of a paid API key.
 *
 *   POST /v1/chat/completions  -> runs `codex exec` with the messages
 *   GET  /v1/models            -> static list so the extension model picker works
 *
 * Usage:  node scripts/codex-bridge.mjs   (default port 8787)
 * Then add a Custom provider in BNTrans Options with
 *   Base URL: http://localhost:8787/v1   Model: codex-subscription
 *
 * Caveats: ~10s+ per request (agent cold start) and each call consumes
 * subscription tokens with agent overhead — fine for manual translation,
 * too slow/heavy for instant/hover bulk translation.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.CODEX_BRIDGE_PORT) || 8787;
const BRIDGE_MODEL = "codex-subscription";
// Translation is a trivial task: default to the cheap/fast model with low
// reasoning effort. CODEX_MODEL overrides; a request may also pick a model.
const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL || "gpt-6-luna";
const REQUEST_TIMEOUT_MS = 180_000;

function buildPrompt(messages) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const user = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n\n");
  return system ? `${system}\n\n${user}` : user;
}

function runCodex(prompt, model) {
  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-"));
  const outFile = join(dir, "out.md");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-o",
    outFile,
    "-c",
    'model_reasoning_effort="low"'
  ];
  // The bridge alias maps to the bridge default model; an explicit model in
  // the request wins.
  args.push("-m", model && model !== BRIDGE_MODEL ? model : DEFAULT_CODEX_MODEL);

  return new Promise((resolve, reject) => {
    const proc = execFile(
      "codex",
      args,
      // The prompt goes over stdin: codex exec switches to "read stdin" mode
      // whenever stdin is not a TTY, so leaving it as an open pipe hangs
      // forever. A pipe that we write to and close gives it a clean EOF.
      { cwd: dir, timeout: REQUEST_TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] },
      (err, _stdout, stderr) => {
        let output = "";
        try {
          output = readFileSync(outFile, "utf8").trim();
        } catch {
          /* no output file */
        }
        rmSync(dir, { recursive: true, force: true });
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
        } else if (!output) {
          reject(new Error("Codex returned empty output"));
        } else {
          resolve(output);
        }
      }
    );
    proc.stdin.on("error", () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [{ id: BRIDGE_MODEL, object: "model", owned_by: "codex-cli" }]
    });
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    try {
      const body = JSON.parse(await readBody(req));
      const messages = body.messages || [];
      const prompt = buildPrompt(messages);
      const text = await runCodex(prompt, body.model);

      sendJson(res, 200, {
        id: "chatcmpl-codex",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || BRIDGE_MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop"
          }
        ]
      });
    } catch (err) {
      sendJson(res, 500, {
        error: { message: String(err?.message || err), type: "bridge_error" }
      });
    }
    return;
  }

  sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `codex-bridge listening on http://localhost:${PORT}/v1 — model: ${BRIDGE_MODEL}`
  );
});
