import {
  MAX_COMPARE_TEXT,
  compareProviders,
  createCompareEngine,
  renderDiff
} from "./compare-engine.js";

export function compareMessage(api, code, detail = "") {
  const messages = {
    "source-disabled": [
      "Enable Compare in Labs first.",
      "Hãy bật So sánh trong Labs trước."
    ],
    "source-cancelled": [
      "Cancelled. Late results are discarded.",
      "Đã hủy. Bỏ kết quả trả về muộn."
    ],
    "source-stale": [
      "The website tab changed. Capture the selection again.",
      "Tab website đã đổi. Hãy lấy lại vùng chọn."
    ],
    "compare-settings": [
      "Settings changed. Review both columns again.",
      "Cài đặt đã đổi. Hãy kiểm tra lại hai cột."
    ],
    "compare-empty": [
      "Paste text or capture a website selection first.",
      "Dán văn bản hoặc lấy vùng chọn website trước."
    ],
    "compare-limit": [
      `Select at most ${MAX_COMPARE_TEXT} characters; text is never silently truncated.`,
      `Chọn tối đa ${MAX_COMPARE_TEXT} ký tự; nội dung không bị cắt ngầm.`
    ],
    "compare-language": [
      "Choose valid source and target language codes.",
      "Chọn mã ngôn ngữ nguồn và đích hợp lệ."
    ],
    "compare-provider": [
      "Choose two configured, instruction-capable providers. The same provider may use two different models.",
      "Chọn hai provider đã cấu hình có hỗ trợ chỉ dẫn. Có thể dùng cùng provider với hai model khác nhau."
    ],
    "compare-model": [
      "Model must be 1–200 characters without control characters.",
      "Model cần 1–200 ký tự, không có ký tự điều khiển."
    ],
    "compare-duplicate": [
      "Both columns use the same provider and model. Choose a different model or provider; no requests were sent.",
      "Hai cột dùng cùng provider và model. Hãy đổi model hoặc provider; chưa gửi request nào."
    ],
    "compare-pinned-provider": [
      "This website's privacy rule pins a provider. Both columns must use that provider (with different models), or change the rule explicitly in Privacy. Nothing was sent.",
      "Quy tắc riêng tư của website đã ghim provider. Hai cột phải dùng provider đó (model khác nhau), hoặc bro chủ động sửa quy tắc trong Riêng tư. Chưa gửi gì."
    ],
    "compare-provider-mismatch": [
      "The returned provider does not match this column. Result hidden.",
      "Provider trả về không khớp cột này. Đã ẩn kết quả."
    ],
    "compare-consent": [
      "Sending declined. No remaining requests were sent.",
      "Đã từ chối gửi. Không gửi các request còn lại."
    ],
    "compare-output": [
      "Provider returned empty or oversized text. Retry this column only.",
      "Provider trả văn bản rỗng hoặc quá dài. Chỉ thử lại cột này."
    ],
    "compare-busy": [
      "Cancel or wait for the current comparison.",
      "Hủy hoặc đợi lượt so sánh hiện tại."
    ],
    "compare-retry": [
      "Only a failed column can be retried.",
      "Chỉ thử lại được cột bị lỗi."
    ]
  };
  if (messages[code]) {
    const message = api.t(...messages[code]);
    return code === "compare-pinned-provider" && detail
      ? `${message} ${api.t("Pinned provider ID", "ID provider được ghim")}: ${detail}.`
      : message;
  }
  if (String(code).startsWith("Privacy blocked:"))
    return api.t(
      `Privacy blocked this provider/destination: ${code}`,
      `Quy tắc riêng tư chặn provider/đích gửi này: ${code}`
    );
  return String(code || api.t("Request failed.", "Request thất bại."));
}

