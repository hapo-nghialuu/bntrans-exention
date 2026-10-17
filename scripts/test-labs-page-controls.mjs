import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "../extension/src/experimental/page-controls.js";
import { createHarness, deferred, until } from "./test-labs-page-harness.mjs";

function panelApi(h, overrides = {}) {
  let settings = {
    labFeatures: { page: true },
    activeProviderId: "synthetic-provider",
    labPage: {}
  };
  const sent = [];
  const statuses = [];
  return {
    sent,
    statuses,
    get settingsValue() {
      return settings;
    },
    api: {
      t: (en) => en,
      settings: async () => settings,
      updateSettings: async (patch) => {
        settings = { ...settings, ...patch };
      },
      activeTab: async () => ({ url: "https://synthetic.example/page" }),
      sendToTab: async (...args) => {
        sent.push(args);
        return { ok: true, units: 2 };
      },
      status: (...args) => statuses.push(args),
      field: (label, input) => {
        const field = h.document.createElement("div");
        input.value = String(input.value);
        input.checkValidity = () => true;
        field.append(label, input);
        return field;
      },
      button: (label, callback) => {
        const button = h.document.createElement("button");
        button.textContent = label;
        button.callback = callback;
        return button;
      },
      ...overrides
    }
  };
}

function setup(t, overrides) {
  const h = createHarness();
  const previousDocument = globalThis.document;
  globalThis.document = h.document;
  t.after(() => {
    globalThis.document = previousDocument;
    h.dispose();
  });
  const container = h.document.createElement("div");
  h.document.body.appendChild(container);
  return { h, container, ...panelApi(h, overrides) };
}

test("page panel targets selected tab, saves budgets and exact-host mode", async (t) => {
  const { container, api, sent, statuses } = setup(t);
  const cleanup = await mount(container, api);
  const select = container.querySelector("select");
  select.value = "translation";
  const buttons = container.querySelectorAll("button");
  const click = (name) =>
    buttons.find((b) => b.textContent === name).callback();
  await click("Estimate before sending");
  await click("Start");
  await click("Apply reading mode");
  assert.deepEqual(
    sent.map(([, payload]) => payload.command),
    ["estimate", "translate", "mode"]
  );
  assert.ok(sent.every(([type]) => type === "labs-page-command"));
  assert.ok(sent.every(([, payload]) => payload.mode === "translation"));
  assert.equal(
    (await api.settings()).labPage.providerLimits["synthetic-provider"]
      .concurrency,
    2
  );
  await click("Remember mode for selected host");
  assert.equal(
    (await api.settings()).labPage.siteModes["synthetic.example"],
    "translation"
  );
  assert.equal(statuses.length, 1);
  cleanup();
  assert.equal(container.querySelector("section"), null);
});

test("disabled page panel rejects commands and cleanup drops late results", async (t) => {
  const pending = deferred();
  let enabled = false;
  let calls = 0;
  const { container, api } = setup(t, {
    settings: async () => ({ labFeatures: { page: enabled }, labPage: {} }),
    sendToTab: async () => {
      calls++;
      return pending.promise;
    }
  });
  const cleanup = await mount(container, api);
  const button = container
    .querySelectorAll("button")
    .find((b) => b.textContent === "Refresh status");
  await assert.rejects(button.callback(), /Enable Page Labs first/);
  assert.equal(calls, 0);
  enabled = true;
  const task = button.callback();
  await until(() => calls === 1);
  const result = container.querySelector("pre");
  cleanup();
  pending.resolve({ ok: true, units: 2 });
  await task;
  assert.equal(result.textContent, "");
});
