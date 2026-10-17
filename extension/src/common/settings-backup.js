const SECRET_FIELDS = new Set([
  "apikey",
  "xapikey",
  "xgoogapikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "token",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie"
]);
const URL_FIELDS = new Set(["baseurl", "url", "urltemplate", "endpoint"]);
const normalizedKey = (key) => key.replace(/[-_]/g, "").toLowerCase();
const isSecret = (key) => SECRET_FIELDS.has(normalizedKey(key));
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function redactUrl(value) {
  const withoutAuth = value
    .replace(/^([a-z][\w+.-]*:\/\/)[^/?#]*@/i, "$1")
    .split("#")[0];
  const index = withoutAuth.indexOf("?");
  if (index < 0) return withoutAuth;
  const query = withoutAuth
    .slice(index + 1)
    .split("&")
    .filter((part) => {
      let key = part.split("=")[0];
      try {
        key = decodeURIComponent(key.replace(/\+/g, " "));
      } catch {
        // Keep malformed non-credential parameters unchanged.
      }
      return (
        !isSecret(key) &&
        !["key", "auth", "sig", "signature"].includes(key.toLowerCase())
      );
    })
    .join("&");
  return withoutAuth.slice(0, index) + (query ? `?${query}` : "");
}

function redact(value, key = "") {
  if (["glossary", "aliases", "translationHistory"].includes(key)) {
    return structuredClone(value);
  }
  if (typeof value === "string" && URL_FIELDS.has(normalizedKey(key))) {
    return redactUrl(value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSecret(key))
      .map(([key, value]) => [key, redact(value, key)])
  );
}

function validateSettings(settings) {
  if (!isObject(settings)) throw new Error("Invalid settings file");
  const invalid = (field) => {
    throw new Error(`Invalid ${field} in settings file`);
  };
  const stringMap = (value) =>
    isObject(value) && Object.values(value).every((v) => typeof v === "string");
  const strings = [
    "nativeLanguageCode",
    "targetLanguageCode",
    "interfaceLanguage",
    "theme",
    "translationStyle",
    "activeProviderId",
    "activeTTSProviderId",
    "customPrompt",
    "hoverTranslateMode",
    "hoverModifierKey",
    "hoverTranslateGranularity",
    "screenshotModel",
    "screenshotProviderId"
  ];
  const booleans = [
    "enabled",
    "useAutoDetect",
    "preferNativeAsSource",
    "showConfirmModal",
    "dualSubtitlesEnabled",
    "instantTranslateEnabled",
    "hoverTranslateEnabled",
    "hoverUniqueMode",
    "screenshotFill",
    "allowCloudFallback"
  ];
  for (const field of strings)
    if (field in settings && typeof settings[field] !== "string")
      invalid(field);
  for (const field of booleans)
    if (field in settings && typeof settings[field] !== "boolean")
      invalid(field);
  for (const field of ["selectionLastSource", "selectionLastTarget"])
    if (
      field in settings &&
      settings[field] !== null &&
      typeof settings[field] !== "string"
    )
      invalid(field);
  for (const field of ["instantDelay", "dialogTimeout"])
    if (
      field in settings &&
      (!Number.isFinite(settings[field]) || settings[field] < 0)
    )
      invalid(field);
  if ("schemaVersion" in settings && settings.schemaVersion !== 1)
    invalid("schemaVersion");
  for (const field of ["aliases", "glossary"])
    if (field in settings && !stringMap(settings[field])) invalid(field);
  if (
    "translationHistory" in settings &&
    (!Array.isArray(settings.translationHistory) ||
      settings.translationHistory.some(
        (entry) =>
          !isObject(entry) ||
          typeof entry.text !== "string" ||
          typeof entry.translation !== "string" ||
          [
            "sourceLanguage",
            "targetLanguage",
            "providerName",
            "providerId"
          ].some(
            (key) => entry[key] != null && typeof entry[key] !== "string"
          ) ||
          ("ts" in entry && (!Number.isFinite(entry.ts) || entry.ts < 0))
      ))
  )
    invalid("translationHistory");
  for (const field of [
    "instantDomains",
    "autoTranslateDomains",
    "hoverTranslateDomains"
  ]) {
    if (
      field in settings &&
      (!Array.isArray(settings[field]) ||
        settings[field].some(
          (entry) =>
            !isObject(entry) ||
            typeof entry.domain !== "string" ||
            !entry.domain.trim() ||
            ("enabled" in entry && typeof entry.enabled !== "boolean") ||
            ("position" in entry &&
              !["auto", "top", "bottom"].includes(entry.position))
        ))
    )
      invalid(field);
  }
  for (const field of [
    "instantToggleShortcut",
    "hoverToggleShortcut",
    "screenshotShortcut"
  ]) {
    if (field in settings) {
      const value = settings[field];
      if (
        !isObject(value) ||
        typeof value.key !== "string" ||
        !value.key.trim() ||
        ["ctrl", "shift", "alt", "meta"].some(
          (key) => key in value && typeof value[key] !== "boolean"
        )
      )
        invalid(field);
    }
  }
  if ("hoverInjectStyle" in settings) {
    const style = settings.hoverInjectStyle;
    if (
      !isObject(style) ||
      ["backgroundColor", "textColor", "fontSize"].some(
        (key) => key in style && typeof style[key] !== "string"
      ) ||
      ["showIcon", "underline"].some(
        (key) => key in style && typeof style[key] !== "boolean"
      )
    )
      invalid("hoverInjectStyle");
  }
  if (
    "labFeatures" in settings &&
    (!isObject(settings.labFeatures) ||
      Object.values(settings.labFeatures).some((v) => typeof v !== "boolean"))
  )
    invalid("labFeatures");
  for (const field of ["providers", "ttsProviders"]) {
    if (!(field in settings)) continue;
    const list = settings[field];
    if (
      !Array.isArray(list) ||
      list.some((p) => !isObject(p) || typeof p.id !== "string" || !p.id) ||
      new Set(list.map((p) => p.id)).size !== list.length
    ) {
      throw new Error("Invalid providers in settings file");
    }
    for (const provider of list) {
      for (const key of ["type", "name", "url"])
        if (key in provider && typeof provider[key] !== "string")
          invalid(field);
      if ("config" in provider) {
        if (!isObject(provider.config)) invalid(field);
        for (const key of ["apiKey", "model", "baseUrl", "endpoint", "url"])
          if (
            key in provider.config &&
            typeof provider.config[key] !== "string"
          )
            invalid(field);
        if ("headers" in provider.config && !stringMap(provider.config.headers))
          invalid(field);
      }
    }
  }
}

export function createSettingsBackup(settings) {
  validateSettings(settings);
  return redact(settings);
}

function endpoints(value, path = "") {
  if (!isObject(value)) return [];
  return Object.entries(value)
    .filter(([key]) => !isSecret(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      const nextPath = `${path}/${key}`;
      return URL_FIELDS.has(normalizedKey(key)) && typeof value === "string"
        ? [[nextPath, redactUrl(value)]]
        : endpoints(value, nextPath);
    });
}

function restoreCredentials(imported, current, key = "") {
  if (
    typeof imported === "string" &&
    typeof current === "string" &&
    URL_FIELDS.has(normalizedKey(key)) &&
    imported === redactUrl(current)
  ) {
    return current;
  }
  if (!isObject(imported) || !isObject(current)) return imported;
  const entries = Object.entries(imported).map(([key, value]) => [
    key,
    restoreCredentials(value, current[key], key)
  ]);
  for (const [key, value] of Object.entries(current)) {
    if (isSecret(key) && !Object.hasOwn(imported, key)) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

export function prepareSettingsImport(settings, current = {}) {
  validateSettings(settings);
  const imported = structuredClone(settings);
  for (const field of ["providers", "ttsProviders"]) {
    if (!Array.isArray(imported[field])) continue;
    imported[field] = imported[field].map((provider) => {
      const existing = (
        Array.isArray(current[field]) ? current[field] : []
      ).find(
        (p) =>
          p.id === provider.id &&
          p.type === provider.type &&
          JSON.stringify(endpoints(p)) === JSON.stringify(endpoints(provider))
      );
      return existing ? restoreCredentials(provider, existing) : provider;
    });
  }
  return imported;
}
