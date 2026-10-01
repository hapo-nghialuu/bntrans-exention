import { i18n } from "./common/i18n.js";
import { tts } from "./services/tts.js";
import { enhanceSelects } from "./common/custom-select.js";

enhanceSelects(document.body);

const enabledCheckbox = document.querySelector("#enabled");
const settingsContainer = document.querySelector("#settings-container");
const nativeSelect = document.querySelector("#native");
const targetSelect = document.querySelector("#target");

const autoDetect = document.querySelector("#auto-detect");
const confirmModal = document.querySelector("#confirm-modal");
const saveStatus = document.querySelector("#save-status");
const aliasListEl = document.querySelector("#alias-list");
const aliasKeyInput = document.querySelector("#alias-key");
const aliasValueInput = document.querySelector("#alias-value");
const addAliasBtn = document.querySelector("#add-alias");
const translationStyleSelect = document.querySelector("#translation-style");
const glossaryListEl = document.querySelector("#glossary-list");
const glossaryKeyInput = document.querySelector("#glossary-key");
const glossaryValueInput = document.querySelector("#glossary-value");
const addGlossaryBtn = document.querySelector("#add-glossary");

// Theme element
const themeSelect = document.querySelector("#theme-select");

// Quick translate elements
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

// Instant translate elements
const instantEnabledCheckbox = document.querySelector(
  "#instant-translate-enabled"
);
const instantSettings = document.querySelector("#instant-settings");
const instantDelayInput = document.querySelector("#instant-delay");
const domainListEl = document.querySelector("#instant-domain-list");
const newDomainInput = document.querySelector("#new-domain");
const addDomainBtn = document.querySelector("#add-domain");

// Keyboard shortcut elements
const shortcutCtrlCheckbox = document.querySelector("#shortcut-ctrl");
const shortcutShiftCheckbox = document.querySelector("#shortcut-shift");
const shortcutAltCheckbox = document.querySelector("#shortcut-alt");
const shortcutKeyInput = document.querySelector("#shortcut-key");
const shortcutPreview = document.querySelector("#shortcut-preview");

// Provider List elements
const providerListEl = document.querySelector("#provider-list");
const btnAddProvider = document.querySelector("#btn-add-provider");
const providerForm = document.querySelector("#provider-form");
const formTitle = document.querySelector("#form-title");
const formType = document.querySelector("#form-type");
const formName = document.querySelector("#form-name");
const formDynamicFields = document.querySelector("#form-dynamic-fields");
const btnFormCancel = document.querySelector("#form-cancel");
const btnFormSave = document.querySelector("#form-save");

// Prompt customization elements
const systemPromptDisplay = document.querySelector("#system-prompt-display");
const userCustomPrompt = document.querySelector("#user-custom-prompt");
const promptCharCount = document.querySelector("#prompt-char-count");

// Hover to Translate elements
const hoverTranslateEnabled = document.getElementById(
  "hover-translate-enabled"
);
const hoverUniqueMode = document.getElementById("hover-unique-mode");
const hoverSettings = document.getElementById("hover-settings");
const hoverMode = document.getElementById("hover-mode");
const hoverGranularity = document.getElementById("hover-granularity");
const hoverModifier = document.getElementById("hover-modifier");
const shotShortcutCtrl = document.getElementById("shot-shortcut-ctrl");
const shotShortcutShift = document.getElementById("shot-shortcut-shift");
const shotShortcutAlt = document.getElementById("shot-shortcut-alt");
const shotShortcutKey = document.getElementById("shot-shortcut-key");
const shotShortcutPreview = document.getElementById("shot-shortcut-preview");
const shotModel = document.getElementById("shot-model");
const shotProvider = document.getElementById("shot-provider");

const hoverShortcutCtrl = document.getElementById("hover-shortcut-ctrl");
const hoverShortcutShift = document.getElementById("hover-shortcut-shift");
const hoverShortcutAlt = document.getElementById("hover-shortcut-alt");
const hoverShortcutKey = document.getElementById("hover-shortcut-key");
const hoverShortcutPreview = document.getElementById("hover-shortcut-preview");
// const hoverBgColor = document.getElementById('hover-bg-color'); // Removed
const hoverTextColor = document.getElementById("hover-text-color");
const hoverFontSize = document.getElementById("hover-font-size");
const hoverShowIcon = document.getElementById("hover-show-icon");
const hoverUnderline = document.getElementById("hover-underline");
const manageHoverDomains = document.getElementById("manage-hover-domains");
const hoverDomainListSection = document.getElementById(
  "hover-domain-list-section"
);
const hoverDomainList = document.getElementById("hover-domain-list");
const hoverDomainCount = document.getElementById("hover-domain-count");
const newHoverDomain = document.getElementById("new-hover-domain");
const addHoverDomain = document.getElementById("add-hover-domain");

let currentAliases = {};
let currentGlossary = {};
let currentDomains = [];
let currentHoverDomains = [];
let providers = [];
let activeProviderId = "builtin";
let editingProviderId = null;

let ttsProviders = [];
let activeTTSProviderId = "google-tts";
let editingTTSProviderId = null;
// The default target the last load/save produced. The selection popup
// remembers its own last target; when the user changes the explicit
// default we sync that memory so the new default actually takes effect.
let savedTargetLanguageCode = null;

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
    const key = el.getAttribute("data-i18n");
    el.innerHTML = i18n.t(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.setAttribute("placeholder", i18n.t(key));
  });
}

// Display version in header
function displayVersion() {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById("version-display");
  if (versionEl && manifest.version) {
    versionEl.textContent = `v${manifest.version}`;
  }
}

function updateAutomationBadge() {
  setNavBadge("nav-badge-instant", currentDomains.length);
  setNavBadge("nav-badge-hover", currentHoverDomains.length);
}

function setNavBadge(id, count) {
  const badge = document.getElementById(id);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count || "";
}

function applyTheme(value) {
  // body also carries .bt-vars-container, so the attribute must live on both
  for (const el of [document.documentElement, document.body]) {
    if (value === "auto") el.removeAttribute("data-theme");
    else el.dataset.theme = value;
  }
}

