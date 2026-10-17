import { createLabApi } from "./lab-api.js";
import { readSettings } from "../common/settings-storage.js";

const modules = [
  {
    id: "page",
    en: "Reading",
    vi: "Đọc trang",
    subEn: "Live pages · reading modes · budgets",
    subVi: "Trang động · chế độ đọc · ngân sách",
    file: "page-controls.js",
    count: "03"
  },
  {
    id: "learning",
    en: "Vocabulary",
    vi: "Học từ",
    subEn: "Wordbook · dictionary · flashcards",
    subVi: "Sổ từ · từ điển · flashcards",
    file: "learning.js",
    count: "06"
  },
  {
    id: "writing",
    en: "Writing",
    vi: "Viết lại",
    subEn: "Rewrite · compare · voice input",
    subVi: "Viết lại · so sánh · giọng nói",
    file: "writing.js",
    count: "02"
  },
  {
    id: "media",
    en: "Subtitles",
    vi: "Phụ đề",
    subEn: "Files · transcript · live captions",
    subVi: "Tệp · transcript · caption trực tiếp",
    file: "media.js",
    count: "05"
  },
  {
    id: "documents",
    en: "Documents",
    vi: "Tài liệu",
    subEn: "PDF reader · bilingual ePub",
    subVi: "Đọc PDF · ePub song ngữ",
    file: "documents.js",
    count: "02"
  },
  {
    id: "ocr",
    en: "Local OCR",
    vi: "OCR local",
    subEn: "Preview · redact · recognize locally",
    subVi: "Xem trước · che ảnh · nhận dạng local",
    file: "ocr.js",
    count: "01"
  },
  {
    id: "privacy",
    en: "Privacy",
    vi: "Riêng tư",
    subEn: "Local-only · consent · retention",
    subVi: "Chỉ local · xác nhận · thời hạn lưu",
    file: "privacy.js",
    count: "01"
  }
];

const workspace = document.getElementById("lab-workspace");
const navigation = document.getElementById("lab-navigation");
const target = document.getElementById("lab-target");
let settings = await readSettings();
let language = settings.interfaceLanguage === "vi" ? "vi" : "en";
let selected = modules.some((module) => module.id === location.hash.slice(1))
  ? location.hash.slice(1)
  : "page";
let cleanup;
let generation = 0;
let api;

function status(message, kind) {
  const output = document.getElementById("lab-status");
  output.hidden = !message;
  output.textContent = message;
  output.dataset.kind = kind;
}

function createApi() {
  api = createLabApi({
    language,
    selectedTab: () => target.value,
    onStatus: status
  });
}

async function refreshTabs() {
  const previous = target.value;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = api.t("Choose a website tab", "Chọn tab website");
  target.replaceChildren(placeholder);
  for (const tab of await api.tabs()) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = tab.title || tab.url;
    target.append(option);
  }
  if ([...target.options].some((option) => option.value === previous))
    target.value = previous;
}

function renderNavigation() {
  navigation.replaceChildren();
  for (const module of modules) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.active = String(selected === module.id);
    if (selected === module.id) button.setAttribute("aria-current", "page");
    const label = document.createElement("span");
    label.textContent = api.t(module.en, module.vi);
    const count = document.createElement("small");
    count.textContent = module.count;
    button.append(label, count);
    button.addEventListener("click", () => {
      location.hash = module.id;
    });
    navigation.append(button);
  }
}

function renderChrome() {
  document.documentElement.lang = language;
  document.getElementById("lab-language").value = language;
  document.getElementById("lab-nav-label").textContent = api.t(
    "EXPERIMENTS",
    "THỬ NGHIỆM"
  );
  document.getElementById("lab-build-label").textContent = api.t(
    "EXPERIMENTAL BUILD · OPT-IN",
    "BẢN THỬ NGHIỆM · TỰ CHỌN BẬT"
  );
  document.getElementById("lab-heading").textContent = api.t(
    "Try what comes next.",
    "Thử những điều sắp tới."
  );
  document.getElementById("lab-description").textContent = api.t(
    "Read, learn and write across languages. New tools stay off until you choose to enable them.",
    "Đọc, học và viết qua các ngôn ngữ. Công cụ mới chỉ hoạt động khi bro tự bật."
  );
  document.getElementById("lab-target-label").textContent = api.t(
    "Website tab",
    "Tab website"
  );
  document.getElementById("lab-refresh-tabs").textContent = api.t(
    "Refresh tabs",
    "Làm mới tab"
  );
  document.getElementById("lab-local-note").textContent = api.t(
    "Off by default. Enable one workspace at a time.",
    "Mặc định tắt. Bật từng khu làm việc để thử."
  );
  document.getElementById("lab-settings").textContent = api.t(
    "Settings",
    "Cài đặt"
  );
  document.getElementById("lab-theme").textContent = api.t(
    "Light / Dark",
    "Sáng / Tối"
  );
  document.getElementById("lab-footer").textContent = api.t(
    "Experimental tools can fail. Website automation requires opt-in; translation still uses your configured provider. Local OCR does not make cloud text translation offline.",
    "Công cụ thử nghiệm có thể lỗi. Tự động trên website cần bật riêng; bản dịch vẫn dùng provider đã cấu hình. OCR local không làm phần dịch cloud chạy offline."
  );
  renderNavigation();
}

