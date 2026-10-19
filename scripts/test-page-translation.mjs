import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHarness, deferred, until } from "./test-labs-page-harness.mjs";

const ids = (batch) =>
  batch.map((text) => Number(text.replace("Synthetic ", "")));
function verifyUnique(h, count) {
  const all = h.batches.flat();
  assert.equal(all.length, count);
  assert.equal(new Set(all).size, count);
  assert.equal(h.pageSnapshot().complete, count);
}

test("prioritizes the initial viewport before the observer's first callback", async (t) => {
  const h = createHarness({ count: 70, visible: [49, 50, 51] });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.deepEqual(ids(h.batches[0]).slice(0, 3), [49, 50, 51]);
  verifyUnique(h, 70);
});

test("reserves queued units before sequential fallback can select them again", async (t) => {
  const h = createHarness({
    count: 70,
    provider: (payload, number) => {
      if (number === 2) h.intersect([62, 63]);
      return {
        ok: true,
        result: {
          translation: payload.text
            .split(" ||| ")
            .map((s) => "Translated " + s)
            .join(" ||| ")
        }
      };
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.deepEqual(ids(h.batches[2]).slice(0, 2), [62, 63]);
  verifyUnique(h, 70);
});

test("repeated intersections never schedule a unit twice", async (t) => {
  const h = createHarness({
    count: 70,
    visible: [26, 27],
    provider: (payload) => {
      h.intersect([0, 26, 27, 62, 63]);
      return {
        ok: true,
        result: {
          translation: payload.text
            .split(" ||| ")
            .map((s) => "Translated " + s)
            .join(" ||| ")
        }
      };
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  verifyUnique(h, 70);
  assert.ok(h.batches.every((batch) => batch.length <= 25));
});

test("handles multiple translation units sharing a visible anchor", async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  const p = h.appendParagraph("", true);
  for (let i = 0; i < 30; i++)
    p.append(
      h.document.createTextNode("Synthetic " + i),
      h.document.createElement("br")
    );
  await h.runPageTranslation();
  verifyUnique(h, 30);
  assert.deepEqual(
    h.batches.map((batch) => batch.length),
    [25, 5]
  );
});

test("marks failed batches once and disconnects observers on restore", async (t) => {
  const h = createHarness({
    count: 30,
    provider: () => {
      throw new Error("Provider unavailable");
    }
  });
  t.after(h.dispose);
  await h.runPageTranslation();
  assert.equal(h.requests.length, 2);
  assert.equal(h.pageSnapshot().complete, 0);
  assert.equal(h.pageSnapshot().remaining, 30);
  const wrappers = h.document.querySelectorAll("[data-bntrans-translation]");
  assert.equal(wrappers.length, 0);
  assert.match(h.pageSnapshot().error, /Provider unavailable/);
  assert.match(
    h.document.getElementById("bntrans-page-progress").textContent,
    /Provider unavailable/
  );
  assert.ok(h.paragraphs.every((p, i) => p.textContent === "Synthetic " + i));
  h.dispose();
  assert.equal(h.intersections[0].disconnected, true);
  assert.equal(h.listeners.size, 0);
});

test("retains the page safety cap and handles empty pages", async (t) => {
  const capped = createHarness({ count: 550 });
  t.after(capped.dispose);
  await capped.runPageTranslation();
  verifyUnique(capped, 500);
  assert.equal(capped.pageSnapshot().capped, true);
  const empty = createHarness();
  t.after(empty.dispose);
  await empty.runPageTranslation();
  assert.equal(empty.requests.length, 0);
});

test("page collection leaves navigation, fixed UI and nested controls untouched while translating prose and tables", async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  h.context.window.getComputedStyle = (node) => ({
    position: node.style.position
  });
  for (const tag of ["header", "nav", "footer", "aside"]) {
    const node = h.document.createElement(tag);
    node.textContent = "Protected " + tag;
    h.document.body.appendChild(node);
  }
  const p = h.appendParagraph("Public story ");
  for (const role of [
    "navigation",
    "banner",
    "contentinfo",
    "complementary",
    "menu",
    "menubar",
    "toolbar",
    "button",
    "dialog"
  ]) {
    const outer = h.document.createElement("span");
    const node = h.document.createElement("span");
    node.setAttribute("role", role);
    node.textContent = "Protected " + role;
    outer.appendChild(node);
    p.appendChild(outer);
  }
  for (const position of ["fixed", "sticky"]) {
    const node = h.document.createElement("div");
    node.style.position = position;
    node.textContent = "Protected " + position;
    h.document.body.appendChild(node);
  }
  const article = h.document.createElement("article");
  const prose = h.document.createElement("p");
  const link = h.document.createElement("a");
  link.setAttribute("href", "https://example.test/reference");
  link.textContent = "linked reference";
  const code = h.document.createElement("code");
  code.textContent = "[1, 4, 9]";
  prose.append("Public prose ", link, " uses ", code);
  article.appendChild(prose);
  const table = h.document.createElement("table");
  const row = h.document.createElement("tr");
  for (const tag of ["th", "td"]) {
    const cell = h.document.createElement(tag);
    cell.textContent = "Public table " + tag;
    row.appendChild(cell);
  }
  table.appendChild(row);
  article.appendChild(table);
  h.document.body.appendChild(article);
  const original = [...prose.childNodes];
  await h.runPageTranslation();
  assert.equal(h.pageSnapshot().complete, 4);
  assert.ok(h.requests.every((request) => !request.text.includes("Protected")));
  assert.equal(link.getAttribute("href"), "https://example.test/reference");
  assert.equal(code.textContent, "[1, 4, 9]");
  h.dispose();
  assert.deepEqual(prose.childNodes, original);
  assert.equal(h.document.querySelectorAll("[data-bntrans-wrapper]").length, 0);
});

test("native page toggle acknowledges restore during an in-flight request and prevents late reinjection", async (t) => {
  const pending = deferred();
  const h = createHarness({ count: 1, provider: () => pending.promise });
  t.after(h.dispose);
  assert.equal((await h.toggle()).active, true);
  await until(() => h.requests.length === 1);
  assert.equal((await h.toggle()).active, false);
  pending.resolve({ ok: true, result: { translation: "Translated story" } });
  await new Promise((resolve) => setImmediate(resolve));
  await until(
    () => h.document.querySelectorAll("[data-bntrans-wrapper]").length === 0
  );
  assert.equal(h.document.getElementById("bntrans-page-progress"), null);
  assert.equal(
    h.document.body.hasAttribute("data-bntrans-page-translated"),
    false
  );
  assert.deepEqual(h.stateMessages, [true, false]);
});

test("page context menu targets only frame zero and ignores iframe state during menu registration", async () => {
  const source = readFileSync(
    new URL("../extension/src/background.js", import.meta.url),
    "utf8"
  );
  const messages = [],
    updates = [],
    events = [],
    clicks = [],
    stateListeners = [];
  const context = vm.createContext({
    readSettings: async () => ({ interfaceLanguage: "en" }),
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener: (fn) => stateListeners.push(fn) }
      },
      contextMenus: {
        remove: (_id, callback) => setImmediate(callback),
        create: (item, callback) => {
          events.push("create:" + item.id);
          callback();
        },
        update: (id, options, callback) => {
          events.push("update:" + id);
          updates.push(options.title);
          callback();
        },
        onClicked: { addListener: (fn) => clicks.push(fn) }
      },
      tabs: {
        sendMessage: async (...args) => {
          messages.push(args);
        }
      }
    }
  });
  vm.runInContext(
    source.slice(source.indexOf("const SCREENSHOT_MENU_ID =")),
    context
  );
  const acknowledged = await new Promise((resolve) => {
    assert.equal(
      stateListeners[0](
        { type: "page-translation-state", active: true },
        { frameId: 0 },
        resolve
      ),
      true
    );
    assert.equal(
      stateListeners[0](
        { type: "page-translation-state", active: false },
        { frameId: 4 },
        () => assert.fail("iframe must not change menu")
      ),
      undefined
    );
  });
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(updates, ["Restore original page"]);
  assert.ok(
    events.indexOf("update:bntrans-page-translate") >
      events.indexOf("create:bntrans-page-translate")
  );
  clicks[0]({ menuItemId: "bntrans-page-translate", frameId: 4 }, { id: 7 });
  assert.equal(messages[0][0], 7);
  assert.equal(messages[0][1].type, "toggle-page-translation");
  assert.equal(messages[0][2].frameId, 0);
});
