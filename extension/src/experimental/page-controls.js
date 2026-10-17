export async function mount(container, api) {
  let disposed = false;
  const settings = await api.settings();
  if (disposed) return () => {};
  const config = settings.labPage || {};
  const panel = document.createElement("section");
  panel.className = "lab-panel";
  const heading = document.createElement("h2");
  heading.textContent = api.t("Page reading controls", "Điều khiển đọc trang");
  const note = document.createElement("p");
  note.textContent = api.t(
    "Only the selected tab is translated. Every retry counts toward the text/request budget. Stopping drops late results; requests already sent may finish remotely. Route changes restore and stop the session.",
    "Chỉ dịch tab đã chọn. Mỗi lần thử lại đều tính vào ngân sách ký tự/request. Dừng sẽ bỏ kết quả muộn; request đã gửi có thể vẫn chạy ở provider. Đổi route sẽ restore và dừng phiên."
  );
  const result = document.createElement("pre");
  result.className = "lab-result";
  result.setAttribute("aria-live", "polite");
  const form = document.createElement("div");
  const mode = document.createElement("select");
  for (const [value, en, vi] of [
    ["original", "Original", "Bản gốc"],
    ["bilingual", "Bilingual", "Song ngữ"],
    ["translation", "Translation only", "Chỉ bản dịch"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = api.t(en, vi);
    mode.appendChild(option);
  }
  mode.value = config.mode || "bilingual";
  form.appendChild(api.field(api.t("Reading mode", "Chế độ đọc"), mode));
  const controls = {};
  for (const [key, fallback, min, max, step, en, vi] of [
    [
      "maxRequests",
      100,
      1,
      1000,
      1,
      "Session request budget",
      "Ngân sách request/phiên"
    ],
    [
      "maxChars",
      100000,
      1,
      1000000,
      1,
      "Session character budget",
      "Ngân sách ký tự/phiên"
    ],
    [
      "concurrency",
      2,
      1,
      4,
      1,
      "Maximum concurrency",
      "Request đồng thời tối đa"
    ],
    [
      "requestsPerSecond",
      2,
      0.1,
      10,
      0.1,
      "Requests per second",
      "Request mỗi giây"
    ],
    ["timeoutMs", 30000, 100, 120000, 100, "Timeout (ms)", "Timeout (ms)"],
    ["maxRetries", 1, 0, 2, 1, "Retries per segment", "Thử lại mỗi đoạn"]
  ]) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = ["concurrency", "requestsPerSecond", "timeoutMs"].includes(
      key
    )
      ? (config.providerLimits?.[settings.activeProviderId]?.[key] ??
        config[key] ??
        fallback)
      : (config[key] ?? fallback);
    controls[key] = input;
    form.appendChild(api.field(api.t(en, vi), input));
  }
  for (const [key, en, vi] of [
    [
      "live",
      "Observe new/changed content (opt-in)",
      "Theo dõi nội dung mới/thay đổi (tự chọn)"
    ],
    ["nearViewportOnly", "Only near the viewport", "Chỉ gần vùng đang đọc"]
  ]) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = config[key] === true;
    controls[key] = input;
    form.appendChild(api.field(api.t(en, vi), input));
  }
  const save = async () => {
    const current = await api.settings();
    if (current.labFeatures?.page !== true)
      throw new Error(
        api.t("Enable Page Labs first", "Hãy bật Page Labs trước")
      );
    const patch = { ...current.labPage, mode: mode.value };
    for (const [key, input] of Object.entries(controls)) {
      if (input.type === "checkbox") patch[key] = input.checked;
      else {
        if (!input.checkValidity() || !input.value.trim())
          throw new Error(
            api.t(
              "Invalid budget or rate",
              "Ngân sách hoặc tốc độ không hợp lệ"
            )
          );
        patch[key] = Number(input.value);
      }
    }
    if (current.activeProviderId) {
      patch.providerLimits = {
        ...current.labPage?.providerLimits,
        [current.activeProviderId]: {
          concurrency: patch.concurrency,
          requestsPerSecond: patch.requestsPerSecond,
          timeoutMs: patch.timeoutMs
        }
      };
    }
    await api.updateSettings({ labPage: patch });
  };
  const command = async (name) => {
    const current = await api.settings();
    if (current.labFeatures?.page !== true)
      throw new Error(
        api.t("Enable Page Labs first", "Hãy bật Page Labs trước")
      );
    const response = await api.sendToTab("labs-page-command", {
      command: name,
      mode: mode.value
    });
    if (response?.ok === false) throw new Error(response.error);
    if (!disposed) result.textContent = JSON.stringify(response, null, 2);
  };
  const toolbar = document.createElement("div");
  toolbar.className = "lab-toolbar";
  for (const [name, en, vi] of [
    ["estimate", "Estimate before sending", "Ước tính trước khi gửi"],
    ["translate", "Start", "Bắt đầu"],
    ["pause", "Pause", "Tạm dừng"],
    ["resume", "Resume", "Tiếp tục"],
    ["mode", "Apply reading mode", "Áp dụng chế độ đọc"],
    ["restore", "Restore original DOM", "Khôi phục DOM gốc"],
    ["snapshot", "Refresh status", "Cập nhật trạng thái"]
  ]) {
    toolbar.appendChild(
      api.button(api.t(en, vi), async () => {
        if (["translate", "resume", "estimate"].includes(name)) await save();
        await command(name);
      })
    );
  }
  toolbar.appendChild(
    api.button(
      api.t(
        "Save settings for next session",
        "Lưu cấu hình cho phiên tiếp theo"
      ),
      save
    )
  );
  toolbar.appendChild(
    api.button(
      api.t("Remember mode for selected host", "Nhớ chế độ cho host đã chọn"),
      async () => {
        await save();
        const tab = await api.activeTab();
        const url = new URL(tab?.url || "");
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error(
            api.t("An HTTP(S) tab is required", "Cần chọn tab HTTP(S)")
          );
        const current = await api.settings();
        await api.updateSettings({
          labPage: {
            ...current.labPage,
            siteModes: {
              ...current.labPage?.siteModes,
              [url.hostname]: mode.value
            }
          }
        });
        api.status(
          api.t("Reading mode saved for ", "Đã lưu chế độ cho ") + url.hostname
        );
      }
    )
  );
  panel.append(heading, note, form, toolbar, result);
  container.appendChild(panel);
  return () => {
    disposed = true;
    panel.remove();
  };
}
