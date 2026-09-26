import { i18n } from "./common/i18n.js";
import { tts } from "./services/tts.js";

const quickInput = document.getElementById("quick-input");
const quickSource = document.getElementById("quick-source");
const quickTarget = document.getElementById("quick-target");
const quickSwap = document.getElementById("quick-swap");
const quickTranslateBtn = document.getElementById("quick-translate");
const quickResult = document.getElementById("quick-result");
const quickResultText = document.getElementById("quick-result-text");
const quickProvider = document.getElementById("quick-provider");
const quickCopy = document.getElementById("quick-copy");
const quickSpeak = document.getElementById("quick-speak");
const openOptionsBtn = document.getElementById("open-options");

let activeProviderId = "google-translate";

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "pt", name: "Portuguese" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "zh", name: "Chinese" },
  { code: "ru", name: "Russian" },
  { code: "ko", name: "Korean" },
  { code: "hi", name: "Hindi" },
  { code: "ar", name: "Arabic" },
  { code: "tr", name: "Turkish" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" }
];

function translateUI() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.innerHTML = i18n.t(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute(
      "placeholder",
      i18n.t(el.getAttribute("data-i18n-placeholder"))
    );
  });
}

function displayVersion() {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById("version-display");
  if (versionEl && manifest.version)
    versionEl.textContent = `v${manifest.version}`;
}

function applyTheme(value) {
  // body also carries .bt-vars-container, so the attribute must live on both
  for (const el of [document.documentElement, document.body]) {
    if (value === "auto") el.removeAttribute("data-theme");
    else el.dataset.theme = value;
  }
}

function populateLangs() {
  const options = LANGUAGES.map(
    (l) =>
      `<option value="${l.code}">${i18n.t("lang." + l.code) || l.name} (${l.code})</option>`
  ).join("");
  const src = quickSource.value;
  const tgt = quickTarget.value;
  quickSource.innerHTML =
    `<option value="auto">${i18n.t("popup.autoDetectOption")}</option>` +
    options;
  quickTarget.innerHTML = options;
  if (src) quickSource.value = src;
  if (tgt) quickTarget.value = tgt;
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "get-settings" });
    if (!res?.ok) return;
    applyTheme(res.settings.theme || "auto");
    i18n.setLanguage(res.settings.interfaceLanguage || "en");
    populateLangs();
    translateUI();
    quickTarget.value = res.settings.targetLanguageCode || "en";
    activeProviderId = res.settings.activeProviderId || activeProviderId;
  } catch {
    // background not ready
  }
}

async function runQuickTranslate() {
  const text = quickInput.value.trim();
  if (!text) return;

  quickTranslateBtn.disabled = true;
  quickResult.hidden = false;
  quickProvider.textContent = "";
  quickResultText.textContent = i18n.t("dialog.translating");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "translate",
      payload: {
        text,
        sourceLanguage:
          quickSource.value === "auto" ? undefined : quickSource.value,
        targetLanguage: quickTarget.value,
        providerId: activeProviderId
      }
    });

    if (res?.ok && res.result?.translation) {
      quickResultText.innerHTML = res.result.translation;
      quickProvider.textContent = res.result.providerName || "";
    } else {
      quickResultText.textContent = `${i18n.t("popup.translateFailed")}: ${res?.error || "Unknown error"}`;
    }
  } catch (err) {
    quickResultText.textContent = `${i18n.t("popup.translateFailed")}: ${err.message}`;
  } finally {
    quickTranslateBtn.disabled = false;
  }
}

quickTranslateBtn?.addEventListener("click", runQuickTranslate);

quickInput?.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    runQuickTranslate();
  }
});

quickSwap?.addEventListener("click", () => {
  if (quickSource.value === "auto") return;
  const s = quickSource.value;
  quickSource.value = quickTarget.value;
  quickTarget.value = s;
});

quickCopy?.addEventListener("click", async () => {
  const text = quickResultText.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    quickCopy.textContent = "✓";
    setTimeout(() => (quickCopy.textContent = "⧉"), 1200);
  } catch {
    // clipboard unavailable
  }
});

quickSpeak?.addEventListener("click", async () => {
  const text = quickResultText.textContent;
  if (!text || text === i18n.t("dialog.translating")) return;
  await tts.play(text, quickTarget.value);
});

openOptionsBtn?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

loadSettings();
displayVersion();
quickInput?.focus();
