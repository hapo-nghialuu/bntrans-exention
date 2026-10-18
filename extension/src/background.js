import {
  readSettings,
  writeSettings,
  updateSettings
} from "./common/settings-storage.js";
import { AIProviderService } from "./services/ai-providers.js";
import {
  createCorrectionStore,
  correctionScope
} from "./experimental/correction-store.js";
import {
  resolvePrivacy,
  assertProvider,
  assertDestination,
  privacyResponse,
  canRetain,
  ttlMillis,
  PrivacyError
} from "./common/privacy-policy.js";
import {
  htmlToMarkdown,
  markdownToHtml,
  shouldConvertFormat
} from "./services/format-utils.js";

const OFFSCREEN_URL = chrome.runtime.getURL("../pages/offscreen.html");
let offscreenPromise;
async function ensureOffscreen() {
  if (!offscreenPromise)
    offscreenPromise = (async () => {
      const contexts = await chrome.runtime.getContexts({});
      if (
        !contexts.some(
          (c) =>
            c.contextType === "OFFSCREEN_DOCUMENT" &&
            c.documentUrl === OFFSCREEN_URL
        )
      ) {
        await chrome.offscreen.createDocument({
          url: "../pages/offscreen.html",
          reasons: ["IFRAME_SCRIPTING", "AUDIO_PLAYBACK"],
          justification:
            "Built-in translation, language detection and speech playback."
        });
      }
    })().finally(() => {
      offscreenPromise = null;
    });
  return offscreenPromise;
}

async function detectLanguageWithOffscreen(text) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      type: "detect-language",
      payload: { text: String(text || "").slice(0, 1000) }
    });
    return res?.ok ? res.detectedLanguage : null;
  } catch {
    return null;
  }
}

