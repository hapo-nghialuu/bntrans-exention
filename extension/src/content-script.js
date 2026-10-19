/* global handleLineByLineTranslate, handleSentenceBySentenceTranslate */
/* global getTranslationUnits, toMarkdown, injectUnitWrappers, requestSegmentTranslations, updateWrappers */
let normalizeLanguageToCode;
let i18n;
let tts;

const TRANSLATION_COMMAND_PATTERN = /!!([a-zA-ZÀ-ÿ-]+)$/i;

let isTranslating = false;
let debounceTimer = null;

// Instant translate state
let instantTimer = null;
let currentSuggestion = null;
let justAppliedTranslation = false;
let currentKeyHandler = null; // Track active keyboard handler
let isIMEComposing = false; // Track if IME composition is active

// Select-to-translate state
let selectionIcon = null;
let selectionPopup = null;
let selectedText = "";

// Theme (auto/light/dark) applied to injected UI containers
let currentTheme = "auto";

function applyThemeTo(el) {
  if (!el) return;
  if (currentTheme === "auto") el.removeAttribute("data-theme");
  else el.dataset.theme = currentTheme;
}

function refreshInjectedTheme() {
  document.querySelectorAll(".bt-vars-container").forEach(applyThemeTo);
}

// Global error handler for extension context invalidation
window.addEventListener("error", (event) => {
  if (
    event.error &&
    event.error.message &&
    (event.error.message.includes("Extension context invalidated") ||
      event.error.message.includes("Could not establish connection") ||
      event.error.message.includes("receiving end does not exist"))
  ) {
    console.log("BNTrans: Caught global extension context invalidation error");
    cleanupExtensionElements();
    event.preventDefault(); // Prevent the error from being logged to console
  }
});

// Global unhandled promise rejection handler
window.addEventListener("unhandledrejection", (event) => {
  if (
    event.reason &&
    event.reason.message &&
    (event.reason.message.includes("Extension context invalidated") ||
      event.reason.message.includes("Could not establish connection") ||
      event.reason.message.includes("receiving end does not exist"))
  ) {
    console.log(
      "BNTrans: Caught unhandled promise rejection for extension context invalidation"
    );
    cleanupExtensionElements();
    event.preventDefault(); // Prevent the error from being logged to console
  }
});

(async function bootstrap() {
  try {
    if (!isExtensionContextValid()) {
      console.log("BNTrans: Extension context not available during bootstrap");
      return;
    }

    // Wrap all chrome.runtime calls in try-catch
    let mod, i18nMod, ttsMod;
    try {
      mod = await import(chrome.runtime.getURL("src/common/language-map.js"));
      normalizeLanguageToCode = mod.normalizeLanguageToCode;

      i18nMod = await import(chrome.runtime.getURL("src/common/i18n.js"));
      i18n = i18nMod.i18n;

      ttsMod = await import(chrome.runtime.getURL("src/services/tts.js"));
      tts = ttsMod.tts;
    } catch (importError) {
      if (
        importError.message.includes("Extension context invalidated") ||
        importError.message.includes("Could not establish connection")
      ) {
        console.log("BNTrans: Extension context invalidated during import");
        cleanupExtensionElements();
        return;
      }
      throw importError;
    }

    // Initialize i18n with current settings
    getSettings()
      .then((settings) => {
        if (settings.interfaceLanguage) {
          i18n.setLanguage(settings.interfaceLanguage);
        }
      })
      .catch((err) => {
        console.log("BNTrans: Error initializing i18n:", err.message);
      });

    // Listen for setting changes
    try {
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === "local" && changes.translatorSettings) {
          const newSettings = changes.translatorSettings.newValue;
          if (newSettings && newSettings.interfaceLanguage) {
            i18n.setLanguage(newSettings.interfaceLanguage);
          }
        }
      });
    } catch (storageError) {
      console.log(
        "BNTrans: Error setting up storage listener:",
        storageError.message
      );
    }

    injectGlobalStylesheet();
    registerAutoDetection();
    registerInstantMode();
    registerSelectionMode();
    registerInstantToggleShortcut();
    registerInstantLabelIndicator();
    registerHoverTranslate();
    registerHoverToggleShortcut();
    registerScreenshotTranslate();
    registerDualSubtitles();
  } catch (error) {
    console.log("BNTrans: Bootstrap failed:", error.message);
    if (
      error.message.includes("Extension context invalidated") ||
      error.message.includes("Could not establish connection")
    ) {
      // Extension was reloaded, clean up and exit gracefully
      cleanupExtensionElements();
    }
  }
})();

function injectGlobalStylesheet() {
  try {
    if (!isExtensionContextValid()) {
      return;
    }

    const href = chrome.runtime.getURL("assets/styles/dialogs.css");
    if (![...document.styleSheets].some((s) => s.href === href)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  } catch (error) {
    console.log("BNTrans: Error injecting stylesheet:", error.message);
    if (
      error.message.includes("Extension context invalidated") ||
      error.message.includes("Could not establish connection")
    ) {
      cleanupExtensionElements();
    }
  }
}

const editableGenerations = new WeakMap();
const editableRevisions = new WeakMap();

function isSensitiveElement(element) {
  for (
    let node = element;
    node;
    node = node.parentElement || node.getRootNode?.().host
  ) {
    if (node.nodeType === 3) continue;
    if (
      String(node.type || node.getAttribute?.("type") || "").toLowerCase() ===
      "password"
    )
      return true;
    const autocomplete = (node.getAttribute?.("autocomplete") || "")
      .toLowerCase()
      .split(/\s+/);
    if (
      autocomplete.some((token) =>
        /^(?:current-password|new-password|one-time-code|username|webauthn|cc-.+)$/.test(
          token
        )
      )
    )
      return true;
  }
  return false;
}

function isEditableElement(element) {
  if (!element) return false;
  if (isSensitiveElement(element) || element.disabled || element.readOnly)
    return false;

  const tag = element.tagName?.toLowerCase();

  if (tag === "input") {
    const type = (
      element.type ||
      element.getAttribute("type") ||
      "text"
    ).toLowerCase();
    return ["text", "search", "email", "url", "tel"].includes(type) || !type;
  }

  if (tag === "textarea") return true;
  if (element.isContentEditable) {
    return !Array.from(
      element.querySelectorAll?.("input, [autocomplete]") || []
    ).some(isSensitiveElement);
  }

  return false;
}

function editableValue(element) {
  return element.isContentEditable ? element.innerHTML : element.value;
}

function captureEditableSnapshot(element, selectionOnly = false) {
  if (!isEditableElement(element) || !element.isConnected) return null;
  const generation = (editableGenerations.get(element) || 0) + 1;
  editableGenerations.set(element, generation);
  const snapshot = {
    element,
    generation,
    revision: editableRevisions.get(element) || 0,
    value: editableValue(element),
    text: element.isContentEditable ? element.innerText : element.value,
    replaceAll: true
  };
  if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (selectionOnly && range && !range.collapsed) {
      if (
        !element.contains(range.startContainer) ||
        !element.contains(range.endContainer) ||
        isSensitiveElement(range.startContainer) ||
        isSensitiveElement(range.endContainer)
      )
        return null;
      snapshot.range = range.cloneRange();
      snapshot.text = range.toString();
      snapshot.replaceAll = false;
    } else {
      snapshot.range = document.createRange();
      snapshot.range.selectNodeContents(element);
    }
    snapshot.rangeText = snapshot.range.toString();
  } else {
    snapshot.start = element.selectionStart ?? 0;
    snapshot.end = element.selectionEnd ?? 0;
    if (selectionOnly && snapshot.start !== snapshot.end) {
      snapshot.text = element.value.slice(snapshot.start, snapshot.end);
      snapshot.replaceAll = false;
    }
  }
  return snapshot;
}

function isEditableSnapshotCurrent(snapshot) {
  if (!snapshot) return false;
  const { element, range } = snapshot;
  return (
    isEditableElement(element) &&
    element.isConnected &&
    editableGenerations.get(element) === snapshot.generation &&
    (editableRevisions.get(element) || 0) === snapshot.revision &&
    editableValue(element) === snapshot.value &&
    (!range ||
      (range.startContainer.isConnected &&
        range.endContainer.isConnected &&
        element.contains(range.startContainer) &&
        element.contains(range.endContainer) &&
        range.toString() === snapshot.rangeText))
  );
}

function showStaleEditableNotice() {
  showToast(
    i18n?.language === "vi"
      ? "Nội dung đã thay đổi; không ghi đè. Hãy dịch lại."
      : "Content changed; nothing was replaced. Translate again."
  );
}

function applyEditableSnapshot(snapshot, text) {
  if (!isEditableSnapshotCurrent(snapshot)) {
    showStaleEditableNotice();
    return false;
  }
  const { element, range } = snapshot;
  if (range) {
    element.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range.cloneRange());
    // Scoped insertText preserves the browser's undo stack where supported.
    if (
      !isEditableSnapshotCurrent(snapshot) ||
      !document.execCommand("insertText", false, text)
    ) {
      showToast(i18n.t("toast.translationFailed"));
      return false;
    }
  } else if (snapshot.replaceAll) {
    element.value = text;
  } else {
    element.setRangeText(text, snapshot.start, snapshot.end, "end");
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function getSafeSelection() {
  const selection = window.getSelection();
  if (
    isSensitiveElement(getDeepActiveElement()) ||
    isSensitiveElement(selection?.anchorNode) ||
    isSensitiveElement(selection?.focusNode)
  )
    return null;
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const candidates = root.querySelectorAll?.("input, [autocomplete]") || [];
    for (const node of candidates) {
      if (isSensitiveElement(node) && range.intersectsNode(node)) return null;
    }
  }
  return selection;
}

function getDeepActiveElement(root = document) {
  let element = root.activeElement || null;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element;
}

function getActiveEditableElement() {
  const element = getDeepActiveElement();
  return isEditableElement(element) ? element : null;
}

function parseFieldTextAndCommand(element) {
  if (!isEditableElement(element)) return null;

  let value = "";
  const tag = element.tagName?.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    value = element.value;
  } else if (element.isContentEditable) {
    value = element.innerText;
  }

  const match = value.match(TRANSLATION_COMMAND_PATTERN);
  if (!match) return null;

  const languageRaw = match[1];
  const precedingText = value.slice(0, match.index).trimEnd();
  return { text: precedingText, languageRaw };
}

async function getSettings() {
  if (!isExtensionContextValid()) {
    // Don't show toast, just return default settings
    return {
      enabled: false,
      nativeLanguageCode: "vi",
      targetLanguageCode: "en",
      useAutoDetect: false,
      showConfirmModal: true,
      dialogTimeout: 10,
      aliases: {},
      interfaceLanguage: "en"
    };
  }

  try {
    // Double-check context validity before making the call
    if (!isExtensionContextValid()) {
      throw new Error("Extension context invalidated");
    }

    const res = await chrome.runtime.sendMessage({ type: "get-settings" });
    if (res?.ok) {
      // Initialize i18n with the fetched language setting
      if (i18n) {
        i18n.setLanguage(res.settings.interfaceLanguage || "en");
      }
      return res.settings;
    }
  } catch (error) {
    console.log("BNTrans: Error getting settings:", error.message);
    if (
      error.message.includes("Extension context invalidated") ||
      error.message.includes("Could not establish connection")
    ) {
      cleanupExtensionElements();
    }
  }

  return {
    enabled: true,
    nativeLanguageCode: "vi",
    targetLanguageCode: "en",
    useAutoDetect: false,
    showConfirmModal: true,
    dialogTimeout: 10,
    aliases: {},
    interfaceLanguage: "en"
  };
}

// Initialize theme from settings + keep injected UI in sync
try {
  getSettings().then((s) => {
    currentTheme = s?.theme || "auto";
    refreshInjectedTheme();
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.translatorSettings?.newValue) {
      const theme = changes.translatorSettings.newValue.theme || "auto";
      if (theme !== currentTheme) {
        currentTheme = theme;
        refreshInjectedTheme();
      }
    }
  });
} catch {
  /* extension context not ready */
}

/**
 * Page context sent with every translation request so the provider can
 * resolve ambiguity (site + page title, never translated itself).
 */
function getPageContext() {
  try {
    const title = (document.title || "").trim();
    const host = location.hostname || "";
    return `${host} — ${title}`.slice(0, 200).trim();
  } catch {
    return "";
  }
}

async function requestTranslation(payload) {
  if (!isExtensionContextValid()) {
    throw new Error(i18n.t("toast.extensionUpdated"));
  }

  try {
    // Double-check context validity before making the call
    if (!isExtensionContextValid()) {
      throw new Error("Extension context invalidated");
    }

    return chrome.runtime.sendMessage({
      type: "translate",
      payload: { context: getPageContext(), ...payload }
    });
  } catch (error) {
    if (
      error.message.includes("Extension context invalidated") ||
      error.message.includes("Could not establish connection")
    ) {
      cleanupExtensionElements();
      throw new Error(i18n.t("toast.extensionUpdated"));
    }
    throw error;
  }
}

function removeTranslationCommandSuffix(element) {
  if (!isEditableElement(element)) return "";

  let value = "";
  const tag = element.tagName?.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    value = element.value;
    value = value.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return value;
  }

  if (element.isContentEditable) {
    value = element.innerText;
    value = value.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
    element.textContent = value;
    return value;
  }

  return "";
}

function showToast(message) {
  const host = document.createElement("div");
  const lowerMsg = message.toLowerCase();

  // Determine toast type and icon
  let icon = "•";
  let toastType = "default"; // default, warning, success

  if (lowerMsg.includes("translating") || lowerMsg.includes("đang dịch")) {
    icon = "⏳";
    toastType = "default";
  } else if (lowerMsg.includes("enabled") || lowerMsg.includes("đã bật")) {
    icon = "✓";
    toastType = "success";
  } else if (lowerMsg.includes("disabled") || lowerMsg.includes("đã tắt")) {
    icon = "⚠️";
    toastType = "warning";
  } else if (lowerMsg.includes("failed") || lowerMsg.includes("thất bại")) {
    icon = "⚠️";
    toastType = "warning";
  } else if (lowerMsg.includes("updated") || lowerMsg.includes("cập nhật")) {
    icon = "ℹ️";
    toastType = "default";
  } else if (lowerMsg.includes("error") || lowerMsg.includes("lỗi")) {
    icon = "❌";
    toastType = "warning";
  } else if (
    lowerMsg.includes("invalid") ||
    lowerMsg.includes("không hợp lệ")
  ) {
    icon = "⚠️";
    toastType = "warning";
  } else if (lowerMsg.includes("instant")) {
    icon = "⚡";
    toastType = "default";
  }

  // Set class based on type
  host.className = `bt-toast-notify bt-toast-notify-${toastType} bt-vars-container`;
  applyThemeTo(host);

  host.innerHTML = `
    <div class="bt-toast-notify-content">
      <span class="bt-toast-notify-icon">${icon}</span>
      <span class="bt-toast-notify-text">${message}</span>
    </div>
  `;
  document.documentElement.appendChild(host);

  // Fade out animation - close faster
  setTimeout(() => {
    host.classList.add("bt-toast-notify-exit");
    setTimeout(() => host.remove(), 300);
  }, 1500);
}

function registerAutoDetection() {
  document.addEventListener("input", handleUserInputEvent, true);
  document.addEventListener("blur", handleUserInputEvent, true);
}

function handleUserInputEvent(event) {
  const target = event?.composedPath?.()[0] || event?.target;
  if (target && event.type === "input")
    editableRevisions.set(target, (editableRevisions.get(target) || 0) + 1);
  clearTimeout(debounceTimer);
  clearTimeout(instantTimer);
  const element = getActiveEditableElement();
  if (!element) return;
  debounceTimer = setTimeout(() => attemptTranslationTrigger(element), 600);
}

function attemptTranslationTrigger(element) {
  if (isTranslating) return;
  const parsed = parseFieldTextAndCommand(element);
  if (!parsed) return;
  handleAutoTranslation(element, parsed);
}

function resolveTargetLanguage(raw, settings) {
  if (raw === "t") return settings.targetLanguageCode || "en";

  // Check aliases
  if (settings.aliases && settings.aliases[raw]) {
    return settings.aliases[raw];
  }

  // Fallback to normalization (e.g. "english" -> "en")
  return normalizeLanguageToCode(raw);
}

