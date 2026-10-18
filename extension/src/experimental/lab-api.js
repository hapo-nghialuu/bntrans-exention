import { readSettings } from "../common/settings-storage.js";

export function matchesHostname(hostname, rule) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  const domain = String(rule || "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
  return Boolean(domain && (host === domain || host.endsWith(`.${domain}`)));
}

export function createLabApi({ language = "en", selectedTab, onStatus } = {}) {
  const t = (en, vi) => (language === "vi" ? vi : en);
  const status = (message, kind = "info") => onStatus?.(String(message), kind);
  const send = async (type, payload = {}) => {
    const message = { type, payload };
    if (type === "set-settings") message.settings = payload;
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.ok === false) {
      throw new Error(
        response?.error ||
          t("No response from extension", "Extension không phản hồi")
      );
    }
    return response;
  };
  const tabs = async () => {
    const all = await chrome.tabs.query({});
    return all
      .filter((tab) => /^(https?|file):/i.test(tab.url || ""))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  };
  const activeTab = async () => {
    const id = selectedTab?.();
    if (id == null || id === "") {
      throw new Error(
        t("Choose a website tab first", "Chọn tab website trước")
      );
    }
    const tab = await chrome.tabs.get(Number(id));
    if (!/^(https?|file):/i.test(tab.url || "")) {
      throw new Error(t("This tab is not supported", "Không hỗ trợ tab này"));
    }
    return tab;
  };
  const api = {
    t,
    status,
    send,
    tabs,
    activeTab,
    settings: readSettings,
    updateSettings: async (patch) =>
      (await send("set-settings", patch)).settings,
    async sendToTab(type, payload = {}) {
      const tab = await activeTab();
      let response;
      try {
        response = await chrome.tabs.sendMessage(
          tab.id,
          { type, payload },
          { frameId: 0 }
        );
      } catch {
        throw new Error(
          t(
            "Reload the website tab after loading this extension",
            "Tải lại tab website sau khi nạp extension"
          )
        );
      }
      if (!response || response.ok === false) {
        throw new Error(
          response?.error ||
            t("No response from the website", "Website không phản hồi")
        );
      }
      return response;
    },
    async get(key, fallback = null) {
      const name = `bntransLabs:${key}`;
      const result = await chrome.storage.local.get(name);
      return result[name] ?? fallback;
    },
    async set(key, value) {
      await chrome.storage.local.set({ [`bntransLabs:${key}`]: value });
      return value;
    },
    async saveVocabulary(entry) {
      const { saveVocabulary } = await import("./learning-store.js");
      return saveVocabulary(entry);
    },
    async translate(text, options = {}) {
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(t("Enter some text first", "Nhập nội dung trước"));
      }
      const settings = await readSettings();
      const tab = await activeTab().catch(() => null);
      const siteUrl = options.siteUrl || tab?.url || "";
      let hostname = "";
      try {
        hostname = new URL(siteUrl).hostname;
      } catch {
        // Local files do not have a website profile.
      }
      const rule = (
        Array.isArray(settings.privacyRules) ? settings.privacyRules : []
      )
        .filter((item) => matchesHostname(hostname, item.hostname))
        .sort((a, b) => b.hostname.length - a.hostname.length)[0];
      const mode =
        options.privacyPolicy === "local-only"
          ? "local-only"
          : rule?.mode || settings.privacyDefaultMode || "cloud";
      const providerId =
        options.providerId || rule?.providerId || settings.activeProviderId;
      const provider = settings.providers?.find(
        (item) => item.id === providerId
      );
      let cloudConsent = false;
      if (mode === "ask") {
        const accepted = window.confirm(
          t(
            `Send this action's text to ${provider?.name || providerId || "your provider"}? Website: ${hostname || "local document"}. No API key is shared with websites.`,
            `Cho gửi nội dung thao tác này đến ${provider?.name || providerId || "provider đã chọn"}? Website: ${hostname || "tài liệu local"}. Không chia sẻ API key với website.`
          )
        );
        if (!accepted) throw new Error(t("Sending cancelled", "Đã hủy gửi"));
        cloudConsent = true;
      }
      const response = await send("translate", {
        ...options,
        text,
        sourceLanguage: options.sourceLanguage || "auto",
        targetLanguage:
          options.targetLanguage || settings.nativeLanguageCode || "vi",
        skipHistory: options.skipHistory !== false,
        providerId,
        siteUrl,
        privacyPolicy: mode,
        cloudConsent
      });
      const translation = response.result?.translation;
      if (typeof translation !== "string") {
        throw new Error(
          t("Provider returned no text", "Provider không trả văn bản")
        );
      }
      return translation;
    },
    download(filename, value, mime = "text/plain;charset=utf-8") {
      const blob =
        value instanceof Blob ? value : new Blob([value], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
    button(label, callback) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        try {
          await callback();
        } catch (error) {
          status(error.message || error, "error");
        } finally {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      });
      return button;
    },
    field(label, element) {
      const wrapper = document.createElement("label");
      wrapper.className = "lab-field";
      const text = document.createElement("span");
      text.textContent = label;
      wrapper.append(text, element);
      return wrapper;
    }
  };
  return api;
}
