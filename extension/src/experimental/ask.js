import { matchesHostname } from "./lab-api.js";
import { createReadingFeatureApi } from "./reading-feature-api.js";
import { createReadingPdf } from "./reading-documents.js";
import { ASK_LIMITS, createAskSession } from "./ask-engine.js";

const ERRORS = {
  "source-disabled": [
    "Enable Ask in Labs first.",
    "Bật Hỏi nguồn trong Labs trước."
  ],
  "source-selection": [
    "Select readable website text first, or capture the article.",
    "Chọn văn bản website có thể đọc trước, hoặc lấy nội dung bài."
  ],
  "source-empty": [
    "No readable source. Hidden, editable and protected text is excluded.",
    "Không có nguồn đọc được. Đã loại văn bản ẩn, đang sửa và được bảo vệ."
  ],
  "source-stale": [
    "The source changed. Capture it again before asking.",
    "Nguồn đã đổi. Lấy lại nguồn trước khi hỏi."
  ],
  "source-cancelled": ["Action cancelled.", "Đã hủy thao tác."],
  "ask-question": [
    "Enter a question of 1–2,000 characters.",
    "Nhập câu hỏi từ 1–2.000 ký tự."
  ],
  "ask-selection": ["Choose at least one snippet.", "Chọn ít nhất một đoạn."],
  "ask-consent": [
    "Confirm sending the selected snippets and this question first.",
    "Xác nhận gửi đoạn đã chọn và câu hỏi này trước."
  ],
  "ask-provider": [
    "Configure an instruction-capable AI provider in Settings first.",
    "Cấu hình provider AI hỗ trợ chỉ dẫn trong Cài đặt trước."
  ],
  "ask-prompt": [
    "The request exceeds the size limit. Select fewer snippets.",
    "Request vượt giới hạn kích thước. Chọn ít đoạn hơn."
  ],
  "ask-source": ["Unsupported source data.", "Dữ liệu nguồn không hỗ trợ."],
  "ask-output": [
    "Invalid or oversized answer JSON. No sourced answer was accepted.",
    "JSON trả lời lỗi hoặc quá dài. Không chấp nhận câu trả lời có nguồn."
  ],
  "ask-citation": [
    "A citation is invalid, unselected or has a mismatched quote. Answer rejected.",
    "Citation sai, chưa được chọn hoặc trích dẫn không khớp. Đã từ chối câu trả lời."
  ],
  "ask-no-citations": [
    "No supporting source was returned. No sourced answer was accepted.",
    "Không có nguồn hỗ trợ được trả về. Không chấp nhận câu trả lời có nguồn."
  ],
  "file-size": ["Choose a PDF up to 25 MiB.", "Chọn PDF tối đa 25 MiB."],
  "pdf-invalid": ["Choose a valid local PDF.", "Chọn PDF local hợp lệ."],
  "pdf-pages": ["PDF must have 1–500 pages.", "PDF phải có 1–500 trang."],
  "pdf-page": ["Choose a valid page number.", "Chọn số trang hợp lệ."],
  "pdf-closed": ["Open a PDF first.", "Mở PDF trước."],
  "pdf-no-text": [
    "This page has no text layer. Scanned PDFs need OCR; nothing was sent.",
    "Trang này không có text layer. PDF scan cần OCR; chưa gửi gì."
  ],
  "pdf-encrypted": [
    "Encrypted PDFs are unsupported. No decryption attempted.",
    "Chưa hỗ trợ PDF mã hóa. Không thử giải mã."
  ],
  "pdf-capability": [
    "Local PDF parser/worker unavailable. No answer was fabricated.",
    "Không dùng được parser/worker PDF local. Không tạo câu trả lời giả."
  ]
};

const instructionProviders = new Set([
  "gemini",
  "openai",
  "openrouter",
  "groq",
  "claude",
  "ollama",
  "codex",
  "custom"
]);

