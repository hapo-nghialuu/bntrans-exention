import { applySiteProfile } from "./site-profiles.js";
import { qualityWarningText } from "./translation-quality.js";
import { saveVocabulary } from "../experimental/learning-store.js";

const SKIP =
  "input,textarea,select,button,form,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='searchbox'],[autocomplete],[data-bntrans-sensitive],[hidden],[inert],[aria-hidden='true'],script,style,noscript,iframe,object,embed,[data-bntrans-quick]";

export function captureQuickSelection(doc) {
  const allowed = (node) => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element?.isConnected || element.closest(SKIP)) return false;
    for (
      let current = element;
      current;
      current = current.parentElement || current.getRootNode?.().host
    ) {
      if (current.matches?.(SKIP)) return false;
      const style = doc.defaultView.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return false;
    }
    return true;
  };
  const selection = doc.defaultView.getSelection();
  if (
    !selection ||
    selection.rangeCount !== 1 ||
    selection.isCollapsed ||
    !allowed(doc.activeElement)
  )
    return null;
  const range = selection.getRangeAt(0).cloneRange();
  const text = range.toString().trim();
  const valid = () => {
    if (
      !allowed(range.startContainer) ||
      !allowed(range.endContainer) ||
      range.toString().trim() !== text
    )
      return false;
    const root = range.commonAncestorContainer;
    const blocked = root.querySelectorAll?.(SKIP) || [];
    if (blocked.length > 1000) return false;
    return ![...blocked].some((node) => range.intersectsNode(node));
  };
  return text && text.length <= 8000 && valid() ? { text, range, valid } : null;
}