async function handleAutoTranslation(element, parsed) {
  const initialSnapshot = captureEditableSnapshot(element);
  if (!initialSnapshot) return;
  isTranslating = true;
  let suggestion = null;

  try {
    const baseText = parsed.text;

    // Wrap getSettings to catch invalidation early
    let settings;
    try {
      settings = await getSettings();
    } catch (e) {
      if (e.message.includes("Extension context invalidated")) {
        showToast(i18n.t("toast.extensionUpdated"));
        return;
      }
      throw e;
    }

    if (settings.enabled === false) return;
    if (!isEditableSnapshotCurrent(initialSnapshot)) return;

    // Skip if this domain is already handled by instant translation
    if (isInstantDomain(settings)) return;

    const targetCode = resolveTargetLanguage(parsed.languageRaw, settings);

    if (!baseText || !baseText.trim()) return;
    if (!targetCode) {
      showToast(i18n.t("toast.invalidLanguage"));
      return;
    }

    const cleanSourceValue = removeTranslationCommandSuffix(element);
    const snapshot = captureEditableSnapshot(element);
    if (!snapshot) return;

    // If confirm is OFF, just translate and replace immediately
    if (!settings.showConfirmModal) {
      // Only show loading for non-builtin models
      if (settings.activeProviderId !== "builtin") {
        showToast(i18n.t("toast.translating"));
      }
      let res;
      try {
        res = await requestTranslation({
          text: cleanSourceValue,
          nativeLanguageCode: settings.nativeLanguageCode || "en",
          targetLanguage: targetCode,
          languageOverride: parsed.languageRaw !== "t",
          useAutoDetect: settings.useAutoDetect === true
        });
      } catch (e) {
        showToast(e.message || i18n.t("toast.translationFailed"));
        return;
      }

      if (res?.ok && res.result?.translation) {
        setFieldText(element, res.result.translation, { snapshot });
      } else {
        showToast(
          res?.error ? String(res.error) : i18n.t("toast.translationFailed")
        );
      }
      return;
    }

    // If confirm is ON, show inline suggestion
    // Only show loading for non-builtin models
    if (settings.activeProviderId !== "builtin") {
      showToast(i18n.t("toast.translating"));
    }

    let res;
    try {
      res = await requestTranslation({
        text: cleanSourceValue,
        nativeLanguageCode: settings.nativeLanguageCode || "en",
        targetLanguage: targetCode,
        languageOverride: parsed.languageRaw !== "t",
        useAutoDetect: settings.useAutoDetect === true
      });
    } catch (e) {
      showToast(e.message || i18n.t("toast.translationFailed"));
      return;
    }

    if (!res || !res.ok || !res.result?.translation) {
      showToast(
        res?.error ? String(res.error) : i18n.t("toast.translationFailed")
      );
      return;
    }

    const translation = res.result.translation;
    if (!isEditableSnapshotCurrent(snapshot)) {
      showStaleEditableNotice();
      return;
    }
    const providerInfo = `${res.result.providerName || "AI"} (${res.result.providerType || "Bot"})`;

    // Use buildInlineSuggestion with auto positioning
    suggestion = buildInlineSuggestion(
      element,
      translation,
      providerInfo,
      "auto"
    );

    // Setup Tab/Esc handlers
    const handleKeydown = (ev) => {
      if (ev.key === "Tab") {
        ev.preventDefault();
        setFieldText(element, translation, { snapshot });
        suggestion.destroy();
        document.removeEventListener("keydown", handleKeydown, true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        suggestion.destroy();
        document.removeEventListener("keydown", handleKeydown, true);
      }
    };

    document.addEventListener("keydown", handleKeydown, true);

    // Cleanup if element loses focus or is removed
    const onBlur = () => {
      suggestion.destroy();
      document.removeEventListener("keydown", handleKeydown, true);
      element.removeEventListener("blur", onBlur);
    };
    element.addEventListener("blur", onBlur);
  } catch (err) {
    if (suggestion) suggestion.destroy();
    showToast(err.message || "An error occurred");
    console.error(err);
  } finally {
    isTranslating = false;
  }
}

// ============================================
// INSTANT TRANSLATE MODE
// ============================================

function isInstantDomain(settings) {
  if (!settings.instantTranslateEnabled) return null;

  const currentUrl = window.location.href;
  return (
    settings.instantDomains.find(
      (d) => d.enabled && currentUrl.includes(d.domain)
    ) || null
  );
}

function shouldTriggerInstant(text) {
  // Don't trigger if:
  if (!text || text.trim().length < 5) return false; // Too short
  if (/^https?:\/\//.test(text)) return false; // URL
  if (/^[!@#$%^&*()_+=[\]{};':"\\|,.<>/?`~-]+$/.test(text)) return false; // Only special chars
  return true;
}

function setFieldText(element, text, options = {}) {
  const snapshot = options.snapshot || captureEditableSnapshot(element);
  if (!isEditableSnapshotCurrent(snapshot)) {
    showStaleEditableNotice();
    return;
  }
  const tag = element.tagName?.toLowerCase();

  // Ensure element has focus first
  if (document.activeElement !== element) {
    element.focus();
  }
  if (!isEditableSnapshotCurrent(snapshot)) {
    showStaleEditableNotice();
    return;
  }

  if (tag === "input" || tag === "textarea") {
    // Use native setter to bypass React's value tracking
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      tag === "input"
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, text);
    } else {
      element.value = text;
    }

    // Trigger React's onChange by dispatching input event
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element.isContentEditable) {
    applyEditableSnapshot(snapshot, text);
  }
}

function buildInlineSuggestion(
  element,
  translatedText,
  providerInfo,
  position = "auto",
  settings = {}
) {
  const container = document.createElement("div");
  container.className = "bt-inline-suggestion bt-vars-container";
  applyThemeTo(container);

  // Position relative to input
  const rect = element.getBoundingClientRect();
  container.style.position = "fixed";
  container.style.zIndex = "9999999999";

  // Smart width calculation to prevent UI breaking on small inputs
  const minPopupWidth = 320;
  const maxPopupWidth = 600;
  const inputWidth = rect.width;

  // Calculate popup width with constraints
  let popupWidth = Math.max(inputWidth - 80, minPopupWidth);
  popupWidth = Math.min(popupWidth, maxPopupWidth);

  container.style.width = `${popupWidth}px`;
  container.style.minWidth = `${minPopupWidth}px`;
  container.style.maxWidth = `${maxPopupWidth}px`;

  // Smart horizontal positioning
  let leftPos = rect.left;

  // Get available viewport considering panels
  const viewport = getAvailableViewport();

  // If popup is wider than input, center it relative to input
  if (popupWidth > inputWidth) {
    leftPos = rect.left - (popupWidth - inputWidth) / 2;

    // Keep popup within viewport considering panel offsets
    const maxLeft = viewport.width + viewport.leftOffset - popupWidth - 10;
    const minLeft = viewport.leftOffset + 10;
    leftPos = Math.max(minLeft, Math.min(leftPos, maxLeft));
  }

  container.style.left = `${leftPos}px`;

  // AUTO-DETECT optimal vertical position
  let finalPosition = position;

  if (position === "auto") {
    // Calculate available space above and below
    const spaceAbove = rect.top;
    const spaceBelow = viewport.height - rect.bottom;

    const minSpaceNeeded = 120;

    // Prefer bottom if enough space, otherwise use position with more space
    if (spaceBelow >= minSpaceNeeded) {
      finalPosition = "bottom";
    } else if (spaceAbove >= minSpaceNeeded) {
      finalPosition = "top";
    } else {
      // Choose side with more space
      finalPosition = spaceAbove > spaceBelow ? "top" : "bottom";
    }
  }

  // Set vertical position based on final decision
  if (finalPosition === "top") {
    container.style.bottom = `${viewport.height - rect.top + 8}px`;
    container.classList.add("bt-popup-top");
  } else {
    container.style.top = `${rect.bottom + 8}px`;
    container.classList.add("bt-popup-bottom");
  }

  // Add to DOM first to get dimensions
  document.body.appendChild(container);

  // Get container dimensions and adjust position if needed
  const containerRect = container.getBoundingClientRect();

  // Ensure container stays within viewport bounds
  if (
    finalPosition === "bottom" &&
    containerRect.bottom > viewport.height - 10
  ) {
    // If bottom position causes overflow, try top position
    if (rect.top - containerRect.height - 8 >= 10) {
      container.style.top = "";
      container.style.bottom = `${viewport.height - rect.top + 8}px`;
      container.classList.remove("bt-popup-bottom");
      container.classList.add("bt-popup-top");
    } else {
      // Adjust to fit within viewport
      container.style.top = `${Math.max(10, viewport.height - containerRect.height - 10)}px`;
    }
  } else if (finalPosition === "top" && containerRect.top < 10) {
    // If top position causes overflow, try bottom position
    if (rect.bottom + containerRect.height + 8 <= viewport.height - 10) {
      container.style.bottom = "";
      container.style.top = `${rect.bottom + 8}px`;
      container.classList.remove("bt-popup-top");
      container.classList.add("bt-popup-bottom");
    } else {
      // Adjust to fit within viewport
      container.style.bottom = `${Math.max(10, viewport.height - containerRect.height - 10)}px`;
    }
  }

  // Remove from DOM temporarily to continue setup
  container.remove();

  let iconUrl;
  try {
    iconUrl = isExtensionContextValid()
      ? chrome.runtime.getURL("assets/icons/icon-19.png")
      : "";
  } catch (error) {
    console.log("BNTrans: Error getting icon URL:", error.message);
    iconUrl = "";
  }

  container.innerHTML = `
    <div class="bt-suggestion-content">
      ${iconUrl ? `<img src="${iconUrl}" class="bt-suggestion-icon" alt="BNTrans" />` : '<span class="bt-suggestion-icon">🔄</span>'}
      <span class="bt-suggestion-text"></span>
      <kbd class="bt-suggestion-tab-hint">Tab</kbd>
    </div>
    <div class="bt-suggestion-footer">
      <div class="bt-suggestion-provider-container"></div>
    </div>
  `;

  // Prevent clicking on the suggestion from blurring the input
  // EXCEPT for select elements (allow clicking model selector)
  container.querySelector(".bt-suggestion-text").textContent = translatedText;

  const preventBlur = (e) => {
    // Allow clicks on select elements
    if (e.target.tagName === "SELECT" || e.target.closest("select")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  container.addEventListener("mousedown", preventBlur);
  container.addEventListener("pointerdown", preventBlur);

  const providerContainer = container.querySelector(
    ".bt-suggestion-provider-container"
  );
  const providerSelect = populateProviderSelectorForSuggestion(
    providerContainer,
    settings
  );

  document.body.appendChild(container);

  return {
    element: container,
    translatedText,
    providerSelect,
    destroy: () => {
      container.remove();
    }
  };
}

function populateProviderSelectorForSuggestion(container, settings) {
  const providers = settings.providers || [];
  const activeId = settings.activeProviderId || "builtin";

  if (providers.length <= 1) {
    // Show as a label tag
    const provider = providers[0] || { name: "Chrome Built-in AI" };
    const tag = document.createElement("span");
    tag.className = "bt-model-tag";
    tag.textContent = provider.name;
    container.appendChild(tag);
    return null;
  } else {
    // Show as a select dropdown
    const label = document.createElement("span");
    label.className = "bt-suggestion-provider-label";
    label.textContent = "Model: ";

    const select = document.createElement("select");
    select.className = "bt-suggestion-provider-select";
    select.tabIndex = -1; // CRITICAL: Prevent Tab key from focusing this element

    providers.forEach((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.name;
      if (p.id === activeId) option.selected = true;
      select.appendChild(option);
    });

    container.appendChild(label);
    container.appendChild(select);

    return select;
  }
}

function setupSuggestionKeyHandlers(element, suggestion) {
  // CRITICAL: Remove any existing handler first
  if (currentKeyHandler) {
    window.removeEventListener("keydown", currentKeyHandler, true);
    window.removeEventListener("keyup", currentKeyHandler, true);
    document.removeEventListener("keydown", currentKeyHandler, true);
    document.removeEventListener("keyup", currentKeyHandler, true);
    currentKeyHandler = null;
  }

  let isApplying = false; // Prevent multiple calls

  const handleKey = (ev) => {
    // Only handle specific keys, let everything else pass through
    if (ev.key === "Tab") {
      // CRITICAL: Block ALL propagation immediately and synchronously
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      // Legacy support
      if (ev.returnValue !== undefined) {
        ev.returnValue = false;
      }

      // Only process on keydown, just block keyup
      if (ev.type === "keyup") return false;

      // Prevent multiple calls
      if (isApplying) return false;

      // Apply translation (async, but we don't await in event handler)
      applyTranslation();
      return false;
    }

    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      if (ev.type === "keyup") return false;
      dismiss();
      return false;
    }

    if (ev.key === "Backspace" || ev.key === "Delete") {
      if (ev.type === "keyup") return;
      dismiss();
      return;
    }
  };

  const applyTranslation = async () => {
    // Prevent re-entry
    if (isApplying) return;
    isApplying = true;

    // Commit IME composition before applying translation and wait for completion
    await commitIMEComposition(element);

    // Cleanup FIRST to prevent any interference
    window.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keyup", handleKey, true);
    currentKeyHandler = null;

    // Set flag to prevent instant translate from re-triggering
    justAppliedTranslation = true;

    // Apply translation IMMEDIATELY with Lexical-compatible method
    setFieldText(element, suggestion.translatedText, {
      snapshot: suggestion.snapshot
    });

    // Destroy popup after a tiny delay to ensure insertion completes
    setTimeout(() => {
      if (suggestion) {
        suggestion.destroy();
      }
      currentSuggestion = null;
    }, 50);

    // Clear flag after a short delay
    setTimeout(() => {
      justAppliedTranslation = false;
    }, 500);
  };

  const dismiss = () => {
    window.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keyup", handleKey, true);
    currentKeyHandler = null;
    suggestion.destroy();
    currentSuggestion = null;
  };

  // Store reference and add listeners at MULTIPLE levels with CAPTURE
  // This ensures we catch the event before Facebook's handlers
  currentKeyHandler = handleKey;

  // Add at both window and document level for maximum coverage
  window.addEventListener("keydown", handleKey, true);
  window.addEventListener("keyup", handleKey, true);
  document.addEventListener("keydown", handleKey, true);
  document.addEventListener("keyup", handleKey, true);
}

// Commit IME composition by blur/focus
// This is needed for macOS IME (Vietnamese, Chinese, Japanese, etc.)
// to ensure the underline is removed before showing the translation popup
async function commitIMEComposition(element) {
  if (!isIMEComposing) return;

  try {
    // Blur triggers browser to fire compositionend event and commit IME
    element.blur();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Re-focus to keep input active
    element.focus();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } catch (err) {
    console.error("Error committing IME composition:", err);
  }
}

async function handleInstantTranslate(element) {
  // Skip if we just applied a translation
  if (justAppliedTranslation) return;
  const snapshot = captureEditableSnapshot(element);
  if (!snapshot) return;

  const text = element.value?.trim() || element.innerText?.trim();
  if (!shouldTriggerInstant(text)) return;

  let settings;
  try {
    settings = await getSettings();
  } catch {
    return; // Silently fail if settings unavailable
  }

  const domainConfig = isInstantDomain(settings);
  if (
    !domainConfig ||
    settings.enabled === false ||
    !isEditableSnapshotCurrent(snapshot)
  )
    return;

  // Clear existing timer
  if (instantTimer) {
    clearTimeout(instantTimer);
    instantTimer = null;
  }

  // Dismiss existing suggestion
  if (currentSuggestion) {
    currentSuggestion.destroy();
    currentSuggestion = null;
  }

  // Start new timer
  instantTimer = setTimeout(async () => {
    try {
      // Commit IME composition before translation
      await commitIMEComposition(element);
      if (
        !isEditableSnapshotCurrent(snapshot) ||
        getActiveEditableElement() !== element
      )
        return;

      // Get fresh text after IME composition is committed
      const freshText = element.value?.trim() || element.innerText?.trim();
      if (!shouldTriggerInstant(freshText)) return;

      // Only show loading for non-builtin models
      if (settings.activeProviderId !== "builtin") {
        showToast(i18n.t("toast.translating"));
      }

      const res = await requestTranslation({
        text: freshText,
        nativeLanguageCode: settings.nativeLanguageCode || "en",
        targetLanguage: settings.targetLanguageCode || "en",
        sourceLanguage: settings.nativeLanguageCode || "en", // Always translate from native language
        useAutoDetect: false, // Never auto-detect for instant (always Native→Target)
        skipHistory: true // Instant fires per pause — too noisy for history
      });

      if (res?.ok && res.result?.translation) {
        if (
          !isEditableSnapshotCurrent(snapshot) ||
          getActiveEditableElement() !== element
        )
          return;
        // Use 'auto' by default for smart positioning
        const position = domainConfig.position || "auto";
        const providerInfo = `${res.result.providerName || "AI"} (${res.result.providerType || "Bot"})`;
        currentSuggestion = buildInlineSuggestion(
          element,
          res.result.translation,
          providerInfo,
          position,
          settings
        );
        currentSuggestion.snapshot = snapshot;
        setupSuggestionKeyHandlers(element, currentSuggestion);

        // Handle provider change
        if (currentSuggestion.providerSelect) {
          currentSuggestion.providerSelect.addEventListener("change", (e) => {
            reTranslateSuggestion(element, freshText, e.target.value, settings);
          });
        }
      } else {
        // Show error toast when translation fails
        showToast(res?.error || i18n.t("toast.translationFailed"));
      }
    } catch (err) {
      console.error("Instant translate error:", err);
      showToast(i18n.t("toast.translationFailed"));
    }
  }, settings.instantDelay || 3000);
}

async function reTranslateSuggestion(element, text, providerId, settings) {
  if (!currentSuggestion) return;
  const suggestion = currentSuggestion;
  if (!isEditableSnapshotCurrent(suggestion.snapshot)) {
    suggestion.destroy();
    currentSuggestion = null;
    return;
  }
  const snapshot = captureEditableSnapshot(element);
  suggestion.snapshot = snapshot;

  const textEl = currentSuggestion.element.querySelector(".bt-suggestion-text");
  if (textEl) {
    textEl.textContent = i18n.t("dialog.translating");
    textEl.classList.add("bt-loading-text");
  }

  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: settings.nativeLanguageCode || "en",
      targetLanguage: settings.targetLanguageCode || "es",
      useAutoDetect: settings.useAutoDetect === true,
      providerId: providerId
    });

    if (res?.ok && res.result?.translation) {
      if (
        currentSuggestion !== suggestion ||
        !isEditableSnapshotCurrent(snapshot)
      )
        return;
      if (textEl) {
        textEl.textContent = res.result.translation;
        textEl.classList.remove("bt-loading-text");
      }
      suggestion.translatedText = res.result.translation;
    }
  } catch (err) {
    console.error("Re-translation error:", err);
    if (textEl) {
      textEl.textContent = "Error: " + err.message;
      textEl.classList.remove("bt-loading-text");
    }
  }
}

