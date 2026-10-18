import { readSettings, updateSettings } from "./settings-storage.js";
import { normalizeSiteProfiles } from "./site-profiles.js";
import { languageSynonymsToBcp47 } from "./language-map.js";

export async function mountProductivitySettings(container) {
  if (!container) return;
  const settings = await readSettings();
  const commands = await chrome.commands?.getAll?.();
  const shortcut = commands?.find(
    (command) => command.name === "quick-actions"
  )?.shortcut;
  const t = (en, vi) => (settings.interfaceLanguage === "vi" ? vi : en);
  const make = (tag, text, className = "") => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    node.className = className;
    return node;
  };
  const section = make("section", "", "bt-productivity");
  section.id = "website-profiles";
  const status = make("p");
  status.setAttribute("role", "status");
  const button = (text, action) => {
    const node = make("button", text, "bt-btn bt-btn-secondary");
    node.type = "button";
    node.addEventListener("click", async () => {
      node.disabled = true;
      try {
        await action();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        node.disabled = false;
      }
    });
    return node;
  };
  section.append(
    make("h3", t("Quick Actions", "Thao tác nhanh")),
    make(
      "p",
      t(
        `Select page text, then use Quick Actions (${shortcut || "unassigned — set a shortcut below"}) to translate, read or save a word. Sensitive inputs are excluded.`,
        `Bôi đen văn bản trang rồi mở Thao tác nhanh (${shortcut || "chưa gán — hãy đặt phím bên dưới"}) để dịch, đọc hoặc lưu từ. Không dùng trong vùng nhập liệu nhạy cảm.`
      )
    ),
    button(t("Change shortcut", "Đổi phím tắt"), () =>
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
    ),
    make(
      "p",
      t(
        "Translation checks warn about changed placeholders, links, code and numbers. Warnings are advisory, not a correctness score; no automatic corrections or extra provider requests.",
        "Kiểm tra bản dịch cảnh báo biến giữ chỗ, liên kết, code và số liệu bị đổi. Đây là gợi ý kiểm tra, không phải điểm chính xác; không tự sửa hay gọi thêm provider."
      )
    ),
    make("h3", t("Website translation profiles", "Cấu hình dịch theo website")),
    make(
      "p",
      t(
        "Defaults for translation languages, style and glossary on this website; explicit language choices and privacy restrictions still apply. Empty fields inherit current settings. No provider or credential changes.",
        "Ngôn ngữ, văn phong và thuật ngữ mặc định cho website này; lựa chọn ngôn ngữ thủ công và giới hạn riêng tư vẫn được ưu tiên. Ô trống dùng cài đặt chung. Không thay provider hoặc credentials."
      )
    )
  );
  const list = make("div"),
    form = make("form"),
    row = make("div", "", "bt-row");
  const field = (label, input) => {
    const wrapper = make("label", label, "bt-field");
    input.className = "bt-input";
    wrapper.append(input);
    return wrapper;
  };
  const host = make("input");
  host.required = true;
  host.placeholder = "github.com";
  host.maxLength = 253;
  host.autocomplete = "off";
  const language = (source) => {
    const select = make("select");
    select.append(new Option(t("Inherit", "Dùng cài đặt chung"), ""));
    if (source) select.append(new Option(t("Detect", "Tự nhận diện"), "auto"));
    const names = new Intl.DisplayNames(
      [settings.interfaceLanguage === "vi" ? "vi" : "en"],
      { type: "language" }
    );
    for (const code of [
      ...new Set(Object.values(languageSynonymsToBcp47))
    ].sort())
      select.append(new Option(`${names.of(code)} (${code})`, code));
    return select;
  };
  const source = language(true),
    target = language(false),
    style = make("select"),
    glossary = make("textarea");
  for (const [value, label] of [
    ["", t("Inherit", "Dùng cài đặt chung")],
    ["natural", t("Natural", "Tự nhiên")],
    ["formal", t("Formal", "Trang trọng")],
    ["literal", t("Literal", "Sát nghĩa")]
  ])
    style.append(new Option(label, value));
  glossary.rows = 4;
  glossary.maxLength = 50000;
  glossary.placeholder = "pull request = pull request\ncommit = commit";
  const subdomains = make("input"),
    enabled = make("input");
  subdomains.type = enabled.type = "checkbox";
  enabled.checked = true;
  row.append(
    field(t("Source", "Ngôn ngữ nguồn"), source),
    field(t("Target", "Ngôn ngữ đích"), target),
    field(t("Style", "Văn phong"), style)
  );
  form.append(
    field(t("Hostname (no URL/path)", "Hostname (không nhập URL/path)"), host),
    row,
    field(t("Include subdomains", "Gồm tên miền con"), subdomains),
    field(t("Enabled", "Bật"), enabled),
    field(
      t(
        "Glossary — term = translation, one per line",
        "Thuật ngữ — từ = bản dịch, mỗi dòng một cặp"
      ),
      glossary
    )
  );
  let editing = null;
  const reset = () => {
    form.reset();
    enabled.checked = true;
    editing = null;
  };
  const render = async () => {
    const current = await readSettings();
    list.replaceChildren();
    for (const profile of normalizeSiteProfiles(current.websiteProfiles)) {
      const item = make("div", "", "bt-profile-row");
      item.append(
        make(
          "p",
          `${profile.hostname}${profile.includeSubdomains ? " (+ subdomains)" : ""} · ${profile.sourceLanguage || "—"} → ${profile.targetLanguage || "—"} · ${profile.enabled ? t("On", "Bật") : t("Off", "Tắt")}`
        ),
        button(t("Edit", "Sửa"), () => {
          editing = profile.hostname;
          host.value = profile.hostname;
          source.value = profile.sourceLanguage;
          target.value = profile.targetLanguage;
          style.value = profile.translationStyle;
          enabled.checked = profile.enabled;
          subdomains.checked = profile.includeSubdomains;
          glossary.value = Object.entries(profile.glossary)
            .map(([a, b]) => `${a} = ${b}`)
            .join("\n");
          host.focus();
        }),
        button(t("Delete", "Xóa"), async () => {
          await updateSettings((latest) => ({
            websiteProfiles: normalizeSiteProfiles(
              latest.websiteProfiles
            ).filter((entry) => entry.hostname !== profile.hostname)
          }));
          if (editing === profile.hostname) reset();
          await render();
          status.textContent = t("Deleted", "Đã xóa");
        })
      );
      list.append(item);
    }
  };
  const save = make(
    "button",
    t("Save website profile", "Lưu cấu hình website"),
    "bt-btn bt-btn-primary"
  );
  save.type = "submit";
  form.append(save, button(t("Cancel editing", "Hủy sửa"), reset));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const terms = {};
      for (const line of glossary.value
        .split("\n")
        .filter((text) => text.trim())) {
        const index = line.indexOf("=");
        if (index < 1)
          throw new Error(
            t("Use term = translation", "Nhập dạng từ = bản dịch")
          );
        const key = line.slice(0, index).trim();
        if (Object.hasOwn(terms, key))
          throw new Error(t("Duplicate glossary term", "Thuật ngữ bị trùng"));
        Object.defineProperty(terms, key, {
          value: line.slice(index + 1).trim(),
          enumerable: true
        });
      }
      const [profile] = normalizeSiteProfiles([
        {
          hostname: host.value,
          sourceLanguage: source.value,
          targetLanguage: target.value,
          translationStyle: style.value,
          glossary: terms,
          includeSubdomains: subdomains.checked,
          enabled: enabled.checked
        }
      ]);
      await updateSettings((latest) => {
        const profiles = normalizeSiteProfiles(latest.websiteProfiles).filter(
          (entry) => entry.hostname !== editing
        );
        return {
          websiteProfiles: normalizeSiteProfiles([...profiles, profile])
        };
      });
      reset();
      await render();
      status.textContent = t("Saved", "Đã lưu");
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  section.append(list, form, status);
  container.querySelector("#website-profiles")?.remove();
  container.append(section);
  await render();
}
