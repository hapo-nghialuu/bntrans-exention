import {
  MAX_WRITING_TEXT,
  rewriteOptions,
  renderDiff
} from "./writing-utils.js";

export async function mount(container, api) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const t = (en, vi) => api.t(en, vi);
  let alive = true;
  let busy = false;
  let generation = 0;
  let capture = null;
  let undo = null;
  let variants = [];
  let original = "";
  let recognition = null;
  let listening = false;
  let holding = false;
  const listeners = [];
  let variantListeners = [];
  function on(target, event, handler) {
    target.addEventListener(event, handler);
    listeners.push(() => target.removeEventListener(event, handler));
  }
  function el(tag, text, className) {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function status(en, vi, kind = "info") {
    if (alive) api.status(t(en, vi), kind);
  }
  function button(en, vi, action, parent = toolbar) {
    const node = el("button", t(en, vi));
    node.type = "button";
    on(node, "click", () => {
      Promise.resolve()
        .then(action)
        .catch(() =>
          status(
            "Action failed. Check the selected tab, Labs flag and provider settings.",
            "Thao tác lỗi. Kiểm tra tab đã chọn, cờ Labs và cấu hình nhà cung cấp.",
            "error"
          )
        );
    });
    parent.append(node);
    return node;
  }
  const panel = el("section", "", "lab-panel");
  panel.append(
    el(
      "h2",
      t(
        "Writing & voice — review before applying",
        "Viết & giọng nói — xem trước khi áp dụng"
      )
    )
  );
  panel.append(
    el(
      "p",
      t(
        "Rewrite in the original language using your configured LLM. Model output can change meaning: check every diff. Rich text is read-only unless the editor is a single plain text node. Nothing is saved here.",
        "Viết lại cùng ngôn ngữ bằng LLM đã cấu hình. Kết quả có thể sai nghĩa: hãy kiểm tra diff. Rich text chỉ xem, trừ ô soạn một nút văn bản thuần. Nội dung không được lưu ở đây."
      )
    )
  );
  const source = el("textarea");
  source.rows = 8;
  source.maxLength = MAX_WRITING_TEXT;
  source.placeholder = t(
    "Type an email or capture a selection from the tab you chose in Labs…",
    "Gõ email hoặc lấy vùng chọn từ tab bạn đã chọn trong Labs…"
  );
  panel.append(
    api.field(
      t("Original / editable transcript", "Bản gốc / lời nhận dạng có thể sửa"),
      source
    )
  );
  const style = el("select");
  for (const [value, en, vi] of [
    ["grammar", "Correct grammar", "Sửa lỗi"],
    ["concise", "Make concise", "Rút gọn"],
    ["polite", "Make polite", "Lịch sự"]
  ]) {
    const option = el("option", t(en, vi));
    option.value = value;
    style.append(option);
  }
  panel.append(api.field(t("Rewrite action", "Cách viết lại"), style));
  const toolbar = el("div", "", "lab-toolbar");
  panel.append(toolbar);
  const origin = el(
    "p",
    t(
      "Manual text: Apply updates this editor only.",
      "Văn bản gõ tay: Áp dụng chỉ sửa ô này."
    )
  );
  panel.append(origin);
  const result = el("section", "", "lab-result");
  result.hidden = true;
  result.append(
    el(
      "h3",
      t(
        "Preview — deletions struck through, additions underlined",
        "Xem trước — phần xóa gạch ngang, phần thêm gạch chân"
      )
    )
  );
  const variantBar = el("div", "", "lab-toolbar");
  const diff = el("div", "", "lab-card");
  diff.setAttribute("aria-live", "polite");
  const preview = el("textarea");
  preview.rows = 7;
  preview.maxLength = MAX_WRITING_TEXT;
  result.append(
    variantBar,
    diff,
    api.field(
      t(
        "Review or edit this variant before Apply",
        "Xem/sửa biến thể này trước khi Áp dụng"
      ),
      preview
    )
  );
  const applyBar = el("div", "", "lab-toolbar");
  result.append(applyBar);
  panel.append(result);

  async function enabled() {
    let settings;
    try {
      settings = await api.settings();
    } catch {
      stopVoice(true);
      status(
        "Cannot read Labs settings. Typed input remains available; retry after the extension reconnects.",
        "Không đọc được cài đặt Labs. Vẫn nhập bằng bàn phím được; thử lại sau khi extension kết nối lại.",
        "error"
      );
      return null;
    }
    if (!alive) return null;
    if (settings?.labFeatures?.writing !== true) {
      stopVoice(true);
      status(
        "Enable Writing in Labs first. It is off by default.",
        "Hãy bật Viết trong Labs trước. Mặc định tính năng tắt.",
        "error"
      );
      return null;
    }
    return settings;
  }
  function refresh() {
    generate.disabled = busy || listening || !source.value.trim();
    captureButton.disabled = busy || listening;
    alternative.disabled =
      busy ||
      listening ||
      !variants.length ||
      variants.length >= 3 ||
      source.value !== original;
    applyButton.disabled =
      busy ||
      listening ||
      !preview.value.trim() ||
      source.value !== original ||
      (!!capture && !capture.editable);
    undoButton.disabled = busy || listening || !undo;
    style.disabled = busy || listening;
    mic.disabled = busy || !Recognition || !consent.checked;
    language.disabled = listening;
  }
  function invalidate() {
    generation++;
    variants = [];
    result.hidden = true;
    preview.value = "";
    clearVariantButtons();
    refresh();
  }
  function selectVariant(index) {
    preview.value = variants[index];
    renderDiff(diff, original, preview.value);
    refresh();
  }
  function clearVariantButtons() {
    for (const remove of variantListeners) remove();
    variantListeners = [];
    variantBar.replaceChildren();
  }
  function tabMatches(tab, state) {
    return tab?.id === state.tabId && tab?.url === state.url;
  }
  function responseError(response) {
    if (response?.ok !== true) {
      const code = response?.error;
      const messages = {
        SENSITIVE_FIELD: [
          "Sensitive/password/payment fields are blocked.",
          "Chặn trường nhạy cảm, mật khẩu và thanh toán."
        ],
        NO_SELECTION: [
          "Select page text, or focus a plain text input in the chosen tab first.",
          "Chọn văn bản hoặc đặt con trỏ trong ô văn bản thuần ở tab đã chọn."
        ],
        RICH_TEXT_UNSUPPORTED: [
          "This rich-text editor is not supported. Paste text manually instead.",
          "Ô rich text này chưa hỗ trợ. Hãy dán văn bản thủ công."
        ],
        TARGET_CHANGED: [
          "The page text changed. No write was made; capture it again.",
          "Văn bản trang đã đổi. Không ghi đè; hãy lấy lại vùng chọn."
        ],
        TARGET_DISCONNECTED: [
          "The original editor no longer exists. Capture again.",
          "Ô gốc không còn trên trang. Hãy lấy lại vùng chọn."
        ],
        WRITING_DISABLED: [
          "Writing is disabled in Labs.",
          "Tính năng Viết đang tắt trong Labs."
        ],
        SNAPSHOT_EXPIRED: [
          "The capture expired. Capture again before applying.",
          "Vùng chọn đã hết hạn. Hãy lấy lại trước khi áp dụng."
        ]
      };
      const message = messages[code] || [
        "Capture/apply is unavailable. Check the tab and capture again; nothing was overwritten.",
        "Không lấy/ghi được vùng chọn. Kiểm tra tab rồi lấy lại; không ghi đè dữ liệu."
      ];
      status(...message, "error");
      return true;
    }
    return false;
  }
  async function captureText() {
    if (busy || listening) return;
    busy = true;
    const request = ++generation;
    refresh();
    try {
      if (!(await enabled()) || request !== generation) return;
      const tab = await api.activeTab();
      if (!alive || request !== generation) return;
      if (!tab?.id) {
        status(
          "Choose a target tab in Labs first.",
          "Chọn tab đích trong Labs trước.",
          "error"
        );
        return;
      }
      const response = await api.sendToTab("labs-writing-command", {
        command: "capture"
      });
      if (!alive || responseError(response)) return;
      if (!tabMatches(await api.activeTab(), { tabId: tab.id, url: tab.url })) {
        status(
          "The selected tab changed. Capture again.",
          "Tab đã chọn đã thay đổi. Hãy lấy lại vùng chọn.",
          "error"
        );
        return;
      }
      if (!alive || request !== generation) return;
      if (
        typeof response.text !== "string" ||
        response.text.length > MAX_WRITING_TEXT ||
        !response.id
      )
        throw new Error("Invalid capture");
      source.value = response.text;
      capture = {
        id: response.id,
        tabId: tab.id,
        url: tab.url,
        editable: response.editable === true
      };
      undo = null;
      origin.textContent = capture.editable
        ? t(
            "Captured editor: Apply writes only to this unchanged snapshot in the same selected tab.",
            "Ô đã lấy: Áp dụng chỉ ghi vào snapshot chưa đổi của đúng tab này."
          )
        : t(
            "Read-only page selection: preview only. Copy the result manually.",
            "Vùng chọn trang chỉ đọc: chỉ xem trước. Sao chép kết quả thủ công."
          );
      invalidate();
    } finally {
      busy = false;
      if (alive) refresh();
    }
  }
  async function rewrite(another = false) {
    if (busy || listening) return;
    busy = true;
    refresh();
    const request = ++generation;
    const text = source.value;
    try {
      const settings = await enabled();
      if (!settings || !text.trim() || text.length > MAX_WRITING_TEXT) return;
      const provider = settings.providers?.find(
        (item) => item.id === settings.activeProviderId
      );
      if (
        !provider ||
        ![
          "gemini",
          "openai",
          "openrouter",
          "groq",
          "claude",
          "ollama",
          "codex",
          "custom"
        ].includes(provider.type)
      ) {
        status(
          "Choose a prompt-capable LLM provider in settings. Translation-only providers cannot rewrite.",
          "Chọn LLM hỗ trợ prompt trong cài đặt. Nhà cung cấp chỉ dịch không thể viết lại.",
          "error"
        );
        return;
      }
      if (capture && !tabMatches(await api.activeTab(), capture)) {
        status(
          "Choose the captured tab again, or type manually to detach this capture.",
          "Chọn lại tab đã lấy hoặc gõ thủ công để bỏ liên kết vùng chọn.",
          "error"
        );
        return;
      }
      if (!alive || request !== generation || source.value !== text) return;
      const options = rewriteOptions(
        style.value,
        another ? variants.length : 0
      );
      if (capture) options.siteUrl = capture.url;
      status(
        "Rewriting… Your original text is unchanged.",
        "Đang viết lại… Bản gốc chưa thay đổi."
      );
      const rewritten = await api.translate(text, options);
      if (
        !(await enabled()) ||
        !alive ||
        request !== generation ||
        source.value !== text
      )
        return;
      if (
        typeof rewritten !== "string" ||
        !rewritten.trim() ||
        rewritten.length > MAX_WRITING_TEXT
      ) {
        status(
          "The provider returned empty, invalid or oversized output. Nothing was applied.",
          "Nhà cung cấp trả kết quả trống, không hợp lệ hoặc quá dài. Chưa áp dụng gì.",
          "error"
        );
        return;
      }
      if (!another) {
        variants = [];
        clearVariantButtons();
      }
      if (variants.includes(rewritten)) {
        status(
          "The provider returned the same variant. No alternative was invented.",
          "Nhà cung cấp trả cùng biến thể. Không tạo phương án giả."
        );
        return;
      }
      original = text;
      const index = variants.push(rewritten) - 1;
      const choice = el(
        "button",
        t(`Variant ${index + 1}`, `Biến thể ${index + 1}`)
      );
      choice.type = "button";
      const choose = () => {
        if (!busy && !listening) selectVariant(index);
      };
      choice.addEventListener("click", choose);
      variantListeners.push(() => choice.removeEventListener("click", choose));
      variantBar.append(choice);
      selectVariant(index);
      result.hidden = false;
      status(
        "Preview ready. Review language, facts and diff, then Apply explicitly.",
        "Đã có bản xem trước. Kiểm tra ngôn ngữ, dữ kiện và diff rồi mới Áp dụng."
      );
    } catch {
      status(
        "Rewrite failed or policy denied it. Check your LLM and privacy settings; original text is unchanged.",
        "Viết lại lỗi hoặc bị chính sách chặn. Kiểm tra LLM và quyền riêng tư; bản gốc chưa đổi.",
        "error"
      );
    } finally {
      busy = false;
      if (alive) refresh();
    }
  }
  async function applyText() {
    if (
      busy ||
      listening ||
      source.value !== original ||
      !preview.value.trim() ||
      preview.value.length > MAX_WRITING_TEXT
    )
      return;
    const text = preview.value;
    const target = capture;
    const request = generation;
    busy = true;
    refresh();
    try {
      if (
        !(await enabled()) ||
        !alive ||
        generation !== request ||
        source.value !== original ||
        preview.value !== text ||
        capture !== target
      )
        return;
      if (target) {
        const tab = await api.activeTab();
        if (
          !alive ||
          generation !== request ||
          source.value !== original ||
          preview.value !== text ||
          capture !== target
        )
          return;
        if (!target.editable || !tabMatches(tab, target)) {
          status(
            "The target is read-only or the selected tab changed. Nothing was written.",
            "Đích chỉ đọc hoặc tab đã đổi. Chưa ghi gì.",
            "error"
          );
          return;
        }
        const response = await api.sendToTab("labs-writing-command", {
          command: "apply",
          id: target.id,
          text
        });
        if (!alive || responseError(response)) return;
        undo = { ...target, kind: "tab" };
        capture = null;
      } else {
        undo = {
          kind: "manual",
          before: source.value,
          applied: text,
          start: source.selectionStart,
          end: source.selectionEnd,
          direction: source.selectionDirection
        };
        source.value = text;
      }
      invalidate();
      status(
        "Applied. Undo is available only while the applied text is unchanged.",
        "Đã áp dụng. Chỉ hoàn tác khi văn bản đã áp dụng chưa bị sửa."
      );
    } finally {
      busy = false;
      if (alive) refresh();
    }
  }
  async function undoText() {
    if (busy || listening || !undo) return;
    const state = undo;
    busy = true;
    refresh();
    try {
      if (!(await enabled()) || !alive || undo !== state) return;
      if (state.kind === "tab") {
        const tab = await api.activeTab();
        if (!alive || undo !== state) return;
        if (!tabMatches(tab, state)) {
          status(
            "Choose the original tab to Undo.",
            "Chọn đúng tab gốc để Hoàn tác.",
            "error"
          );
          return;
        }
        const response = await api.sendToTab("labs-writing-command", {
          command: "undo",
          id: state.id
        });
        if (!alive || responseError(response)) return;
      } else {
        if (source.value !== state.applied) {
          status(
            "You edited the applied text; Undo will not overwrite your edits.",
            "Bạn đã sửa nội dung sau áp dụng; Hoàn tác sẽ không ghi đè phần sửa.",
            "error"
          );
          return;
        }
        source.value = state.before;
        source.setSelectionRange(state.start, state.end, state.direction);
      }
      undo = null;
      invalidate();
      status(
        "Original text and selection restored.",
        "Đã khôi phục văn bản và vùng chọn gốc."
      );
    } finally {
      busy = false;
      if (alive) refresh();
    }
  }
  const captureButton = button(
    "Capture chosen tab",
    "Lấy từ tab đã chọn",
    captureText
  );
  const generate = button("Rewrite preview", "Xem trước viết lại", () =>
    rewrite()
  );
  const alternative = button(
    "Generate another variant",
    "Tạo biến thể khác",
    () => rewrite(true)
  );
  const undoButton = button("Undo once", "Hoàn tác một bước", undoText);
  const applyButton = button(
    "Apply reviewed text",
    "Áp dụng bản đã xem",
    applyText,
    applyBar
  );
  on(source, "input", () => {
    capture = null;
    origin.textContent = t(
      "Manual text: Apply updates this editor only.",
      "Văn bản gõ tay: Áp dụng chỉ sửa ô này."
    );
    invalidate();
  });
  on(style, "change", invalidate);
  on(preview, "input", () => {
    renderDiff(diff, original, preview.value);
    refresh();
  });

  const voice = el("section", "", "lab-card");
  voice.append(
    el(
      "h3",
      t(
        "Voice input — hold to talk, release to stop",
        "Nhập giọng nói — giữ để nói, thả để dừng"
      )
    )
  );
  voice.append(
    el(
      "p",
      t(
        "Optional browser speech recognition, not BNTrans offline recognition. Chrome may send audio to its recognition service (cloud). No audio is sent to your translation provider here. Permission and runtime support vary; use this full Labs page, or type if unavailable. The transcript is editable and is never automatically rewritten or translated.",
        "Nhận dạng giọng nói tùy chọn của trình duyệt, không phải nhận dạng offline của BNTrans. Chrome có thể gửi âm thanh tới dịch vụ nhận dạng (cloud). Tính năng này không gửi âm thanh tới nhà cung cấp dịch. Quyền và hỗ trợ tùy runtime; dùng trang Labs đầy đủ hoặc gõ nếu không khả dụng. Có thể sửa lời nhận dạng; không tự viết lại hay dịch."
      )
    )
  );
  const consent = el("input");
  consent.type = "checkbox";
  voice.append(
    api.field(
      t(
        "I consent to browser recognition, which may process audio in the cloud, for this session",
        "Tôi đồng ý nhận dạng qua trình duyệt, có thể xử lý âm thanh trên cloud, trong phiên này"
      ),
      consent
    )
  );
  const language = el("select");
  for (const [value, label] of [
    ["vi-VN", "Tiếng Việt"],
    ["en-US", "English (US)"],
    ["en-GB", "English (UK)"],
    ["ja-JP", "日本語"],
    ["ko-KR", "한국어"],
    ["zh-CN", "中文"],
    ["fr-FR", "Français"],
    ["de-DE", "Deutsch"],
    ["es-ES", "Español"]
  ]) {
    const option = el("option", label);
    option.value = value;
    language.append(option);
  }
  voice.append(
    api.field(t("Recognition language", "Ngôn ngữ nhận dạng"), language)
  );
  const mic = el("button", t("Hold to talk", "Giữ để nói"));
  mic.type = "button";
  mic.setAttribute("aria-pressed", "false");
  voice.append(mic);
  const voiceState = el("p");
  voiceState.setAttribute("aria-live", "polite");
  voice.append(voiceState);
  panel.append(voice);
  const Recognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  voiceState.textContent = Recognition
    ? t(
        "Stopped. Hold the button (or Space/Enter while focused) to request microphone access.",
        "Đang dừng. Giữ nút (hoặc Space/Enter khi focus) để yêu cầu quyền micro."
      )
    : t(
        "Speech recognition is unavailable in this browser/runtime. Open full Labs if in a popup; typed input still works.",
        "Runtime/trình duyệt này không hỗ trợ nhận dạng. Mở trang Labs đầy đủ nếu đang ở popup; vẫn gõ được."
      );

  function stopVoice(abort = false) {
    holding = false;
    if (recognition) {
      const current = recognition;
      if (abort) {
        current.onresult = current.onerror = current.onend = null;
        recognition = null;
        listening = false;
        mic.setAttribute("aria-pressed", "false");
        voiceState.textContent = t(
          "Stopped. Typed input remains available.",
          "Đã dừng. Bạn vẫn nhập bằng bàn phím được."
        );
      } else {
        voiceState.textContent = t(
          "Stopping recognition… Review the transcript before rewriting.",
          "Đang dừng nhận dạng… Xem lời nhận dạng trước khi viết lại."
        );
      }
      try {
        if (abort) current.abort();
        else current.stop();
      } catch {
        /* Already stopped. */
      }
      if (alive) refresh();
    }
  }
  async function startVoice() {
    if (
      !alive ||
      busy ||
      listening ||
      holding ||
      !Recognition ||
      !consent.checked
    )
      return;
    holding = true;
    if (!(await enabled()) || !holding || !alive) return;
    const base = source.value;
    if (base.length >= MAX_WRITING_TEXT) {
      holding = false;
      return;
    }
    try {
      recognition = new Recognition();
      const current = recognition;
      let accepted = false;
      let errored = false;
      const sourceGeneration = generation;
      current.lang = language.value;
      current.continuous = false;
      current.interimResults = false;
      current.maxAlternatives = 1;
      current.onresult = (event) => {
        if (!alive || current !== recognition || accepted) return;
        const transcript = Array.from(event.results || [])
          .filter((item) => item.isFinal)
          .map((item) => item[0]?.transcript || "")
          .join(" ");
        if (!transcript.trim()) return;
        accepted = true;
        if (source.value !== base || sourceGeneration !== generation) {
          status(
            "Text changed while listening; transcript was not inserted. Try again after editing.",
            "Nội dung thay đổi lúc đang nghe; không chèn lời nhận dạng. Thử lại sau khi sửa.",
            "error"
          );
          return;
        }
        const text = base + (base && !/\s$/.test(base) ? " " : "") + transcript;
        if (text.length > MAX_WRITING_TEXT) {
          status(
            "Transcript exceeds the text limit; nothing was inserted.",
            "Lời nhận dạng vượt giới hạn; chưa chèn gì.",
            "error"
          );
          return;
        }
        source.value = text;
        capture = null;
        origin.textContent = t(
          "Manual transcript: review and edit before requesting a rewrite.",
          "Lời nhận dạng thủ công: xem/sửa trước khi yêu cầu viết lại."
        );
        invalidate();
      };
      current.onerror = (event) => {
        if (!alive || current !== recognition) return;
        errored = true;
        stopVoice(true);
        voiceState.textContent = [
          "not-allowed",
          "service-not-allowed"
        ].includes(event.error)
          ? t(
              "Microphone/recognition permission denied. You can still type normally.",
              "Bị từ chối quyền micro/nhận dạng. Bạn vẫn gõ bình thường."
            )
          : t(
              "Browser recognition failed or was stopped. No transcript was fabricated; type or try again.",
              "Nhận dạng trình duyệt lỗi hoặc đã dừng. Không tạo lời nhận dạng giả; hãy gõ hoặc thử lại."
            );
      };
      current.onend = () => {
        if (!alive || current !== recognition) return;
        listening = false;
        holding = false;
        recognition = null;
        mic.setAttribute("aria-pressed", "false");
        if (!errored)
          voiceState.textContent = accepted
            ? t(
                "Stopped. Edit the transcript, then choose Rewrite preview when ready.",
                "Đã dừng. Sửa lời nhận dạng rồi chọn Xem trước viết lại khi sẵn sàng."
              )
            : t(
                "Stopped without a final transcript. Type or try again.",
                "Đã dừng, chưa có lời nhận dạng hoàn chỉnh. Hãy gõ hoặc thử lại."
              );
        refresh();
      };
      listening = true;
      voiceState.textContent = t(
        "Listening / requesting permission… Release to stop. Nothing will auto-translate.",
        "Đang nghe / xin quyền… Thả để dừng. Không tự dịch."
      );
      mic.setAttribute("aria-pressed", "true");
      refresh();
      current.start();
    } catch {
      listening = false;
      recognition = null;
      holding = false;
      mic.setAttribute("aria-pressed", "false");
      voiceState.textContent = t(
        "Recognition cannot start here. Use full Labs or type; no extra extension permissions were requested.",
        "Không thể nhận dạng tại đây. Dùng trang Labs đầy đủ hoặc gõ; không yêu cầu thêm quyền extension."
      );
      refresh();
    }
  }
  on(consent, "change", () => {
    if (!consent.checked) stopVoice(true);
    refresh();
  });
  on(mic, "pointerdown", (event) => {
    if (event.button === 0) {
      event.preventDefault();
      void startVoice();
    }
  });
  on(win, "pointerup", () => {
    if (holding || listening) stopVoice();
  });
  on(win, "pointercancel", () => stopVoice(true));
  on(mic, "keydown", (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (!event.repeat) void startVoice();
    }
  });
  on(mic, "keyup", (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      stopVoice();
    }
  });
  on(win, "blur", () => stopVoice(true));
  on(win, "pagehide", () => stopVoice(true));
  on(doc, "visibilitychange", () => {
    if (doc.hidden) stopVoice(true);
  });
  container.replaceChildren(panel);
  refresh();
  await enabled();
  return () => {
    alive = false;
    generation++;
    stopVoice(true);
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition = null;
    }
    for (const remove of listeners) remove();
    clearVariantButtons();
    source.value = preview.value = "";
    variants = [];
    capture = undo = null;
    panel.remove();
  };
}