function populateSelects() {
  const currentNative = nativeSelect.value;
  const currentTarget = targetSelect.value;
  const currentQuickSource = quickSource?.value;
  const currentQuickTarget = quickTarget?.value;

  const options = LANGUAGES.map(
    (l) =>
      `<option value="${l.code}">${i18n.t("lang." + l.code) || l.name} (${l.code})</option>`
  ).join("");

  nativeSelect.innerHTML = options;
  targetSelect.innerHTML = options;

  if (quickSource) {
    quickSource.innerHTML =
      `<option value="auto">${i18n.t("popup.autoDetectOption")}</option>` +
      options;
    if (currentQuickSource) quickSource.value = currentQuickSource;
  }
  if (quickTarget) {
    quickTarget.innerHTML = options;
    if (currentQuickTarget) quickTarget.value = currentQuickTarget;
  }

  if (currentNative) nativeSelect.value = currentNative;
  if (currentTarget) targetSelect.value = currentTarget;
}

function renderAliases() {
  aliasListEl.innerHTML = "";
  Object.entries(currentAliases).forEach(([key, value]) => {
    const item = document.createElement("div");
    item.className = "bt-alias-item";
    item.innerHTML = `
      <span><b>${key}</b> → ${value}</span>
      <button data-key="${key}" class="bt-remove-alias">×</button>
    `;
    aliasListEl.appendChild(item);
  });

  document.querySelectorAll(".bt-remove-alias").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const key = e.target.dataset.key;
      delete currentAliases[key];
      renderAliases();
      saveSettings();
    });
  });
}

function renderGlossary() {
  if (!glossaryListEl) return;
  glossaryListEl.innerHTML = "";
  Object.entries(currentGlossary).forEach(([key, value]) => {
    const item = document.createElement("div");
    item.className = "bt-alias-item";
    item.innerHTML = `
      <span><b>${key}</b> → ${value}</span>
      <button data-key="${key}" class="bt-remove-glossary">×</button>
    `;
    glossaryListEl.appendChild(item);
  });

  glossaryListEl.querySelectorAll(".bt-remove-glossary").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      delete currentGlossary[e.target.dataset.key];
      renderGlossary();
      saveSettings();
    });
  });
}

function renderDomains() {
  if (!domainListEl) return;

  domainListEl.innerHTML = "";
  currentDomains.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "bt-domain-item";
    const position = item.position || "auto"; // Default to 'auto'
    div.innerHTML = `
      <input type="checkbox" ${item.enabled ? "checked" : ""} data-index="${index}" />
      <span class="bt-domain-name">${item.domain}</span>
      <select class="bt-position-select" data-index="${index}">
        <option value="auto" ${position === "auto" ? "selected" : ""}>Auto</option>
        <option value="bottom" ${position === "bottom" ? "selected" : ""}>Bottom</option>
        <option value="top" ${position === "top" ? "selected" : ""}>Top</option>
      </select>
      <button class="bt-remove-alias" data-index="${index}">×</button>
    `;
    domainListEl.appendChild(div);
  });

  domainListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      currentDomains[e.target.dataset.index].enabled = e.target.checked;
      saveSettings();
    });
  });

  domainListEl.querySelectorAll(".bt-position-select").forEach((select) => {
    select.addEventListener("change", (e) => {
      currentDomains[e.target.dataset.index].position = e.target.value;
      saveSettings();
    });
  });

  domainListEl.querySelectorAll(".bt-remove-alias").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      currentDomains.splice(e.target.dataset.index, 1);
      renderDomains();
      saveSettings();
    });
  });

  updateAutomationBadge();
}

function renderProviderList() {
  providerListEl.innerHTML = "";

  // Define default provider IDs that cannot be edited or deleted
  const DEFAULT_PROVIDER_IDS = ["google-translate", "builtin"];

  providers.forEach((p) => {
    const isActive = p.id === activeProviderId;
    const isDefaultProvider = DEFAULT_PROVIDER_IDS.includes(p.id);

    const el = document.createElement("div");
    el.className = `bt-provider-item ${isActive ? "active" : ""}`;

    // Actions
    let actionsHtml = "";
    if (isActive) {
      actionsHtml += `<span class="bt-badge-active">${i18n.t("popup.active")}</span>`;
    } else {
      actionsHtml += `<button class="bt-btn-text btn-set-active" data-id="${p.id}">${i18n.t("popup.use")}</button>`;
    }

    // Only allow edit/delete for non-default providers
    if (!isDefaultProvider) {
      actionsHtml += `<button class="bt-btn-text btn-edit" data-id="${p.id}">${i18n.t("popup.edit")}</button>`;
      actionsHtml += `<button class="bt-btn-text btn-delete" data-id="${p.id}">${i18n.t("popup.delete")}</button>`;
    }

    el.innerHTML = `
      <div class="bt-provider-info">
        <div class="bt-provider-name">${p.name}</div>
        <div class="bt-provider-type">${p.type}</div>
      </div>
      <div class="bt-provider-actions">
        ${actionsHtml}
      </div>
    `;
    providerListEl.appendChild(el);
  });

  setNavBadge("nav-badge-providers", providers.length);

  // Attach events
  providerListEl.querySelectorAll(".btn-set-active").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      activeProviderId = e.target.dataset.id;
      renderProviderList();
      saveSettings();
    });
  });

  providerListEl.querySelectorAll(".btn-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this provider?")) {
        providers = providers.filter((p) => p.id !== e.target.dataset.id);
        if (activeProviderId === e.target.dataset.id) {
          // Fallback to Google Translate instead of builtin
          activeProviderId = "google-translate";
        }
        renderProviderList();
        saveSettings();
      }
    });
  });

  providerListEl.querySelectorAll(".btn-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const p = providers.find((item) => item.id === e.target.dataset.id);
      if (p) openProviderForm(p);
    });
  });
}

function getProviderInfo(type) {
  switch (type) {
    case "gemini":
      return {
        link: "https://aistudio.google.com/app/apikey",
        text: "Google AI Studio"
      };
    case "openai":
      return {
        link: "https://platform.openai.com/api-keys",
        text: "OpenAI Platform"
      };
    case "openrouter":
      return {
        link: "https://openrouter.ai/keys",
        text: "OpenRouter"
      };
    case "deepl":
      return {
        link: "https://www.deepl.com/your-account/keys",
        text: "DeepL Account"
      };
    case "groq":
      return {
        link: "https://console.groq.com/keys",
        text: "Groq Console"
      };
    default:
      return null;
  }
}