const CACHE_LIMIT = 300;
const CACHE_STORAGE_KEY = "translationCache";
let translationCache;
let cacheLoadPromise;
let cacheQueue = Promise.resolve();
let cacheEpochSeen;
async function loadTranslationCache() {
  if (!cacheLoadPromise)
    cacheLoadPromise = chrome.storage.local
      .get(CACHE_STORAGE_KEY)
      .then((stored) => {
        translationCache = new Map(
          Object.entries(stored?.[CACHE_STORAGE_KEY] || {}).filter(([key]) =>
            key.startsWith("v2:")
          )
        );
        return translationCache;
      })
      .catch((error) => {
        cacheLoadPromise = null;
        throw error;
      });
  return cacheLoadPromise;
}
function cacheTransaction(action) {
  const run = async () => {
    await loadTranslationCache();
    return updateSettings(async (current) => (await action(current)) || null);
  };
  const result = cacheQueue.then(run, run);
  cacheQueue = result.catch(() => {});
  return result;
}
async function translationCacheKey({
  text,
  sourceLang,
  targetLang,
  provider,
  settings,
  customPrompt,
  context,
  task
}) {
  // Only the digest is persisted; config can include credentials, never a raw cache key.
  const input = JSON.stringify([
    "v2",
    provider,
    sourceLang,
    targetLang,
    settings.translationStyle || "natural",
    settings.glossary || {},
    customPrompt?.trim() || settings.customPrompt || "",
    context || "",
    task || "translate",
    text
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return (
    "v2:" +
    [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
async function cacheAccess(key, settings, policy, result) {
  if (!canRetain(settings, policy, "cache") || !ttlMillis(settings, "cache"))
    return null;
  let hit = null;
  await cacheTransaction(async (current) => {
    if (cacheEpochSeen === undefined) cacheEpochSeen = current.cacheEpoch || 0;
    if (cacheEpochSeen !== (current.cacheEpoch || 0)) {
      translationCache.clear();
      cacheEpochSeen = current.cacheEpoch || 0;
    }
    if (
      !canRetain(current, policy, "cache") ||
      (settings.cacheEpoch || 0) !== (current.cacheEpoch || 0)
    )
      return;
    const now = Date.now();
    for (const [k, entry] of translationCache) {
      if (!entry.created || now - entry.created > ttlMillis(current, "cache"))
        translationCache.delete(k);
    }
    if (result) translationCache.set(key, { result, ts: now, created: now });
    else {
      hit = translationCache.get(key) || null;
      if (hit) {
        translationCache.delete(key);
        translationCache.set(key, { ...hit, ts: now });
      }
    }
    while (translationCache.size > CACHE_LIMIT)
      translationCache.delete(translationCache.keys().next().value);
    await chrome.storage.local.set({
      [CACHE_STORAGE_KEY]: Object.fromEntries(translationCache)
    });
  });
  return hit;
}

function recordHistory(settings, policy, entry) {
  if (!canRetain(settings, policy, "history")) return Promise.resolve();
  return updateSettings((current) => {
    if (
      !canRetain(current, policy, "history") ||
      (settings.historyEpoch || 0) !== (current.historyEpoch || 0)
    )
      return null;
    const ttl = ttlMillis(current, "history");
    if (!ttl) return null;
    const previous = (current.translationHistory || []).filter(
      (e) => Date.now() - e.ts < ttl
    );
    if (
      previous[0]?.text === entry.text &&
      previous[0]?.targetLanguage === entry.targetLanguage
    )
      return null;
    return { translationHistory: [entry, ...previous].slice(0, 50) };
  });
}

let correctionMemory;
function getCorrectionMemory() {
  return (correctionMemory ||= createCorrectionStore({
    settings: readSettings
  }));
}
async function lookupCorrection(settings, policy, payload) {
  if (
    settings.labFeatures?.corrections !== true ||
    payload.labFeature ||
    (payload.task && payload.task !== "translate") ||
    !policy.hostname
  )
    return null;
  let scope;
  try {
    scope = correctionScope(payload.correctionSiteUrl);
  } catch {
    return null;
  }
  try {
    return await getCorrectionMemory().lookup(
      {
        ...scope,
        text: payload.text,
        sourceLanguage: payload.sourceLanguage || "auto",
        targetLanguage: payload.targetLanguage
      },
      policy
    );
  } catch {
    return null;
  }
}
async function handleCorrection(message, sender) {
  const payload = message.payload || {};
  const extensionPage =
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    sender.url?.startsWith(chrome.runtime.getURL(""));
  const page =
    sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0;
  if (!extensionPage && !(page && payload.command === "save"))
    throw new Error("correction-sender");
  if (payload.command === "clear" && extensionPage) {
    await getCorrectionMemory().clear();
    return { ok: true };
  }
  const settings = await readSettings();
  let tab;
  if (page) tab = sender.tab;
  else if (Number.isInteger(payload.targetTabId))
    tab = await chrome.tabs.get(payload.targetTabId);
  if (tab && tab.url !== payload.url) throw new Error("correction-stale");
  const policy = resolvePrivacy(
    settings,
    { ephemeral: payload.ephemeral === true },
    tab ? { ...sender, tab } : sender
  );
  const store = getCorrectionMemory();
  if (payload.command === "list")
    return { ok: true, items: await store.list(policy) };
  if (payload.command === "save") {
    if (payload.explicitSave !== true)
      throw new Error("correction-explicit-save-required");
    if (page && (!tab || !payload.url)) throw new Error("correction-stale");
    const entry = page
      ? { ...payload.entry, ...correctionScope(tab.url) }
      : payload.entry;
    const validate = async () => {
      if (!page) return true;
      try {
        const response = await chrome.tabs.sendMessage(
          tab.id,
          {
            type: "labs-corrections-page",
            payload: {
              command: "validate-save",
              token: payload.token,
              url: payload.url
            }
          },
          { frameId: 0 }
        );
        return response?.ok === true;
      } catch {
        return false;
      }
    };
    return { ok: true, entry: await store.save(entry, policy, validate) };
  }
  if (payload.command === "delete") {
    await store.delete(payload.entry, policy);
    return { ok: true };
  }
  if (payload.command === "import") {
    return { ok: true, count: await store.import(payload.value, policy) };
  }
  throw new Error("correction-command");
}
chrome.storage.onChanged?.addListener((changes, area) => {
  const settings = changes.translatorSettings?.newValue;
  if (
    area === "local" &&
    settings &&
    (correctionMemory ||
      changes.translatorSettings?.oldValue?.labFeatures?.corrections ===
        true) &&
    (settings.enabled === false ||
      settings.labFeatures?.corrections !== true ||
      settings.retentionEnabled === false ||
      settings.historyEnabled === false ||
      settings.cacheEnabled === false ||
      ttlMillis(settings, "history") === 0 ||
      ttlMillis(settings, "cache") === 0)
  )
    void getCorrectionMemory()
      .clear()
      .catch(() => {});
});

async function handleTranslate(payload, sender) {
  let settings = await readSettings();
  const feature = payload.labFeature;
  if (feature !== undefined) {
    if (!["ask", "image", "compare", "readalong"].includes(feature))
      throw new Error("Unknown reading feature");
    if (settings.enabled === false || settings.labFeatures?.[feature] !== true)
      throw new Error("Reading feature is disabled");
    payload = { ...payload, ephemeral: true, skipHistory: true };
    if (!sender.tab && payload.siteUrl !== "") {
      if (!Number.isInteger(payload.targetTabId))
        throw new Error("Choose a website tab for this reading request");
      const tab = await chrome.tabs.get(payload.targetTabId);
      if (!tab || !/^(https?|file):/i.test(tab.url || ""))
        throw new Error("Reading target tab is unavailable");
      if (payload.siteUrl && payload.siteUrl !== tab.url)
        throw new Error("Reading source is stale; capture it again");
      payload = { ...payload, siteUrl: tab.url };
    }
  } else if (payload.model !== undefined) {
    throw new Error("Model override requires a reading feature");
  }
  const policy = resolvePrivacy(settings, payload, sender);
  const correctionPayload = {
    ...payload,
    correctionSiteUrl: sender.tab?.url || payload.siteUrl || ""
  };
  const remembered = await lookupCorrection(
    settings,
    policy,
    correctionPayload
  );
  if (remembered)
    return {
      ok: true,
      result: {
        translation: remembered.translation,
        providerName: "Correction memory",
        providerType: "correction",
        sourceLanguage: remembered.sourceLanguage,
        targetLanguage: remembered.targetLanguage,
        correction: true
      }
    };
  if (
    settings.labFeatures?.corrections === true &&
    !feature &&
    (!payload.task || payload.task === "translate") &&
    Array.isArray(payload.correctionSegments) &&
    payload.correctionSegments.length > 1 &&
    payload.correctionSegments.length <= 40 &&
    payload.correctionSegments.join(" ||| ") === payload.text
  ) {
    const entries = await Promise.all(
      payload.correctionSegments.map((text) =>
        lookupCorrection(settings, policy, { ...correctionPayload, text })
      )
    );
    if (entries.some(Boolean)) {
      const parts = [];
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]) parts.push(entries[i].translation);
        else {
          const result = await handleTranslate(
            {
              ...payload,
              text: payload.correctionSegments[i],
              correctionSegments: undefined,
              skipHistory: true
            },
            sender
          );
          parts.push(result.result.translation);
        }
      }
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i]) continue;
        const current = await lookupCorrection(await readSettings(), policy, {
          ...correctionPayload,
          text: payload.correctionSegments[i]
        });
        if (current?.translation !== entries[i].translation)
          throw new Error("correction-stale");
      }
      return {
        ok: true,
        result: {
          translation: parts.join(" ||| "),
          providerName: "Correction memory",
          providerType: "correction",
          correction: true
        }
      };
    }
  }
  const ensureReadingRequest = async () => {
    if (!feature) return;
    const current = await readSettings();
    if (current.enabled === false || current.labFeatures?.[feature] !== true)
      throw new Error("Reading feature is disabled");
    const tabId = sender.tab?.id ?? payload.targetTabId;
    if (Number.isInteger(tabId) && (sender.tab || payload.siteUrl !== "")) {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url !== (sender.tab?.url || payload.siteUrl))
        throw new Error("Reading source is stale; capture it again");
    }
  };
  if (
    feature &&
    payload.providerId &&
    policy.providerId &&
    payload.providerId !== policy.providerId
  )
    throw new Error(
      "Selected provider conflicts with this site's privacy rule"
    );
  const {
    text,
    targetLanguage: targetLang,
    customPrompt,
    context,
    task
  } = payload;
  let sourceLang = payload.sourceLanguage || "auto";
  const providerId = policy.providerId || payload.providerId;
  let service = new AIProviderService(settings, policy);
  let usedProvider = providerId
    ? settings.providers?.find((p) => p.id === providerId)
    : service.activeProvider;
  if (!usedProvider) throw new Error("Selected provider is not configured");
  if (payload.model !== undefined) {
    if (
      !settings.providers?.some(
        (provider) => provider.id === usedProvider.id
      ) ||
      ![
        "gemini",
        "openai",
        "openrouter",
        "groq",
        "claude",
        "ollama",
        "codex",
        "custom"
      ].includes(usedProvider.type)
    )
      throw new Error("This provider does not support model overrides");
    if (
      typeof payload.model !== "string" ||
      !payload.model.trim() ||
      payload.model.length > 200 ||
      [...payload.model].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
      throw new Error("Invalid model override");
    usedProvider = {
      ...usedProvider,
      config: {
        ...usedProvider.config,
        model: payload.model.trim()
      }
    };
    settings = {
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === usedProvider.id ? usedProvider : provider
      )
    };
    service = new AIProviderService(settings, policy);
  }
  assertProvider(policy, usedProvider);
  if (
    task &&
    task !== "translate" &&
    ["google-translate", "deepl", "gemini-nano"].includes(usedProvider?.type)
  ) {
    throw new Error(
      "This task requires an instruction-capable AI provider, not a translation-only engine."
    );
  }
  if (sourceLang === "auto") {
    const detected = await detectLanguageWithOffscreen(text);
    if (detected) {
      sourceLang = detected;
      if (
        (!task || task === "translate") &&
        detected.split("-")[0].toLowerCase() ===
          String(targetLang).split("-")[0].toLowerCase()
      ) {
        await ensureReadingRequest();
        return {
          ok: true,
          result: {
            translation: text,
            providerName: "Detection",
            providerType: "same-language",
            sourceLanguage: detected,
            targetLanguage: targetLang,
            skippedSameLanguage: true
          }
        };
      }
    }
  }
  const cacheKey = await translationCacheKey({
    text,
    sourceLang,
    targetLang,
    provider: usedProvider,
    settings,
    customPrompt,
    context,
    task
  });
  const saveHistory = async (result) => {
    if (!payload.skipHistory && result.translation)
      await recordHistory(settings, policy, {
        text: String(text).slice(0, 500),
        translation: String(result.translation).slice(0, 1000),
        sourceLanguage: sourceLang,
        targetLanguage: targetLang,
        providerName: result.providerName,
        ts: Date.now()
      });
  };
  const hit = await cacheAccess(cacheKey, settings, policy);
  if (hit) {
    await saveHistory(hit.result);
    return {
      ok: true,
      result: {
        ...hit.result,
        providerName: `${hit.result.providerName || ""} ·cache`,
        cached: true
      }
    };
  }
  let providerCompleted = false;
  try {
    await ensureReadingRequest();
    const formatted =
      (!task || task === "translate") && shouldConvertFormat(text);
    const input = formatted ? htmlToMarkdown(text) : text;
    let result = await service.translate(
      input,
      sourceLang,
      targetLang,
      providerId,
      customPrompt,
      context,
      task
    );
    if (result?.useOffscreen) {
      if (task && task !== "translate")
        throw new Error(
          "Built-in Translator does not support this task; choose an instruction-capable provider."
        );
      await ensureOffscreen();
      const offscreen = await chrome.runtime.sendMessage({
        type: "offscreen-translate",
        payload: { ...payload, text: input }
      });
      if (!offscreen?.ok)
        throw new Error(offscreen?.error || "Built-in translation unavailable");
      result = {
        ...offscreen,
        providerName: "Chrome Built-in AI",
        providerType: "gemini-nano"
      };
    }
    if (typeof result?.translation !== "string" || !result.translation.trim())
      throw new Error("Provider returned no translation");
    const resultObj = {
      translation: formatted
        ? markdownToHtml(result.translation)
        : result.translation,
      providerName: result.providerName,
      providerType: result.providerType,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang
    };
    providerCompleted = true;
    await ensureReadingRequest();
    await saveHistory(resultObj);
    await cacheAccess(cacheKey, settings, policy, resultObj);
    return { ok: true, result: resultObj };
  } catch (error) {
    if (providerCompleted || error?.code === "PRIVACY_BLOCKED") throw error;
    // Task-specific work must not be replaced by a plain Google translation.
    if (
      usedProvider?.type !== "google-translate" &&
      !feature &&
      settings.allowCloudFallback === true &&
      (!task || task === "translate")
    ) {
      try {
        const google = {
          id: "google-translate",
          type: "google-translate",
          name: "Google Translate",
          config: {}
        };
        assertProvider(policy, google);
        const fallback = new AIProviderService(
          { ...settings, providers: [google], activeProviderId: google.id },
          policy
        );
        const result = await fallback.translate(
          text,
          sourceLang,
          targetLang,
          google.id
        );
        return {
          ok: true,
          result: {
            ...result,
            providerName: "Google Translate (fallback)",
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
            fellBackFrom: usedProvider?.name || usedProvider?.type
          }
        };
      } catch (fallbackError) {
        if (fallbackError?.code === "PRIVACY_BLOCKED") throw fallbackError;
      }
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "labs-corrections") {
    handleCorrection(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse(privacyResponse(error)));
    return true;
  }
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "get-settings") {
    readSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((e) => sendResponse(privacyResponse(e)));
    return true;
  }
  if (message?.type === "set-settings") {
    const patch = message.settings || {};
    const disabled =
      patch.enabled === false ||
      patch.labFeatures?.corrections === false ||
      patch.retentionEnabled === false ||
      patch.historyEnabled === false ||
      patch.cacheEnabled === false ||
      (patch.historyTTLHours !== undefined &&
        ttlMillis(patch, "history") === 0) ||
      (patch.cacheTTLHours !== undefined && ttlMillis(patch, "cache") === 0);
    readSettings()
      .then((current) =>
        disabled &&
        (correctionMemory || current.labFeatures?.corrections === true)
          ? getCorrectionMemory().clear()
          : undefined
      )
      .then(() => writeSettings(message.settings))
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((e) => sendResponse(privacyResponse(e)));
    return true;
  }
  if (message?.type === "privacy-clear-cache") {
    cacheTransaction(async (current) => {
      translationCache.clear();
      await chrome.storage.local.set({ translationCache: {} });
      return { cacheEpoch: (current.cacheEpoch || 0) + 1 };
    })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse(privacyResponse(e)));
    return true;
  }
  if (message?.type === "detect-page-language") {
    chrome.i18n
      .detectLanguage(message.text || "")
      .then((res) =>
        sendResponse({
          ok: true,
          language: res?.languages?.[0]?.language || ""
        })
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "translate") {
    handleTranslate(message.payload || {}, sender)
      .then(sendResponse)
      .catch((e) => sendResponse(privacyResponse(e)));
    return true;
  }

  // Screenshot-area capture: return the visible tab as a PNG data URL.
  // The content script crops to the user-selected rect on its side.
  if (message?.type === "capture-visible") {
    const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs
      .captureVisibleTab(windowId, { format: "png" })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse(privacyResponse(err)));
    return true;
  }

  // OCR + translate a cropped screenshot through Gemini vision.
  if (message?.type === "translate-image") {
    readSettings()
      .then(async (settings) => {
        try {
          const providers = settings.providers || [];
          // Explicit choice wins; otherwise prefer a keyed Gemini, then any
          // provider type that can accept image input.
          const IMAGE_CAPABLE = new Set([
            "gemini",
            "openai",
            "openrouter",
            "groq",
            "claude",
            "ollama",
            "custom",
            "codex"
          ]);
          const policy = resolvePrivacy(settings, message.payload, sender);
          const requestedProviderId =
            policy.providerId ||
            message.payload?.providerId ||
            settings.screenshotProviderId;
          if (
            requestedProviderId &&
            !providers.some((p) => p.id === requestedProviderId)
          ) {
            throw new Error("Selected image provider is not configured");
          }
          const chosen =
            providers.find((p) => p.id === requestedProviderId) ||
            providers.find((p) => p.type === "gemini" && p.config?.apiKey) ||
            providers.find((p) => IMAGE_CAPABLE.has(p.type));
          if (!chosen) {
            sendResponse({
              ok: false,
              error:
                "Screenshot translation needs an image-capable provider (Gemini, OpenAI…). Configure one in Options → Screenshot."
            });
            return;
          }
          if (!IMAGE_CAPABLE.has(chosen.type)) {
            sendResponse({
              ok: false,
              error: `Provider "${chosen.name || chosen.type}" cannot read images — pick a vision-capable one in Options → Screenshot.`
            });
            return;
          }
          assertProvider(policy, chosen);
          const service = new AIProviderService(
            {
              ...settings,
              providers: providers.map((p) =>
                p.id === chosen.id
                  ? {
                      ...p,
                      config: {
                        ...p.config,
                        model: settings.screenshotModel || p.config?.model
                      }
                    }
                  : p
              )
            },
            policy
          );
          const provider = service.getProvider(chosen.id, "");
          const targetLang =
            message.payload?.targetLanguage ||
            settings.targetLanguageCode ||
            "en";
          const result = await provider.translateImage(
            message.payload.imageBase64,
            targetLang,
            message.payload.mimeType,
            message.payload.mode
          );
          sendResponse({
            ok: true,
            result: {
              ...result,
              providerName: chosen.name || chosen.type,
              targetLanguage: targetLang
            }
          });
        } catch (err) {
          sendResponse(privacyResponse(err));
        }
      })
      .catch((err) => sendResponse(privacyResponse(err)));
    return true;
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return true;
  }
  if (
    ["tts-play", "tts-stop", "tts-pause", "tts-resume"].includes(message?.type)
  ) {
    (async () => {
      const settings = await readSettings();
      const payload = message.payload || {};
      const policy = resolvePrivacy(settings, payload, sender);
      await ensureOffscreen();
      if (message.type !== "tts-play")
        return chrome.runtime.sendMessage({
          type: message.type.replace("tts-", "offscreen-tts-")
        });
      const localOnly =
        policy.mode === "local-only" ||
        settings.activeTTSProviderId === "local";
      const template =
        settings.ttsProviders?.find(
          (p) => p.id === settings.activeTTSProviderId
        )?.url ||
        "https://translate.google.com/translate_tts?ie=UTF-8&tl={lang}&client=dict-chrome-ex&ttsspeed={speed}&q={text}";
      if (!localOnly)
        assertDestination(
          policy,
          template
            .replaceAll("{text}", "")
            .replaceAll("{lang}", "en")
            .replaceAll("{speed}", "1")
        );
      if (policy.mode === "ask" && !localOnly && !policy.cloudConsent)
        throw new PrivacyError("Speech requires confirmation");
      return chrome.runtime.sendMessage({
        type: "play-tts",
        payload: {
          text: payload.text,
          lang: payload.lang,
          speed: payload.speed,
          urlTemplate: template,
          localOnly,
          privacyPolicy: policy
        }
      });
    })()
      .then((result) =>
        sendResponse(
          result || { ok: false, error: "Speech service unavailable" }
        )
      )
      .catch((e) => sendResponse(privacyResponse(e)));
    return true;
  }
});