// --- Dual subtitles (YouTube) ----------------------------------------------
// Appends a translated line under each caption segment when enabled.
// The injected span is excluded when computing the segment's source text so
// MutationObserver feedback does not retrigger translation.
function registerDualSubtitles() {
  if (
    location.hostname !== "youtube.com" &&
    !location.hostname.endsWith(".youtube.com")
  )
    return;

  const SUB_CLASS = "bntrans-sub-translation";
  let processed = new WeakMap();
  let settings = null;
  let observer = null;
  let generation = 0;

  function segmentSourceText(seg) {
    return [...seg.childNodes]
      .filter((n) => !(n.nodeType === 1 && n.classList.contains(SUB_CLASS)))
      .map((n) => n.textContent)
      .join("")
      .trim();
  }

  async function translateSegment(seg) {
    if (
      !settings?.dualSubtitlesEnabled ||
      globalThis.BNTransMedia?.active ||
      !seg.isConnected
    )
      return;
    const text = segmentSourceText(seg);
    if (!text || processed.get(seg) === text) return;
    processed.set(seg, text);

    seg.querySelectorAll(`.${SUB_CLASS}`).forEach((n) => n.remove());
    const token = generation;
    try {
      const res = await requestTranslation({
        text,
        sourceLanguage: settings.targetLanguageCode || "auto",
        targetLanguage: settings.nativeLanguageCode || "vi",
        skipHistory: true,
        siteUrl: location.href
      });
      if (!res?.ok || !res.result?.translation) return;
      // Cue may have advanced while translating — bail if stale
      if (
        token !== generation ||
        !settings?.dualSubtitlesEnabled ||
        !seg.isConnected ||
        segmentSourceText(seg) !== text
      )
        return;
      const sub = document.createElement("span");
      sub.className = SUB_CLASS;
      sub.style.cssText =
        "display:block;color:#a5f3fc;font-size:0.85em;line-height:1.3;";
      sub.textContent = String(res.result.translation).replace(/<[^>]+>/g, "");
      seg.appendChild(sub);
    } catch {
      /* single cue failure is fine */
    }
  }

  function scanCaptions(root) {
    if (root.nodeType !== 1) return;
    if (root.matches?.(".ytp-caption-segment")) translateSegment(root);
    root.querySelectorAll?.(".ytp-caption-segment").forEach(translateSegment);
  }

  function configure(s) {
    generation++;
    observer?.disconnect();
    observer = null;
    processed = new WeakMap();
    settings = s || {};
    document.querySelectorAll(`.${SUB_CLASS}`).forEach((node) => node.remove());
    if (!settings.dualSubtitlesEnabled || globalThis.BNTransMedia?.active)
      return;
    observer = new MutationObserver((mutations) => {
      const segments = new Set();
      for (const m of mutations) {
        const target =
          m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (target?.closest?.(`.${SUB_CLASS}`)) continue;
        const segment = target?.closest?.(".ytp-caption-segment");
        if (segment) segments.add(segment);
        for (const node of m.addedNodes || []) {
          if (node.nodeType === 1 && !node.classList.contains(SUB_CLASS)) {
            if (node.matches?.(".ytp-caption-segment")) segments.add(node);
            node
              .querySelectorAll?.(".ytp-caption-segment")
              .forEach((seg) => segments.add(seg));
          }
        }
      }
      segments.forEach(translateSegment);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    scanCaptions(document.body);
  }
  const initialGeneration = generation;
  getSettings()
    .then((s) => {
      if (generation === initialGeneration) configure(s);
    })
    .catch(() => {});
  const onSettings = (changes, namespace) => {
    if (namespace !== "local" || !changes.translatorSettings) return;
    const next = changes.translatorSettings.newValue || {};
    if (
      next.dualSubtitlesEnabled !== settings?.dualSubtitlesEnabled ||
      next.nativeLanguageCode !== settings?.nativeLanguageCode ||
      next.targetLanguageCode !== settings?.targetLanguageCode
    )
      configure(next);
  };
  chrome.storage.onChanged.addListener(onSettings);
  const onMediaState = () => {
    if (settings) configure(settings);
  };
  document.addEventListener("bntrans-media-state", onMediaState);
  window.addEventListener(
    "pagehide",
    () => {
      configure({});
      chrome.storage.onChanged.removeListener(onSettings);
      document.removeEventListener("bntrans-media-state", onMediaState);
    },
    { once: true }
  );
}

function registerInstantMode() {
  // Listen for input changes
  document.addEventListener(
    "input",
    async () => {
      const element = getActiveEditableElement();
      if (!element) return;

      // Don't interfere with manual mode
      if (isTranslating) return;

      // Check if manual command is being typed
      const text = element.value?.trim() || element.innerText?.trim();
      if (TRANSLATION_COMMAND_PATTERN.test(text)) return;

      handleInstantTranslate(element);
    },
    true
  );

  // Track IME composition state for proper handling
  document.addEventListener(
    "compositionstart",
    () => {
      isIMEComposing = true;
    },
    true
  );

  document.addEventListener(
    "compositionend",
    () => {
      isIMEComposing = false;
    },
    true
  );

  // Handle click outside to close suggestion
  document.addEventListener("mousedown", (e) => {
    if (currentSuggestion) {
      const isInsideInput = e.target === getActiveEditableElement();
      const isInsideSuggestion = currentSuggestion.element.contains(e.target);

      if (!isInsideInput && !isInsideSuggestion) {
        // Cleanup key handler if it exists
        if (currentKeyHandler) {
          document.removeEventListener("keydown", currentKeyHandler, true);
          currentKeyHandler = null;
        }

        currentSuggestion.destroy();
        currentSuggestion = null;
      }
    }
  });

  // Listen for Enter key to cancel instant translate
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter") {
        // User wants to send message immediately, cancel any pending translation
        if (instantTimer) {
          clearTimeout(instantTimer);
          instantTimer = null;
        }

        // Dismiss any visible suggestion
        if (currentSuggestion) {
          currentSuggestion.destroy();
          currentSuggestion = null;
        }

        // Remove keyboard handler if active
        if (currentKeyHandler) {
          document.removeEventListener("keydown", currentKeyHandler, true);
          currentKeyHandler = null;
        }
      }
    },
    true
  );
}

// ============================================
// INSTANT TOGGLE SHORTCUT
// ============================================

async function toggleInstantDomainForCurrentUrl() {
  try {
    const settings = await getSettings();
    const currentUrl = window.location.href;

    // If global setting is disabled, enable it and FORCE enable the domain
    if (!settings.instantDomains) {
      settings.instantDomains = [];
    }

    // Find matching domain
    const matchingDomainIndex = settings.instantDomains.findIndex((d) =>
      currentUrl.includes(d.domain)
    );

    if (!settings.instantTranslateEnabled) {
      settings.instantTranslateEnabled = true;

      if (matchingDomainIndex !== -1) {
        // Force enable if it exists
        settings.instantDomains[matchingDomainIndex].enabled = true;
      }
      // If it doesn't exist, it will be added below
    } else if (matchingDomainIndex !== -1) {
      // Global is already on, so we just toggle the domain
      settings.instantDomains[matchingDomainIndex].enabled =
        !settings.instantDomains[matchingDomainIndex].enabled;
    }

    if (matchingDomainIndex === -1) {
      // Current domain not in list - AUTO-ADD IT!
      const domain = extractDomainFromUrl(currentUrl);

      // Add to list with enabled: true, position: 'auto'
      settings.instantDomains.push({
        domain: domain,
        enabled: true,
        position: "auto"
      });

      // Save settings
      try {
        await safeRuntimeCall(() =>
          chrome.runtime.sendMessage({
            type: "set-settings",
            settings: { instantDomains: settings.instantDomains }
          })
        );
      } catch (error) {
        console.log("BNTrans: Error saving settings:", error.message);
        return;
      }

      // Show success toast
      const enabledText =
        i18n.t("toast.instantEnabled") || "⚡ Instant translate enabled";
      const forText = i18n.t("toast.for") || "for";
      showToastBottomRight(`${enabledText} ${forText} ${domain}`);
      return;
    }

    // Get the domain object (it definitely exists now)
    const domain = settings.instantDomains[matchingDomainIndex];

    // Update settings
    try {
      await safeRuntimeCall(() =>
        chrome.runtime.sendMessage({
          type: "set-settings",
          settings: { instantDomains: settings.instantDomains }
        })
      );
    } catch (error) {
      console.log("BNTrans: Error updating settings:", error.message);
      return;
    }

    // Show toast notification with domain name
    const status = domain.enabled
      ? i18n.t("toast.instantEnabled") || "⚡ Instant translate enabled"
      : i18n.t("toast.instantDisabled") || "Instant translate disabled";

    const forText = i18n.t("toast.for") || "for";
    showToastBottomRight(`${status} ${forText} ${domain.domain}`);

    // Clear any pending instant translation when disabling
    if (!domain.enabled && instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }

    // Dismiss current suggestion when disabling
    if (!domain.enabled && currentSuggestion) {
      currentSuggestion.destroy();
      currentSuggestion = null;
    }
  } catch (err) {
    console.error("Toggle instant domain error:", err);
    showToast(i18n.t("toast.error") || "Error toggling instant domain");
  }
}

function extractDomainFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return window.location.hostname;
  }
}

// Alias: showToastBottomRight cũng sử dụng style modern
function showToastBottomRight(message) {
  showToast(message);
}

function registerInstantToggleShortcut() {
  document.addEventListener(
    "keydown",
    async (e) => {
      const settings = await getSettings();
      const shortcut = settings.instantToggleShortcut || {
        key: "I",
        ctrl: true,
        shift: true,
        alt: false
      };

      // Check if shortcut matches
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;

      const matches =
        e.key.toUpperCase() === shortcut.key.toUpperCase() &&
        modifierKey === shortcut.ctrl &&
        e.shiftKey === shortcut.shift &&
        e.altKey === shortcut.alt;

      if (matches) {
        e.preventDefault();
        e.stopPropagation();
        await toggleInstantDomainForCurrentUrl();
      }
    },
    true
  );
}

// ============================================
// INSTANT LABEL INDICATOR
// ============================================

function registerInstantLabelIndicator() {
  // Create label element
  const label = document.createElement("div");
  let iconUrl;
  try {
    iconUrl = isExtensionContextValid()
      ? chrome.runtime.getURL("assets/icons/icon-19.png")
      : "";
  } catch (error) {
    console.log("BNTrans: Error getting icon URL for label:", error.message);
    iconUrl = "";
  }
  const labelText = document.createElement("span");

  // Create img element or fallback
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "BNTrans";
    img.style.cssText = "width: 14px; height: 14px; flex-shrink: 0;";
    label.appendChild(img);
  } else {
    const fallbackIcon = document.createElement("span");
    fallbackIcon.textContent = "⚡";
    fallbackIcon.style.cssText =
      "width: 14px; height: 14px; flex-shrink: 0; display: inline-block; text-align: center;";
    label.appendChild(fallbackIcon);
  }
  label.appendChild(labelText);

  label.style.cssText = `
    position: fixed;
    background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
    color: white;
    padding: 3px 6px;
    border-radius: 5px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    font-weight: 500;
    z-index: 9999999;
    pointer-events: none;
    display: none;
    align-items: center;
    gap: 3px;
    box-shadow: 0 2px 8px rgba(14, 165, 233, 0.25), 0 1px 3px rgba(0, 0, 0, 0.1);
    white-space: nowrap;
    backdrop-filter: blur(6px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    opacity: 0.88;
    animation: labelFadeIn 0.3s ease-out;
  `;

  document.body.appendChild(label);

  let currentSettings = null;
  let labelTimeout = null;

  // Load initial settings
  getSettings().then((s) => {
    currentSettings = s;
  });

  // Update settings when they change
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.translatorSettings) {
      currentSettings = changes.translatorSettings.newValue;
    }
  });

  // Check if instant is enabled for current domain
  function isInstantEnabledForCurrentDomain() {
    if (!currentSettings || !currentSettings.instantTranslateEnabled) {
      return false;
    }

    const currentUrl = window.location.href;
    const matchingDomain = currentSettings.instantDomains.find(
      (d) => d.enabled && currentUrl.includes(d.domain)
    );

    return !!matchingDomain;
  }

  // Hide label function
  function hideLabel() {
    if (labelTimeout) {
      clearTimeout(labelTimeout);
    }
    label.style.transition = "opacity 0.3s ease-out";
    label.style.opacity = "0";
    setTimeout(() => {
      label.style.display = "none";
      label.style.transition = "none";
      label.style.opacity = "0.88";
    }, 300);
  }

  // Show label once on focus
  function handleInputFocus(e) {
    if (!isEditableElement(e.target) || !isInstantEnabledForCurrentDomain()) {
      return;
    }

    // Clear any existing timeout
    if (labelTimeout) {
      clearTimeout(labelTimeout);
    }

    // Get input position - align left
    const rect = e.target.getBoundingClientRect();
    const offsetY = rect.top - 35; // Position above input
    const offsetX = rect.left; // Align left with input

    // Update label text with i18n
    labelText.textContent = i18n.t("label.instant") || "Instant";

    // Show label
    label.style.left = `${offsetX}px`;
    label.style.top = `${offsetY}px`;
    label.style.display = "flex";
    label.style.opacity = "0.88";
    label.style.transition = "none";

    // Auto-hide after 3.5 seconds
    labelTimeout = setTimeout(() => {
      hideLabel();
    }, 3500);

    // Hide on blur
    const handleBlur = () => {
      hideLabel();
      e.target.removeEventListener("blur", handleBlur);
    };
    e.target.addEventListener("blur", handleBlur);
  }

  // Add focus listener on document (capture phase)
  document.addEventListener("focus", handleInputFocus, true);
}

// ============================================
// SELECT-TO-TRANSLATE MODE
// ============================================

function showTranslateIcon(x, y, selection) {
  hideTranslateIcon();

  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log(
      "BNTrans: Extension context invalidated, skipping icon creation"
    );
    return;
  }

  try {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    const icon = document.createElement("div");
    icon.className = "bt-translate-icon bt-vars-container";
    applyThemeTo(icon);

    // Use extension icon instead of SVG
    let iconUrl;
    try {
      iconUrl = isExtensionContextValid()
        ? chrome.runtime.getURL("assets/icons/icon-32.png")
        : "";
    } catch (error) {
      console.log(
        "BNTrans: Error getting icon URL for translate icon:",
        error.message
      );
      iconUrl = "";
    }

    if (iconUrl) {
      icon.innerHTML = `<img src="${iconUrl}" width="24" height="24" alt="Translate" />`;
    } else {
      icon.innerHTML = `<span style="font-size: 24px; width: 24px; height: 24px; display: inline-block; text-align: center;">🔄</span>`;
    }

    icon.style.position = "fixed";
    icon.style.zIndex = "9999999999";

    // Position near cursor - choose top or bottom based on viewport
    const viewport = getAvailableViewport();
    const spaceBelow = viewport.height - y;
    const spaceAbove = y;

    // If more space below, show below cursor; otherwise show above
    if (spaceBelow > 200 || spaceBelow > spaceAbove) {
      icon.style.left = `${x - 20}px`;
      icon.style.top = `${y + 12}px`;
      icon.dataset.position = "bottom";
    } else {
      icon.style.left = `${x - 20}px`;
      icon.style.top = `${y - 48}px`;
      icon.dataset.position = "top";
    }

    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      // Pass selection rect instead of icon rect for better positioning
      showTranslationPopup(rect, selectedText, icon.dataset.position);
    });

    document.body.appendChild(icon);
    selectionIcon = icon;
  } catch (error) {
    console.log("BNTrans: Error creating translate icon:", error.message);
    // Extension context might be invalidated, clean up
    if (error.message.includes("Extension context invalidated")) {
      cleanupExtensionElements();
    }
  }
}

function hideTranslateIcon() {
  if (selectionIcon) {
    selectionIcon.remove();
    selectionIcon = null;
  }
}

// Helper function to get actual available viewport considering panels/devtools
function getAvailableViewport() {
  // Get the document's visible area
  const documentElement = document.documentElement;
  const body = document.body;

  // Calculate actual available space
  // Use document.documentElement.clientWidth/Height which excludes scrollbars
  // and is more accurate for content positioning
  const availableWidth = Math.min(
    window.innerWidth,
    documentElement.clientWidth,
    body ? body.clientWidth : window.innerWidth
  );

  const availableHeight = Math.min(
    window.innerHeight,
    documentElement.clientHeight,
    body ? body.clientHeight : window.innerHeight
  );

  // Also consider if there are any fixed elements that might reduce available space
  // Check for common panel/sidebar patterns
  const rightPanels = document.querySelectorAll(
    '[style*="position: fixed"][style*="right: 0"], .devtools-panel, .sidebar-panel'
  );
  const leftPanels = document.querySelectorAll(
    '[style*="position: fixed"][style*="left: 0"], .left-panel'
  );

  let rightOffset = 0;
  let leftOffset = 0;

  rightPanels.forEach((panel) => {
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      rightOffset = Math.max(rightOffset, rect.width);
    }
  });

  leftPanels.forEach((panel) => {
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      leftOffset = Math.max(leftOffset, rect.width);
    }
  });

  return {
    width: Math.max(300, availableWidth - rightOffset - leftOffset), // Minimum 300px
    height: Math.max(200, availableHeight), // Minimum 200px
    leftOffset: leftOffset,
    rightOffset: rightOffset
  };
}

