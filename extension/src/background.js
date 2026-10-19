import {
  readSettings,
  writeSettings,
  updateSettings
} from "./common/settings-storage.js";
import { AIProviderService } from "./services/ai-providers.js";
import { applySiteProfile } from "./common/site-profiles.js";
import { checkTranslationQuality } from "./common/translation-quality.js";
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

async function handleTranslate(payload, sender) {
  const applied = applySiteProfile(await readSettings(), payload, sender);
  const settings = applied.settings;
  payload = applied.payload;
  const policy = resolvePrivacy(settings, payload, sender);
  const {
    text,
    targetLanguage: targetLang,
    customPrompt,
    context,
    task
  } = payload;
  let sourceLang = payload.sourceLanguage || "auto";
  const service = new AIProviderService(settings, policy);
  const providerId = policy.providerId || payload.providerId;
  const usedProvider = providerId
    ? settings.providers?.find((p) => p.id === providerId)
    : service.activeProvider;
  if (!usedProvider) throw new Error("Selected provider is not configured");
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
        return {
          ok: true,
          result: {
            translation: text,
            providerName: "Detection",
            providerType: "same-language",
            sourceLanguage: detected,
            targetLanguage: targetLang,
            skippedSameLanguage: true,
            siteProfile: applied.profile?.hostname || null,
            qualityWarnings: []
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
  const diagnostics = (result) => ({
    ...result,
    siteProfile: applied.profile?.hostname || null,
    qualityWarnings:
      !task || task === "translate"
        ? checkTranslationQuality(
            shouldConvertFormat(text) ? htmlToMarkdown(text) : text,
            shouldConvertFormat(text)
              ? htmlToMarkdown(result.translation)
              : result.translation
          )
        : []
  });
  const hit = await cacheAccess(cacheKey, settings, policy);
  if (hit) {
    await saveHistory(hit.result);
    return {
      ok: true,
      result: {
        ...diagnostics(hit.result),
        providerName: `${hit.result.providerName || ""} ·cache`,
        cached: true
      }
    };
  }
  let providerCompleted = false;
  try {
    const formatted = shouldConvertFormat(text);
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
    await saveHistory(resultObj);
    await cacheAccess(cacheKey, settings, policy, resultObj);
    return { ok: true, result: diagnostics(resultObj) };
  } catch (error) {
    if (providerCompleted || error?.code === "PRIVACY_BLOCKED") throw error;
    // Task-specific work must not be replaced by a plain Google translation.
    if (
      usedProvider?.type !== "google-translate" &&
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
          result: diagnostics({
            ...result,
            providerName: "Google Translate (fallback)",
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
            fellBackFrom: usedProvider?.name || usedProvider?.type
          })
        };
      } catch (fallbackError) {
        if (fallbackError?.code === "PRIVACY_BLOCKED") throw fallbackError;
      }
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    writeSettings(message.settings)
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
chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== "quick-actions") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(
      tab.id,
      { type: "open-quick-actions" },
      { frameId: 0 }
    );
  } catch (error) {
    console.warn("BNTrans Quick Actions:", error.message);
  }
});

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

// Page translation is scoped to the top frame, not embedded documents.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "page-translation-state") return;
  if (sender.frameId > 0) return;
  registerContextMenus()
    .then(() => readSettings())
    .then((settings) => {
      const vi = (settings.interfaceLanguage || "en") === "vi";
      const title = message.active
        ? vi
          ? "Khôi phục trang gốc"
          : "Restore original page"
        : vi
          ? "Dịch trang này (song ngữ)"
          : "Translate page (bilingual)";
      return new Promise((resolve) =>
        chrome.contextMenus.update(PAGE_TRANSLATE_MENU_ID, { title }, () => {
          void chrome.runtime.lastError;
          resolve();
        })
      );
    })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
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
      .sendMessage(tab.id, { type: "toggle-page-translation" }, { frameId: 0 })
      .catch(() => {});
  } else if (info.menuItemId === EDITABLE_MENU_ID) {
    chrome.tabs
      .sendMessage(tab.id, { type: "translate-editable" })
      .catch(() => {});
  }
});