// --- Context menus ---------------------------------------------------------

const SCREENSHOT_MENU_ID = "bntrans-screenshot-area";
const SELECTION_MENU_ID = "bntrans-translate-selection";
const SIDE_PANEL_MENU_ID = "bntrans-open-side-panel";
const PAGE_TRANSLATE_MENU_ID = "bntrans-page-translate";
const EDITABLE_MENU_ID = "bntrans-translate-editable";

let contextMenuPromise = null;
// onInstalled + onStartup + the eager call below can all fire during one
// service-worker boot; funnel them through a single remove→create so two
// concurrent runs can't race into "duplicate id" on create().
function registerContextMenus() {
  if (!contextMenuPromise) {
    contextMenuPromise = (async () => {
      // Callback form + lastError swallow: the promise form does not
      // reliably reject on a missing id and would spam the console on
      // every SW start.
      await Promise.all(
        [
          SCREENSHOT_MENU_ID,
          SELECTION_MENU_ID,
          SIDE_PANEL_MENU_ID,
          PAGE_TRANSLATE_MENU_ID,
          EDITABLE_MENU_ID
        ].map(
          (id) =>
            new Promise((resolve) =>
              chrome.contextMenus.remove(id, () => {
                void chrome.runtime.lastError;
                resolve();
              })
            )
        )
      );
      let screenshotTitle = "Translate screenshot area";
      let selectionTitle = "Translate selection";
      let panelTitle = "Open BNTrans side panel";
      let pageTitle = "Translate page (bilingual)";
      let editableTitle = "Translate & replace text";
      try {
        const settings = await readSettings();
        if ((settings.interfaceLanguage || "en") === "vi") {
          screenshotTitle = "Dịch vùng chụp màn hình";
          selectionTitle = "Dịch đoạn đã chọn";
          panelTitle = "Mở bảng dịch BNTrans";
          pageTitle = "Dịch trang này (song ngữ)";
          editableTitle = "Dịch & thay thế văn bản";
        }
      } catch {
        /* keep English fallback */
      }
      chrome.contextMenus.create(
        {
          id: SCREENSHOT_MENU_ID,
          title: screenshotTitle,
          contexts: ["page", "selection", "image", "frame", "link", "video"]
        },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        {
          id: SELECTION_MENU_ID,
          title: selectionTitle,
          contexts: ["selection"]
        },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        {
          id: SIDE_PANEL_MENU_ID,
          title: panelTitle,
          contexts: ["all", "action"]
        },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        {
          id: PAGE_TRANSLATE_MENU_ID,
          title: pageTitle,
          contexts: ["page", "frame"]
        },
        () => void chrome.runtime.lastError
      );
      chrome.contextMenus.create(
        {
          id: EDITABLE_MENU_ID,
          title: editableTitle,
          contexts: ["editable"]
        },
        () => void chrome.runtime.lastError
      );
    })();
  }
  return contextMenuPromise;
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);
// MV3 service workers restart often; menu items persist per session but a
// dev reload clears them, so register eagerly too (remove+create is safe).
registerContextMenus();

