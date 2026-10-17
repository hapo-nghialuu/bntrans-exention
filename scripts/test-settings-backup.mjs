import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsBackup,
  prepareSettingsImport
} from "../extension/src/common/settings-backup.js";

function fixture() {
  return {
    targetLanguageCode: "fr",
    glossary: { token: "jeton", password: "mot de passe" },
    aliases: { secret: "en" },
    instantToggleShortcut: { key: "I", ctrl: true },
    translationHistory: [
      { text: "Private input", translation: "Private output" }
    ],
    providers: [
      {
        id: "g",
        type: "gemini",
        name: "Gemini",
        config: { apiKey: "fake-gemini-secret", model: "model-a" }
      },
      {
        id: "c",
        type: "openai-compat",
        name: "Custom",
        config: {
          apiKey: "fake-custom-secret",
          baseUrl:
            "https://test-user:test-password@example.test/v1?api-version=1&api_key=fake-query-secret",
          model: "model-b",
          headers: {
            Authorization: "fake-bearer-secret",
            "X-API-Key": "fake-header-secret",
            "X-Feature": "enabled"
          }
        }
      }
    ],
    ttsProviders: [
      {
        id: "t",
        type: "custom",
        name: "TTS",
        url: "https://example.test/tts?key=fake-tts-secret&text={text}&lang={lang}&speed={speed}"
      }
    ]
  };
}

test("export removes credentials without changing stored settings", () => {
  const current = fixture();
  const original = structuredClone(current);
  const backup = createSettingsBackup(current);
  const json = JSON.stringify(backup);
  for (const secret of [
    "fake-gemini-secret",
    "fake-custom-secret",
    "test-user",
    "test-password",
    "fake-query-secret",
    "fake-bearer-secret",
    "fake-header-secret",
    "fake-tts-secret"
  ]) {
    assert.equal(json.includes(secret), false);
  }
  assert.deepEqual(current, original);
  assert.equal(
    backup.providers[1].config.baseUrl,
    "https://example.test/v1?api-version=1"
  );
  assert.equal(
    backup.ttsProviders[0].url,
    "https://example.test/tts?text={text}&lang={lang}&speed={speed}"
  );
  assert.equal(backup.providers[1].config.headers["X-Feature"], "enabled");
});

test("export preserves language choices, shortcuts, glossary and history", () => {
  const current = fixture();
  const backup = createSettingsBackup(current);
  for (const key of [
    "targetLanguageCode",
    "glossary",
    "aliases",
    "instantToggleShortcut",
    "translationHistory"
  ])
    assert.deepEqual(backup[key], current[key]);
});

test("sanitized round trip keeps local keys and credential URLs on the same device", () => {
  const current = fixture();
  const backup = createSettingsBackup(current);
  assert.deepEqual(prepareSettingsImport(backup, current), current);
  assert.equal(Object.hasOwn(backup.providers[0].config, "apiKey"), false);
});

test("import on a new device does not invent credentials", () => {
  const backup = createSettingsBackup(fixture());
  assert.deepEqual(prepareSettingsImport(backup), backup);
});

test("import matches provider IDs, not array position", () => {
  const current = fixture();
  const backup = createSettingsBackup(current);
  backup.providers.reverse();
  const imported = prepareSettingsImport(backup, current);
  assert.equal(imported.providers[0].config.apiKey, "fake-custom-secret");
  assert.equal(imported.providers[1].config.apiKey, "fake-gemini-secret");
});

for (const change of ["id", "type", "host", "path", "tts-host"]) {
  test(`import does not attach local secrets after changing ${change}`, () => {
    const current = fixture();
    const backup = createSettingsBackup(current);
    if (change === "id") backup.providers[1].id = "new-provider";
    if (change === "type") backup.providers[1].type = "claude";
    if (change === "host")
      backup.providers[1].config.baseUrl =
        "https://other.test/v1?api-version=1";
    if (change === "path")
      backup.providers[1].config.baseUrl =
        "https://example.test/other?api-version=1";
    if (change === "tts-host")
      backup.ttsProviders[0].url = "https://other.test/tts?text={text}";
    const imported = prepareSettingsImport(backup, current);
    if (change === "tts-host") {
      assert.equal(imported.ttsProviders[0].url, backup.ttsProviders[0].url);
    } else {
      assert.equal(
        Object.hasOwn(imported.providers[1].config, "apiKey"),
        false
      );
      assert.equal(
        Object.hasOwn(imported.providers[1].config.headers, "Authorization"),
        false
      );
      assert.equal(
        imported.providers[1].config.baseUrl,
        backup.providers[1].config.baseUrl
      );
    }
  });
}

test("legacy full backups can explicitly replace or clear a key", () => {
  const current = fixture();
  const backup = createSettingsBackup(current);
  backup.providers[0].config.apiKey = "fake-new-key";
  backup.providers[1].config.apiKey = "";
  const imported = prepareSettingsImport(backup, current);
  assert.equal(imported.providers[0].config.apiKey, "fake-new-key");
  assert.equal(imported.providers[1].config.apiKey, "");
});

test("ordinary imported settings override current settings", () => {
  const current = fixture();
  const backup = createSettingsBackup(current);
  backup.targetLanguageCode = "ja";
  backup.providers[0].config.model = "updated-model";
  const imported = prepareSettingsImport(backup, current);
  assert.equal(imported.targetLanguageCode, "ja");
  assert.equal(imported.providers[0].config.model, "updated-model");
  assert.equal(imported.providers[0].config.apiKey, "fake-gemini-secret");
});

test("redaction recognizes encoded query keys and keeps URL placeholders intact", () => {
  const backup = createSettingsBackup({
    ttsProviders: [
      {
        id: "t",
        url: "https://example.test/tts?%61pi%5Fkey=fake-secret&TOKEN=fake-secret&text={text}#access_token=fake-secret"
      }
    ]
  });
  assert.equal(
    backup.ttsProviders[0].url,
    "https://example.test/tts?text={text}"
  );
});

test("malformed settings and ambiguous provider identities are rejected", () => {
  for (const input of [
    null,
    [],
    "wrong",
    { providers: {} },
    { providers: [null] },
    { providers: [{ id: "a" }, { id: "a" }] }
  ]) {
    assert.throws(() => prepareSettingsImport(input));
  }
  assert.deepEqual(prepareSettingsImport({ theme: "dark" }, fixture()), {
    theme: "dark"
  });
});

test("import does not mutate either argument", () => {
  const current = fixture();
  const backup = createSettingsBackup(current);
  const original = structuredClone({ current, backup });
  prepareSettingsImport(backup, current);
  assert.deepEqual({ current, backup }, original);
});