// Helper function to safely make chrome.runtime calls
async function safeRuntimeCall(callback) {
  if (!isExtensionContextValid()) {
    throw new Error("Extension context invalidated");
  }

  try {
    return await callback();
  } catch (error) {
    if (
      error.message.includes("Extension context invalidated") ||
      error.message.includes("Could not establish connection") ||
      error.message.includes("receiving end does not exist")
    ) {
      cleanupExtensionElements();
      throw new Error("Extension context invalidated");
    }
    throw error;
  }
}

// Helper function to clean up extension elements when context is invalidated
function cleanupExtensionElements() {
  try {
    // Remove any existing popups or icons
    if (typeof hideTranslationPopup === "function") {
      hideTranslationPopup();
    }
    if (typeof hideTranslateIcon === "function") {
      hideTranslateIcon();
    }

    // Clear current suggestion
    if (currentSuggestion) {
      try {
        currentSuggestion.destroy();
      } catch {
        // Ignore errors during cleanup
      }
      currentSuggestion = null;
    }

    // Clear timers
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }

    // Clear any global timers
    if (window.bntransCleanupTimer) {
      clearTimeout(window.bntransCleanupTimer);
      window.bntransCleanupTimer = null;
    }

    // Remove event listeners if they exist
    if (currentKeyHandler) {
      try {
        window.removeEventListener("keydown", currentKeyHandler, true);
        window.removeEventListener("keyup", currentKeyHandler, true);
        document.removeEventListener("keydown", currentKeyHandler, true);
        document.removeEventListener("keyup", currentKeyHandler, true);
      } catch {
        // Ignore errors during cleanup
      }
      currentKeyHandler = null;
    }

    // Remove any extension-created elements
    const extensionElements = document.querySelectorAll(
      ".bt-inline-suggestion, .bt-selection-popup, .bt-selection-icon, .bt-toast-notify, .bt-hover-popup"
    );
    extensionElements.forEach((el) => {
      try {
        el.remove();
      } catch {
        // Ignore errors during cleanup
      }
    });

    console.log(
      "BNTrans: Cleaned up extension elements due to context invalidation"
    );
  } catch (error) {
    // Ignore cleanup errors - we're already in an error state
    console.log("BNTrans: Error during cleanup (ignored):", error.message);
  }
}

// Helper function to check if extension context is valid
function isExtensionContextValid() {
  try {
    // Check if chrome.runtime exists and has an id
    if (!chrome || !chrome.runtime || !chrome.runtime.id) {
      return false;
    }

    // Try to access a runtime property to ensure context is truly valid
    chrome.runtime.getURL("test");
    return true;
  } catch {
    return false;
  }
}

// Helper function to ensure popup stays within viewport bounds
function ensurePopupInViewport(popup, selectionRect) {
  const rect = popup.getBoundingClientRect();
  const viewport = getAvailableViewport();

  let adjustedLeft = parseFloat(popup.style.left);
  let positionChanged = false;

  // Adjust horizontal position if popup goes off-screen
  // Consider left and right offsets from panels
  const maxRight = viewport.width + viewport.leftOffset - 10;
  const minLeft = viewport.leftOffset + 10;

  if (rect.right > maxRight) {
    adjustedLeft = maxRight - rect.width;
    popup.style.left = `${adjustedLeft}px`;
    positionChanged = true;
  }
  if (rect.left < minLeft) {
    adjustedLeft = minLeft;
    popup.style.left = `${adjustedLeft}px`;
    positionChanged = true;
  }

  // Recalculate arrow position if horizontal position changed
  if (positionChanged && selectionRect) {
    const selectionCenter = selectionRect.left + selectionRect.width / 2;
    const newArrowLeft = selectionCenter - adjustedLeft;
    // Ensure arrow stays within popup bounds (at least 20px from edges)
    const clampedArrowLeft = Math.max(
      20,
      Math.min(newArrowLeft, rect.width - 20)
    );
    popup.style.setProperty("--bt-arrow-left", `${clampedArrowLeft}px`);
  }

  // Adjust vertical position if popup goes off-screen
  if (popup.style.top && rect.bottom > viewport.height - 10) {
    // If using top positioning and popup goes below viewport
    const newTop = Math.max(10, viewport.height - rect.height - 10);
    popup.style.top = `${newTop}px`;
  }

  if (popup.style.bottom && rect.top < 10) {
    // If using bottom positioning and popup goes above viewport
    const newBottom = Math.max(10, viewport.height - rect.height - 10);
    popup.style.bottom = `${newBottom}px`;
  }
}

// Helper function to readjust popup position after content is loaded
function readjustPopupAfterContentLoad(popup, selectionRect) {
  // Wait a bit for content to render, then readjust
  setTimeout(() => {
    ensurePopupInViewport(popup, selectionRect);
  }, 100);

  // Also readjust after a longer delay to catch any async content loading
  setTimeout(() => {
    ensurePopupInViewport(popup, selectionRect);
  }, 500);
}

async function showTranslationPopup(selectionRect, text, iconPosition) {
  const selection = getSafeSelection();
  if (!selection) return;
  const selectionSource = [
    getDeepActiveElement(),
    selection.anchorNode,
    selection.focusNode
  ];
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.log("BNTrans: Extension context invalidated, cannot show popup");
    // Silent dead-clicks confuse users — tell them the page needs a refresh
    try {
      showToast(i18n.t("toast.extensionUpdated"));
    } catch {
      /* toast needs DOM only; ignore */
    }
    return;
  }

  try {
    hideTranslationPopup();

    // Fetch settings first to ensure i18n is updated
    const settings = await getSettings();

    const popup = document.createElement("div");
    popup._selectionSource = selectionSource;
    let iconUrl;
    try {
      iconUrl = isExtensionContextValid()
        ? chrome.runtime.getURL("assets/icons/icon-19.png")
        : "";
    } catch (error) {
      console.log("BNTrans: Error getting icon URL for popup:", error.message);
      iconUrl = "";
    }
    popup.className = "bt-selection-popup bt-vars-container";
    applyThemeTo(popup);
    popup.innerHTML = `
    <div class="bt-selection-header">
      <span class="bt-selection-title">
        ${iconUrl ? `<img src="${iconUrl}" width="16" height="16" alt="Translate" />` : ""}
        <span>${i18n.t("selection.title")}</span>
      </span>
      <button class="bt-selection-close">×</button>
    </div>
    <div class="bt-selection-content">
      <div class="bt-selection-original">
        <label>
          ${i18n.t("selection.original")}
          <select class="bt-selection-source-select"></select>
        </label>
        <div class="bt-selection-text-container bt-selection-content-style">
          <button class="bt-speak-btn bt-speak-source" title="Listen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path class="bt-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              <path class="bt-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
          </button>
          <div class="bt-selection-text-content"></div>
        </div>
      </div>
      <div class="bt-selection-translated">
        <label>
          ${i18n.t("selection.translate")}
          <select class="bt-selection-target-select"></select>
        </label>
        <div class="bt-selection-result-container">
          <div class="bt-selection-text-container bt-selection-content-style">
            <button class="bt-speak-btn bt-speak-target" title="Listen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path class="bt-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                <path class="bt-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
            </button>
            <div class="bt-selection-text-content bt-loading-text">${i18n.t("dialog.translating")}</div>
          </div>
          <button class="bt-selection-copy-btn" title="${i18n.t("selection.copy")}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span class="bt-copy-feedback">${i18n.t("selection.copied")}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="bt-selection-footer">
      <div class="bt-selection-provider-container">
        <!-- Provider selector or label will be injected here -->
      </div>
      <a href="#" class="bt-selection-settings">${i18n.t("selection.settings")}</a>
    </div>
  `;

    popup.style.position = "fixed";
    popup.style.zIndex = "9999999999";

    // Center popup based on SELECTION rect
    // First, add popup to DOM to get actual dimensions
    document.body.appendChild(popup);
    const tempRect = popup.getBoundingClientRect();
    const actualPopupWidth = tempRect.width;

    // Get available viewport considering panels
    const viewport = getAvailableViewport();

    popup.querySelector(
      ".bt-selection-original .bt-selection-text-content"
    ).textContent = text;

    const selectionCenter = selectionRect.left + selectionRect.width / 2;
    const left = selectionCenter - actualPopupWidth / 2;

    // Ensure popup doesn't go off-screen horizontally
    // Consider panel offsets
    const maxLeft =
      viewport.width + viewport.leftOffset - actualPopupWidth - 10;
    const minLeft = viewport.leftOffset + 10;
    const finalLeft = Math.max(minLeft, Math.min(left, maxLeft));

    // Calculate arrow position relative to popup
    // Arrow should point to selection center
    const arrowLeft = selectionCenter - finalLeft;
    popup.style.setProperty("--bt-arrow-left", `${arrowLeft}px`);

    // Vertical positioning: close to selection with overflow check
    // Get initial popup dimensions after adding to DOM
    const initialRect = popup.getBoundingClientRect();

    // Estimate final popup height (accounting for content that will be loaded)
    // Use a more conservative estimate since content will be added
    const estimatedPopupHeight = Math.max(initialRect.height, 200); // Minimum 200px for safety

    // Calculate available space above and below selection
    const spaceAbove = selectionRect.top;
    const spaceBelow = viewport.height - selectionRect.bottom;

    // Determine best position based on available space and estimated popup height
    let finalPosition = iconPosition;

    if (iconPosition === "bottom") {
      // Check if popup fits below selection with some buffer
      if (
        selectionRect.bottom + 8 + estimatedPopupHeight >
        viewport.height - 20
      ) {
        // Not enough space below, check if there's more space above
        if (
          spaceAbove > spaceBelow &&
          spaceAbove >= estimatedPopupHeight + 28
        ) {
          finalPosition = "top";
        }
      }
    } else {
      // Check if popup fits above selection with some buffer
      if (selectionRect.top - 8 - estimatedPopupHeight < 20) {
        // Not enough space above, check if there's more space below
        if (
          spaceBelow > spaceAbove &&
          spaceBelow >= estimatedPopupHeight + 28
        ) {
          finalPosition = "bottom";
        }
      }
    }

    // Apply final positioning with better calculations
    if (finalPosition === "bottom") {
      popup.style.left = `${finalLeft}px`;
      // Ensure popup doesn't go below viewport, with extra buffer
      const maxTop = viewport.height - estimatedPopupHeight - 20;
      popup.style.top = `${Math.min(selectionRect.bottom + 8, maxTop)}px`;
      popup.classList.add("bt-popup-bottom");
      popup.classList.remove("bt-popup-top");
    } else {
      popup.style.left = `${finalLeft}px`;
      // Ensure popup doesn't go above viewport, with extra buffer
      const maxBottom = viewport.height - selectionRect.top + 8;
      const minBottom = estimatedPopupHeight + 20;
      popup.style.bottom = `${Math.min(maxBottom, viewport.height - minBottom)}px`;
      popup.classList.add("bt-popup-top");
      popup.classList.remove("bt-popup-bottom");
    }
    selectionPopup = popup;

    // Store selectionRect for later use in readjustment
    popup._selectionRect = selectionRect;

    // Ensure popup stays within viewport bounds after positioning
    ensurePopupInViewport(popup, selectionRect);

    // Schedule readjustment after content loads
    readjustPopupAfterContentLoad(popup, selectionRect);

    // Final arrow position adjustment is now handled in ensurePopupInViewport

    // Make draggable
    const header = popup.querySelector(".bt-selection-header");
    makeDraggable(popup, header);

    // Hide icon when popup opens
    hideTranslateIcon();

    // Populate selectors (Mirror Logic)
    const nativeLang = settings.nativeLanguageCode || "vi";
    const targetLang = settings.targetLanguageCode || "en";

    let defaultSource, defaultTarget;

    if (!settings.useAutoDetect) {
      // Fixed direction (Mirror Logic)
      defaultSource = targetLang;
      defaultTarget = nativeLang;
    } else {
      // Auto-detect mode
      defaultSource = "auto";
      defaultTarget = targetLang;
    }

    // Override with last used selection languages if available
    if (settings.selectionLastSource) {
      defaultSource = settings.selectionLastSource;
    }
    if (settings.selectionLastTarget) {
      defaultTarget = settings.selectionLastTarget;
    }

    // Populate selectors
    populateLanguageSelector(
      popup.querySelector(".bt-selection-source-select"),
      defaultSource,
      true
    );
    populateLanguageSelector(
      popup.querySelector(".bt-selection-target-select"),
      defaultTarget,
      false
    );

    // Initial translation
    translateSelectionWithSource(
      text,
      defaultSource,
      popup,
      null,
      defaultTarget
    );

    popup.querySelector(".bt-selection-close").addEventListener("click", () => {
      hideTranslationPopup();
      hideTranslateIcon();
    });

    popup
      .querySelector(".bt-selection-source-select")
      .addEventListener("change", (e) => {
        popup._languageOverride = true;
        const providerSelect = popup.querySelector(
          ".bt-selection-provider-select"
        );
        const providerId = providerSelect ? providerSelect.value : null;
        const targetLang = popup.querySelector(
          ".bt-selection-target-select"
        ).value;

        // Save preference
        try {
          safeRuntimeCall(() =>
            chrome.runtime.sendMessage({
              type: "set-settings",
              settings: { selectionLastSource: e.target.value }
            })
          );
        } catch (error) {
          console.log(
            "BNTrans: Error saving source preference:",
            error.message
          );
        }

        translateSelectionWithSource(
          text,
          e.target.value,
          popup,
          providerId,
          targetLang
        );
      });

    popup
      .querySelector(".bt-selection-target-select")
      .addEventListener("change", (e) => {
        popup._languageOverride = true;
        const providerSelect = popup.querySelector(
          ".bt-selection-provider-select"
        );
        const providerId = providerSelect ? providerSelect.value : null;
        const sourceLang = popup.querySelector(
          ".bt-selection-source-select"
        ).value;

        // Save preference
        console.log("Saving selectionLastTarget:", e.target.value);
        try {
          safeRuntimeCall(() =>
            chrome.runtime.sendMessage({
              type: "set-settings",
              settings: { selectionLastTarget: e.target.value }
            })
          );
        } catch (error) {
          console.log(
            "BNTrans: Error saving target preference:",
            error.message
          );
        }

        translateSelectionWithSource(
          text,
          sourceLang,
          popup,
          providerId,
          e.target.value
        );
      });

    // Populate provider selector
    const providerSelect = populateProviderSelector(popup, settings);
    if (providerSelect) {
      providerSelect.addEventListener("change", (e) => {
        const sourceLang = popup.querySelector(
          ".bt-selection-source-select"
        ).value;
        const targetLang = popup.querySelector(
          ".bt-selection-target-select"
        ).value;
        translateSelectionWithSource(
          text,
          sourceLang,
          popup,
          e.target.value,
          targetLang
        );
      });
    }

    // Settings link
    popup
      .querySelector(".bt-selection-settings")
      .addEventListener("click", (e) => {
        e.preventDefault();
        try {
          safeRuntimeCall(() =>
            chrome.runtime.sendMessage({ type: "open-options" })
          );
        } catch (error) {
          console.log("BNTrans: Error opening options:", error.message);
        }
      });

    // Copy button
    const copyBtn = popup.querySelector(".bt-selection-copy-btn");
    copyBtn.addEventListener("click", async () => {
      const textToCopy = popup.querySelector(
        ".bt-selection-translated .bt-selection-text-content"
      ).textContent;
      if (!textToCopy || textToCopy === i18n.t("dialog.translating")) return;

      try {
        await navigator.clipboard.writeText(textToCopy);
        copyBtn.classList.add("bt-copied");
        setTimeout(() => copyBtn.classList.remove("bt-copied"), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    });

    // TTS Handlers
    popup
      .querySelector(".bt-speak-source")
      .addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains("bt-speak-loading")) return;

        const sourceLang = popup.querySelector(
          ".bt-selection-source-select"
        ).value;
        const textToSpeak = text; // Original text

        btn.classList.add("bt-speak-loading");
        try {
          await tts.play(
            textToSpeak,
            sourceLang === "auto" ? "en" : sourceLang
          );
        } catch (err) {
          showToast(err.message || i18n.t("popup.speechError"));
        } finally {
          btn.classList.remove("bt-speak-loading");
        }
      });

    popup
      .querySelector(".bt-speak-target")
      .addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains("bt-speak-loading")) return;

        const targetLang = popup.querySelector(
          ".bt-selection-target-select"
        ).value;
        const textToSpeak = popup.querySelector(
          ".bt-selection-translated .bt-selection-text-content"
        ).textContent;

        if (textToSpeak && textToSpeak !== i18n.t("dialog.translating")) {
          btn.classList.add("bt-speak-loading");
          try {
            await tts.play(textToSpeak, targetLang);
          } catch (err) {
            showToast(err.message || i18n.t("popup.speechError"));
          } finally {
            btn.classList.remove("bt-speak-loading");
          }
        }
      });
  } catch (error) {
    console.log("BNTrans: Error showing translation popup:", error.message);
    // Extension context might be invalidated, clean up
    if (error.message.includes("Extension context invalidated")) {
      cleanupExtensionElements();
    }
  }
}

function hideTranslationPopup() {
  if (selectionPopup) {
    selectionPopup.remove();
    selectionPopup = null;
  }
}