export function mount(container, api, { pdf = createReadingPdf() } = {}) {
  const doc = container.ownerDocument;
  const t = (en, vi) => api.t(en, vi);
  const reading = createReadingFeatureApi(api, "ask");
  const session = createAskSession({ reading, pdf });
  const removers = [];
  const snippets = new Map();
  let alive = true,
    busy = false,
    generation = 0,
    settings = null;
  let selected = new Set();
  const el = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const listen = (node, event, handler) => {
    node.addEventListener(event, handler);
    removers.push(() => node.removeEventListener(event, handler));
  };
  const button = (name, en, vi, callback) => {
    const node = el("button", t(en, vi));
    node.type = "button";
    node.dataset.ask = name;
    listen(node, "click", callback);
    return node;
  };
  const enabled = () =>
    settings?.enabled !== false && settings?.labFeatures?.ask === true;
  const provider = () => {
    let host = "";
    try {
      host = new URL(session.source?.url || "").hostname;
    } catch {
      /* PDF has no website policy. */
    }
    const rule = (settings?.privacyRules || [])
      .filter((entry) => host && matchesHostname(host, entry.hostname))
      .sort((a, b) => b.hostname.length - a.hostname.length)[0];
    const id = rule?.providerId || settings?.activeProviderId;
    return {
      value: settings?.providers?.find((entry) => entry.id === id),
      mode: rule?.mode || settings?.privacyDefaultMode || "cloud"
    };
  };
  const say = (message, kind = "info") => {
    if (alive) api.status(message, kind);
  };
  const showError = (error) => {
    const message = ERRORS[error.code || error.message];
    say(
      message
        ? t(...message)
        : t(
            "Action failed. Check the source, provider and privacy settings; nothing was saved.",
            "Thao tác thất bại. Kiểm tra nguồn, provider và riêng tư; không lưu nội dung."
          ),
      "error"
    );
  };
  const invalidSource = (error) =>
    ["source-stale", "source-disabled", "source-cancelled"].includes(
      error.code || error.message
    );

  const panel = el("section", undefined, "lab-panel");
  panel.append(
    el("h2", t("Ask selected sources", "Hỏi nguồn đã chọn")),
    el(
      "p",
      t(
        "Capture first, choose snippets, then ask. Only checked text and your question are sent on your click. Answers stay in this workspace's memory; no chat, history or source content is saved. PDF text layers only, no OCR.",
        "Lấy nguồn, chọn đoạn rồi hỏi. Chỉ gửi đoạn đã chọn và câu hỏi khi bấm gửi. Câu trả lời chỉ ở bộ nhớ khu làm việc; không lưu chat, lịch sử hay nội dung nguồn. Chỉ PDF có text layer, chưa OCR."
      )
    )
  );
  const sourceControls = el("div", undefined, "lab-toolbar");
  const mode = el("select");
  mode.dataset.ask = "mode";
  for (const [value, en, vi] of [
    ["selection", "Selected website text", "Văn bản đang chọn trên web"],
    ["article", "Readable article", "Nội dung bài có thể đọc"]
  ]) {
    const option = el("option", t(en, vi));
    option.value = value;
    mode.append(option);
  }
  const capture = button(
    "capture",
    "Capture website",
    "Lấy nguồn website",
    () => {
      clearView();
      file.value = "";
      void run(async () => {
        await session.captureWebsite(mode.value);
        await refreshSettings();
      }, true);
    }
  );
  sourceControls.append(
    api.field(t("Website source", "Nguồn website"), mode),
    capture
  );
  const file = el("input");
  file.dataset.ask = "file";
  file.type = "file";
  file.accept = ".pdf,application/pdf";
  const open = button("open", "Open PDF locally", "Mở PDF local", () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    clearView();
    void run(async () => {
      await session.openPdf(chosen);
      page.value = "1";
      await refreshSettings();
    }, true);
  });
  const pdfControls = el("div", undefined, "lab-toolbar");
  pdfControls.append(
    api.field(
      t("Local PDF · maximum 25 MiB", "PDF local · tối đa 25 MiB"),
      file
    ),
    open
  );
  const page = el("input");
  page.dataset.ask = "page";
  page.type = "number";
  page.min = "1";
  page.value = "1";
  const preview = button("preview", "Preview page", "Xem nguồn trang", () => {
    clearView();
    void run(async () => {
      await session.capturePdfPage(Number(page.value));
      await refreshSettings();
    }, true);
  });
  const pageControls = el("div", undefined, "lab-toolbar");
  const documentInfo = el("span", "", "lab-muted");
  pageControls.append(
    api.field(t("PDF page", "Trang PDF"), page),
    preview,
    documentInfo
  );
  const sourceInfo = el("p", "", "lab-muted");
  sourceInfo.dataset.ask = "source";
  const sourceList = el("ol", undefined, "lab-list");
  sourceList.dataset.ask = "sources";
  const summary = el("p", "", "lab-muted");
  summary.dataset.ask = "summary";
  const providerInfo = el("p", "", "lab-muted");
  providerInfo.dataset.ask = "provider";
  const question = el("textarea");
  question.dataset.ask = "question";
  question.maxLength = ASK_LIMITS.question;
  const consent = el("input");
  consent.type = "checkbox";
  consent.dataset.ask = "consent";
  const send = button(
    "send",
    "Ask selected sources",
    "Hỏi đoạn đã chọn",
    () => {
      const accepted = consent.checked;
      consent.checked = false;
      answerView.replaceChildren();
      void run(() =>
        session.ask(question.value, [...selected], {
          consent: accepted,
          providerId: provider().value?.id
        })
      );
    }
  );
  const cancel = button("cancel", "Cancel / clear", "Hủy / xóa nguồn", () => {
    generation++;
    busy = false;
    clearView();
    file.value = "";
    void session.cancel().catch(showError);
    update();
    say(
      t(
        "Cancelled; source and consent cleared. In-flight network requests may still finish, but their answers are discarded.",
        "Đã hủy, xóa nguồn và xác nhận. Request đang chạy có thể vẫn hoàn tất trên mạng nhưng sẽ bỏ kết quả."
      )
    );
  });
  const actions = el("div", undefined, "lab-toolbar");
  actions.append(send, cancel);
  const progress = el("p", "", "lab-muted");
  progress.setAttribute("role", "status");
  const answerView = el("section");
  answerView.dataset.ask = "answer";
  panel.append(
    sourceControls,
    pdfControls,
    pageControls,
    sourceInfo,
    sourceList,
    summary,
    providerInfo,
    api.field(
      t("Question · maximum 2,000 characters", "Câu hỏi · tối đa 2.000 ký tự"),
      question
    ),
    api.field(
      t(
        "I agree to send only the checked snippets and this question to the provider shown above, for this request.",
        "Tôi đồng ý gửi chỉ đoạn đã chọn và câu hỏi này đến provider hiển thị ở trên, cho request này."
      ),
      consent
    ),
    actions,
    progress,
    answerView
  );
  container.append(panel);

  function clearView() {
    selected = new Set();
    consent.checked = false;
    question.value = "";
    snippets.clear();
    sourceList.replaceChildren();
    answerView.replaceChildren();
  }
  function update() {
    if (!alive) return;
    const source = session.source,
      document = session.document;
    const { value: chosen, mode: policy } = provider();
    const capable = instructionProviders.has(chosen?.type);
    const blocks =
      source?.blocks.filter((block) => selected.has(block.id)) || [];
    const chars = blocks.reduce((n, block) => n + block.text.length, 0);
    pageControls.hidden = !document;
    page.max = String(document?.pages || 1);
    documentInfo.textContent = document
      ? `${document.title} · ${document.pages} ${t("pages", "trang")}`
      : "";
    sourceInfo.textContent = source
      ? (source.kind === "pdf"
          ? `${source.title} · ${t("Page", "Trang")} ${source.page} · ${t("local text layer", "text layer local")}`
          : `${source.title} · ${source.url}`) +
        (source.truncated
          ? t(" · truncated preview", " · nguồn đã cắt theo giới hạn")
          : "")
      : t(
          "No source yet. Capturing previews text locally; it does not send it.",
          "Chưa có nguồn. Lấy nguồn chỉ xem trước văn bản local, không gửi đi."
        );
    summary.textContent = t(
      `${blocks.length} selected snippets · ${chars} source characters · ${question.value.length}/${ASK_LIMITS.question} question characters`,
      `${blocks.length} đoạn đã chọn · ${chars} ký tự nguồn · ${question.value.length}/${ASK_LIMITS.question} ký tự câu hỏi`
    );
    providerInfo.textContent = chosen
      ? `${t("Provider", "Provider")}: ${String(chosen.name || chosen.id).slice(0, 200)} · ${String(chosen.config?.model || chosen.type).slice(0, 200)} · ${policy}` +
        (!capable
          ? t(
              " · Q&A requires an instruction-capable model",
              " · Q&A cần model hỗ trợ chỉ dẫn"
            )
          : "")
      : t("No configured provider.", "Chưa cấu hình provider.");
    capture.disabled =
      open.disabled =
      mode.disabled =
      file.disabled =
        busy || !enabled();
    open.disabled ||= !file.files?.length;
    page.disabled = preview.disabled = busy || !enabled() || !document;
    question.disabled = consent.disabled = busy || !enabled() || !source;
    send.disabled =
      busy ||
      !enabled() ||
      !source ||
      !blocks.length ||
      !question.value.trim() ||
      question.value.length > ASK_LIMITS.question ||
      !consent.checked ||
      !capable;
    for (const check of sourceList.querySelectorAll("input"))
      check.disabled = busy || !enabled();
    progress.textContent = busy
      ? t(
          "Working… Cancel discards late results.",
          "Đang xử lý… Hủy sẽ bỏ kết quả muộn."
        )
      : "";
    panel.setAttribute("aria-busy", String(busy));
  }
  function renderSources() {
    snippets.clear();
    sourceList.replaceChildren();
    for (const block of session.source?.blocks || []) {
      const item = el("li", undefined, "lab-card");
      item.tabIndex = -1;
      const check = el("input");
      check.type = "checkbox";
      check.dataset.blockId = block.id;
      item.append(
        api.field(`${t("Include source", "Chọn nguồn")} ${block.id}`, check),
        el("p", block.text, "lab-result")
      );
      sourceList.append(item);
      snippets.set(block.id, item);
    }
  }
  function renderAnswer() {
    answerView.replaceChildren();
    if (!session.answer) return;
    answerView.append(
      el(
        "h3",
        t(
          "AI answer · check the sources",
          "Câu trả lời AI · hãy kiểm tra nguồn"
        )
      ),
      el("p", session.answer.answer, "lab-result"),
      el(
        "p",
        t(
          "Source IDs and any quotes match the selected snippets. This is not factual verification of the answer.",
          "ID nguồn và trích dẫn (nếu có) khớp đoạn đã chọn. Đây không phải xác minh tính đúng của câu trả lời."
        ),
        "lab-muted"
      )
    );
    const list = el("ol", undefined, "lab-list");
    session.answer.citations.forEach((citation, index) => {
      const item = el("li");
      const jump = el(
        "button",
        `${t("Source", "Nguồn")} ${index + 1} · ${session.source.kind === "pdf" ? `${t("Page", "Trang")} ${session.source.page} · ` : ""}${citation.id}`
      );
      jump.type = "button";
      jump.dataset.citation = String(index);
      item.append(jump);
      if (citation.quote) item.append(el("blockquote", citation.quote));
      list.append(item);
    });
    answerView.append(list);
  }
  async function refreshSettings() {
    const next = await api.settings();
    if (alive) settings = next;
  }
  async function run(operation, newSource = false) {
    const token = ++generation;
    busy = true;
    update();
    say("");
    try {
      await operation();
      if (!alive || token !== generation) return;
      if (newSource) renderSources();
      else renderAnswer();
    } catch (error) {
      if (!alive || token !== generation) return;
      if (invalidSource(error)) {
        clearView();
        await session.cancel().catch(() => {});
      }
      if (alive && token === generation) showError(error);
    } finally {
      if (alive && token === generation) {
        busy = false;
        update();
      }
    }
  }
  listen(sourceList, "change", (event) => {
    const id = event.target.dataset.blockId;
    if (!snippets.has(id) || busy) return;
    if (event.target.checked) selected.add(id);
    else selected.delete(id);
    consent.checked = false;
    answerView.replaceChildren();
    update();
  });
  listen(question, "input", () => {
    consent.checked = false;
    answerView.replaceChildren();
    update();
  });
  listen(consent, "change", update);
  listen(file, "change", () => {
    clearView();
    void run(() => session.cancel(), true);
  });
  listen(page, "input", () => {
    clearView();
    void run(() => session.clearPage(), true);
  });
  listen(answerView, "click", (event) => {
    const citation = event.target.closest("button[data-citation]");
    if (!citation || busy) return;
    const token = generation;
    void session
      .jumpCitation(Number(citation.dataset.citation))
      .then((target) => {
        if (!alive || token !== generation || target.kind !== "pdf") return;
        const item = snippets.get(target.blockId);
        if (!item || Number(page.value) !== target.page)
          throw new Error("source-stale");
        for (const snippet of snippets.values())
          snippet.removeAttribute("aria-current");
        item.setAttribute("aria-current", "true");
        item.focus();
        item.scrollIntoView?.({ block: "center", behavior: "auto" });
      })
      .catch(async (error) => {
        if (!alive || token !== generation) return;
        if (invalidSource(error)) {
          clearView();
          await session.cancel().catch(() => {});
          update();
        }
        if (alive && token === generation) showError(error);
      });
  });
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes.translatorSettings || !alive) return;
    clearView();
    file.value = "";
    void run(async () => {
      await session.cancel();
      await refreshSettings();
    }, true);
  };
  chrome.storage.onChanged.addListener(onStorage);
  void refreshSettings().then(update).catch(showError);
  update();
  return () => {
    if (!alive) return;
    alive = false;
    generation++;
    clearView();
    chrome.storage.onChanged.removeListener(onStorage);
    for (const remove of removers) remove();
    void session.dispose().catch(() => {});
    panel.remove();
  };
}