async function renderWorkspace() {
  const ownGeneration = ++generation;
  cleanup?.();
  cleanup = null;
  workspace.replaceChildren();
  workspace.setAttribute("aria-busy", "true");
  status("", "info");
  settings = await readSettings();
  if (ownGeneration !== generation) return;
  const module = modules.find((item) => item.id === selected);
  const heading = document.createElement("div");
  heading.className = "lab-workspace-heading";
  const title = document.createElement("h2");
  title.textContent = api.t(module.en, module.vi);
  const subtitle = document.createElement("p");
  subtitle.className = "lab-muted";
  subtitle.textContent = api.t(module.subEn, module.subVi);
  const intro = document.createElement("div");
  intro.append(title, subtitle);
  const enabled = settings.labFeatures?.[module.id] === true;
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = enabled;
  toggle.id = `lab-enable-${module.id}`;
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      const current = await api.settings();
      await api.updateSettings({
        labFeatures: { ...current.labFeatures, [module.id]: toggle.checked }
      });
      await renderWorkspace();
    } catch (error) {
      toggle.checked = !toggle.checked;
      toggle.disabled = false;
      status(error.message, "error");
    }
  });
  const toggleLabel = api.field(
    api.t("Enable experiment", "Bật thử nghiệm"),
    toggle
  );
  toggleLabel.classList.add("lab-enable");
  heading.append(intro, toggleLabel);
  workspace.append(heading);
  if (!enabled) {
    const notice = document.createElement("div");
    notice.className = "lab-empty";
    const title = document.createElement("h3");
    title.textContent = api.t(
      "Your choice, your workspace.",
      "Bro chọn, công cụ mới chạy."
    );
    const note = document.createElement("p");
    note.textContent = api.t(
      "Enable this experiment above to show its controls. It does not enable any paid provider or start sending data automatically.",
      "Bật thử nghiệm ở trên để mở công cụ. Thao tác này không đăng ký provider trả phí hay tự gửi dữ liệu."
    );
    notice.append(title, note);
    workspace.append(notice);
    workspace.setAttribute("aria-busy", "false");
    return;
  }
  const panel = document.createElement("div");
  panel.className = "lab-panel";
  workspace.append(panel);
  try {
    const { mount } = await import(`./${module.file}`);
    if (ownGeneration !== generation) return;
    const unmount = await mount(panel, api);
    if (ownGeneration !== generation) {
      if (typeof unmount === "function") unmount();
      return;
    }
    cleanup = typeof unmount === "function" ? unmount : null;
  } catch (error) {
    if (ownGeneration === generation) status(error.message, "error");
  } finally {
    if (ownGeneration === generation)
      workspace.setAttribute("aria-busy", "false");
  }
}

createApi();
renderChrome();
await refreshTabs();
await renderWorkspace();
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (!modules.some((module) => module.id === id)) return;
  selected = id;
  renderNavigation();
  renderWorkspace();
});
document
  .getElementById("lab-refresh-tabs")
  .addEventListener("click", () =>
    refreshTabs().catch((error) => status(error.message, "error"))
  );
document
  .getElementById("lab-language")
  .addEventListener("change", async (event) => {
    language = event.target.value;
    await api.updateSettings({ interfaceLanguage: language });
    createApi();
    renderChrome();
    await refreshTabs();
    await renderWorkspace();
  });
const storedTheme = await api.get("theme", "system");
if (storedTheme !== "system")
  document.documentElement.dataset.theme = storedTheme;
document.getElementById("lab-theme").addEventListener("click", async () => {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  await api.set("theme", next);
});
window.addEventListener("pagehide", () => {
  generation++;
  cleanup?.();
});
