const SETTINGS_KEY = "translatorSettings";

export async function readSettings() {
  const { translatorSettings } = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = translatorSettings || {
    enabled: true,
    labFeatures: {
      learning: false,
      writing: false,
      media: false,
      documents: false,
      ocr: false,
      privacy: false,
      page: false
    },
    privacyDefaultMode: "cloud",
    privacyRules: [],
    allowCloudFallback: false,
    historyEnabled: true,
    cacheEnabled: true,
    cacheEpoch: 0,
    historyTTLHours: 720,
    cacheTTLHours: 168,
    historyEpoch: 0,
    nativeLanguageCode: "vi",
    targetLanguageCode: "en",
    useAutoDetect: false, // Default to fixed direction (Target→Native)
    showConfirmModal: true,
    dialogTimeout: 10,
    dualSubtitlesEnabled: false,
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
    translationHistory: [],
    autoTranslateDomains: []
  };
  const ttl = Number(settings.historyTTLHours ?? 720) * 3600000;
  return {
    ...settings,
    translationHistory:
      settings.historyEnabled === false || settings.retentionEnabled === false
        ? []
        : (settings.translationHistory || []).filter(
            (entry) => ttl > 0 && Date.now() - entry.ts < ttl
          )
  };
}

let settingsQueue = Promise.resolve();

export function updateSettings(transaction) {
  const run = async () => {
    const current = await readSettings();
    const patch = await transaction(current);
    if (!patch) return current;
    const merged = { ...current, ...patch };
    if (patch.labFeatures)
      merged.labFeatures = { ...current.labFeatures, ...patch.labFeatures };
    if (
      Array.isArray(patch.translationHistory) &&
      !patch.translationHistory.length
    ) {
      merged.historyEpoch = (current.historyEpoch || 0) + 1;
    }
    if (merged.cacheEnabled === false || merged.retentionEnabled === false)
      merged.cacheEpoch = (current.cacheEpoch || 0) + 1;
    if (merged.historyEnabled === false || merged.retentionEnabled === false) {
      merged.translationHistory = [];
      merged.historyEpoch = (current.historyEpoch || 0) + 1;
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    if (merged.cacheEnabled === false || merged.retentionEnabled === false) {
      await chrome.storage.local.set({ translationCache: {} });
    }
    return merged;
  };
  const locked = () =>
    globalThis.navigator?.locks?.request
      ? globalThis.navigator.locks.request("bntrans-settings", run)
      : run();
  const result = settingsQueue.then(locked, locked);
  settingsQueue = result.catch(() => {});
  return result;
}

export function writeSettings(next) {
  return updateSettings(() => next);
}