async function translateSelectionWithSource(
  text,
  sourceLang,
  popup,
  providerId = null,
  targetLangOverride = null
) {
  const settings = await getSettings();
  if (popup._selectionSource?.some(isSensitiveElement)) return;
  const nativeLang = settings.nativeLanguageCode || "vi";
  const targetLang = targetLangOverride || nativeLang;

  const translatedDiv = popup.querySelector(
    ".bt-selection-translated .bt-selection-text-content"
  );

  translatedDiv.textContent = i18n.t("dialog.translating");
  translatedDiv.classList.add("bt-loading-text");
  popup.querySelector(".bt-quality-warning")?.remove();

  // If source and target are the same, return original text immediately
  if (
    sourceLang !== "auto" &&
    sourceLang === targetLang &&
    (popup._languageOverride === true || !settings.websiteProfiles?.length)
  ) {
    translatedDiv.textContent = text;
    translatedDiv.classList.remove("bt-loading-text");
    // Readjust popup position after content change
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
    return;
  }

  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: nativeLang,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang, // Pass explicit source language
      languageOverride: popup._languageOverride === true,
      useAutoDetect:
        sourceLang === "auto" ? true : settings.useAutoDetect === true,
      providerId: providerId // Pass provider override
    });

    if (res?.ok && res.result?.translation) {
      translatedDiv.textContent = res.result.translation;
      translatedDiv.classList.remove("bt-loading-text");
      if (!popup._languageOverride) {
        const sourceSelect = popup.querySelector(".bt-selection-source-select");
        const targetSelect = popup.querySelector(".bt-selection-target-select");
        if (res.result.siteProfile && sourceSelect && targetSelect) {
          sourceSelect.value = res.result.sourceLanguage;
          targetSelect.value = res.result.targetLanguage;
        }
      }
      popup.querySelector(".bt-quality-warning")?.remove();
      if (res.result.qualityWarnings?.length) {
        const { qualityWarningText } = await import(
          chrome.runtime.getURL("src/common/translation-quality.js")
        );
        const warning = document.createElement("p");
        warning.className = "bt-quality-warning";
        warning.setAttribute("role", "status");
        warning.textContent = qualityWarningText(
          res.result.qualityWarnings,
          settings.interfaceLanguage
        );
        translatedDiv.after(warning);
      }
    } else {
      // Show actual error message from background/provider
      translatedDiv.textContent =
        res?.error || i18n.t("toast.translationFailed");
      translatedDiv.classList.remove("bt-loading-text");
    }

    // Readjust popup position after content is loaded
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
  } catch (err) {
    translatedDiv.textContent = "Error: " + err.message;
    translatedDiv.classList.remove("bt-loading-text");
    // Readjust popup position even on error
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
  }
}

let lastPopupCloseTime = 0;

function registerSelectionMode() {
  document.addEventListener("mouseup", (e) => {
    // Ignore if clicking on icon or popup
    if (
      e.target.closest(".bt-translate-icon") ||
      e.target.closest(".bt-selection-popup")
    ) {
      return;
    }

    // Ignore if we just closed the popup (within 200ms)
    if (Date.now() - lastPopupCloseTime < 200) {
      return;
    }

    setTimeout(() => {
      const selection = getSafeSelection();
      const text = selection?.toString().trim();

      if (text && text.length > 0) {
        // If popup is already open for this text, don't show icon
        if (selectionPopup && selectedText === text) {
          return;
        }

        selectedText = text;
        showTranslateIcon(e.clientX, e.clientY, selection);
      } else {
        hideTranslateIcon();
        // Don't hide popup here, let mousedown handle it (so we can copy text from popup)
      }
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    // 1. Handle Popup Open State
    if (selectionPopup) {
      if (!selectionPopup.contains(e.target)) {
        // Clicked outside popup
        // Prevent default to PRESERVE selection
        e.preventDefault();
        e.stopPropagation();
        hideTranslationPopup();
        lastPopupCloseTime = Date.now();
      }
      return;
    }

    // 2. Handle Icon Open State (Popup is closed)
    if (selectionIcon) {
      if (!selectionIcon.contains(e.target)) {
        // Clicked outside icon
        // Let default behavior happen (selection clears)
        hideTranslateIcon();
      }
    }
  });
}

function populateLanguageSelector(
  select,
  defaultValue = "auto",
  includeAuto = true
) {
  if (!select) return;

  const languages = includeAuto
    ? ["auto", "en", "vi", "zh", "ja", "ko", "es", "fr", "de"]
    : ["en", "vi", "zh", "ja", "ko", "es", "fr", "de"];

  languages.forEach((code) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = i18n.t("lang." + code);
    select.appendChild(option);
  });

  select.value = defaultValue;
}

function populateProviderSelector(popup, settings) {
  const container = popup.querySelector(".bt-selection-provider-container");
  const providers = settings.providers || [];
  const activeId = settings.activeProviderId || "builtin";

  if (providers.length <= 1) {
    // Show as a label tag
    const provider = providers[0] || { name: "Chrome Built-in AI" };
    const tag = document.createElement("span");
    tag.className = "bt-selection-provider-tag";
    tag.textContent = `Model: ${provider.name}`;
    container.appendChild(tag);
  } else {
    // Show as a select dropdown
    const label = document.createElement("span");
    label.className = "bt-selection-provider-label";
    label.textContent = "Model: ";

    const select = document.createElement("select");
    select.className = "bt-selection-provider-select";

    providers.forEach((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.name;
      if (p.id === activeId) option.selected = true;
      select.appendChild(option);
    });

    container.appendChild(label);
    container.appendChild(select);

    return select;
  }
  return null;
}

function makeDraggable(element, handle) {
  let pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;

  handle.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    e = e || window.event;
    // Only allow left click
    if (e.button !== 0) return;

    // Don't drag if clicking on the close button
    if (e.target.closest(".bt-selection-close")) return;

    e.preventDefault();

    // Convert bottom/right to top/left if needed for consistent math
    const rect = element.getBoundingClientRect();
    element.style.bottom = "auto";
    element.style.right = "auto";
    element.style.top = rect.top + "px";
    element.style.left = rect.left + "px";

    // Get the mouse cursor position at startup
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    // Call a function whenever the cursor moves
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    // Calculate the new cursor position
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    // Set the element's new position
    element.style.top = element.offsetTop - pos2 + "px";
    element.style.left = element.offsetLeft - pos1 + "px";

    // Remove arrow class when dragged to avoid visual artifacts
    element.classList.remove("bt-popup-top", "bt-popup-bottom");
  }

  function closeDragElement() {
    // Stop moving when mouse button is released
    document.onmouseup = null;
    document.onmousemove = null;
  }
}
// Hover translate state
let hoverModifierPressed = false;
let hoverTranslateCache = new Map();

// Translation memory: persist hover translations across sessions so repeated
// segments are free and consistent. Bounded, flushed to storage debounced.
const TM_STORAGE_KEY = "bnTransTM";
const TM_MAX_ENTRIES = 200;
let tmFlushTimer = null;

function tmSet(key, value) {
  if (hoverTranslateCache.has(key)) hoverTranslateCache.delete(key);
  hoverTranslateCache.set(key, value);
  while (hoverTranslateCache.size > TM_MAX_ENTRIES) {
    hoverTranslateCache.delete(hoverTranslateCache.keys().next().value);
  }
  if (tmFlushTimer) return;
  tmFlushTimer = setTimeout(() => {
    tmFlushTimer = null;
    try {
      chrome.storage.local.set({
        [TM_STORAGE_KEY]: Array.from(hoverTranslateCache.entries())
      });
    } catch {
      /* extension context invalidated */
    }
  }, 2000);
}

// Facade passed to granularity handlers so their cache.set also persists
const tmCache = {
  has: (k) => hoverTranslateCache.has(k),
  get: (k) => hoverTranslateCache.get(k),
  set: (k, v) => tmSet(k, v)
};

// Hydrate the cache from storage once on load
try {
  chrome.storage.local.get(TM_STORAGE_KEY).then((data) => {
    const entries = data?.[TM_STORAGE_KEY];
    if (Array.isArray(entries)) {
      entries.forEach(([k, v]) => hoverTranslateCache.set(k, v));
    }
  });
} catch {
  /* extension context not ready */
}
let currentHoveredElement = null;
let hoverTimeout = null;
let lastMouseX = 0;
let lastMouseY = 0;

document.addEventListener(
  "mousemove",
  (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  },
  { passive: true }
);

function registerHoverTranslate() {
  // Track modifier key state
  document.addEventListener(
    "keydown",
    async (e) => {
      const settings = await getSettings();

      if (!settings.hoverTranslateEnabled) {
        return;
      }

      const isOnDomain = isHoverTranslateDomain(settings);

      if (!isOnDomain) {
        return;
      }

      const key = settings.hoverModifierKey || "ctrl";

      if (
        (key === "ctrl" && e.ctrlKey) ||
        (key === "shift" && e.shiftKey) ||
        (key === "alt" && e.altKey)
      ) {
        hoverModifierPressed = true;
        document.body.classList.add("bt-hover-translate-active");

        // Apply custom styles
        applyHoverCustomStyles(settings.hoverInjectStyle);

        // Trigger translation or toggle if already hovering over an element
        const element = document.elementFromPoint(lastMouseX, lastMouseY);
        if (element) {
          // Check if hovering over a translation or an already translated element
          const translationEl = element.closest(".bt-hover-translation");
          const originalEl = element.closest('[data-bt-translated="true"]');

          if (translationEl) {
            // Hovering over translation -> Close it

            const prev = translationEl.previousElementSibling;
            if (prev && prev.dataset.btTranslated) {
              delete prev.dataset.btTranslated;
              prev.classList.remove("bt-hover-original");
            }
            translationEl.remove();
            return;
          }

          if (originalEl) {
            // Hovering over original that is already translated -> Close it

            const next = originalEl.nextElementSibling;
            if (next && next.classList.contains("bt-hover-translation")) {
              next.remove();
            }
            delete originalEl.dataset.btTranslated;
            originalEl.classList.remove("bt-hover-original");
            return;
          }

          const translatable = findTranslatableElement(element);
          if (translatable) {
            // Unique Mode: Clear all other translations if enabled
            // Note: We also check this inside handleHoverTranslate for mouseover events
            if (settings.hoverUniqueMode !== false) {
              clearAllHoverTranslations();
            }

            handleHoverTranslate(translatable, settings);
          }
        }
      }
    },
    true
  );

  document.addEventListener(
    "keyup",
    async (e) => {
      const settings = await getSettings();
      const key = settings.hoverModifierKey || "ctrl";

      if (
        (key === "ctrl" && !e.ctrlKey) ||
        (key === "shift" && !e.shiftKey) ||
        (key === "alt" && !e.altKey)
      ) {
        hoverModifierPressed = false;
        document.body.classList.remove("bt-hover-translate-active");
        // clearAllHoverTranslations(); // Don't clear on key release
      }
    },
    true
  );

  // Hover detection with debouncing
  document.addEventListener(
    "mouseover",
    async (e) => {
      if (!hoverModifierPressed) return;

      const settings = await getSettings();
      if (!isHoverTranslateDomain(settings)) {
        return;
      }

      clearTimeout(hoverTimeout);
      const element = findTranslatableElement(e.target);

      if (!element) {
        return;
      }
      if (element === currentHoveredElement) {
        return;
      }

      currentHoveredElement = element;
      hoverTimeout = setTimeout(() => {
        handleHoverTranslate(element, settings);
      }, 200);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    () => {
      clearTimeout(hoverTimeout);
    },
    true
  );
}

/**
 * Check if element is a translation boundary (should not traverse beyond)
 * Boundaries are containers for individual messages/content blocks on chat platforms
 */
function isTranslationBoundary(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

  // Discord: message content divs have class containing 'messageContent' or ID starting with 'message-content-'
  const className = element.className || "";
  const id = element.id || "";

  // Check Discord patterns
  if (
    className.includes("messageContent") ||
    id.startsWith("message-content-")
  ) {
    return true;
  }

  // Slack: message blocks
  if (
    className.includes("p-rich_text_section") ||
    className.includes("c-message__body")
  ) {
    return true;
  }

  // Telegram Web: message bubbles
  if (
    className.includes("message-content") ||
    className.includes("text-content")
  ) {
    return true;
  }

  // Generic: data attributes that might indicate message boundaries
  if (
    element.hasAttribute("data-message-id") ||
    element.hasAttribute("data-msg-id")
  ) {
    return true;
  }

  return false;
}

/**
 * Find the nearest boundary ancestor (if any)
 */
function findBoundaryAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (isTranslationBoundary(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findTranslatableElement(target) {
  let element = target;
  let depth = 0;
  const maxDepth = 5;

  // Find boundary first - we should not traverse beyond this
  const boundary = findBoundaryAncestor(target);

  while (element && depth < maxDepth) {
    // CRITICAL: If we have a boundary, never go beyond it
    // Check if current element is at or beyond the boundary
    if (boundary) {
      // If we've reached the boundary's parent, stop and return boundary
      if (element === boundary.parentElement || !boundary.contains(element)) {
        return boundary;
      }
    }

    // Ignore our own translation elements
    if (element.classList.contains("bt-hover-translation")) return null;

    // Ignore interactive elements to avoid conflict
    if (
      ["BUTTON", "INPUT", "TEXTAREA", "SELECT", "A"].includes(element.tagName)
    ) {
      // Unless it's a link with significant text, maybe? For now, skip to avoid issues.
      // Actually, users might want to translate links. Let's allow A if it has text.
      if (element.tagName !== "A") {
        element = element.parentElement;
        depth++;
        continue;
      }
    }

    const text = element.textContent?.trim();

    if (text && text.length > 2 && text.length < 2000) {
      // Adjusted limits
      const tagName = element.tagName?.toLowerCase();
      // Block-level elements only (removed 'span', 'a', 'b', 'i' to prioritize containers)
      if (
        [
          "div",
          "p",
          "article",
          "section",
          "li",
          "td",
          "th",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "blockquote",
          "pre"
        ].includes(tagName)
      ) {
        // If this element IS the boundary, return it directly (skip container checks)
        if (boundary && element === boundary) {
          return element;
        }

        // Smart check: If it's a DIV/SECTION, ensure it's not just a container of other blocks
        // We prefer "leaf" blocks or blocks with mostly text
        if (["div", "section", "article"].includes(tagName)) {
          const childBlockCount = element.querySelectorAll(
            "div, p, section, article, li"
          ).length;
          // If it has too many block children, it's likely a container. Skip it unless it has direct text.
          if (childBlockCount > 3) {
            // Check if it has significant direct text
            const directText = Array.from(element.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent.trim())
              .join("");
            if (directText.length < 50) {
              // If this would take us beyond boundary, return boundary instead
              if (
                boundary &&
                (element.parentElement === boundary.parentElement ||
                  !boundary.contains(element.parentElement))
              ) {
                return boundary;
              }
              element = element.parentElement;
              depth++;
              continue;
            }
          }
        }

        const textNodes = Array.from(element.childNodes).filter(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );

        // Allow if it has text nodes OR is a small container
        if (textNodes.length > 0 || element.children.length <= 3) {
          // LIST PROMOTION: If we found a list item, select the whole list
          // BUT NOT if there's a boundary - in chat apps, each LI is a separate message
          if (["LI", "DT", "DD"].includes(element.tagName)) {
            // If we have a boundary ancestor, don't promote - return the boundary
            if (boundary) {
              return boundary;
            }
            return element.closest("ul, ol, dl") || element.parentElement;
          }
          return element;
        }
      }
    }

    element = element.parentElement;
    depth++;
  }

  // If we have a boundary but didn't find suitable element, return boundary
  if (boundary) {
    return boundary;
  }

  return null;
}

async function handleHoverTranslate(element, settings) {
  // Site-aware results use the background cache's effective language/style key.
  const cache = settings.websiteProfiles?.length
    ? { has: () => false, get: () => undefined, set: () => {} }
    : tmCache;
  if (
    isSensitiveElement(element) ||
    Array.from(element.querySelectorAll("input, [autocomplete]")).some(
      isSensitiveElement
    )
  )
    return;
  // Always use innerHTML to capture any potential formatting
  const text = element.innerHTML?.trim();

  if (!text) {
    return;
  }

  // Log parent element info for debugging
  console.log(
    "[Hover] Target:",
    element.tagName,
    "Granularity:",
    settings.hoverTranslateGranularity || "line"
  );

  // Get granularity setting (default: 'line')
  const granularity = settings.hoverTranslateGranularity || "line";

  // Unique Mode Check (Fix: Moved inside handler to catch mouseover events)
  if (settings.hoverUniqueMode !== false) {
    clearAllHoverTranslations();
  }

  // Route to appropriate translation method based on granularity
  if (granularity === "line") {
    return handleLineByLineTranslate(
      element,
      text,
      settings,
      createHoverPlaceholder,
      updateHoverContent,
      requestTranslation,
      cache,
      clearAllHoverTranslations
    );
  } else if (granularity === "sentence") {
    return handleSentenceBySentenceTranslate(
      element,
      text,
      settings,
      createHoverPlaceholder,
      updateHoverContent,
      requestTranslation,
      cache,
      clearAllHoverTranslations
    );
  }

  // Default: Block mode (existing behavior)
  // Create placeholder immediately
  const placeholder = createHoverPlaceholder(element, settings);

  // Include providerId in cache key to support provider switching
  const cacheKey = `${text}-${settings.nativeLanguageCode}-${settings.activeProviderId}`;
  if (cache.has(cacheKey)) {
    updateHoverContent(placeholder, cache.get(cacheKey), settings);
    return;
  }

  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: settings.nativeLanguageCode || "en",
      targetLanguage: settings.nativeLanguageCode || "vi", // Translate TO native language
      sourceLanguage: settings.targetLanguageCode || "en", // FROM target language (e.g., English web content)
      useAutoDetect: false, // Fixed Target→Native for hover
      skipHistory: true // Hover fires per hover — too noisy for history
    });

    if (res?.ok && res.result?.translation) {
      const translation = res.result.translation;
      cache.set(cacheKey, translation);
      updateHoverContent(placeholder, translation, settings);
    } else {
      // Show error inline instead of removing
      updateHoverContent(
        placeholder,
        `❌ ${res?.error || "Translation failed"}`,
        settings,
        true
      );
    }
  } catch (err) {
    // Show error inline instead of removing
    updateHoverContent(
      placeholder,
      `❌ ${err.message || "Error"}`,
      settings,
      true
    );
  }
}

