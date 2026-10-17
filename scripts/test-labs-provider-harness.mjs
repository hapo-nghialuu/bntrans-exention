import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as format from "../extension/src/services/format-utils.js";

export const google = {
  id: "google-translate",
  type: "google-translate",
  name: "Google",
  config: {}
};
export const local = {
  id: "local",
  type: "ollama",
  name: "Local",
  config: { baseUrl: "http://localhost:11434/v1", model: "synthetic" }
};
export const builtin = {
  id: "builtin",
  type: "gemini-nano",
  name: "Chrome Built-in AI",
  config: {}
};
export const success = (text = "Synthetic output") => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: text } }],
    sentences: [{ trans: text }],
    translations: [{ text }]
  })
});
export const source = (name) =>
  readFileSync(new URL(`../extension/src/${name}`, import.meta.url), "utf8")
    .replace(/import\s+[\s\S]*?from\s+["'][^"']+["'];/g, "")
    .replace(/export\s+(?=class|async|function|const)/g, "");
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function worker({
  settings = {},
  state,
  fetch = async () => success(),
  offscreen = { ok: false, error: "Translator API not supported" },
  detect = null,
  setupFails = false
} = {}) {
  state ||= {
    translatorSettings: {
      providers: [local, google, builtin],
      activeProviderId: "local",
      ...settings
    }
  };
  const listeners = [];
  const calls = [];
  const sent = [];
  const url = (path) => new URL(path, "chrome-extension://synthetic/").href;
  let now = Date.now();
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    structuredClone,
    AbortController,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    ...format,
    fetch: async (...args) => {
      calls.push(args);
      return fetch(...args);
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            await tick();
            return { [key]: structuredClone(state[key]) };
          },
          async set(values) {
            await tick();
            Object.assign(state, structuredClone(values));
          }
        }
      },
      runtime: {
        id: "synthetic",
        getURL: url,
        getContexts: async () => {
          if (setupFails) throw new Error("Offscreen unavailable");
          return [
            {
              contextType: "OFFSCREEN_DOCUMENT",
              documentUrl: url("../pages/offscreen.html")
            }
          ];
        },
        onMessage: {
          addListener(fn) {
            listeners.push(fn);
          }
        },
        async sendMessage(message) {
          sent.push(message);
          return message.type === "detect-language"
            ? { ok: true, detectedLanguage: detect }
            : offscreen;
        }
      }
    }
  });
  const background = source("background.js").split("// --- Context menus")[0];
  vm.runInContext(
    [
      source("common/settings-storage.js"),
      source("common/privacy-policy.js"),
      source("services/ai-providers.js"),
      background
    ].join("\n"),
    context
  );
  return {
    state,
    calls,
    sent,
    context,
    now: () => now,
    advance(ms = 1) {
      now += ms;
    },
    send(type, payload = {}, sender = {}) {
      return new Promise((resolve, reject) => {
        const handled = listeners[0](
          {
            type,
            payload,
            ...(type === "set-settings" ? { settings: payload } : {})
          },
          sender,
          resolve
        );
        if (!handled) reject(new Error("Unhandled message"));
      });
    },
    translate(payload = {}, sender = {}) {
      return this.send(
        "translate",
        {
          text: "Synthetic input",
          sourceLanguage: "en",
          targetLanguage: "vi",
          ...payload
        },
        sender
      );
    }
  };
}