// Keep the page-translate menu title in sync with the tab's state.
// NOTE: context menus are global, so the title reflects whichever tab
// reported last — acceptable since the click still toggles correctly.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "page-translation-state") return;
  readSettings()
    .then((settings) => {
      const vi = (settings.interfaceLanguage || "en") === "vi";
      const title = message.active
        ? vi
          ? "Khôi phục trang gốc"
          : "Restore original page"
        : vi
          ? "Dịch trang này (song ngữ)"
          : "Translate page (bilingual)";
      chrome.contextMenus.update(
        PAGE_TRANSLATE_MENU_ID,
        { title },
        () => void chrome.runtime.lastError
      );
    })
    .catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SIDE_PANEL_MENU_ID) {
    // User gesture from the menu click; needs the "sidePanel" permission.
    chrome.sidePanel?.open({ windowId: tab?.windowId }).catch(() => {});
    return;
  }
  if (!tab?.id) return;
  if (info.menuItemId === SCREENSHOT_MENU_ID) {
    chrome.tabs
      .sendMessage(tab.id, { type: "start-screenshot-select" })
      .catch(() => {});
  } else if (info.menuItemId === SELECTION_MENU_ID) {
    chrome.tabs
      .sendMessage(tab.id, { type: "translate-selection" })
      .catch(() => {});
  } else if (info.menuItemId === PAGE_TRANSLATE_MENU_ID) {
    chrome.tabs
      .sendMessage(tab.id, { type: "toggle-page-translation" })
      .catch(() => {});
  } else if (info.menuItemId === EDITABLE_MENU_ID) {
    chrome.tabs
      .sendMessage(tab.id, { type: "translate-editable" })
      .catch(() => {});
  }
});