export async function mount(container, api) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const t = (en, vi) => api.t(en, vi);
  let alive = true,
    captured = null,
    picked = null,
    settingsGeneration = 0,
    sourceGeneration = 0,
    capturing = false,
    settings = {},
    view;
  const listeners = [];
  const on = (target, name, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  };
  function el(tag, text = "", className = "") {
    const node = doc.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function report(error) {
    if (alive && error?.code !== "source-cancelled")
      api.status(
        compareMessage(api, error?.code || error?.message, error?.detail),
        "error"
      );
  }
  function button(en, vi, action) {
    const node = el("button", t(en, vi));
    node.type = "button";
    on(node, "click", () => Promise.resolve().then(action).catch(report));
    return node;
  }
  const panel = el("section", "", "lab-panel");
  panel.append(
    el(
      "h3",
      t("Two translations. Your judgment.", "Hai bản dịch. Bro tự chọn.")
    ),
    el(
      "p",
      t(
        "Preview one text, then send TWO separate requests. Each can incur cost; retries add one request. Ask requires separate consent for each column. No automatic winner, fallback, cache or history.",
        "Xem trước cùng một văn bản, rồi gửi HAI request riêng. Mỗi request có thể mất phí; thử lại thêm một request. Chế độ Hỏi cần xác nhận riêng từng cột. Không tự chọn bên thắng, fallback, cache hay lịch sử."
      ),
      "lab-muted"
    )
  );
  const source = el("textarea");
  source.rows = 6;
  source.maxLength = MAX_COMPARE_TEXT;
  source.dataset.compare = "source";
  panel.append(
    api.field(
      t(
        "Source preview — editable before Compare",
        "Xem trước nguồn — có thể sửa trước khi So sánh"
      ),
      source
    )
  );
  const origin = el("p", "", "lab-muted");
  const count = el("p");
  count.setAttribute("role", "status");
  const capture = button(
    "Capture website selection",
    "Lấy vùng chọn website",
    async () => {
      const token = ++sourceGeneration;
      captured = null;
      source.value = "";
      picked = null;
      capturing = true;
      update();
      try {
        const value = await engine.capture();
        if (!alive || token !== sourceGeneration) return;
        captured = value;
        source.value = value.text;
        picked = null;
        update();
      } finally {
        if (alive && token === sourceGeneration) {
          capturing = false;
          update();
        }
      }
    }
  );
  const paste = button("Use pasted text instead", "Dùng văn bản dán", () => {
    sourceGeneration++;
    capturing = false;
    engine.reset({ clearSource: true });
    captured = null;
    source.value = "";
    picked = null;
    update();
    source.focus();
  });
  const sourceBar = el("div", "", "lab-toolbar");
  sourceBar.append(capture, paste);
  panel.append(sourceBar, origin);
  const languageBar = el("div", "", "lab-toolbar");
  function languageControl(kind, includeAuto) {
    const select = el("select");
    select.dataset.compare = kind;
    const list = [
      ["en", "English", "Tiếng Anh"],
      ["vi", "Vietnamese", "Tiếng Việt"],
      ["ja", "Japanese", "Tiếng Nhật"],
      ["ko", "Korean", "Tiếng Hàn"],
      ["zh-CN", "Chinese (Simplified)", "Tiếng Trung (giản thể)"],
      ["zh-TW", "Chinese (Traditional)", "Tiếng Trung (phồn thể)"],
      ["fr", "French", "Tiếng Pháp"],
      ["de", "German", "Tiếng Đức"],
      ["es", "Spanish", "Tiếng Tây Ban Nha"],
      ["pt", "Portuguese", "Tiếng Bồ Đào Nha"],
      ["ru", "Russian", "Tiếng Nga"],
      ["th", "Thai", "Tiếng Thái"],
      ["id", "Indonesian", "Tiếng Indonesia"],
      ["ar", "Arabic", "Tiếng Ả Rập"],
      ["hi", "Hindi", "Tiếng Hindi"]
    ];
    if (includeAuto) list.unshift(["auto", "Detect language", "Tự nhận diện"]);
    for (const [value, en, vi] of list) {
      const option = el("option", t(en, vi));
      option.value = value;
      select.append(option);
    }
    return select;
  }
  const sourceLanguage = languageControl("source-language", true);
  const targetLanguage = languageControl("target-language", false);
  languageBar.append(
    api.field(
      t("Source language · both columns", "Ngôn ngữ nguồn · hai cột"),
      sourceLanguage
    ),
    api.field(
      t("Target language · both columns", "Ngôn ngữ đích · hai cột"),
      targetLanguage
    )
  );
  panel.append(languageBar);
  const columns = el("div");
  columns.style.display = "grid";
  columns.style.gap = "24px";
  columns.style.gridTemplateColumns =
    "repeat(auto-fit, minmax(min(100%, 280px), 1fr))";
  const sides = ["a", "b"].map((id) => {
    const column = el("section", "", "lab-card");
    column.dataset.column = id;
    const provider = el("select");
    provider.dataset.compare = `provider-${id}`;
    const model = el("input");
    model.type = "text";
    model.maxLength = 200;
    model.autocomplete = "off";
    model.dataset.compare = `model-${id}`;
    const metadata = el("p", "", "lab-muted");
    const status = el("p");
    status.setAttribute("role", "status");
    const output = el("div", "", "lab-result");
    output.dir = "auto";
    output.dataset.compare = `output-${id}`;
    const retry = button(
      "Retry this column · +1 request",
      "Thử lại cột này · +1 request",
      () => engine.retry(id)
    );
    const pick = button(
      `Choose ${id.toUpperCase()}`,
      `Chọn ${id.toUpperCase()}`,
      () => {
        picked = id;
        update();
      }
    );
    const copy = button(
      `Copy ${id.toUpperCase()}`,
      `Sao chép ${id.toUpperCase()}`,
      async () => {
        const result = view.sides.find((side) => side.id === id);
        if (result.status !== "success") return;
        await win.navigator.clipboard.writeText(result.translation);
        if (alive)
          api.status(
            t(
              "Copied. Nothing saved in BNTrans.",
              "Đã sao chép. Không lưu vào BNTrans."
            )
          );
      }
    );
    const actions = el("div", "", "lab-toolbar");
    actions.append(pick, copy, retry);
    column.append(
      el("h3", id.toUpperCase()),
      api.field(t("Configured provider", "Provider đã cấu hình"), provider),
      api.field(
        t("Model override · optional", "Model riêng · không bắt buộc"),
        model
      ),
      metadata,
      status,
      output,
      actions
    );
    columns.append(column);
    return { id, provider, model, metadata, status, output, retry, pick, copy };
  });
  panel.append(columns);
  const toolbar = el("div", "", "lab-toolbar");
  const compare = button("Compare · 2 requests", "So sánh · 2 request", () => {
    picked = null;
    api.status("");
    return engine.compare({
      text: source.value,
      sourceLanguage: sourceLanguage.value,
      targetLanguage: targetLanguage.value,
      ...Object.fromEntries(
        sides.map((side) => [
          side.id,
          {
            providerId: side.provider.value,
            model: side.model.value
          }
        ])
      )
    });
  });
  const cancel = button(
    "Cancel remaining requests",
    "Hủy request còn lại",
    () => {
      sourceGeneration++;
      capturing = false;
      engine.cancel();
    }
  );
  toolbar.append(compare, cancel);
  const chosen = el("p");
  chosen.setAttribute("role", "status");
  const diffSection = el("section", "", "lab-card");
  const diff = el("div", "", "lab-result");
  diff.dataset.compare = "diff";
  diff.dir = "auto";
  diffSection.append(
    el(
      "h3",
      t("Text diff · A removed, B added", "Diff văn bản · xóa từ A, thêm từ B")
    ),
    diff
  );
  panel.append(toolbar, count, chosen, diffSection);
  const engine = createCompareEngine(api, {
    confirm: (message) => win.confirm(message),
    onInvalidate(code) {
      sourceGeneration++;
      capturing = false;
      captured = null;
      source.value = "";
      picked = null;
      update();
      api.status(compareMessage(api, code), "error");
    },
    onChange(state) {
      view = state;
      update();
    }
  });
  view = engine.snapshot();

  function update() {
    if (!alive) return;
    const enabled =
      settings.enabled !== false && settings.labFeatures?.compare === true;
    source.disabled =
      sourceLanguage.disabled =
      targetLanguage.disabled =
        !enabled;
    capture.disabled = !enabled || view.busy || capturing;
    paste.disabled = !enabled;
    compare.disabled =
      !enabled ||
      view.busy ||
      capturing ||
      !source.value.trim() ||
      sides.some((side) => !side.provider.value);
    cancel.disabled = !view.busy && !capturing;
    count.textContent = t(
      `${source.value.length}/${MAX_COMPARE_TEXT} source characters · ${view.requests} requests dispatched. Provider/network retries may add cost; no currency estimate. Cancel cannot recall a request already sent.`,
      `${source.value.length}/${MAX_COMPARE_TEXT} ký tự nguồn · đã gửi ${view.requests} request. Provider/mạng thử lại có thể tăng phí; không ước lượng tiền. Hủy không thu hồi được request đã gửi.`
    );
    origin.textContent = captured
      ? t(
          `Website selection: ${captured.title || captured.url} · ${captured.url}. Edits keep this site's privacy rule.`,
          `Vùng chọn website: ${captured.title || captured.url} · ${captured.url}. Khi sửa vẫn giữ quy tắc riêng tư website này.`
        )
      : t(
          "Pasted text · global privacy policy. Nothing is sent until Compare.",
          "Văn bản dán · quy tắc riêng tư chung. Chưa gửi gì trước khi bấm So sánh."
        );
    for (const side of sides) {
      const result = view.sides.find((item) => item.id === side.id);
      const provider = compareProviders(settings).find(
        (item) => item.id === side.provider.value
      );
      side.provider.disabled = side.model.disabled = !enabled;
      side.model.placeholder = provider?.model || "";
      const model =
        result.model || side.model.value.trim() || provider?.model || "—";
      side.metadata.textContent = t(
        `${result.providerName || provider?.name || "Not configured"} · ID ${result.providerId || provider?.id || "—"} · model ${model} · ${view.characters || source.value.length} characters · ${sourceLanguage.value} → ${targetLanguage.value} · ${result.requests} requests`,
        `${result.providerName || provider?.name || "Chưa cấu hình"} · ID ${result.providerId || provider?.id || "—"} · model ${model} · ${view.characters || source.value.length} ký tự · ${sourceLanguage.value} → ${targetLanguage.value} · ${result.requests} request`
      );
      const labels = {
        idle: ["Ready", "Sẵn sàng"],
        queued: ["Queued · not sent", "Đang chờ · chưa gửi"],
        pending: ["Translating…", "Đang dịch…"],
        consent: ["Waiting for consent · not sent", "Chờ xác nhận · chưa gửi"],
        success: ["Complete", "Hoàn tất"],
        error: ["Failed", "Lỗi"],
        cancelled: ["Cancelled", "Đã hủy"]
      };
      side.status.textContent = result.error
        ? compareMessage(api, result.error)
        : t(...labels[result.status]);
      side.output.textContent = result.translation;
      side.output.hidden = result.status !== "success";
      side.retry.hidden = result.status !== "error";
      side.retry.disabled = !enabled || view.busy;
      side.pick.disabled = side.copy.disabled =
        !enabled || result.status !== "success";
      side.pick.setAttribute("aria-pressed", String(picked === side.id));
    }
    chosen.textContent = picked
      ? t(
          `Your choice: ${picked.toUpperCase()} · kept only in this view.`,
          `Bro chọn: ${picked.toUpperCase()} · chỉ giữ trong màn hình này.`
        )
      : t(
          "No winner selected. Review meaning, not provider claims.",
          "Chưa chọn bên nào. Kiểm tra ý nghĩa, không dựa vào lời quảng cáo provider."
        );
    diffSection.hidden = !view.sides.every((side) => side.status === "success");
    if (!diffSection.hidden)
      renderDiff(diff, view.sides[0].translation, view.sides[1].translation);
    else diff.replaceChildren();
  }
  function invalidate() {
    sourceGeneration++;
    capturing = false;
    picked = null;
    engine.reset();
    update();
  }
  on(source, "input", invalidate);
  for (const control of [
    sourceLanguage,
    targetLanguage,
    ...sides.map((side) => side.provider)
  ])
    on(control, "change", invalidate);
  for (const side of sides) on(side.model, "input", invalidate);
  on(doc.getElementById("lab-target"), "change", () => {
    sourceGeneration++;
    capturing = false;
    if (captured) source.value = "";
    captured = null;
    picked = null;
    engine.reset({ clearSource: true });
    update();
  });
  async function refreshSettings() {
    const token = ++settingsGeneration;
    const next = await api.settings();
    if (!alive || token !== settingsGeneration) return;
    settings = next;
    const providers = compareProviders(settings);
    sides.forEach((side, index) => {
      const previous = side.provider.value;
      side.provider.replaceChildren();
      for (const provider of providers) {
        const option = el("option", `${provider.name} · ${provider.id}`);
        option.value = provider.id;
        side.provider.append(option);
      }
      side.provider.value = providers.some(
        (provider) => provider.id === previous
      )
        ? previous
        : (providers[index] || providers[0])?.id || "";
    });
    if (!providers.length)
      api.status(compareMessage(api, "compare-provider"), "error");
    update();
  }
  const storageChanged = (changes, area) => {
    if (area !== "local" || !changes.translatorSettings) return;
    sourceGeneration++;
    capturing = false;
    if (captured) source.value = "";
    captured = null;
    picked = null;
    settings = {};
    engine.reset({ clearSource: true });
    void refreshSettings().catch(report);
  };
  chrome.storage.onChanged.addListener(storageChanged);
  const teardown = () => {
    if (!alive) return;
    alive = false;
    settingsGeneration++;
    sourceGeneration++;
    for (const remove of listeners) remove();
    chrome.storage.onChanged.removeListener(storageChanged);
    void engine.dispose();
    source.value = "";
    captured = picked = null;
    panel.remove();
  };
  on(win, "pagehide", teardown);
  container.replaceChildren(panel);
  targetLanguage.value = "vi";
  try {
    await refreshSettings();
  } catch (error) {
    teardown();
    throw error;
  }
  if (
    settings.nativeLanguageCode &&
    [...targetLanguage.options].some(
      (option) => option.value === settings.nativeLanguageCode
    )
  )
    targetLanguage.value = settings.nativeLanguageCode;
  update();
  return teardown;
}