function createHoverPlaceholder(element, settings) {
  // Check if already exists
  let existing = element.nextElementSibling;
  if (existing && existing.classList.contains("bt-hover-translation")) {
    return existing;
  }

  // Create element of the same tag to mimic structure
  const translationEl = document.createElement(element.tagName);
  translationEl.className = "bt-hover-translation";

  // Copy styles from original element to look like a clone
  const computedStyle = window.getComputedStyle(element);

  // Copy text styles
  translationEl.style.fontFamily = computedStyle.fontFamily;
  translationEl.style.fontSize =
    settings.hoverInjectStyle?.fontSize || computedStyle.fontSize;
  translationEl.style.fontWeight = computedStyle.fontWeight;
  translationEl.style.fontStyle = computedStyle.fontStyle;
  translationEl.style.lineHeight = computedStyle.lineHeight;
  translationEl.style.textAlign = computedStyle.textAlign;
  translationEl.style.letterSpacing = computedStyle.letterSpacing;

  // Color Logic:
  // Always transparent background.
  // Use user's textColor (default Red #ff0000).
  translationEl.style.backgroundColor = "transparent";
  translationEl.style.color = settings.hoverInjectStyle?.textColor || "#ff0000";

  // Copy layout styles
  translationEl.style.padding = computedStyle.padding;
  translationEl.style.margin = computedStyle.margin;
  translationEl.style.marginTop = "4px"; // Add slight separation
  translationEl.style.width =
    computedStyle.width !== "auto" ? computedStyle.width : "100%";
  translationEl.style.boxSizing = "border-box";

  // Ensure block display for proper positioning below
  translationEl.style.display = "block";

  const style = settings.hoverInjectStyle || {};
  if (style.underline) {
    translationEl.classList.add("bt-hover-underline");
  }

  // Add BNTrans Icon at start (if enabled)
  if (style.showIcon !== false) {
    let iconSrc;
    try {
      iconSrc = isExtensionContextValid()
        ? chrome.runtime.getURL("assets/icons/icon-19.png")
        : "";
    } catch (error) {
      console.log("BNTrans: Error getting icon URL for hover:", error.message);
      iconSrc = "";
    }

    if (iconSrc) {
      const icon = document.createElement("img");
      icon.src = iconSrc; // Use small icon
      icon.className = "bt-hover-icon";
      icon.style.width = "14px";
      icon.style.height = "14px";
      icon.style.verticalAlign = "middle";
      icon.style.marginRight = "6px";
      icon.style.display = "inline-block";
      translationEl.appendChild(icon);
    } else {
      const fallbackIcon = document.createElement("span");
      fallbackIcon.textContent = "🔄";
      fallbackIcon.className = "bt-hover-icon";
      fallbackIcon.style.width = "14px";
      fallbackIcon.style.height = "14px";
      fallbackIcon.style.verticalAlign = "middle";
      fallbackIcon.style.marginRight = "6px";
      fallbackIcon.style.display = "inline-block";
      fallbackIcon.style.fontSize = "12px";
      translationEl.appendChild(fallbackIcon);
    }
  }

  // Add modern CSS spinner instead of GIF
  const loadingSpinner = document.createElement("span");
  loadingSpinner.className = "bt-spinner";
  translationEl.appendChild(loadingSpinner);

  translationEl.dataset.btInjected = "true";

  // Ensure original element handles the insertion correctly
  // if (computedStyle.display === 'inline') {
  //   element.style.display = 'inline-block';
  // }

  element.insertAdjacentElement("afterend", translationEl);
  // element.classList.add('bt-hover-original'); // Keep natural

  return translationEl;
}

function appendSafeTranslation(container, translation) {
  const template = document.createElement("template");
  template.innerHTML = String(translation);
  const allowed = new Set([
    "B",
    "STRONG",
    "I",
    "EM",
    "U",
    "S",
    "BR",
    "P",
    "UL",
    "OL",
    "LI",
    "SPAN",
    "CODE",
    "PRE",
    "A"
  ]);
  const blocked = new Set([
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "SVG",
    "MATH",
    "TEMPLATE"
  ]);
  const append = (parent, node) => {
    if (node.nodeType === 3) {
      parent.appendChild(document.createTextNode(node.textContent));
      return;
    }
    if (node.nodeType !== 1 || blocked.has(node.tagName)) return;
    const output = allowed.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase())
      : document.createDocumentFragment();
    if (node.tagName === "A") {
      try {
        const url = new URL(node.getAttribute("href"));
        if (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        ) {
          output.href = url.href;
          output.target = "_blank";
          output.rel = "noopener noreferrer";
        }
      } catch {
        // Invalid or relative URLs stay inert.
      }
    }
    for (const child of node.childNodes) append(output, child);
    parent.appendChild(output);
  };
  for (const node of template.content.childNodes) append(container, node);
}

function updateHoverContent(element, translation, settings, isError = false) {
  // Keep the BNTrans icon
  const icon = element.querySelector(".bt-hover-icon");

  element.innerHTML = ""; // Clear content
  if (icon) element.appendChild(icon);

  // Provider formatting is limited to inert text tags and HTTP(S) links.
  const textSpan = document.createElement("span");
  appendSafeTranslation(textSpan, translation);
  element.appendChild(textSpan);

  // Apply error styling if needed
  if (isError) {
    element.style.color = "#dc3545"; // text-danger red
    element.style.fontWeight = "bold";
  }

  // Model Label removed as per user request
}

function replaceTextContent(element, newText) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  if (textNodes.length > 0) {
    textNodes[0].textContent = newText;
    textNodes.slice(1).forEach((node) => node.remove());
  }
}

function clearAllHoverTranslations() {
  // 1. Remove standard block translations
  document
    .querySelectorAll(".bt-hover-translation")
    .forEach((el) => el.remove());

  // 2. Remove node-based injected content (Legacy)
  document
    .querySelectorAll(".bt-injected-content")
    .forEach((el) => el.remove());

  // 3. Cleanup Wrappers (Unwrap)
  document.querySelectorAll("[data-bntrans-wrapper]").forEach((wrapper) => {
    const originalSpan = wrapper.querySelector("[data-bntrans-original]");
    if (originalSpan) {
      // Move original text nodes back to parent
      while (originalSpan.firstChild) {
        wrapper.parentNode.insertBefore(originalSpan.firstChild, wrapper);
      }
    }
    wrapper.remove();
  });

  // 4. Cleanup original elements (Block mode replace)
  document.querySelectorAll("[data-bt-original]").forEach((el) => {
    replaceTextContent(el, el.dataset.btOriginal);
    delete el.dataset.btOriginal;
    delete el.dataset.btTranslated;
    el.classList.remove("bt-hover-translated");
  });

  // 5. Cleanup granular mode markers
  document.querySelectorAll("[data-bntrans-translated]").forEach((el) => {
    el.removeAttribute("data-bntrans-translated");
    el.classList.remove("bt-hover-translated");
  });

  currentHoveredElement = null;
}

function isHoverTranslateDomain(settings) {
  if (!settings.hoverTranslateEnabled) return false;
  if (
    !settings.hoverTranslateDomains ||
    settings.hoverTranslateDomains.length === 0
  )
    return false;

  const currentUrl = window.location.href;
  return settings.hoverTranslateDomains.some(
    (d) => d.enabled && currentUrl.includes(d.domain)
  );
}

function applyHoverCustomStyles(style) {
  const root = document.documentElement;
  root.style.setProperty(
    "--bt-hover-bg-color",
    style.backgroundColor || "#667eea"
  );
  root.style.setProperty("--bt-hover-text-color", style.textColor || "#ffffff");
  root.style.setProperty("--bt-hover-font-size", style.fontSize || "0.95em");
  root.style.setProperty(
    "--bt-hover-show-icon",
    style.showIcon !== false ? "inline" : "none"
  );
}

function registerHoverToggleShortcut() {
  document.addEventListener(
    "keydown",
    async (e) => {
      const settings = await getSettings();
      const shortcut = settings.hoverToggleShortcut || {
        key: "O",
        ctrl: true,
        shift: true,
        alt: false
      };

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;

      const matches =
        e.key.toUpperCase() === shortcut.key.toUpperCase() &&
        modifierKey === shortcut.ctrl &&
        e.shiftKey === shortcut.shift &&
        e.altKey === shortcut.alt;

      if (matches) {
        e.preventDefault();
        e.stopPropagation();
        await toggleHoverDomainForCurrentUrl();
      }
    },
    true
  );
}

async function toggleHoverDomainForCurrentUrl() {
  try {
    const settings = await getSettings();
    const currentUrl = window.location.href;

    if (!settings.hoverTranslateDomains) {
      settings.hoverTranslateDomains = [];
    }

    const matchingDomainIndex = settings.hoverTranslateDomains.findIndex((d) =>
      currentUrl.includes(d.domain)
    );

    // If global setting is disabled, enable it and FORCE enable the domain
    if (!settings.hoverTranslateEnabled) {
      settings.hoverTranslateEnabled = true;

      if (matchingDomainIndex !== -1) {
        // Force enable if it exists
        settings.hoverTranslateDomains[matchingDomainIndex].enabled = true;
      }
      // If it doesn't exist, it will be added below
    } else if (matchingDomainIndex !== -1) {
      // Global is already on, so we just toggle the domain
      settings.hoverTranslateDomains[matchingDomainIndex].enabled =
        !settings.hoverTranslateDomains[matchingDomainIndex].enabled;
    }

    if (matchingDomainIndex === -1) {
      // Auto-add domain
      const domain = extractDomainFromUrl(currentUrl);

      settings.hoverTranslateDomains.push({
        domain: domain,
        enabled: true
      });

      try {
        await safeRuntimeCall(() =>
          chrome.runtime.sendMessage({
            type: "set-settings",
            settings: { hoverTranslateDomains: settings.hoverTranslateDomains }
          })
        );
      } catch (error) {
        console.log(
          "BNTrans: Error saving hover domain settings:",
          error.message
        );
        return;
      }

      showToastBottomRight(`✨ Hover translate enabled for ${domain}`);
      return;
    }

    // Get the domain object
    const domain = settings.hoverTranslateDomains[matchingDomainIndex];

    try {
      await safeRuntimeCall(() =>
        chrome.runtime.sendMessage({
          type: "set-settings",
          settings: { hoverTranslateDomains: settings.hoverTranslateDomains }
        })
      );
    } catch (error) {
      console.log(
        "BNTrans: Error updating hover domain settings:",
        error.message
      );
      return;
    }

    const status = domain.enabled
      ? "✨ Hover translate enabled"
      : "Hover translate disabled";

    showToastBottomRight(`${status} for ${domain.domain}`);

    if (!domain.enabled) {
      clearAllHoverTranslations();
    }
  } catch (err) {
    console.error("Toggle hover domain error:", err);
    showToast("Error toggling hover domain");
  }
}

// ============================================
// SCREENSHOT AREA TRANSLATION
// ============================================

let screenshotSelecting = false;
let screenshotPopup = null;
let screenshotFillEl = null;

function hideScreenshotPopup() {
  if (screenshotPopup) {
    screenshotPopup.remove();
    screenshotPopup = null;
  }
  if (screenshotFillEl) {
    screenshotFillEl.remove();
    screenshotFillEl = null;
  }
}

// Paint translations over the captured region segment-by-segment — each
// OCR'd line/block gets its own overlay at the detected bounding box, so
// translated text lands exactly where the original text was (manga-style).
// `result` is either a plain string (loading/error) or
// { translation, segments: [{box:[y0,x0,y1,x1], source, translation}] }.
// `onMode` is invoked when the user clicks the bar's translate/explain
// buttons, letting callers rerun the same capture in another mode.
function renderShotFill(rect, result, mode = "translate", onMode = null) {
  const segments =
    typeof result === "string"
      ? [{ box: [0, 0, 1000, 1000], translation: result }]
      : Array.isArray(result.segments) && result.segments.length
        ? result.segments
        : [{ box: [0, 0, 1000, 1000], translation: result.translation || "" }];

  if (!screenshotFillEl) {
    screenshotFillEl = document.createElement("div");
    screenshotFillEl.className = "bt-shot-fill bt-vars-container";
    applyThemeTo(screenshotFillEl);

    const bar = document.createElement("div");
    bar.className = "bt-shot-fill-bar";
    const mkBtn = (m, key) => {
      const b = document.createElement("button");
      b.className = "bt-shot-fill-btn";
      b.dataset.mode = m;
      b.textContent = i18n.t(key);
      return b;
    };
    const btnTranslate = mkBtn("translate", "screenshot.actionTranslate");
    const btnExplain = mkBtn("explain", "screenshot.actionExplain");
    const close = document.createElement("button");
    close.className = "bt-shot-fill-close";
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      screenshotFillEl.remove();
      screenshotFillEl = null;
    });
    bar.append(btnTranslate, btnExplain);
    screenshotFillEl.appendChild(bar);
    screenshotFillEl.appendChild(close);

    const segs = document.createElement("div");
    segs.className = "bt-shot-fill-segs";
    screenshotFillEl.appendChild(segs);
    document.documentElement.appendChild(screenshotFillEl);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mode]");
      if (btn && screenshotFillEl?._onMode) {
        screenshotFillEl._onMode(btn.dataset.mode);
      }
    });
  }
  screenshotFillEl._onMode = onMode;
  screenshotFillEl.dataset.mode = mode;
  // The bar sits above the region; flip it inside when near the viewport top
  screenshotFillEl.dataset.barBelow = rect.y < 36 ? "true" : "false";

  const docX = rect.docX ?? rect.x + window.scrollX;
  const docY = rect.docY ?? rect.y + window.scrollY;
  screenshotFillEl.style.left = `${docX}px`;
  screenshotFillEl.style.top = `${docY}px`;
  screenshotFillEl.style.width = `${rect.w}px`;
  screenshotFillEl.style.height = `${rect.h}px`;

  const segs = screenshotFillEl.querySelector(".bt-shot-fill-segs");
  segs.innerHTML = "";

  // Explain output is free text — show it as one readable card hanging
  // below the region instead of cramming it into the segment boxes.
  if (mode === "explain") {
    const card = document.createElement("div");
    card.className = "bt-shot-fill-seg bt-shot-fill-explain";
    card.textContent =
      typeof result === "string" ? result : result.translation || "";
    card.style.top = `${rect.h + 8}px`;
    card.style.left = "0px";
    card.style.width = `${Math.max(rect.w, 280)}px`;
    card.style.height = "auto";
    segs.appendChild(card);
    return;
  }

  for (const seg of segments) {
    const [y0, x0, y1, x1] = seg.box;
    const el = document.createElement("div");
    el.className = "bt-shot-fill-seg";
    el.textContent = seg.translation;
    el.style.left = `${(x0 / 1000) * rect.w}px`;
    el.style.top = `${(y0 / 1000) * rect.h}px`;
    el.style.width = `${((x1 - x0) / 1000) * rect.w}px`;
    el.style.height = `${((y1 - y0) / 1000) * rect.h}px`;
    segs.appendChild(el);
    // Shrink font until the text fits inside its box
    let size = Math.min(
      20,
      Math.max(7, Math.floor(((y1 - y0) / 1000) * rect.h))
    );
    el.style.fontSize = `${size}px`;
    while (
      size > 6 &&
      (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
    ) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }
}

function startScreenshotSelection() {
  if (!canCaptureScreenshot()) return;
  if (screenshotSelecting) return;
  if (!isExtensionContextValid()) {
    try {
      showToast(i18n.t("toast.extensionUpdated"));
    } catch {
      /* ignore */
    }
    return;
  }
  hideScreenshotPopup(); // clear a previous fill/popup before re-selecting
  screenshotSelecting = true;

  const overlay = document.createElement("div");
  overlay.className = "bt-shot-overlay bt-vars-container";
  applyThemeTo(overlay);

  const band = document.createElement("div");
  band.className = "bt-shot-band";

  const hint = document.createElement("div");
  hint.className = "bt-shot-hint";
  hint.textContent = i18n.t("screenshot.hint");

  overlay.append(band, hint);
  document.documentElement.appendChild(overlay);

  let start = null;
  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    screenshotSelecting = false;
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    }
  };
  document.addEventListener("keydown", onKey, true);

  overlay.addEventListener("mousedown", (e) => {
    start = { x: e.clientX, y: e.clientY };
    band.style.display = "block";
    e.preventDefault();
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    band.style.left = `${x}px`;
    band.style.top = `${y}px`;
    band.style.width = `${Math.abs(e.clientX - start.x)}px`;
    band.style.height = `${Math.abs(e.clientY - start.y)}px`;
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!start) {
      finish();
      return;
    }
    const rect = {
      x: Math.min(start.x, e.clientX),
      y: Math.min(start.y, e.clientY),
      w: Math.abs(e.clientX - start.x),
      h: Math.abs(e.clientY - start.y),
      // Document coords at capture time so the fill overlay stays glued to
      // the underlying content when the page scrolls.
      docX: Math.min(start.x, e.clientX) + window.scrollX,
      docY: Math.min(start.y, e.clientY) + window.scrollY
    };
    finish();
    if (rect.w >= 10 && rect.h >= 10) {
      captureAndTranslateRect(rect);
    }
  });
}

