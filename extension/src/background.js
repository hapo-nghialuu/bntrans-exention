import { AIProviderService, GeminiProvider } from "./services/ai-providers.js";
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
      selectionLastTarget: null
    }
  );
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

          // Result is the object { translation, providerName, providerType }
          sendResponse({
            ok: true,
            result: {
              translation: translation,
              providerName: result.providerName,
              providerType: result.providerType,
              sourceLanguage: sourceLang,
              targetLanguage: targetLang
            }
          });
        }
      } catch (err) {
        console.error("Translation Error:", err);
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
          const gemini = (settings.providers || []).find(
            (p) => p.type === "gemini" && p.config?.apiKey
          );
          if (!gemini) {
            sendResponse({
              ok: false,
              error:
                "Screenshot translation needs a Gemini API key. Add a Gemini provider in Options → Providers."
            });
            return;
          }
          const provider = new GeminiProvider(gemini.config);
          const targetLang =
            message.payload?.targetLanguage ||
            settings.targetLanguageCode ||
            "en";
          const result = await provider.translateImage(
            message.payload.imageBase64,
            targetLang,
            message.payload.mimeType
          );
          sendResponse({
            ok: true,
            result: {
              ...result,
              providerName: gemini.name || "Gemini",
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

// --- Screenshot-area translation context menu -----------------------------

const SCREENSHOT_MENU_ID = "bntrans-screenshot-area";

async function registerScreenshotMenu() {
  // Callback form + lastError swallow: the promise form does not reliably
  // reject on a missing id and would spam the console on every SW start.
  await new Promise((resolve) =>
    chrome.contextMenus.remove(SCREENSHOT_MENU_ID, () => {
      void chrome.runtime.lastError;
      resolve();
    })
  );
  let title = "Translate screenshot area";
  try {
    const settings = await readSettings();
    if ((settings.interfaceLanguage || "en") === "vi") {
      title = "Dịch vùng chụp màn hình";
    }
  } catch {
    /* keep English fallback */
  }
  chrome.contextMenus.create({
    id: SCREENSHOT_MENU_ID,
    title,
    contexts: ["page", "selection", "image", "frame", "link", "video"]
  });
}

chrome.runtime.onInstalled.addListener(registerScreenshotMenu);
chrome.runtime.onStartup.addListener(registerScreenshotMenu);
// MV3 service workers restart often; menu items persist per session but a
// dev reload clears them, so register eagerly too (remove+create is safe).
registerScreenshotMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== SCREENSHOT_MENU_ID || !tab?.id) return;
  chrome.tabs
    .sendMessage(tab.id, { type: "start-screenshot-select" })
    .catch(() => {});
});
