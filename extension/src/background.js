import { AIProviderService } from "./services/ai-providers.js";
import {
  htmlToMarkdown,
  markdownToHtml,
  shouldConvertFormat
} from "./services/format-utils.js";

const OFFSCREEN_URL = chrome.runtime.getURL("../pages/offscreen.html");
const SETTINGS_KEY = "translatorSettings";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const hasOffscreen = contexts.some(
    (c) =>
      c.contextType === "OFFSCREEN_DOCUMENT" && c.documentUrl === OFFSCREEN_URL
  );

  if (!hasOffscreen) {
    await chrome.offscreen.createDocument({
      url: "../pages/offscreen.html",
      reasons: ["IFRAME_SCRIPTING"],
      justification:
        "Use built-in Translator and LanguageDetector APIs in a windowed context."
    });
  }
}

/**
 * Detect the language of a text via the offscreen LanguageDetector API.
 * Returns a BCP-47 code or null when detection is unavailable/uncertain.
 */
async function detectLanguageWithOffscreen(text) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      type: "detect-language",
      payload: { text: String(text || "").slice(0, 1000) }
    });
    if (res?.ok && res.detectedLanguage) {
      return res.detectedLanguage;
    }
  } catch {
    // Detection is best-effort; fall back to 'auto'
  }
  return null;
}

async function readSettings() {
  const { translatorSettings } = await chrome.storage.local.get(SETTINGS_KEY);
  return (
    translatorSettings || {
      enabled: true,
      nativeLanguageCode: "vi",
      targetLanguageCode: "en",
      useAutoDetect: false, // Default to fixed direction (Target→Native)
      showConfirmModal: true,
      dialogTimeout: 10,
      aliases: {
        e: "en",
        v: "vi",
        ch: "zh",
        j: "ja"
      },
      interfaceLanguage: "en",
      // Instant translate settings
      instantTranslateEnabled: false,
      instantDelay: 3000,
      instantDomains: [
        { domain: "telegram.org", enabled: true, position: "top" },
        { domain: "discord.com", enabled: true, position: "top" },
        { domain: "zalo.me", enabled: true, position: "top" },
        { domain: "openai.com", enabled: true, position: "top" },
        { domain: "claude.ai", enabled: true, position: "top" },
        { domain: "gemini.google.com", enabled: true, position: "top" }
      ],
      // AI Provider settings
      activeProviderId: "google-translate",
      translationStyle: "natural",
      glossary: {},
      providers: [
        {
          id: "google-translate",
          type: "google-translate",
          name: "Google Translate",
          config: {}
        },
        // Microsoft Translate removed - requires Authorization
        // {
        //   id: "microsoft-translate",
        //   type: "microsoft-translate",
        //   name: "Microsoft Translate (Bing)",
        //   config: {}
        // },
        {
          id: "builtin",
          type: "gemini-nano",
          name: "Chrome Built-in AI",
          config: {}
        },
        {
          id: "codex",
          type: "codex",
          name: "Codex CLI (Subscription)",
          config: {}
        }
      ],
      // Keyboard shortcut for toggle instant domain
      instantToggleShortcut: {
        key: "I",
        ctrl: true,
        shift: true,
        alt: false
      },
      // Hover to Translate settings
      hoverTranslateEnabled: false,
      hoverTranslateMode: "inject", // "inject" or "replace"
      hoverTranslateDomains: [],
      hoverModifierKey: "ctrl", // "ctrl", "shift", "alt"
      hoverToggleShortcut: {
        key: "O",
        ctrl: true,
        shift: true,
        alt: false
      },
      // Style customization for hover inject mode
      hoverInjectStyle: {
        backgroundColor: "#667eea",
        textColor: "#0c69e4",
        fontSize: "0.95em",
        showIcon: true,
        underline: false
      },
      // Last used languages in Selection Popup
      selectionLastSource: null,
      selectionLastTarget: null,
      // Recent translations (newest first), capped at 50
      translationHistory: []
    }
  );
}

const HISTORY_LIMIT = 50;

/**
 * Append one entry to settings.translationHistory (newest first, capped).
 * Callers opt out with payload.skipHistory (instant/hover are too noisy).
 * Fire-and-forget: history must never block or fail a translation.
 */
function recordHistory(settings, entry) {
  const prev = settings.translationHistory || [];
  const head = prev[0];
  // Skip an immediate repeat of the same pair (e.g. provider re-pick).
  if (
    head &&
    head.text === entry.text &&
    head.targetLanguage === entry.targetLanguage
  ) {
    return;
  }
  const translationHistory = [entry, ...prev].slice(0, HISTORY_LIMIT);
  writeSettings({ translationHistory }).catch(() => {});
}