function canCaptureScreenshot() {
  if (window.self === window.top) return true;
  showToast(
    i18n?.language === "vi"
      ? "Không chụp trong iframe. Hãy chọn vùng từ trang chính."
      : "Screenshots are unavailable inside frames. Select a region from the main page."
  );
  return false;
}

async function captureAndTranslateRect(rect) {
  if (!canCaptureScreenshot()) return;
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    x: window.scrollX,
    y: window.scrollY
  };
  const isCurrentViewport = () =>
    window.innerWidth === viewport.width &&
    window.innerHeight === viewport.height &&
    window.scrollX === viewport.x &&
    window.scrollY === viewport.y;
  if (
    ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.w < 1 ||
    rect.h < 1 ||
    rect.x + rect.w > viewport.width ||
    rect.y + rect.h > viewport.height
  ) {
    showToast(i18n.t("toast.translationFailed"));
    return;
  }
  try {
    // Let the overlay removal paint before capturing the tab
    await new Promise((r) => setTimeout(r, 120));
    if (!isCurrentViewport())
      throw new Error("Viewport changed; select the region again.");

    const cap = await chrome.runtime.sendMessage({ type: "capture-visible" });
    if (!cap?.ok) {
      showToast(cap?.error || i18n.t("toast.translationFailed"));
      return;
    }

    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = cap.dataUrl;
    });
    if (!isCurrentViewport())
      throw new Error("Viewport changed; select the region again.");

    // captureVisibleTab returns physical pixels; derive the real CSS→image
    // scale from the bitmap rather than trusting window.devicePixelRatio
    // (automation/DSF can make them disagree).
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.w * scaleX);
    canvas.height = Math.round(rect.h * scaleY);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      img,
      Math.round(rect.x * scaleX),
      Math.round(rect.y * scaleY),
      Math.round(rect.w * scaleX),
      Math.round(rect.h * scaleY),
      0,
      0,
      canvas.width,
      canvas.height
    );

    // Downscale large captures before upload — vision models don't need
    // Retina-resolution text, and a smaller JPEG detects noticeably faster.
    const MAX_DIM = 1280;
    let out = canvas;
    const shrink = Math.min(1, MAX_DIM / Math.max(canvas.width, canvas.height));
    if (shrink < 1) {
      out = document.createElement("canvas");
      out.width = Math.round(canvas.width * shrink);
      out.height = Math.round(canvas.height * shrink);
      out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
    }
    const base64 = out.toDataURL("image/jpeg", 0.85).split(",")[1];
    const mimeType = "image/jpeg";

    const settings = await getSettings();
    const useFill = settings.screenshotFill === true;
    // Fill mode replaces the popup entirely — the translation is painted
    // over the captured region and nothing else appears.
    const popup = useFill ? null : showScreenshotPopup(rect, "", null);
    const targetBox = popup?.querySelector(".bt-shot-result-text") || null;
    const targetSelect = popup?.querySelector(".bt-shot-target-select") || null;
    if (targetSelect) {
      populateLanguageSelector(
        targetSelect,
        settings.selectionLastTarget || settings.targetLanguageCode || "en",
        false
      );
    }

    const runTranslation = async (targetLang, mode = "translate") => {
      if (useFill) {
        renderShotFill(rect, i18n.t("dialog.translating"), mode, (m) =>
          runTranslation(targetLang, m)
        );
      } else {
        targetBox.textContent = i18n.t("dialog.translating");
        targetBox.classList.add("bt-loading-text");
      }
      const res = await chrome.runtime.sendMessage({
        type: "translate-image",
        payload: {
          imageBase64: base64,
          mimeType,
          targetLanguage: targetLang,
          mode
        }
      });
      if (useFill ? !screenshotFillEl : !popup.isConnected) return;
      if (res?.ok && res.result) {
        const { source, translation } = res.result;
        const out = translation || i18n.t("screenshot.noText");
        if (useFill) {
          renderShotFill(rect, res.result, mode, (m) =>
            runTranslation(targetLang, m)
          );
        } else {
          popup.querySelector(".bt-shot-source-text").textContent =
            source || i18n.t("screenshot.noText");
          targetBox.textContent = out;
          popup.querySelector(".bt-shot-provider").textContent =
            res.result.providerName || "Gemini";
        }
      } else {
        const err = res?.error || i18n.t("toast.translationFailed");
        if (useFill) {
          renderShotFill(rect, err, mode, (m) => runTranslation(targetLang, m));
        } else {
          targetBox.textContent = err;
        }
      }
      targetBox?.classList.remove("bt-loading-text");
    };

    // Re-translate when the user picks a different target language —
    // the cropped PNG is still in scope so this costs no extra capture.
    targetSelect?.addEventListener("change", (e) => {
      try {
        safeRuntimeCall(() =>
          chrome.runtime.sendMessage({
            type: "set-settings",
            settings: { selectionLastTarget: e.target.value }
          })
        );
      } catch {
        /* context */
      }
      runTranslation(e.target.value);
    });

    await runTranslation(
      targetSelect?.value ||
        settings.selectionLastTarget ||
        settings.targetLanguageCode ||
        "en"
    );
  } catch (err) {
    if (String(err?.message).includes("Extension context invalidated")) {
      cleanupExtensionElements();
      try {
        showToast(i18n.t("toast.extensionUpdated"));
      } catch {
        /* ignore */
      }
      return;
    }
    showToast(err.message || i18n.t("toast.translationFailed"));
  }
}

function showScreenshotPopup(rect, sourceText) {
  hideScreenshotPopup();

  let iconUrl = "";
  try {
    iconUrl = isExtensionContextValid()
      ? chrome.runtime.getURL("assets/icons/icon-19.png")
      : "";
  } catch {
    iconUrl = "";
  }

  const popup = document.createElement("div");
  popup.className = "bt-selection-popup bt-shot-popup bt-vars-container";
  applyThemeTo(popup);
  popup.innerHTML = `
    <div class="bt-selection-header">
      <span class="bt-selection-title">
        ${iconUrl ? `<img src="${iconUrl}" width="16" height="16" alt="" />` : ""}
        <span>${i18n.t("screenshot.title")}</span>
      </span>
      <button class="bt-selection-close">×</button>
    </div>
    <div class="bt-selection-content">
      <div class="bt-selection-original">
        <label>${i18n.t("screenshot.extracted")}</label>
        <div class="bt-selection-text-container bt-selection-content-style">
          <div class="bt-selection-text-content bt-shot-source-text">${sourceText || i18n.t("screenshot.capturing")}</div>
        </div>
      </div>
      <div class="bt-selection-translated">
        <label>${i18n.t("selection.translate")}</label>
        <div class="bt-selection-result-container">
          <div class="bt-selection-text-container bt-selection-content-style">
            <div class="bt-selection-text-content bt-shot-result-text bt-loading-text">${i18n.t("dialog.translating")}</div>
          </div>
          <button class="bt-selection-copy-btn" title="${i18n.t("selection.copy")}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span class="bt-copy-feedback">${i18n.t("selection.copied")}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="bt-selection-footer">
      <span class="bt-shot-provider"></span>
      <select class="bt-selection-target-select bt-shot-target-select"></select>
      <a href="#" class="bt-selection-settings">${i18n.t("selection.settings")}</a>
    </div>
  `;

  popup.style.position = "fixed";
  popup.style.zIndex = "9999999999";
  document.body.appendChild(popup);

  // Anchor just below the captured rect; flip above when no room.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = popup.getBoundingClientRect().width;
  const left = Math.max(
    10,
    Math.min(rect.x + rect.w / 2 - pw / 2, vw - pw - 10)
  );
  popup.style.left = `${left}px`;
  if (rect.y + rect.h + 260 < vh) {
    popup.style.top = `${rect.y + rect.h + 8}px`;
  } else {
    popup.style.bottom = `${Math.max(10, vh - rect.y + 8)}px`;
  }

  popup
    .querySelector(".bt-selection-close")
    .addEventListener("click", hideScreenshotPopup);

  const copyBtn = popup.querySelector(".bt-selection-copy-btn");
  copyBtn.addEventListener("click", async () => {
    const text = popup.querySelector(".bt-shot-result-text").textContent;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.classList.add("bt-copied");
      setTimeout(() => copyBtn.classList.remove("bt-copied"), 1200);
    } catch {
      /* clipboard denied */
    }
  });

  popup
    .querySelector(".bt-selection-settings")
    .addEventListener("click", (e) => {
      e.preventDefault();
      try {
        chrome.runtime.sendMessage({ type: "open-options" });
      } catch {
        /* context */
      }
    });

  makeDraggable(popup, popup.querySelector(".bt-selection-header"));
  screenshotPopup = popup;
  return popup;
}