export async function openQuickActions(doc = document) {
  doc.querySelector("[data-bntrans-quick]")?.remove();
  const snapshot = captureQuickSelection(doc);
  const previous = doc.activeElement;
  const { translatorSettings: settings = {} } =
    await chrome.storage.local.get("translatorSettings");
  if (settings.enabled === false) return;
  if (!snapshot)
    throw new Error(
      "Select ordinary page text first / Hãy chọn văn bản thường, không phải vùng nhập liệu"
    );
  if (!snapshot.valid()) return;
  const vi = settings.interfaceLanguage === "vi";
  const t = (en, text) => (vi ? text : en);
  const direction = applySiteProfile(settings, {
    sourceLanguage:
      settings.selectionLastSource ||
      (settings.useAutoDetect ? "auto" : settings.targetLanguageCode || "en"),
    targetLanguage:
      settings.selectionLastTarget ||
      (settings.useAutoDetect
        ? settings.targetLanguageCode || "en"
        : settings.nativeLanguageCode || "vi"),
    siteUrl: doc.location.href
  }).payload;
  const host = doc.createElement("div");
  host.dataset.bntransQuick = "true";
  host.style.cssText =
    "position:fixed;inset:auto 16px 24px auto;z-index:2147483647;max-width:calc(100vw - 32px);";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `:host{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:light-dark(#182534,#eef3f8)}*{box-sizing:border-box}section{width:min(420px,calc(100vw - 32px));max-height:75vh;overflow:auto;background:light-dark(#fff,#15202b);border:1px solid light-dark(#c6d0d8,#405263);border-top:3px solid #367c86;box-shadow:0 12px 44px #0003;padding:18px;border-radius:8px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:15px;margin:0;letter-spacing:.03em}.meta{font-size:12px;opacity:.7}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}.source{max-height:110px;overflow:auto;border-left:2px solid #81929c;padding-left:12px}nav{display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;padding:6px 10px;border:1px solid #80939c;border-radius:4px;background:transparent;color:inherit;cursor:pointer}button:hover{background:#788c9b22}button:focus-visible{outline:2px solid #367c86;outline-offset:2px}button:disabled{opacity:.45;cursor:default}.warning{font-size:12px;color:light-dark(#865312,#edc788)}[role=status]{font-size:12px}`;
  const panel = doc.createElement("section");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "BNTrans Quick Actions");
  const make = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const title = make("header"),
    nav = make("nav"),
    output = make("p"),
    status = make("p"),
    warning = make("p", "", "warning");
  status.setAttribute("role", "status");
  warning.setAttribute("role", "status");
  let disposed = false,
    busy = false,
    translated = "";
  const close = () => {
    disposed = true;
    host.remove();
    doc.removeEventListener("pointerdown", outside, true);
    doc.defaultView.removeEventListener("pagehide", close);
    chrome.storage.onChanged.removeListener(changed);
    previous?.focus?.({ preventScroll: true });
  };
  const outside = (event) => {
    if (!event.composedPath().includes(host)) close();
  };
  const changed = (changes, area) => {
    if (area === "local" && changes.translatorSettings) close();
  };
  const button = (label, action, requiresSelection = true) => {
    const node = make("button", label);
    node.type = "button";
    node.addEventListener("click", async (event) => {
      if (!event.isTrusted || busy || disposed) return;
      if (requiresSelection && !snapshot.valid()) {
        status.textContent = t(
          "Selection changed; select again.",
          "Văn bản đã đổi; hãy chọn lại."
        );
        return;
      }
      busy = true;
      for (const item of nav.children) item.disabled = true;
      try {
        await action();
      } catch (error) {
        if (!disposed) status.textContent = error.message;
      } finally {
        busy = false;
        if (!disposed) for (const item of nav.children) item.disabled = false;
      }
    });
    return node;
  };
  const closeButton = make("button", t("Close", "Đóng"));
  closeButton.type = "button";
  closeButton.addEventListener("click", close);
  title.append(make("h2", "BNTRANS / QUICK ACTIONS"), closeButton);
  const translate = button(t("Translate", "Dịch"), async () => {
    status.textContent = t("Translating…", "Đang dịch…");
    const response = await chrome.runtime.sendMessage({
      type: "translate",
      payload: { ...direction, text: snapshot.text }
    });
    if (!response?.ok) throw new Error(response?.error || "Translation failed");
    if (disposed || !snapshot.valid()) return;
    translated = response.result.translation;
    output.textContent = translated;
    warning.textContent = qualityWarningText(
      response.result.qualityWarnings,
      vi ? "vi" : "en"
    );
    status.textContent = response.result.providerName;
  });
  const speak = button(t("Read original", "Đọc bản gốc"), async () => {
    const response = await chrome.runtime.sendMessage({
      type: "tts-play",
      payload: {
        text: snapshot.text,
        lang:
          direction.sourceLanguage === "auto"
            ? doc.documentElement.lang || "en"
            : direction.sourceLanguage
      }
    });
    if (!response?.ok) throw new Error(response?.error || "Speech failed");
    if (!disposed)
      status.textContent = t("Reading original", "Đang đọc bản gốc");
  });
  const stop = button(
    t("Stop reading", "Dừng đọc"),
    async () => {
      const response = await chrome.runtime.sendMessage({ type: "tts-stop" });
      if (!response?.ok)
        throw new Error(response?.error || "Speech stop failed");
      if (!disposed) status.textContent = t("Stopped", "Đã dừng");
    },
    false
  );
  const save = button(t("Save word", "Lưu từ"), async () => {
    if (snapshot.text.length > 500)
      throw new Error(
        t(
          "Wordbook accepts up to 500 characters.",
          "Sổ từ nhận tối đa 500 ký tự."
        )
      );
    await saveVocabulary({
      text: snapshot.text,
      translation: translated,
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      url: doc.location.href
    });
    if (!disposed)
      status.textContent = t("Saved to Vocabulary", "Đã lưu vào Sổ từ");
  });
  const copy = button(t("Copy result", "Sao chép"), async () => {
    if (!translated) throw new Error(t("Translate first.", "Hãy dịch trước."));
    await doc.defaultView.navigator.clipboard.writeText(translated);
    if (!disposed) status.textContent = t("Copied", "Đã sao chép");
  });
  nav.append(translate, speak, stop, save, copy);
  panel.append(
    title,
    make(
      "p",
      `${direction.sourceLanguage} → ${direction.targetLanguage}`,
      "meta"
    ),
    make("p", snapshot.text, "source"),
    nav,
    output,
    warning,
    status,
    make(
      "p",
      t(
        "Translation/speech use your privacy rules. Saving requires Vocabulary Labs enabled. No text is sent just by opening this panel.",
        "Dịch/đọc tuân theo cài đặt riêng tư. Lưu từ cần bật Labs Học từ. Mở bảng không gửi văn bản đi."
      ),
      "meta"
    )
  );
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") {
      const buttons = [...panel.querySelectorAll("button:not(:disabled)")];
      const index = buttons.indexOf(shadow.activeElement);
      if (
        (event.shiftKey && index === 0) ||
        (!event.shiftKey && index === buttons.length - 1)
      ) {
        event.preventDefault();
        buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
      }
    }
  });
  shadow.append(style, panel);
  doc.documentElement.append(host);
  doc.addEventListener("pointerdown", outside, true);
  doc.defaultView.addEventListener("pagehide", close, { once: true });
  chrome.storage.onChanged.addListener(changed);
  closeButton.focus();
  return close;
}