/**
 * Fetch the list of models the provider actually serves for these
 * credentials. Returns [] shape varies; normalized to an array of ids.
 */
async function fetchProviderModels(type, { apiKey = "", baseUrl = "" } = {}) {
  if (type === "gemini") {
    if (!apiKey) throw new Error("API key required to list models");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
    return (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter(
        (n) =>
          /^(gemini|gemma)/i.test(n) &&
          !/(tts|image|robotics|omni|transcribe|computer-use|lyria|customtools|aqa|embedding|learnlm|bidi)/i.test(
            n
          )
      );
  }

  const bases = {
    openai: baseUrl || "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    groq: "https://api.groq.com/openai/v1",
    ollama: baseUrl || "http://localhost:11434/v1",
    codex: baseUrl || "http://localhost:8787/v1",
    custom: baseUrl
  };
  const base = bases[type];
  if (!base) throw new Error("Base URL required to list models");

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${base.replace(/\/$/, "")}/models`, { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return (data.data || [])
    .map((m) => m.id)
    .filter(
      (id) =>
        id &&
        !/(tts|whisper|dall-e|embedding|moderation|audio|realtime|transcribe|image)/i.test(
          id
        )
    );
}

async function loadModelsIntoDatalist() {
  const type = formType.value;
  const apiKey = document.querySelector("#field-apiKey")?.value.trim() || "";
  const baseUrl = document.querySelector("#field-baseUrl")?.value.trim() || "";
  const btn = document.querySelector("#btn-load-models");
  const hint = document.querySelector("#model-load-hint");
  const datalist = document.querySelector("#model-datalist");
  if (!btn || !datalist) return;

  btn.disabled = true;
  btn.textContent = "…";
  if (hint) hint.textContent = i18n.t("popup.loadingModels") || "Loading…";

  try {
    const models = await fetchProviderModels(type, { apiKey, baseUrl });
    datalist.innerHTML = models
      .map((m) => `<option value="${m}"></option>`)
      .join("");
    if (hint) {
      hint.textContent = models.length
        ? `${models.length} models — ${models.slice(0, 3).join(", ")}${models.length > 3 ? "…" : ""}`
        : "No models returned";
    }
  } catch (err) {
    if (hint) hint.textContent = `⚠ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "↻";
  }
}

/**
 * Model input + load button + datalist so users can pick from the models
 * their key actually serves, while still allowing free text.
 */
function modelFieldHtml(model, placeholder, hint = "") {
  return `
      <div class="bt-field">
        <label>Model</label>
        <div class="bt-model-row">
          <input type="text" id="field-model" class="bt-input" list="model-datalist" value="${model}" placeholder="${placeholder}" />
          <button type="button" id="btn-load-models" class="bt-button-small" title="Load available models">↻</button>
        </div>
        <datalist id="model-datalist"></datalist>
        <small id="model-load-hint" class="bt-hint">${hint}</small>
      </div>`;
}