function registerScreenshotTranslate() {
  // Configurable keyboard shortcut (default Cmd/Ctrl+Shift+S)
  document.addEventListener(
    "keydown",
    async (e) => {
      const settings = await getSettings();
      const shortcut = settings.screenshotShortcut || {
        key: "S",
        ctrl: true,
        shift: true,
        alt: false
      };
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifierKey = isMac ? e.metaKey : e.ctrlKey;
      const matches =
        e.key.toUpperCase() === shortcut.key.toUpperCase() &&
        modifierKey === shortcut.ctrl &&
        e.shiftKey === shortcut.shift &&
        e.altKey === shortcut.alt;
      if (matches) {
        e.preventDefault();
        e.stopPropagation();
        startScreenshotSelection();
      }
    },
    true
  );

  // --- Bilingual whole-page translation -----------------------------------
  // Walks the page into inline translation units (reusing the granularity
  // helpers), injects the translation under each original block, and toggles
  // off by restoring the DOM. Batched + skipHistory so it neither rate-limits
  // nor floods history.

  /* global shouldSkipSubtree */
  const PAGE_MAX_UNITS = 500;
  const PAGE_BATCH_CHARS = 3000;
  const PAGE_BATCH_UNITS = 25;
  const PAGE_PROGRESS_ID = "bntrans-page-progress";
  let pageTranslateActive = false;
  let pageSession = null;

  function pageSkipSubtree(node) {
    if (shouldSkipSubtree(node)) return true;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    // Source viewers can render code as table cells instead of pre/code.
    if (
      node.hasAttribute("data-code-marker") ||
      ["blob-code", "blob-num", "js-blob-wrapper", "diff-table"].some((name) =>
        node.classList?.contains(name)
      )
    )
      return true;
    if (
      ["header", "nav", "footer", "aside"].includes(node.tagName.toLowerCase())
    )
      return true;
    if (
      [
        "navigation",
        "banner",
        "contentinfo",
        "complementary",
        "menu",
        "menubar",
        "toolbar",
        "button",
        "dialog",
        "code"
      ].includes(node.getAttribute("role"))
    )
      return true;
    const position = window.getComputedStyle?.(node).position;
    return position === "fixed" || position === "sticky";
  }

  function pageOptions(settings) {
    const config =
      settings.labFeatures?.page === true ? settings.labPage || {} : {};
    const provider = config.providerLimits?.[settings.activeProviderId] || {};
    const number = (key, fallback, min, max) => {
      const input = ["concurrency", "requestsPerSecond", "timeoutMs"].includes(
        key
      )
        ? (provider[key] ?? config[key])
        : config[key];
      const value = Number(input);
      return Number.isFinite(value) && input != null
        ? Math.min(max, Math.max(min, value))
        : fallback;
    };
    return {
      maxRequests: Math.floor(number("maxRequests", 100, 1, 1000)),
      maxChars: Math.floor(number("maxChars", 100000, 1, 1000000)),
      concurrency: Math.floor(number("concurrency", 2, 1, 4)),
      requestsPerSecond: number("requestsPerSecond", 2, 0.1, 10),
      timeoutMs: number("timeoutMs", 30000, 100, 120000),
      maxRetries: Math.floor(number("maxRetries", 1, 0, 2)),
      nearViewportOnly: config.nearViewportOnly === true,
      live: settings.labFeatures?.page === true && config.live === true,
      mode: ["original", "bilingual", "translation"].includes(
        config.siteModes?.[location.hostname] || config.mode
      )
        ? config.siteModes?.[location.hostname] || config.mode
        : "bilingual"
    };
  }

  function pageError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function showPageProgress(text) {
    let badge = document.getElementById(PAGE_PROGRESS_ID);
    if (!badge) {
      badge = document.createElement("div");
      badge.id = PAGE_PROGRESS_ID;
      badge.setAttribute("role", "status");
      badge.style.cssText =
        "position:fixed;bottom:16px;right:16px;z-index:2147483647;" +
        "background:#111827;color:#fff;padding:8px 12px;border-radius:8px;" +
        "font:12px/1.4 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);";
      document.documentElement.appendChild(badge);
    }
    badge.textContent = text;
    return badge;
  }

  function reportPageTranslateState() {
    chrome.runtime
      .sendMessage({
        type: "page-translation-state",
        active: pageTranslateActive
      })
      .catch(() => {});
  }

  function pageSnapshot() {
    const s = pageSession;
    if (!s) return { ok: true, active: false, state: "idle" };
    const complete = s.records.filter((r) => r.status === "done").length;
    const options = s.options || pageOptions({});
    return {
      ok: true,
      active: pageTranslateActive,
      state: s.state,
      mode: options.mode,
      units: s.records.length,
      complete,
      remaining: s.records.length - complete,
      estimatedChars: s.records.reduce((sum, r) => sum + r.md.length, 0),
      requests: s.requests,
      sentChars: s.sentChars,
      inflight: s.inflight,
      maxRequests: options.maxRequests,
      maxChars: options.maxChars,
      qualityWarnings: s.qualityWarnings || 0,
      error: s.error || "",
      capped: s.capped
    };
  }

  function pageNotice(s) {
    if (pageSession !== s || s.cancelled) return;
    const stats = pageSnapshot();
    s.badge.textContent = [
      s.state,
      stats.complete + "/" + stats.units,
      stats.requests + "/" + stats.maxRequests + " requests",
      stats.sentChars + "/" + stats.maxChars + " chars",
      stats.qualityWarnings
        ? `${stats.qualityWarnings} ${s.settings.interfaceLanguage === "vi" ? "bản dịch cần kiểm tra" : "translations need review"}`
        : "",
      s.error
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function pageNear(unit) {
    const el = unit.nodes[0]?.parentElement;
    const rect = el?.getBoundingClientRect();
    return (
      !!rect &&
      rect.bottom > -200 &&
      rect.top < window.innerHeight + 200 &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  }

  function pageObserve(s) {
    if (s.mutations && !s.cancelled)
      s.mutations.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["translate", "contenteditable", "class"]
      });
  }

  function pageOwnMutation(s, callback) {
    const pending = s.mutations?.takeRecords();
    s.mutations?.disconnect();
    try {
      return callback();
    } finally {
      pageObserve(s);
      if (pending?.length) pageSchedule(s);
    }
  }

  function pageSchedule(s) {
    clearTimeout(s.debounce);
    s.debounce = setTimeout(() => {
      if (pageSession !== s || s.cancelled || s.route?.()) return;
      pageCollect(s);
      pageWake(s);
    }, 200);
  }

  function pageValid(record) {
    const w = record.wrappers?.[0];
    if (
      !w ||
      w.wrapper.isConnected === false ||
      toMarkdown(w.originalSpan.childNodes) !== record.md ||
      !record.unit.nodes.every((n) => n.parentNode === w.originalSpan)
    )
      return false;
    for (
      let ancestor = w.wrapper.parentNode;
      ancestor;
      ancestor = ancestor.parentNode
    ) {
      if (pageSkipSubtree(ancestor)) return false;
    }
    // A newly protected descendant must remain visible, even if its text is empty.
    const units = getTranslationUnits(w.originalSpan, pageSkipSubtree);
    return (
      units.length === 1 &&
      units[0].nodes.length === record.unit.nodes.length &&
      units[0].nodes.every((n, i) => n === record.unit.nodes[i])
    );
  }

  function pageUnwrap(wrapper) {
    const original = wrapper.querySelector("[data-bntrans-original]");
    const parent = wrapper.parentNode;
    if (original && parent) {
      while (original.firstChild)
        parent.insertBefore(original.firstChild, wrapper);
    }
    wrapper.remove();
  }

  function pageSetMode(s, mode) {
    if (!["original", "bilingual", "translation"].includes(mode))
      throw new Error("Invalid reading mode");
    s.options.mode = mode;
    pageOwnMutation(s, () => {
      for (const r of s.records)
        for (const w of r.wrappers || []) {
          const done = r.status === "done" && pageValid(r);
          w.originalSpan.style.display =
            mode === "translation" && done ? "none" : "";
          w.translationSpan.style.display =
            mode === "original" ? "none" : "inline";
          w.separator.style.display = mode === "original" ? "none" : "";
        }
    });
  }

  function pageCancelEpoch(s) {
    s.epoch++;
    for (const cancel of s.cancelWaiters) cancel();
    s.cancelWaiters.clear();
  }

  function removePageTranslation() {
    const s = pageSession;
    if (s) {
      s.cancelled = true;
      pageCancelEpoch(s);
      s.mutations?.disconnect();
      s.intersections?.disconnect();
      clearTimeout(s.debounce);
      clearInterval(s.routeTimer);
      window.removeEventListener("popstate", s.route);
      window.removeEventListener("hashchange", s.route);
    }
    pageSession = null;
    pageTranslateActive = false;
    document
      .querySelectorAll("[data-bntrans-wrapper][data-bntrans-page]")
      .forEach(pageUnwrap);
    document.getElementById(PAGE_PROGRESS_ID)?.remove();
    document.body?.removeAttribute("data-bntrans-page-translated");
    reportPageTranslateState();
  }

  function pageCollect(s) {
    pageOwnMutation(s, () => {
      // Revisions are checked again at apply time, even before an observer callback.
      for (const record of s.records) {
        if (!record.wrappers?.length) continue;
        const changed = !pageValid(record);
        if (changed) {
          record.revision++;
          record.status = "stale";
          record.wrappers.forEach((w) => pageUnwrap(w.wrapper));
          record.wrappers = [];
          s.identity.delete(record.unit.nodes[0]);
        }
      }
      s.records = s.records.filter((r) => r.status !== "stale");
      for (const unit of getTranslationUnits(document.body, pageSkipSubtree)) {
        const key = unit.nodes[0];
        const md = toMarkdown(unit.nodes);
        if (!md.trim() || s.identity.has(key)) continue;
        if (s.records.length >= PAGE_MAX_UNITS) {
          s.capped = true;
          break;
        }
        const record = {
          id: ++s.nextId,
          unit,
          md,
          revision: 0,
          status: "pending",
          priority: pageNear(unit)
        };
        s.identity.set(key, record);
        s.records.push(record);
        const anchor = key.parentElement;
        if (anchor) s.intersections?.observe(anchor);
      }
    });
    pageNotice(s);
  }

  async function pageRequest(s, epoch, payload) {
    const current = () =>
      pageSession === s &&
      !s.cancelled &&
      s.epoch === epoch &&
      s.state === "running";
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    while (s.inflight >= s.options.concurrency || Date.now() < s.nextRequest) {
      if (!current()) throw pageError("cancelled", "Translation cancelled");
      await delay(Math.min(50, Math.max(1, s.nextRequest - Date.now())));
    }
    if (!current()) throw pageError("cancelled", "Translation cancelled");
    if (s.records.some((r) => r.status === "working" && !pageValid(r))) {
      throw pageError("revision", "Page content changed before sending");
    }
    const chars = payload.text.length;
    if (
      s.requests >= s.options.maxRequests ||
      s.sentChars + chars > s.options.maxChars
    ) {
      throw pageError(
        "budget",
        "Session budget reached; increase budget and resume"
      );
    }
    s.requests++;
    s.sentChars += chars;
    s.nextRequest = Date.now() + 1000 / s.options.requestsPerSecond;
    s.inflight++;
    const transport = Promise.resolve().then(() => {
      if (!current()) throw pageError("cancelled", "Translation cancelled");
      return requestTranslation({
        ...payload,
        skipHistory: true,
        siteUrl: location.href
      });
    });
    // Runtime messaging cannot abort a provider HTTP request already sent.
    transport.then(
      () => {
        s.inflight--;
      },
      () => {
        s.inflight--;
      }
    );
    let timeout;
    let cancel;
    try {
      const response = await Promise.race([
        transport,
        new Promise((_, reject) => {
          cancel = () =>
            reject(pageError("cancelled", "Translation cancelled"));
          s.cancelWaiters.add(cancel);
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                pageError(
                  "timeout",
                  "Request timed out; remote request may still finish"
                )
              ),
            s.options.timeoutMs
          );
        })
      ]);
      if (!current()) throw pageError("cancelled", "Translation cancelled");
      if (response?.result?.qualityWarnings?.length)
        s.qualityWarnings = (s.qualityWarnings || 0) + 1;
      return response;
    } finally {
      clearTimeout(timeout);
      s.cancelWaiters.delete(cancel);
      pageNotice(s);
    }
  }

  function pageApply(s, records, revisions, segments) {
    if (pageSession !== s || s.cancelled) return;
    pageOwnMutation(s, () => {
      records.forEach((r, i) => {
        if (
          !segments?.[i] ||
          r.revision !== revisions[i] ||
          !r.wrappers?.length
        )
          return;
        if (!pageValid(r)) return;
        updateWrappers(r.wrappers, [segments[i]], s.settings);
        r.status = "done";
      });
    });
    pageSetMode(s, s.options.mode);
  }

  async function pagePump(s) {
    if (s.pumping || pageSession !== s || s.state !== "running") return;
    s.pumping = true;
    const epoch = s.epoch;
    const current = () =>
      pageSession === s &&
      !s.cancelled &&
      s.epoch === epoch &&
      s.state === "running";
    try {
      while (current()) {
        pageCollect(s);
        const candidates = s.records.filter(
          (r) =>
            r.status === "pending" &&
            (!s.options.nearViewportOnly || pageNear(r.unit))
        );
        candidates.sort(
          (a, b) =>
            Number(b.priority || pageNear(b.unit)) -
            Number(a.priority || pageNear(a.unit))
        );
        const batch = [];
        let chars = 0;
        for (const r of candidates) {
          if (
            batch.length >= PAGE_BATCH_UNITS ||
            (batch.length && chars + r.md.length > PAGE_BATCH_CHARS)
          )
            break;
          batch.push(r);
          chars += r.md.length;
        }
        if (!batch.length) break;
        const revisions = batch.map((r) => r.revision);
        pageOwnMutation(s, () => {
          batch.forEach((r) => {
            if (!r.wrappers?.length) r.wrappers = injectUnitWrappers([r.unit]);
            r.wrappers.forEach((w) =>
              w.wrapper.setAttribute("data-bntrans-page", "true")
            );
            r.status = r.wrappers.length ? "working" : "stale";
          });
        });
        try {
          const segments = await requestSegmentTranslations(
            batch.map((r) => r.md),
            s.settings,
            (payload) => pageRequest(s, epoch, payload),
            {
              isCurrent: current,
              concurrency: s.options.concurrency,
              maxRetries: s.options.maxRetries
            }
          );
          if (current()) pageApply(s, batch, revisions, segments);
        } catch (error) {
          if (!current()) break;
          pageApply(s, batch, revisions, error.partialTranslations);
          if (error.code === "revision") {
            batch.forEach((r) => {
              if (r.status === "working") r.status = "pending";
            });
            continue;
          }
          s.error = error.message;
          if (["budget", "timeout", "cancelled"].includes(error.code)) {
            s.state = error.code === "budget" ? "budget" : "paused";
            pageCancelEpoch(s);
          } else {
            pageOwnMutation(s, () => {
              for (const record of batch.filter((r) => r.status !== "done")) {
                record.wrappers.forEach((w) => pageUnwrap(w.wrapper));
                record.wrappers = [];
              }
            });
          }
        }
        batch.forEach((r) => {
          if (r.status === "working")
            r.status = s.state === "running" ? "error" : "pending";
        });
        pageNotice(s);
      }
      if (current()) s.state = s.options.live ? "watching" : "complete";
    } finally {
      s.pumping = false;
      pageNotice(s);
    }
  }

  function pageWake(s) {
    if (
      pageSession !== s ||
      s.cancelled ||
      !["watching", "running", "complete"].includes(s.state)
    )
      return;
    s.state = "running";
    void pagePump(s);
  }

  async function runPageTranslation() {
    if (!document.body) return;
    if (pageSession) return pageSnapshot();
    const s = {
      settings: null,
      options: null,
      records: [],
      identity: new WeakMap(),
      nextId: 0,
      epoch: 0,
      cancelWaiters: new Set(),
      cancelled: false,
      pumping: false,
      state: "starting",
      requests: 0,
      sentChars: 0,
      inflight: 0,
      nextRequest: 0,
      url: location.href,
      badge: showPageProgress("Preparing page translation…")
    };
    pageSession = s;
    pageTranslateActive = true;
    reportPageTranslateState();
    try {
      s.settings = await getSettings();
      if (pageSession !== s || s.cancelled) return;
      s.options = pageOptions(s.settings);
      s.state = "running";
      document.body.setAttribute("data-bntrans-page-translated", "true");
      if (typeof IntersectionObserver === "function") {
        s.intersections = new IntersectionObserver(
          (entries) => {
            for (const e of entries)
              if (e.isIntersecting) {
                s.records.forEach((r) => {
                  if (r.unit.nodes[0]?.parentElement === e.target)
                    r.priority = true;
                });
              }
            if (s.options.nearViewportOnly) pageWake(s);
          },
          { rootMargin: "200px 0px" }
        );
      }
      pageCollect(s);
      if (!s.records.length && !s.options.live) {
        removePageTranslation();
        return pageSnapshot();
      }
      if (s.options.live && typeof MutationObserver !== "function") {
        s.error = "Live translation unavailable: MutationObserver missing";
      } else if (s.options.live) {
        s.mutations = new MutationObserver(() => pageSchedule(s));
        pageObserve(s);
      }
      s.route = () => {
        if (location.href === s.url) return false;
        removePageTranslation();
        showPageProgress("Route changed; start a new page session");
        return true;
      };
      window.addEventListener("popstate", s.route);
      window.addEventListener("hashchange", s.route);
      s.routeTimer = setInterval(s.route, 500);
      await pagePump(s);
      return pageSnapshot();
    } catch (error) {
      if (pageSession === s) {
        const message = error?.message || "Page translation unavailable";
        removePageTranslation();
        showPageProgress(message);
        return { ...pageSnapshot(), ok: false, error: message };
      }
    }
  }

  async function pageCommand(message) {
    const settings = await getSettings();
    if (settings.labFeatures?.page !== true)
      throw new Error("Enable Page Labs first");
    const command = message.command;
    if (
      ![
        "estimate",
        "translate",
        "restore",
        "pause",
        "resume",
        "mode",
        "snapshot"
      ].includes(command)
    )
      throw new Error("Unknown page command");
    if (command === "estimate") {
      const units = getTranslationUnits(document.body, pageSkipSubtree).slice(
        0,
        PAGE_MAX_UNITS
      );
      return {
        ok: true,
        units: units.length,
        chars: units.reduce((n, u) => n + toMarkdown(u.nodes).length, 0),
        existing: pageSnapshot(),
        options: pageOptions(settings)
      };
    }
    if (command === "translate") {
      void runPageTranslation();
      return { ok: true, state: "starting" };
    }
    if (command === "restore") {
      removePageTranslation();
      return pageSnapshot();
    }
    const s = pageSession;
    if (!s) return pageSnapshot();
    if (command === "pause") {
      s.state = "paused";
      pageCancelEpoch(s);
      s.records.forEach((r) => {
        if (r.status === "working") r.status = "pending";
      });
      pageNotice(s);
    } else if (command === "resume") {
      s.settings = settings;
      s.options = { ...pageOptions(settings), mode: s.options.mode };
      s.records.forEach((r) => {
        if (r.status === "error") r.status = "pending";
      });
      s.error = "";
      // The old pump unwinds before resuming; no second concurrent queue.
      if (s.pumping)
        throw new Error("Previous request is settling; retry resume shortly");
      s.state = "running";
      void pagePump(s);
    } else if (command === "mode") {
      pageSetMode(s, message.mode);
    } else if (command !== "snapshot") throw new Error("Unknown page command");
    return pageSnapshot();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "labs-page-command") return;
    pageCommand(message.payload || message).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error.message })
    );
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area !== "local" ||
      !changes.translatorSettings?.newValue ||
      !pageSession
    )
      return;
    const next = changes.translatorSettings.newValue;
    if (
      next.enabled === false ||
      (pageSession.options?.live &&
        (next.labFeatures?.page !== true || next.labPage?.live !== true))
    )
      removePageTranslation();
  });

  function togglePageTranslation() {
    if (
      pageTranslateActive ||
      document.body?.hasAttribute("data-bntrans-page-translated")
    ) {
      removePageTranslation();
    } else {
      void runPageTranslation();
    }
  }

  // --- Translate & replace inside editable fields (context menu) -----------
  // Right-click in an input/textarea/contenteditable: translates the current
  // selection (or the whole field when nothing is selected) and writes the
  // result back in place. Uses the same direction as the quick popup.

  async function translateEditableSelection() {
    const element = getActiveEditableElement();
    if (!element) return;
    const snapshot = captureEditableSnapshot(element, true);
    if (!snapshot?.text?.trim()) return;

    const settings = await getSettings();
    if (!isEditableSnapshotCurrent(snapshot)) return;
    const sourceLanguage =
      settings.selectionLastSource ||
      (settings.useAutoDetect ? "auto" : settings.targetLanguageCode || "en");
    const targetLanguage =
      settings.selectionLastTarget ||
      (settings.useAutoDetect
        ? settings.targetLanguageCode || "en"
        : settings.nativeLanguageCode || "vi");
    showToast(i18n.t("toast.translating"));

    try {
      const res = await requestTranslation({
        text: snapshot.text,
        nativeLanguageCode: settings.nativeLanguageCode || "vi",
        targetLanguage,
        sourceLanguage: sourceLanguage === "auto" ? undefined : sourceLanguage,
        useAutoDetect: sourceLanguage === "auto"
      });
      const translation = res?.result?.translation;
      if (!(res?.ok && translation)) {
        showToast(res?.error || i18n.t("toast.translationFailed"));
        return;
      }
      applyEditableSnapshot(snapshot, translation);
    } catch (err) {
      console.error("[BNTrans] Editable translate failed:", err);
      showToast(i18n.t("toast.translationFailed"));
    }
  }

  // Triggered from the extension context menu / quick popup button
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "start-screenshot-select") {
      startScreenshotSelection();
    } else if (message?.type === "get-selection-text") {
      sendResponse({
        ok: true,
        text: getSafeSelection()?.toString() || ""
      });
    } else if (message?.type === "translate-selection") {
      // Right-click "Translate selection": open the popup directly on the
      // current selection, skipping the icon step.
      const selection = getSafeSelection();
      const text = selection?.toString().trim();
      if (text && selection.rangeCount > 0) {
        selectedText = text;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        showTranslationPopup(rect, text, "bottom");
      }
    } else if (message?.type === "toggle-page-translation") {
      togglePageTranslation();
      sendResponse(pageSnapshot());
    } else if (message?.type === "translate-editable") {
      translateEditableSelection();
    }
  });

  // --- Language-detect banner ---------------------------------------------
  // Offer page translation when the page's language differs from the user's
  // native language (document.lang first, chrome.i18n detect as fallback).
  const LANG_BANNER_DISMISS_KEY = "bntrans-lang-banner-dismissed";

  function showLangBanner(pageLang) {
    if (document.getElementById("bntrans-lang-banner")) return;
    const banner = document.createElement("div");
    banner.id = "bntrans-lang-banner";
    banner.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;" +
      "background:#111827;color:#fff;padding:10px 14px;border-radius:10px;" +
      "font:13px/1.4 sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.35);" +
      "display:flex;gap:10px;align-items:center;";
    const label = document.createElement("span");
    label.textContent = i18n.t("banner.pageInLang").replace("{lang}", pageLang);
    const translateBtn = document.createElement("button");
    translateBtn.textContent = i18n.t("popup.translateNow");
    translateBtn.style.cssText =
      "background:#3b82f6;color:#fff;border:none;border-radius:6px;" +
      "padding:4px 10px;font:inherit;cursor:pointer;";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText =
      "background:none;color:#9ca3af;border:none;font:inherit;cursor:pointer;";

    const dismiss = () => {
      try {
        sessionStorage.setItem(LANG_BANNER_DISMISS_KEY, "1");
      } catch {
        /* private mode */
      }
      banner.remove();
    };
    translateBtn.addEventListener("click", () => {
      togglePageTranslation();
      banner.remove();
    });
    closeBtn.addEventListener("click", dismiss);

    banner.append(label, translateBtn, closeBtn);
    document.documentElement.appendChild(banner);
  }

  getSettings()
    .then(async (s) => {
      const native = (s.nativeLanguageCode || "vi").split("-")[0];
      const autoList = s.autoTranslateDomains || [];
      if (
        autoList.some(
          (d) => d.enabled && window.location.href.includes(d.domain)
        )
      ) {
        return; // auto-translate already handles this page
      }
      try {
        if (sessionStorage.getItem(LANG_BANNER_DISMISS_KEY)) return;
      } catch {
        /* private mode */
      }

      let pageLang = (document.documentElement.lang || "")
        .split("-")[0]
        .toLowerCase();
      if (!pageLang) {
        try {
          const res = await chrome.runtime.sendMessage({
            type: "detect-page-language",
            text: (document.body?.innerText || "").slice(0, 2000)
          });
          pageLang = (res?.language || "").split("-")[0].toLowerCase();
        } catch {
          /* background not ready */
        }
      }
      if (!pageLang || pageLang === native) return;
      showLangBanner(pageLang);
    })
    .catch(() => {});

  // Auto-translate pages whose domain is in settings.autoTranslateDomains
  // (same substring matching as instantTranslate domains).
  getSettings()
    .then((s) => {
      const list = s.autoTranslateDomains || [];
      const url = window.location.href;
      if (list.some((d) => d.enabled && url.includes(d.domain))) {
        runPageTranslation();
      }
    })
    .catch(() => {});

  // Click outside the result popup closes it
  document.addEventListener("mousedown", (e) => {
    if (screenshotPopup && !screenshotPopup.contains(e.target)) {
      hideScreenshotPopup();
    }
  });
}