async function writeSettings(next) {
  // Merge instead of replace: callers send partial or possibly stale
  // snapshots; keys they don't know about (e.g. selectionLastTarget saved
  // from a content script) must survive a save from another surface.
  const current = await readSettings();
  const merged = { ...current, ...next };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "get-settings") {
    readSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }

  if (message?.type === "set-settings") {
    writeSettings(message.settings).then((s) =>
      sendResponse({ ok: true, settings: s })
    );
    return true;
  }

  // --- Persistent translation cache (LRU in storage.local) -------------------
  // Separate storage key so settings export/import stays clean. Keyed on
  // provider + model + languages + style + glossary + prompt + text via a
  // cyrb53 hash; bounded at CACHE_LIMIT entries with LRU eviction.

  const CACHE_LIMIT = 300;
  const CACHE_STORAGE_KEY = "translationCache";
  let translationCache = null; // lazily-loaded Map

  async function loadTranslationCache() {
    if (translationCache) return translationCache;
    translationCache = new Map();
    try {
      const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
      const obj = stored?.[CACHE_STORAGE_KEY];
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) translationCache.set(k, v);
      }
    } catch {
      /* start empty */
    }
    return translationCache;
  }

  // cyrb53 — fast 53-bit hash, sufficient for cache-key collisions risk
  function hashString(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
  }

  function translationCacheKey({
    text,
    sourceLang,
    targetLang,
    providerKey,
    model,
    settings,
    customPrompt
  }) {
    return hashString(
      JSON.stringify([
        providerKey,
        model || "",
        sourceLang,
        targetLang,
        settings.translationStyle || "",
        settings.glossary || {},
        customPrompt || "",
        text
      ])
    );
  }

  function translationCacheGet(key) {
    const entry = translationCache?.get(key);
    if (!entry) return null;
    entry.ts = Date.now(); // LRU touch
    return entry;
  }

  function translationCacheSet(key, result) {
    if (!translationCache) return;
    translationCache.set(key, { result, ts: Date.now() });
    if (translationCache.size > CACHE_LIMIT) {
      const oldest = [...translationCache.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, translationCache.size - CACHE_LIMIT);
      for (const [k] of oldest) translationCache.delete(k);
    }
    chrome.storage.local
      .set({ [CACHE_STORAGE_KEY]: Object.fromEntries(translationCache) })
      .catch(() => {});
  }

  // ---------------------------------------------------------------------------

  if (message?.type === "translate") {
    readSettings().then(async (settings) => {
      // Extract payload using keys sent by content-script.js
      const {
        text,
        targetLanguage,
        sourceLanguage,
        providerId,
        customPrompt,
        context
      } = message.payload;

      const targetLang = targetLanguage;
      let sourceLang = sourceLanguage || "auto";

      // Detect the source language when it is not explicitly provided, so
      // prompts get a concrete language and we can skip no-op translations
      // (e.g., English text -> English target).
      if (sourceLang === "auto") {
        const detected = await detectLanguageWithOffscreen(text);
        if (detected) {
          const sameBaseLang =
            detected.split("-")[0].toLowerCase() ===
            String(targetLang || "")
              .split("-")[0]
              .toLowerCase();
          if (sameBaseLang) {
            // Source already matches the target language: return it as-is.
            sendResponse({
              ok: true,
              result: {
                translation: text,
                providerName: "Detection",
                providerType: "same-language",
                sourceLanguage: detected,
                targetLanguage: targetLang,
                skippedSameLanguage: true
              }
            });
            return;
          }
          sourceLang = detected;
        }
      }

      const aiService = new AIProviderService(settings);
      const usedProvider = providerId
        ? settings.providers?.find((p) => p.id === providerId)
        : aiService.activeProvider;

      // Serve an identical previous translation straight from the cache —
      // skips provider calls for repeated text (page translate, UI strings).
      await loadTranslationCache();
      const cacheKey = translationCacheKey({
        text,
        sourceLang,
        targetLang,
        providerKey: usedProvider?.id || usedProvider?.type || "?",
        model: usedProvider?.model,
        settings,
        customPrompt
      });
      const hit = translationCacheGet(cacheKey);
      if (hit) {
        if (!message.payload.skipHistory) {
          recordHistory(settings, {
            text: String(text).slice(0, 500),
            translation: String(hit.result.translation || "").slice(0, 1000),
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
            providerName: hit.result.providerName,
            ts: Date.now()
          });
        }
        sendResponse({
          ok: true,
          result: {
            ...hit.result,
            providerName: `${hit.result.providerName || ""} ·cache`,
            cached: true
          }
        });
        return;
      }

      try {
        // --- Format Conversion Logic ---
        let textToTranslate = text;
        let hasFormatting = false;

        // Apply format conversion for all providers
        if (shouldConvertFormat(text)) {
          textToTranslate = htmlToMarkdown(text);
          hasFormatting = true;
        }

        const result = await aiService.translate(
          textToTranslate,
          sourceLang,
          targetLang,
          providerId,
          customPrompt,
          context
        );

        // If result is the special signal for Window AI, use offscreen
        if (result?.useOffscreen) {
          await ensureOffscreen();
          const offscreenResult = await chrome.runtime.sendMessage({
            type: "offscreen-translate",
            payload: { ...message.payload, text: textToTranslate }
          });

          if (offscreenResult?.ok) {
            let translation = offscreenResult.translation;

            // Convert back to HTML if formatting was converted
            if (hasFormatting && translation) {
              translation = markdownToHtml(translation);
            }

            // offscreenResult is { ok: true, translation: "...", ... }
            // We need to construct the result object expected by content-script
            const resultObj = {
              translation: translation,
              sourceLanguage: offscreenResult.sourceLanguage,
              targetLanguage: offscreenResult.targetLanguage,
              providerName:
                offscreenResult.providerName || "Chrome Built-in AI",
              providerType: offscreenResult.providerType || "Built-in"
            };

            if (!message.payload.skipHistory && translation) {
              recordHistory(settings, {
                text: String(text).slice(0, 500),
                translation: String(translation).slice(0, 1000),
                sourceLanguage: resultObj.sourceLanguage,
                targetLanguage: targetLang,
                providerName: resultObj.providerName,
                ts: Date.now()
              });
            }

            translationCacheSet(cacheKey, resultObj);
            sendResponse({ ok: true, result: resultObj });
          } else {
            sendResponse({
              ok: false,
              error: offscreenResult?.error || "Unknown error"
            });
          }
        } else {
          // Convert back to HTML if formatting was converted
          let translation = result.translation;
          if (hasFormatting && translation) {
            translation = markdownToHtml(translation);
          }

          if (!message.payload.skipHistory && translation) {
            recordHistory(settings, {
              text: String(text).slice(0, 500),
              translation: String(translation).slice(0, 1000),
              sourceLanguage: sourceLang,
              targetLanguage: targetLang,
              providerName: result.providerName,
              ts: Date.now()
            });
          }

          // Result is the object { translation, providerName, providerType }
          const resultObj = {
            translation: translation,
            providerName: result.providerName,
            providerType: result.providerType,
            sourceLanguage: sourceLang,
            targetLanguage: targetLang
          };
          translationCacheSet(cacheKey, resultObj);
          sendResponse({ ok: true, result: resultObj });
        }
      } catch (err) {
        console.error("Translation Error:", err);

        // Retry once through Google Translate so a provider outage/quota
        // still yields a translation instead of a dead error.
        if (usedProvider?.type !== "google-translate") {
          try {
            const fallback = new AIProviderService({
              ...settings,
              activeProviderId: "google-translate"
            });
            const fb = await fallback.translate(
              text,
              sourceLang,
              targetLang,
              "google-translate",
              "",
              ""
            );
            if (fb && typeof fb === "object" && !fb.useOffscreen) {
              sendResponse({
                ok: true,
                result: {
                  translation: fb.translation,
                  providerName: "Google Translate (fallback)",
                  providerType: "google-translate",
                  sourceLanguage: sourceLang,
                  targetLanguage: targetLang,
                  fellBackFrom: usedProvider?.name || usedProvider?.type
                }
              });
              return;
            }
          } catch (fbErr) {
            console.error("Fallback Error:", fbErr);
          }
        }

        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    });

    return true;
  }

  // Screenshot-area capture: return the visible tab as a PNG data URL.
  // The content script crops to the user-selected rect on its side.
  if (message?.type === "capture-visible") {
    const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs
      .captureVisibleTab(windowId, { format: "png" })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );
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
          const chosen =
            providers.find((p) => p.id === settings.screenshotProviderId) ||
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
          const service = new AIProviderService({
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
          });
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
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );
    return true;
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return true;
  }
  if (message?.type === "tts-play") {
    ensureOffscreen().then(async () => {
      try {
        await chrome.runtime.sendMessage({
          type: "play-tts",
          payload: message.payload
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    });
    return true;
  }
});

// --- Context menus ---------------------------------------------------------

const SCREENSHOT_MENU_ID = "bntrans-screenshot-area";
const SELECTION_MENU_ID = "bntrans-translate-selection";
const SIDE_PANEL_MENU_ID = "bntrans-open-side-panel";
const PAGE_TRANSLATE_MENU_ID = "bntrans-page-translate";

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
          PAGE_TRANSLATE_MENU_ID
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
      try {
        const settings = await readSettings();
        if ((settings.interfaceLanguage || "en") === "vi") {
          screenshotTitle = "Dịch vùng chụp màn hình";
          selectionTitle = "Dịch đoạn đã chọn";
          panelTitle = "Mở bảng dịch BNTrans";
          pageTitle = "Dịch trang này (song ngữ)";
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
    })();
  }
  return contextMenuPromise;
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);
// MV3 service workers restart often; menu items persist per session but a
// dev reload clears them, so register eagerly too (remove+create is safe).
registerContextMenus();

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
  }
});
