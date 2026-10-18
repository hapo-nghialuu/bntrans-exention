const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};

export async function mount(container, api) {
  const t = api.t;
  let settings = await api.settings(),
    pinned = null,
    disposed = false,
    generation = 0,
    items = [];
  const panel = node("section");
  panel.className = "lab-panel";
  panel.append(
    node("h2", t("Corrections", "Sửa bản dịch")),
    node(
      "p",
      t(
        "Edit translated text on the selected website. Originals and formatting remain untouched. Nothing is saved until you click Save correction.",
        "Sửa bản dịch ngay trên website đã chọn. Giữ nguyên nội dung gốc và định dạng. Chỉ lưu khi bấm Lưu cách sửa."
      )
    )
  );
  const enabled = node("input");
  enabled.type = "checkbox";
  enabled.checked = settings.labFeatures?.corrections === true;
  panel.append(
    api.field(
      t(
        "Enable corrections (off by default)",
        "Bật sửa bản dịch (mặc định tắt)"
      ),
      enabled
    )
  );
  panel.append(
    node(
      "p",
      t(
        "Local memory matches exact text, website origin and language pair, before providers/cache. No subdomain sharing. Incognito, ephemeral requests or disabled history/cache retention never use or save memory. Entries expire at the shorter history/cache lifetime. Disabling corrections clears memory.",
        "Kho cục bộ khớp chính xác nội dung, origin website và cặp ngôn ngữ, ưu tiên trước provider/cache. Không dùng chung subdomain. Không dùng/lưu kho khi ẩn danh, yêu cầu tạm thời hoặc tắt lưu lịch sử/cache. Hết hạn theo thời gian ngắn hơn của lịch sử/cache. Tắt tính năng sẽ xóa kho."
      )
    )
  );
  const target = node(
    "p",
    t("No website is being edited", "Chưa sửa website nào")
  );
  target.className = "lab-result";
  panel.append(target);
  const send = (payload) => api.send("labs-corrections", payload);
  async function assertEnabled() {
    settings = await api.settings();
    if (
      disposed ||
      settings.enabled === false ||
      settings.labFeatures?.corrections !== true
    )
      throw new Error(t("Enable corrections first", "Bật tính năng sửa trước"));
  }
  async function stop() {
    generation++;
    const old = pinned;
    pinned = null;
    if (old) {
      try {
        await api.sendToTab(
          "labs-corrections-page",
          { command: "stop" },
          old.id
        );
      } catch {
        /* Tab may have closed. */
      }
    }
    if (!disposed)
      target.textContent = t(
        "No website is being edited",
        "Chưa sửa website nào"
      );
  }
  panel.append(
    api.button(t("Save feature setting", "Lưu bật/tắt tính năng"), async () => {
      await stop();
      await api.updateSettings({
        labFeatures: { corrections: enabled.checked }
      });
      if (!enabled.checked) {
        items = [];
        render();
      }
      api.status(t("Setting saved", "Đã lưu cài đặt"));
    })
  );
  panel.append(
    api.button(
      t("Edit translations on selected tab", "Sửa bản dịch trên tab đã chọn"),
      async () => {
        await stop();
        const token = generation;
        await assertEnabled();
        const tab = await api.activeTab();
        pinned = tab;
        const response = await api.sendToTab(
          "labs-corrections-page",
          { command: "start", url: tab.url },
          tab.id
        );
        const current = await api.activeTab();
        if (
          disposed ||
          token !== generation ||
          tab.id !== current.id ||
          tab.url !== current.url
        ) {
          await stop();
          return;
        }
        target.textContent = t(
          `Editing tab ${tab.id}: ${tab.title || tab.url} — ${tab.url}. ${response.count} translations ready. Use Edit translation beside translated text. Translate the page first if none appear.`,
          `Đang sửa tab ${tab.id}: ${tab.title || tab.url} — ${tab.url}. Có ${response.count} bản dịch. Bấm Sửa bản dịch cạnh nội dung đã dịch. Nếu chưa có, dịch trang trước.`
        );
      }
    ),
    api.button(
      t("Stop editing / restore previews", "Dừng sửa / khôi phục xem trước"),
      stop
    )
  );
  const search = node("input");
  search.type = "search";
  search.placeholder = t(
    "Search source, correction or website",
    "Tìm nội dung, cách sửa hoặc website"
  );
  panel.append(
    api.field(t("Local correction memory", "Kho cách sửa cục bộ"), search)
  );
  const list = node("div");
  list.className = "lab-list";
  panel.append(list);
  async function load() {
    const token = generation;
    await assertEnabled();
    const result = await send({ command: "list" });
    if (disposed || token !== generation) return;
    items = result.items;
    render();
  }
  function render() {
    if (disposed) return;
    list.replaceChildren();
    const query = search.value.toLocaleLowerCase();
    for (const item of items.filter((entry) =>
      `${entry.text}\n${entry.translation}\n${entry.scope}`
        .toLocaleLowerCase()
        .includes(query)
    )) {
      const card = node("article");
      card.className = "lab-card";
      card.append(
        node(
          "small",
          `${item.scope} · ${item.sourceLanguage} → ${item.targetLanguage}`
        ),
        node("p", item.text)
      );
      const input = node("textarea");
      input.maxLength = 12000;
      input.value = item.translation;
      card.append(
        api.field(t("Corrected translation", "Bản dịch đã sửa"), input)
      );
      card.append(
        api.button(t("Save edit", "Lưu sửa"), async () => {
          await assertEnabled();
          await send({
            command: "save",
            explicitSave: true,
            entry: { ...item, translation: input.value }
          });
          await load();
        }),
        api.button(t("Delete", "Xóa"), async () => {
          await assertEnabled();
          await send({ command: "delete", entry: item });
          await load();
        })
      );
      list.append(card);
    }
    if (!list.childElementCount)
      list.append(
        node(
          "p",
          t(
            "No loaded matches. Click Load memory to refresh.",
            "Chưa có kết quả. Bấm Nạp kho để cập nhật."
          )
        )
      );
  }
  search.addEventListener("input", render);
  panel.append(
    api.button(t("Load memory", "Nạp kho"), load),
    api.button(t("Clear memory", "Xóa toàn bộ kho"), async () => {
      if (
        !window.confirm(
          t("Delete all saved corrections?", "Xóa tất cả cách sửa đã lưu?")
        )
      )
        return;
      generation++;
      await send({ command: "clear" });
      items = [];
      render();
    }),
    api.button(t("Export memory", "Xuất kho"), async () => {
      await assertEnabled();
      const result = await send({ command: "list" });
      if (disposed) return;
      api.download(
        "bntrans-corrections.json",
        JSON.stringify({ schemaVersion: 1, items: result.items }, null, 2),
        "application/json"
      );
    })
  );
  const file = node("input");
  file.type = "file";
  file.accept = ".json,application/json";
  panel.append(
    api.field(t("Import local memory JSON", "Nhập JSON kho cục bộ"), file),
    api.button(t("Import selected file", "Nhập tệp đã chọn"), async () => {
      await assertEnabled();
      const selected = file.files?.[0];
      if (!selected || selected.size > 2000000)
        throw new Error(
          t("Choose a JSON file up to 2 MB", "Chọn tệp JSON tối đa 2 MB")
        );
      await send({
        command: "import",
        value: JSON.parse(await selected.text())
      });
      await load();
    })
  );
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes.translatorSettings) return;
    void stop();
    items = [];
    render();
  };
  chrome.storage.onChanged.addListener(onStorage);
  const timer = setInterval(async () => {
    if (!pinned || disposed) return;
    try {
      const tab = await api.activeTab();
      if (pinned && (tab.id !== pinned.id || tab.url !== pinned.url))
        await stop();
    } catch {
      await stop();
    }
  }, 500);
  render();
  container.append(panel);
  return () => {
    disposed = true;
    void stop();
    clearInterval(timer);
    chrome.storage.onChanged.removeListener(onStorage);
    search.removeEventListener("input", render);
    panel.remove();
  };
}