function renderFormFields(type, config = {}) {
  formDynamicFields.innerHTML = "";

  // Info Link
  const info = getProviderInfo(type);
  if (info) {
    const infoDiv = document.createElement("div");
    infoDiv.className = "bt-provider-help";
    infoDiv.innerHTML = `
      <a href="${info.link}" target="_blank" class="bt-link">${i18n.t("popup.getApiKey")} (${info.text}) ↗</a>
    `;
    formDynamicFields.appendChild(infoDiv);
  }

  if (type === "gemini") {
    const model = config.model || "gemini-3.1-flash-lite";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>API Key</label>
        <input type="password" id="field-apiKey" class="bt-input api-key-input" value="${config.apiKey || ""}" />
      </div>
      ${modelFieldHtml(model, "gemini-3.1-flash-lite")}
    `
    );
  } else if (type === "openai") {
    const model = config.model || "gpt-4o-mini";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>API Key</label>
        <input type="password" id="field-apiKey" class="bt-input api-key-input" value="${config.apiKey || ""}" />
      </div>
      ${modelFieldHtml(model, "gpt-4o-mini")}
      <div class="bt-field">
        <label>Base URL (Optional)</label>
        <input type="text" id="field-baseUrl" class="bt-input" value="${config.baseUrl || ""}" placeholder="https://api.openai.com/v1" />
      </div>
    `
    );
  } else if (type === "openrouter") {
    const model = config.model || "openai/gpt-4o-mini";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>API Key</label>
        <input type="password" id="field-apiKey" class="bt-input api-key-input" value="${config.apiKey || ""}" />
      </div>
      ${modelFieldHtml(model, "openai/gpt-4o-mini")}
    `
    );
  } else if (type === "deepl") {
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>API Key</label>
        <input type="password" id="field-apiKey" class="bt-input api-key-input" value="${config.apiKey || ""}" />
      </div>
    `
    );
  } else if (type === "groq") {
    const model = config.model || "llama-3.3-70b-versatile";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>API Key</label>
        <input type="password" id="field-apiKey" class="bt-input api-key-input" value="${config.apiKey || ""}" />
      </div>
      ${modelFieldHtml(model, "llama-3.3-70b-versatile", "Lightning-fast inference")}
    `
    );
  } else if (type === "ollama") {
    const model = config.model || "llama3.1";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>Base URL</label>
        <input type="text" id="field-baseUrl" class="bt-input" value="${config.baseUrl || "http://localhost:11434/v1"}" placeholder="http://localhost:11434/v1" />
        <small style="color: #666;">Default Ollama endpoint</small>
      </div>
      ${modelFieldHtml(model, "llama3.1", "e.g., llama3.1, qwen2.5, mistral")}
    `
    );
  } else if (type === "codex") {
    const model = config.model || "codex-subscription";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>Base URL</label>
        <input type="text" id="field-baseUrl" class="bt-input" value="${config.baseUrl || "http://localhost:8787/v1"}" placeholder="http://localhost:8787/v1" />
        <small style="color: #666;">Requires <code>node scripts/codex-bridge.mjs</code> running — uses your local Codex CLI login, no API key</small>
      </div>
      ${modelFieldHtml(model, "codex-subscription", "codex-subscription, gpt-6-luna, gpt-6-astra…")}
    `
    );
  } else if (type === "custom") {
    const baseUrl = config.baseUrl || "";
    const model = config.model || "llama3.1";
    formDynamicFields.insertAdjacentHTML(
      "beforeend",
      `
      <div class="bt-field">
        <label>Base URL</label>
        <input type="text" id="field-baseUrl" class="bt-input" value="${baseUrl}" placeholder="https://api.example.com/v1" />
        <small style="color: #666;">OpenAI-compatible API endpoint</small>
      </div>
      ${modelFieldHtml(model, "llama3.1")}
      <div class="bt-field">
        <label>API Key (Optional)</label>
        <input type="password" id="field-apiKey" class="bt-input api-key-input" value="${config.apiKey || ""}" placeholder="Leave empty if not needed" />
      </div>
    `
    );
  }

  // Security Note
  formDynamicFields.insertAdjacentHTML(
    "beforeend",
    `
    <div class="bt-security-note">
      <span class="bt-icon-shield">🛡️</span> ${i18n.t("popup.securityNote")}
    </div>
  `
  );

  document
    .querySelector("#btn-load-models")
    ?.addEventListener("click", loadModelsIntoDatalist);
}

function openProviderForm(provider = null) {
  editingProviderId = provider ? provider.id : null;
  formTitle.textContent = provider
    ? i18n.t("popup.edit")
    : i18n.t("popup.addProvider");
  formType.value = provider ? provider.type : "gemini";
  formType.disabled = !!provider; // Cannot change type when editing
  formName.value = provider ? provider.name : "";

  renderFormFields(formType.value, provider ? provider.config : {});

  providerListEl.parentElement.hidden = true;
  providerForm.hidden = false;
}

function closeProviderForm() {
  providerForm.hidden = true;
  providerListEl.parentElement.hidden = false;
  editingProviderId = null;
}

function saveProviderFromForm() {
  const type = formType.value;
  const name = formName.value.trim() || type;
  const config = {};

  const apiKeyEl = document.querySelector("#field-apiKey");
  if (apiKeyEl) config.apiKey = apiKeyEl.value.trim();

  const modelEl = document.querySelector("#field-model");
  if (modelEl) config.model = modelEl.value;

  const baseUrlEl = document.querySelector("#field-baseUrl");
  if (baseUrlEl) config.baseUrl = baseUrlEl.value.trim();

  if (editingProviderId) {
    // Update
    const idx = providers.findIndex((p) => p.id === editingProviderId);
    if (idx !== -1) {
      providers[idx].name = name;
      providers[idx].config = config;
    }
  } else {
    // Create
    const newId = crypto.randomUUID();
    providers.push({
      id: newId,
      type,
      name,
      config
    });
    // If it's the first custom provider, maybe set it as default? No, keep builtin default.
  }

  saveSettings();
  renderProviderList();
  closeProviderForm();
}

// Event Listeners for Form
btnAddProvider.addEventListener("click", () => openProviderForm(null));
btnFormCancel.addEventListener("click", closeProviderForm);
btnFormSave.addEventListener("click", saveProviderFromForm);
formType.addEventListener("change", () => renderFormFields(formType.value));

// ============================================
// TTS Provider Logic
// ============================================

const ttsProviderListEl = document.querySelector("#tts-provider-list");
const btnAddTTSProvider = document.querySelector("#btn-add-tts-provider");
const ttsProviderForm = document.querySelector("#tts-provider-form");
const ttsFormTitle = document.querySelector("#tts-form-title");
const ttsFormName = document.querySelector("#tts-form-name");
const ttsFormUrl = document.querySelector("#tts-form-url");
const btnTTSFormCancel = document.querySelector("#tts-form-cancel");
const btnTTSFormSave = document.querySelector("#tts-form-save");

function renderTTSProviderList() {
  if (!ttsProviderListEl) return;
  ttsProviderListEl.innerHTML = "";

  // Default Google TTS (cannot be deleted)
  const googleTTS = {
    id: "google-tts",
    name: "Google TTS",
    type: "google",
    readonly: true
  };

  // Combine default and custom
  const allProviders = [googleTTS, ...ttsProviders];
  setNavBadge("nav-badge-tts", allProviders.length);

  allProviders.forEach((p) => {
    const isActive = p.id === activeTTSProviderId;

    const el = document.createElement("div");
    el.className = `bt-provider-item ${isActive ? "active" : ""}`;

    // Actions
    let actionsHtml = "";
    if (isActive) {
      actionsHtml += `<span class="bt-badge-active">${i18n.t("popup.active")}</span>`;
    } else {
      actionsHtml += `<button class="bt-btn-text btn-set-active-tts" data-id="${p.id}">${i18n.t("popup.use")}</button>`;
    }

    if (!p.readonly) {
      actionsHtml += `<button class="bt-btn-text btn-edit-tts" data-id="${p.id}">${i18n.t("popup.edit")}</button>`;
      actionsHtml += `<button class="bt-btn-text btn-delete-tts" data-id="${p.id}">${i18n.t("popup.delete")}</button>`;
    }

    el.innerHTML = `
      <div class="bt-provider-info">
        <div class="bt-provider-name">${p.name}</div>
        <div class="bt-provider-type">${p.type === "google" ? "Standard" : "Custom URL"}</div>
      </div>
      <div class="bt-provider-actions">
        ${actionsHtml}
      </div>
    `;
    ttsProviderListEl.appendChild(el);
  });

  // Attach events
  ttsProviderListEl.querySelectorAll(".btn-set-active-tts").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      activeTTSProviderId = e.target.dataset.id;
      renderTTSProviderList();
      saveSettings();
    });
  });

  ttsProviderListEl.querySelectorAll(".btn-delete-tts").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (confirm("Delete this TTS provider?")) {
        ttsProviders = ttsProviders.filter((p) => p.id !== e.target.dataset.id);
        if (activeTTSProviderId === e.target.dataset.id) {
          activeTTSProviderId = "google-tts";
        }
        renderTTSProviderList();
        saveSettings();
      }
    });
  });

  ttsProviderListEl.querySelectorAll(".btn-edit-tts").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const p = ttsProviders.find((item) => item.id === e.target.dataset.id);
      if (p) openTTSProviderForm(p);
    });
  });
}

function openTTSProviderForm(provider = null) {
  editingTTSProviderId = provider ? provider.id : null;
  ttsFormTitle.textContent = provider
    ? "Edit TTS Provider"
    : "Add TTS Provider";
  ttsFormName.value = provider ? provider.name : "";
  ttsFormUrl.value = provider ? provider.url : "";

  ttsProviderListEl.parentElement.hidden = true;
  ttsProviderForm.hidden = false;
}

function closeTTSProviderForm() {
  ttsProviderForm.hidden = true;
  ttsProviderListEl.parentElement.hidden = false;
  editingTTSProviderId = null;
}

function saveTTSProviderFromForm() {
  const name = ttsFormName.value.trim() || "Custom TTS";
  const url = ttsFormUrl.value.trim();

  if (!url) {
    alert("URL Template is required");
    return;
  }

  if (editingTTSProviderId) {
    const idx = ttsProviders.findIndex((p) => p.id === editingTTSProviderId);
    if (idx !== -1) {
      ttsProviders[idx].name = name;
      ttsProviders[idx].url = url;
    }
  } else {
    const newId = crypto.randomUUID();
    ttsProviders.push({
      id: newId,
      type: "custom",
      name,
      url
    });
  }

  saveSettings();
  renderTTSProviderList();
  closeTTSProviderForm();
}

if (btnAddTTSProvider)
  btnAddTTSProvider.addEventListener("click", () => openTTSProviderForm(null));
if (btnTTSFormCancel)
  btnTTSFormCancel.addEventListener("click", closeTTSProviderForm);
if (btnTTSFormSave)
  btnTTSFormSave.addEventListener("click", saveTTSProviderFromForm);

function updateSettingsVisibility() {
  if (enabledCheckbox.checked) {
    settingsContainer.removeAttribute("disabled");
  } else {
    settingsContainer.setAttribute("disabled", "true");
  }
}

function toggleInstantSettings() {
  if (!instantEnabledCheckbox || !instantSettings) return;
  instantSettings.classList.toggle(
    "bt-feature-off",
    !instantEnabledCheckbox.checked
  );
}

function updateShortcutPreview() {
  if (!shortcutPreview) return;

  const parts = [];
  if (shortcutCtrlCheckbox.checked) parts.push("Ctrl");
  if (shortcutShiftCheckbox.checked) parts.push("Shift");
  if (shortcutAltCheckbox.checked) parts.push("Alt");

  const key = shortcutKeyInput.value.toUpperCase() || "I";
  parts.push(key);

  const shortcut = parts.join("+");
  const macShortcut = shortcut.replace("Ctrl", "Cmd");

  shortcutPreview.textContent = `${shortcut} (${macShortcut} on Mac)`;
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: "get-settings" });

  populateSelects();

  if (res?.ok) {
    enabledCheckbox.checked = res.settings.enabled !== false;
    nativeSelect.value = res.settings.nativeLanguageCode || "vi";
    targetSelect.value = res.settings.targetLanguageCode || "en";
    savedTargetLanguageCode = targetSelect.value;

    // Migration: Convert old preferNativeAsSource to new useAutoDetect (reversed logic)
    // Old true (prefer native) → New false (fixed direction)
    // Old false (auto-detect) → New true (auto-detect)
    const oldValue = res.settings.preferNativeAsSource;
    const newValue = res.settings.useAutoDetect;
    if (newValue === undefined && oldValue !== undefined) {
      // Migrate from old setting (reverse logic)
      autoDetect.checked = !oldValue;
    } else {
      autoDetect.checked = newValue === true;
    }

    confirmModal.checked = res.settings.showConfirmModal !== false;
    currentAliases = res.settings.aliases || {};

    const theme = res.settings.theme || "auto";
    if (themeSelect) themeSelect.value = theme;
    applyTheme(theme);

    const lang = res.settings.interfaceLanguage || "vi";
    updateLangToggleUI(lang);
    i18n.setLanguage(lang);
    populateSelects();
    translateUI();

    if (quickTarget) {
      quickTarget.value = res.settings.targetLanguageCode || "en";
    }

    if (instantEnabledCheckbox) {
      instantEnabledCheckbox.checked =
        res.settings.instantTranslateEnabled || false;
    }
    if (instantDelayInput) {
      instantDelayInput.value = (res.settings.instantDelay || 3000) / 1000;
    }
    currentDomains = res.settings.instantDomains || [];

    // Load Providers
    providers = res.settings.providers || [
      {
        id: "builtin",
        type: "gemini-nano",
        name: "Chrome Built-in AI",
        config: {}
      }
    ];
    activeProviderId = res.settings.activeProviderId || "builtin";

    // Load TTS Providers
    ttsProviders = res.settings.ttsProviders || [];
    activeTTSProviderId = res.settings.activeTTSProviderId || "google-tts";

    // Load Custom Prompt
    if (userCustomPrompt) {
      userCustomPrompt.value = res.settings.customPrompt || "";
      updateCharCounter();
    }
    if (systemPromptDisplay) {
      // Show user-friendly version of system prompt
      systemPromptDisplay.value =
        "You are a professional translator. Translate the user's text from source language to target language. Return ONLY the translated text.";
    }
    if (translationStyleSelect) {
      translationStyleSelect.value = res.settings.translationStyle || "natural";
    }
    currentGlossary = res.settings.glossary || {};

    // Load Keyboard Shortcut
    const shortcut = res.settings.instantToggleShortcut || {
      key: "I",
      ctrl: true,
      shift: true,
      alt: false
    };
    if (shortcutCtrlCheckbox) shortcutCtrlCheckbox.checked = shortcut.ctrl;
    if (shortcutShiftCheckbox) shortcutShiftCheckbox.checked = shortcut.shift;
    if (shortcutAltCheckbox) shortcutAltCheckbox.checked = shortcut.alt;
    if (shortcutKeyInput) shortcutKeyInput.value = shortcut.key.toUpperCase();
    updateShortcutPreview();

    // Load Hover Translate settings
    hoverTranslateEnabled.checked = res.settings.hoverTranslateEnabled || false;
    hoverUniqueMode.checked = res.settings.hoverUniqueMode !== false; // Default true
    hoverSettings.classList.toggle(
      "bt-feature-off",
      !hoverTranslateEnabled.checked
    );
    hoverMode.value = res.settings.hoverTranslateMode || "inject";
    hoverModifier.value = res.settings.hoverModifierKey || "ctrl";
    hoverGranularity.value = res.settings.hoverTranslateGranularity || "line";

    // Load hover toggle shortcut
    const hoverShortcut = res.settings.hoverToggleShortcut || {
      key: "H",
      ctrl: true,
      shift: true,
      alt: false
    };
    hoverShortcutCtrl.checked = hoverShortcut.ctrl;
    hoverShortcutShift.checked = hoverShortcut.shift;
    hoverShortcutAlt.checked = hoverShortcut.alt;
    hoverShortcutKey.value = hoverShortcut.key;
    updateHoverShortcutPreview();

    // Load screenshot-translate shortcut
    const shotShortcut = res.settings.screenshotShortcut || {
      key: "S",
      ctrl: true,
      shift: true,
      alt: false
    };
    if (shotShortcutCtrl) shotShortcutCtrl.checked = shotShortcut.ctrl;
    if (shotShortcutShift) shotShortcutShift.checked = shotShortcut.shift;
    if (shotShortcutAlt) shotShortcutAlt.checked = shotShortcut.alt;
    if (shotShortcutKey) shotShortcutKey.value = shotShortcut.key;
    if (shotModel) shotModel.value = res.settings.screenshotModel || "";
    populateShotProviders(res.settings.providers || []);
    if (shotProvider)
      shotProvider.value = res.settings.screenshotProviderId || "";
    updateShotModelPlaceholder();
    updateShotShortcutPreview();

    // Load style settings
    const hoverStyle = res.settings.hoverInjectStyle || {};
    // hoverBgColor.value = hoverStyle.backgroundColor || '#667eea'; // Removed
    hoverTextColor.value = hoverStyle.textColor || "#0c69e4";
    hoverFontSize.value = hoverStyle.fontSize || "0.95em";
    hoverShowIcon.checked = hoverStyle.showIcon !== false;
    hoverUnderline.checked = hoverStyle.underline || false;

    // Load hover domains
    currentHoverDomains = res.settings.hoverTranslateDomains || [];
    renderHoverDomainList(currentHoverDomains);
  } else {
    // Defaults
    enabledCheckbox.checked = true;
    nativeSelect.value = "vi";
    targetSelect.value = "en";
    autoDetect.checked = false; // Default: fixed direction
    confirmModal.checked = true;
    currentAliases = {};

    updateLangToggleUI("en");
    i18n.setLanguage("en");
    populateSelects();
    translateUI();

    if (instantEnabledCheckbox) instantEnabledCheckbox.checked = false;
    if (instantDelayInput) instantDelayInput.value = 3;
    currentDomains = [];

    providers = [
      {
        id: "builtin",
        type: "gemini-nano",
        name: "Chrome Built-in AI",
        config: {}
      }
    ];
    activeProviderId = "builtin";

    ttsProviders = [];
    activeTTSProviderId = "google-tts";

    // Default custom prompt
    if (userCustomPrompt) {
      userCustomPrompt.value = "";
      updateCharCounter();
    }
    if (systemPromptDisplay) {
      // Show user-friendly version of system prompt
      systemPromptDisplay.value =
        "You are a professional translator. Translate the user's text from source language to target language. Return ONLY the translated text.";
    }

    // Default keyboard shortcut
    if (shortcutCtrlCheckbox) shortcutCtrlCheckbox.checked = true;
    if (shortcutShiftCheckbox) shortcutShiftCheckbox.checked = true;
    if (shortcutAltCheckbox) shortcutAltCheckbox.checked = false;
    if (shortcutKeyInput) shortcutKeyInput.value = "I";
    updateShortcutPreview();
  }

  renderAliases();
  renderGlossary();
  renderDomains();
  renderProviderList();
  renderTTSProviderList();
  updateSettingsVisibility();
  toggleInstantSettings();
}

async function saveSettings() {
  const settings = {
    enabled: enabledCheckbox.checked,
    nativeLanguageCode: nativeSelect.value,
    targetLanguageCode: targetSelect.value,
    // A changed explicit default must win over the popup's remembered target
    ...(savedTargetLanguageCode !== null &&
    savedTargetLanguageCode !== targetSelect.value
      ? { selectionLastTarget: targetSelect.value }
      : {}),
    useAutoDetect: autoDetect.checked,
    showConfirmModal: confirmModal.checked,
    aliases: currentAliases,
    theme: themeSelect?.value || "auto",
    interfaceLanguage: document
      .querySelector("#lang-toggle .active")
      .getAttribute("data-lang"),
    instantTranslateEnabled: instantEnabledCheckbox?.checked || false,
    instantDelay: (parseInt(instantDelayInput?.value, 10) || 3) * 1000,
    instantDomains: currentDomains,
    // New Provider Structure
    providers,
    activeProviderId,
    // TTS Settings
    ttsProviders,
    activeTTSProviderId,
    // Custom Prompt
    customPrompt: userCustomPrompt?.value || "",
    translationStyle: translationStyleSelect?.value || "natural",
    glossary: currentGlossary,
    // Keyboard shortcut
    instantToggleShortcut: {
      key: shortcutKeyInput?.value.toUpperCase() || "I",
      ctrl: shortcutCtrlCheckbox?.checked || false,
      shift: shortcutShiftCheckbox?.checked || false,
      alt: shortcutAltCheckbox?.checked || false
    },
    screenshotProviderId: shotProvider?.value || "",
    screenshotModel: shotModel?.value.trim() || "",
    screenshotShortcut: {
      key: shotShortcutKey?.value.toUpperCase() || "S",
      ctrl: shotShortcutCtrl?.checked || false,
      shift: shotShortcutShift?.checked || false,
      alt: shotShortcutAlt?.checked || false
    },
    // Hover Translate settings
    hoverTranslateEnabled: hoverTranslateEnabled?.checked || false,
    hoverUniqueMode: hoverUniqueMode?.checked !== false,
    hoverTranslateMode: hoverMode?.value || "inject",
    hoverTranslateGranularity: hoverGranularity?.value || "line",
    hoverModifierKey: hoverModifier?.value || "ctrl",
    hoverToggleShortcut: {
      key: hoverShortcutKey?.value.toUpperCase() || "O",
      ctrl: hoverShortcutCtrl?.checked || false,
      shift: hoverShortcutShift?.checked || false,
      alt: hoverShortcutAlt?.checked || false
    },
    hoverInjectStyle: {
      // backgroundColor: hoverBgColor?.value || '#667eea', // Removed
      textColor: hoverTextColor?.value || "#0c69e4",
      fontSize: hoverFontSize?.value || "0.95em",
      showIcon: hoverShowIcon?.checked !== false,
      underline: hoverUnderline?.checked || false
    },
    hoverTranslateDomains: currentHoverDomains || []
  };

  const res = await chrome.runtime.sendMessage({
    type: "set-settings",
    settings
  });

  if (res?.ok) savedTargetLanguageCode = targetSelect.value;

  if (res?.ok && saveStatus) {
    saveStatus.textContent = `✓ ${i18n.t("popup.saved")}`;
    saveStatus.classList.add("visible");
    clearTimeout(saveStatus._timer);
    saveStatus._timer = setTimeout(
      () => saveStatus.classList.remove("visible"),
      1600
    );
  }
}

addAliasBtn.addEventListener("click", () => {
  const key = aliasKeyInput.value.trim();
  const value = aliasValueInput.value.trim();
  if (key && value) {
    currentAliases[key] = value;
    aliasKeyInput.value = "";
    aliasValueInput.value = "";
    renderAliases();
    saveSettings();
  }
});

addGlossaryBtn?.addEventListener("click", () => {
  const key = glossaryKeyInput.value.trim();
  const value = glossaryValueInput.value.trim();
  if (key && value) {
    currentGlossary[key] = value;
    glossaryKeyInput.value = "";
    glossaryValueInput.value = "";
    renderGlossary();
    saveSettings();
  }
});

translationStyleSelect?.addEventListener("change", saveSettings);

enabledCheckbox.addEventListener("change", () => {
  updateSettingsVisibility();
  saveSettings();
});

nativeSelect.addEventListener("change", saveSettings);
targetSelect.addEventListener("change", saveSettings);
themeSelect?.addEventListener("change", () => {
  applyTheme(themeSelect.value);
  saveSettings();
});

autoDetect.addEventListener("change", saveSettings);
confirmModal.addEventListener("change", saveSettings);

const langToggle = document.querySelector("#lang-toggle");

langToggle.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-lang")) {
    const lang = e.target.getAttribute("data-lang");
    i18n.setLanguage(lang);
    translateUI();
    populateSelects();
    renderAliases();
    renderDomains();
    renderProviderList();
    updateLangToggleUI(lang);
    saveSettings();
  }
});

function updateLangToggleUI(lang) {
  langToggle.querySelectorAll("span[data-lang]").forEach((span) => {
    if (span.getAttribute("data-lang") === lang) {
      span.classList.add("active");
    } else {
      span.classList.remove("active");
    }
  });
}

if (instantEnabledCheckbox) {
  instantEnabledCheckbox.addEventListener("change", () => {
    toggleInstantSettings();
    saveSettings();
  });
}

if (instantDelayInput) {
  instantDelayInput.addEventListener("change", saveSettings);
}

if (addDomainBtn && newDomainInput) {
  addDomainBtn.addEventListener("click", () => {
    const domain = newDomainInput.value.trim();
    if (domain && !currentDomains.some((d) => d.domain === domain)) {
      currentDomains.push({ domain, enabled: true, position: "auto" });
      newDomainInput.value = "";
      renderDomains();
      saveSettings();
    }
  });
}

// Keyboard Shortcut Event Listeners
if (shortcutCtrlCheckbox) {
  shortcutCtrlCheckbox.addEventListener("change", () => {
    updateShortcutPreview();
    saveSettings();
  });
}

if (shortcutShiftCheckbox) {
  shortcutShiftCheckbox.addEventListener("change", () => {
    updateShortcutPreview();
    saveSettings();
  });
}

if (shortcutAltCheckbox) {
  shortcutAltCheckbox.addEventListener("change", () => {
    updateShortcutPreview();
    saveSettings();
  });
}

if (shortcutKeyInput) {
  shortcutKeyInput.addEventListener("input", (e) => {
    // Only allow single letter
    e.target.value = e.target.value
      .replace(/[^a-zA-Z]/g, "")
      .toUpperCase()
      .slice(0, 1);
    updateShortcutPreview();
  });

  shortcutKeyInput.addEventListener("change", saveSettings);
}

document.querySelectorAll(".bt-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".bt-tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".bt-tab-content")
      .forEach((c) => c.classList.remove("active"));

    tab.classList.add("active");
    const contentId = "tab-" + tab.dataset.tab;
    document.getElementById(contentId).classList.add("active");
  });
});

// Character counter for custom prompt
function updateCharCounter() {
  if (promptCharCount && userCustomPrompt) {
    promptCharCount.textContent = userCustomPrompt.value.length;
  }
}

if (userCustomPrompt) {
  userCustomPrompt.addEventListener("input", () => {
    updateCharCounter();
    saveSettings();
  });
}

// Hover Translate Event Listeners
if (hoverTranslateEnabled) {
  hoverTranslateEnabled.addEventListener("change", () => {
    hoverSettings.classList.toggle(
      "bt-feature-off",
      !hoverTranslateEnabled.checked
    );
    saveSettings();
  });
}

// Auto-save for other hover settings
if (hoverUniqueMode) hoverUniqueMode.addEventListener("change", saveSettings);
if (hoverShowIcon) hoverShowIcon.addEventListener("change", saveSettings);
if (hoverUnderline) hoverUnderline.addEventListener("change", saveSettings);
if (hoverFontSize) hoverFontSize.addEventListener("change", saveSettings);
if (hoverTextColor) hoverTextColor.addEventListener("change", saveSettings);
if (hoverMode) hoverMode.addEventListener("change", saveSettings);
if (hoverGranularity) hoverGranularity.addEventListener("change", saveSettings);
if (hoverModifier) hoverModifier.addEventListener("change", saveSettings);

if (manageHoverDomains) {
  manageHoverDomains.addEventListener("click", () => {
    hoverDomainListSection.hidden = !hoverDomainListSection.hidden;
  });
}

if (addHoverDomain) {
  addHoverDomain.addEventListener("click", () => {
    const domain = newHoverDomain.value.trim();
    if (!domain) return;

    chrome.runtime.sendMessage({ type: "get-settings" }, (res) => {
      if (!res.ok) return;
      const settings = res.settings;

      // Initialize array if undefined
      if (!settings.hoverTranslateDomains) {
        settings.hoverTranslateDomains = [];
      }

      if (!settings.hoverTranslateDomains.find((d) => d.domain === domain)) {
        settings.hoverTranslateDomains.push({ domain, enabled: true });
        currentHoverDomains = settings.hoverTranslateDomains;
        chrome.runtime.sendMessage({ type: "set-settings", settings }, () => {
          renderHoverDomainList(settings.hoverTranslateDomains);
          newHoverDomain.value = "";
        });
      }
    });
  });
}

if (
  hoverShortcutCtrl &&
  hoverShortcutShift &&
  hoverShortcutAlt &&
  hoverShortcutKey
) {
  [
    hoverShortcutCtrl,
    hoverShortcutShift,
    hoverShortcutAlt,
    hoverShortcutKey
  ].forEach((el) => {
    el.addEventListener("change", updateHoverShortcutPreview);
    el.addEventListener("input", updateHoverShortcutPreview);
  });
}

if (
  shotShortcutCtrl &&
  shotShortcutShift &&
  shotShortcutAlt &&
  shotShortcutKey
) {
  [shotShortcutCtrl, shotShortcutShift, shotShortcutAlt].forEach((el) =>
    el.addEventListener("change", () => {
      updateShotShortcutPreview();
      saveSettings();
    })
  );
  shotShortcutKey.addEventListener("input", (e) => {
    e.target.value = e.target.value
      .replace(/[^a-zA-Z]/g, "")
      .toUpperCase()
      .slice(0, 1);
    updateShotShortcutPreview();
  });
  shotShortcutKey.addEventListener("change", saveSettings);

  shotModel?.addEventListener("change", saveSettings);
  shotProvider?.addEventListener("change", () => {
    updateShotModelPlaceholder();
    saveSettings();
  });
}

// Screenshot translation only works with Gemini vision today — list the
// configured Gemini providers so users can pick which key/model it uses.
let shotProviderModels = {}; // providerId -> configured model
function populateShotProviders(providers) {
  if (!shotProvider) return;
  shotProviderModels = {};
  shotProvider.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = i18n.t("popup.screenshotProviderAuto");
  shotProvider.appendChild(auto);
  providers
    .filter((p) => p.type === "gemini")
    .forEach((p) => {
      shotProviderModels[p.id] = p.config?.model || "";
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      shotProvider.appendChild(opt);
    });
}

function updateShotModelPlaceholder() {
  if (!shotModel || !shotProvider) return;
  const model = shotProviderModels[shotProvider.value];
  shotModel.placeholder =
    model ||
    (shotProvider.value
      ? i18n.t("popup.screenshotModel")
      : "gemini-3.1-flash-lite");
}

function updateShotShortcutPreview() {
  if (!shotShortcutPreview) return;
  const parts = [];
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  if (shotShortcutCtrl?.checked) parts.push(isMac ? "Cmd" : "Ctrl");
  if (shotShortcutShift?.checked) parts.push("Shift");
  if (shotShortcutAlt?.checked) parts.push("Alt");
  parts.push(shotShortcutKey?.value.toUpperCase() || "S");

  shotShortcutPreview.textContent = parts.join("+");
}

// Hover Translate Helper Functions
function updateHoverShortcutPreview() {
  if (!hoverShortcutPreview) return;
  const parts = [];
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  if (hoverShortcutCtrl?.checked) parts.push(isMac ? "Cmd" : "Ctrl");
  if (hoverShortcutShift?.checked) parts.push("Shift");
  if (hoverShortcutAlt?.checked) parts.push("Alt");
  parts.push(hoverShortcutKey?.value.toUpperCase() || "H");

  hoverShortcutPreview.textContent = parts.join("+");
}

function renderHoverDomainList(domains) {
  if (!hoverDomainList) return;
  hoverDomainList.innerHTML = "";
  if (hoverDomainCount) hoverDomainCount.textContent = domains.length;
  updateAutomationBadge();

  domains.forEach((d, index) => {
    const item = document.createElement("div");
    item.className = "bt-domain-item";
    item.innerHTML = `
      <div class="bt-domain-info">
        <span class="bt-domain-name">${d.domain}</span>
      </div>
      <div class="bt-domain-actions">
        <label class="bt-domain-toggle">
          <input type="checkbox" ${d.enabled ? "checked" : ""} data-index="${index}" class="hover-domain-toggle">
          <span>Active</span>
        </label>
        <button class="bt-button-icon remove-hover-domain" data-index="${index}">×</button>
      </div>
    `;
    hoverDomainList.appendChild(item);
  });

  document.querySelectorAll(".hover-domain-toggle").forEach((toggle) => {
    toggle.addEventListener("change", (e) => {
      const index = parseInt(e.target.dataset.index);
      chrome.runtime.sendMessage({ type: "get-settings" }, (res) => {
        const settings = res.settings;
        settings.hoverTranslateDomains[index].enabled = e.target.checked;
        currentHoverDomains = settings.hoverTranslateDomains;
        chrome.runtime.sendMessage({ type: "set-settings", settings });
      });
    });
  });

  document.querySelectorAll(".remove-hover-domain").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = parseInt(e.target.dataset.index);
      chrome.runtime.sendMessage({ type: "get-settings" }, (res) => {
        const settings = res.settings;
        settings.hoverTranslateDomains.splice(index, 1);
        currentHoverDomains = settings.hoverTranslateDomains;
        chrome.runtime.sendMessage({ type: "set-settings", settings }, () => {
          renderHoverDomainList(settings.hoverTranslateDomains);
        });
      });
    });
  });
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
      quickProvider.textContent = "";
    }
  } catch (err) {
    quickResultText.textContent = `${i18n.t("popup.translateFailed")}: ${err.message}`;
    quickProvider.textContent = "";
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

loadSettings();
displayVersion();
