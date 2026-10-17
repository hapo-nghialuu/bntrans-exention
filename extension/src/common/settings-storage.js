const SETTINGS_KEY = "translatorSettings";

export async function readSettings() {
  const { translatorSettings } = await chrome.storage.local.get(SETTINGS_KEY);
  return (
    translatorSettings || {
      enabled: true,
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
    }
  );
}

export async function writeSettings(next) {
  // Merge instead of replace: callers send partial or possibly stale
  // snapshots; keys they don't know about (e.g. selectionLastTarget saved
  // from a content script) must survive a save from another surface.
  const current = await readSettings();
  const merged = { ...current, ...next };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}
