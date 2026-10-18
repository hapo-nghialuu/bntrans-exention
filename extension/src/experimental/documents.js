import {
  DOCUMENT_LIMITS,
  DocumentError,
  TranslationQueue,
  archivePath,
  checkFile,
  documentIdentity,
  exportEpub,
  parseEpub,
  pdfParagraphs,
  settingsIdentity,
  splitText
} from "./document-utils.js";

const CACHE_KEY = "documents:checkpoint";
const ERRORS = {
  "file-size": [
    "Choose a non-empty file up to 25 MiB.",
    "Chọn file khác rỗng, tối đa 25 MiB."
  ],
  "zip-path": [
    "Unsafe archive path; import refused.",
    "Đường dẫn ZIP không an toàn; đã từ chối nhập."
  ],
  "zip-invalid": [
    "Invalid or unsupported ZIP archive.",
    "Gói ZIP lỗi hoặc không được hỗ trợ."
  ],
  "zip-limits": [
    "ZIP exceeds safety limits or uses unsupported ZIP64/compression.",
    "ZIP vượt giới hạn an toàn hoặc dùng ZIP64/kiểu nén chưa hỗ trợ."
  ],
  drm: [
    "Encrypted ePub is unsupported (including DRM/font obfuscation). No decryption attempted.",
    "Chưa hỗ trợ ePub mã hóa (kể cả DRM/font obfuscation). Không thử giải mã."
  ],
  "epub-invalid": [
    "Invalid ePub structure or XHTML.",
    "Cấu trúc ePub/XHTML không hợp lệ."
  ],
  "epub-missing": [
    "An ePub manifest resource is missing.",
    "Thiếu tài nguyên trong manifest ePub."
  ],
  "epub-spine": [
    "Only XHTML books with 1–500 spine chapters are supported.",
    "Chỉ hỗ trợ sách XHTML có 1–500 chương spine."
  ],
  "xml-entity": [
    "XML entity declarations are unsupported.",
    "Không hỗ trợ khai báo XML entity."
  ],
  "xml-invalid": [
    "Cannot parse this XML/XHTML document.",
    "Không đọc được XML/XHTML này."
  ],
  "text-limit": [
    "Page/chapter text exceeds the safety limit.",
    "Văn bản trang/chương vượt giới hạn an toàn."
  ],
  "cache-limit": [
    "Checkpoint is full (2 million characters). Export or clear it.",
    "Checkpoint đã đầy (2 triệu ký tự). Hãy xuất hoặc xóa."
  ],
  "translation-empty": [
    "Provider returned an empty translation; nothing was saved.",
    "Provider trả bản dịch rỗng; không lưu kết quả."
  ],
  "queue-busy": [
    "Wait for the active request to finish after cancelling.",
    "Đợi request đang chạy kết thúc sau khi hủy."
  ],
  "settings-changed": [
    "Settings changed. Resume to start a fresh checkpoint for the new configuration.",
    "Cấu hình đã đổi. Bấm Tiếp tục để tạo checkpoint mới cho cấu hình mới."
  ],
  disabled: [
    "Enable Documents in Labs before using this reader.",
    "Bật Documents trong Labs trước khi dùng reader."
  ],
  consent: [
    "Confirm sending selected text to your configured provider first.",
    "Xác nhận gửi văn bản được chọn tới provider đã cấu hình trước."
  ],
  "pdf-pages": [
    "PDF exceeds the 500-page limit.",
    "PDF vượt giới hạn 500 trang."
  ],
  "pdf-scan": [
    "No text layer on this page. Scanned PDFs need OCR, which is not included here.",
    "Trang này không có text layer. PDF scan cần OCR, chưa hỗ trợ tại đây."
  ],
  "file-type": [
    "Choose a .pdf or DRM-free .epub file.",
    "Chọn file .pdf hoặc .epub không DRM."
  ],
  "pdf-capability": [
    "PDF parser/worker/rendering is unavailable. Check the bundled assets and extension CSP; no translation was fabricated.",
    "Không dùng được parser/worker/render PDF. Kiểm tra asset nội bộ và CSP extension; không tạo bản dịch giả."
  ]
};

export async function mount(container, api) {
  const t = (en, vi) => api.t(en, vi);
  const doc = container.ownerDocument;
  const listeners = [];
  const urls = new Set();
  let disposed = false;
  let epoch = 0;
  let viewEpoch = 0;
  let state = null;
  let loadingTask = null;
  let workerPort = null;
  let pdfWorker = null;
  let renderTask = null;
  let pending = false;
  const el = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const listen = (node, event, handler) => {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  };
  const status = (message, kind = "info") => {
    if (!disposed) api.status(message, kind);
  };
  const showError = (error) => {
    if (disposed) return;
    const message = ERRORS[error.code];
    status(
      message
        ? t(...message)
        : t(
            "Operation failed. Check the file/provider configuration and try again.",
            "Thao tác thất bại. Kiểm tra file/cấu hình provider rồi thử lại."
          ),
      "error"
    );
  };
  const action = (label, handler) => {
    const button = el("button", label);
    button.type = "button";
    listen(button, "click", () => {
      button.disabled = true;
      return Promise.resolve()
        .then(handler)
        .catch(showError)
        .finally(() => {
          if (!disposed) button.disabled = false;
        });
    });
    return button;
  };
  const panel = el("section", undefined, "lab-panel");
  panel.append(
    el("h2", t("Local PDF & ePub reader", "Reader PDF & ePub nội bộ"))
  );
  panel.append(
    el(
      "p",
      t(
        "Experimental: PDF text layers only; no OCR, formula recognition or PDF export. PDF images may require the extension's local WASM decoder permission. ePub keeps chapters/anchors, raster images and basic sanitized SVG, but removes scripts, styling and active resources. Imported files stay in memory; only text you explicitly translate goes to the configured provider.",
        "Thử nghiệm: chỉ PDF có text layer; chưa OCR, nhận diện công thức hay xuất PDF. Ảnh PDF có thể cần quyền decoder WASM nội bộ của extension. ePub giữ chương/anchor, ảnh raster và SVG cơ bản đã làm sạch nhưng bỏ script, kiểu dáng và tài nguyên chủ động. File nhập chỉ ở bộ nhớ; chỉ văn bản bạn chủ động dịch được gửi tới provider đã cấu hình."
      )
    )
  );
  const file = el("input");
  file.type = "file";
  file.accept = ".pdf,.epub,application/pdf,application/epub+zip";
  const consent = el("input");
  consent.type = "checkbox";
  panel.append(
    api.field(t("Open file (maximum 25 MiB)", "Mở file (tối đa 25 MiB)"), file)
  );
  panel.append(
    api.field(
      t(
        "I agree to send this page/chapter's text to my provider. Translations are checkpointed locally (last file only).",
        "Tôi đồng ý gửi văn bản trang/chương này tới provider. Bản dịch được checkpoint cục bộ (chỉ file cuối)."
      ),
      consent
    )
  );
  const toolbar = el("div", undefined, "lab-toolbar");
  const select = el("select");
  select.setAttribute("aria-label", t("Page or chapter", "Trang hoặc chương"));
  const summary = el("p");
  const reader = el("div", undefined, "lab-result");
  const progress = el("p");
  progress.setAttribute("aria-live", "polite");
  const clearUrls = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const allowed = async () => {
    const settings = await api.settings();
    if (settings.labFeatures?.documents !== true)
      throw new DocumentError("disabled");
    return settings;
  };
  const release = async () => {
    state?.queue?.cancel();
    renderTask?.cancel();
    renderTask = null;
    clearUrls();
    const task = loadingTask;
    loadingTask = null;
    state = null;
    try {
      if (task) await task.destroy();
    } finally {
      pdfWorker?.destroy();
      pdfWorker = null;
      workerPort?.terminate();
      workerPort = null;
    }
  };
  const renderPairs = (blocks, prefix, translations) => {
    const list = el("div", undefined, "lab-list");
    blocks.forEach((text, index) => {
      const card = el("article", undefined, "lab-card");
      card.append(el("p", text));
      const result = el(
        "p",
        translations[`${prefix}:${index}`] || t("Not translated", "Chưa dịch")
      );
      result.dataset.unit = `${prefix}:${index}`;
      card.append(result);
      list.append(card);
    });
    return list;
  };
  const previewChapter = (chapter) => {
    const preview = el("article", undefined, "lab-card");
    const body = chapter.doc.getElementsByTagNameNS("*", "body")[0];
    const copy = (source, target) => {
      for (const child of source.childNodes) {
        if (child.nodeType === 3) {
          target.append(doc.createTextNode(child.textContent));
          continue;
        }
        if (child.nodeType !== 1) continue;
        const node = el(child.localName);
        for (const name of ["id", "lang", "dir", "alt", "title"])
          if (child.hasAttribute(name))
            node.setAttribute(name, child.getAttribute(name));
        if (child.localName === "a" && child.hasAttribute("href")) {
          node.setAttribute("href", "#");
          node.dataset.bookHref = child.getAttribute("href");
        }
        if (child.localName === "img" && child.hasAttribute("src")) {
          const path = archivePath(child.getAttribute("src"), chapter.path);
          const type = /\.svg$/i.test(path)
            ? "image/svg+xml"
            : /\.png$/i.test(path)
              ? "image/png"
              : /\.gif$/i.test(path)
                ? "image/gif"
                : /\.webp$/i.test(path)
                  ? "image/webp"
                  : "image/jpeg";
          const url = URL.createObjectURL(
            new Blob([state.book.entries[path]], { type })
          );
          urls.add(url);
          node.src = url;
          node.style.maxWidth = "100%";
        }
        copy(child, node);
        target.append(node);
      }
    };
    copy(body, preview);
    return preview;
  };
  const showPage = async (index) => {
    if (!state || disposed) return;
    const current = state;
    current.queue.cancel();
    const generation = ++viewEpoch;
    renderTask?.cancel();
    clearUrls();
    current.index = Math.max(0, Math.min(index, current.count - 1));
    current.units = [];
    select.value = String(current.index);
    reader.replaceChildren();
    progress.textContent = "";
    const original = el("div", undefined, "lab-card");
    const translated = el("div", undefined, "lab-card");
    reader.style.display = "grid";
    reader.style.gridTemplateColumns =
      "repeat(auto-fit, minmax(min(100%, 300px), 1fr))";
    reader.style.gap = "16px";
    original.append(el("h3", t("Original", "Bản gốc")));
    translated.append(el("h3", t("Paired translation", "Bản dịch đối chiếu")));
    reader.append(original, translated);
    if (current.kind === "pdf") {
      const page = await current.pdf.getPage(current.index + 1);
      const text = await page.getTextContent();
      if (generation !== viewEpoch || current !== state || disposed) return;
      const blocks = pdfParagraphs(text.items);
      current.units = blocks.map((text, i) => ({
        id: `pdf:${current.index}:${i}`,
        text
      }));
      translated.append(
        renderPairs(blocks, `pdf:${current.index}`, current.queue.results)
      );
      if (!blocks.length) status(t(...ERRORS["pdf-scan"]), "error");
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1.4, 1200 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = el("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = "100%";
      canvas.setAttribute(
        "aria-label",
        t(`PDF page ${current.index + 1}`, `Trang PDF ${current.index + 1}`)
      );
      original.append(canvas);
      try {
        renderTask = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport
        });
        await renderTask.promise;
      } catch (error) {
        if (
          error.name !== "RenderingCancelledException" &&
          generation === viewEpoch
        )
          throw new DocumentError("pdf-capability");
      }
    } else {
      const chapter = current.book.chapters[current.index];
      current.units = chapter.blocks.flatMap((block, i) =>
        splitText(block.textContent).map((text, chunk) => ({
          id: `epub:${current.index}:${i}:${chunk}`,
          text
        }))
      );
      original.append(previewChapter(chapter));
      const list = el("div", undefined, "lab-list");
      for (const unit of current.units) {
        const card = el("article", undefined, "lab-card");
        const result = el(
          "p",
          current.queue.results[unit.id] || t("Not translated", "Chưa dịch")
        );
        result.dataset.unit = unit.id;
        card.append(el("p", unit.text), result);
        list.append(card);
      }
      translated.append(list);
    }
  };
  const previous = action(t("Previous", "Trước"), () =>
    showPage((state?.index || 0) - 1)
  );
  const next = action(t("Next", "Sau"), () =>
    showPage((state?.index || 0) + 1)
  );
  const translate = action(
    t(
      "Translate current page/chapter · Resume",
      "Dịch trang/chương hiện tại · Tiếp tục"
    ),
    async () => {
      if (!state) return;
      const settings = await allowed();
      if (!consent.checked) throw new DocumentError("consent");
      const current = state;
      const identity = await documentIdentity(current.bytes, settings);
      if (state !== current || disposed) return;
      if (identity !== current.identity) {
        current.identity = identity;
        current.queue.results = {};
        await showPage(current.index);
      }
      if (!current.units?.length)
        throw new DocumentError(
          current.kind === "pdf" ? "pdf-scan" : "epub-invalid"
        );
      current.settings = settings;
      translate.disabled = true;
      try {
        await current.queue.run(current.units, (id, result) => {
          if (state !== current || disposed) return;
          for (const node of reader.querySelectorAll("[data-unit]"))
            if (node.dataset.unit === id) node.textContent = result;
          progress.textContent = t(
            "Checkpoint saved locally.",
            "Đã lưu checkpoint cục bộ."
          );
        });
      } finally {
        translate.disabled = false;
      }
    }
  );
  const cancel = action(t("Cancel", "Hủy"), () => {
    state?.queue.cancel();
    status(
      t(
        "Stopped scheduling requests. One in-flight provider request may still finish and be checkpointed.",
        "Đã dừng tạo request mới. Một request đang chạy có thể vẫn hoàn tất và được checkpoint."
      )
    );
  });
  const exportButton = action(
    t("Export bilingual ePub", "Xuất ePub song ngữ"),
    async () => {
      if (state?.kind !== "epub") return;
      await allowed();
      const completed = state.book.chapters.every((chapter, index) =>
        chapter.blocks.every((block, blockIndex) =>
          splitText(block.textContent).every((_, chunk) =>
            Object.hasOwn(
              state.queue.results,
              `epub:${index}:${blockIndex}:${chunk}`
            )
          )
        )
      );
      if (!completed)
        status(
          t(
            "Partial export: untranslated blocks remain original.",
            "Xuất một phần: đoạn chưa dịch vẫn giữ nguyên gốc."
          )
        );
      const bytes = exportEpub(
        state.book,
        state.queue.results,
        state.settings.nativeLanguageCode || "vi"
      );
      await api.download(
        state.name.replace(/\.epub$/i, "") + "-bilingual.epub",
        new Blob([bytes], { type: "application/epub+zip" }),
        "application/epub+zip"
      );
    }
  );
  const clear = action(
    t("Clear saved translations", "Xóa bản dịch đã lưu"),
    async () => {
      if (state?.queue.running) throw new DocumentError("queue-busy");
      await api.set(CACHE_KEY, null);
      if (state) {
        state.queue.results = {};
        await showPage(state.index);
      }
      status(t("Local checkpoint cleared.", "Đã xóa checkpoint cục bộ."));
    }
  );
  toolbar.append(
    previous,
    select,
    next,
    translate,
    cancel,
    exportButton,
    clear
  );
  panel.append(toolbar, summary, progress, reader);
  container.replaceChildren(panel);
  listen(select, "change", () =>
    showPage(Number(select.value)).catch(showError)
  );
  listen(reader, "click", (event) => {
    const anchor = event.target.closest?.("a[data-book-href]");
    if (!anchor || !state?.book) return;
    event.preventDefault();
    const value = anchor.dataset.bookHref;
    const chapter = state.book.chapters[state.index];
    const [filePath, hash] = value.split("#");
    const target = filePath
      ? archivePath(filePath, chapter.path)
      : chapter.path;
    const index = state.book.chapters.findIndex((item) => item.path === target);
    if (index < 0) {
      status(
        t(
          "Link is outside the readable spine.",
          "Liên kết nằm ngoài spine có thể đọc."
        )
      );
      return;
    }
    showPage(index)
      .then(() => {
        if (hash)
          Array.from(reader.querySelectorAll("[id]"))
            .find((node) => node.id === decodeURIComponent(hash))
            ?.scrollIntoView?.();
      })
      .catch(showError);
  });
  listen(file, "change", async () => {
    if (pending || disposed) return;
    pending = true;
    file.disabled = true;
    const currentEpoch = ++epoch;
    ++viewEpoch;
    try {
      const settings = await allowed();
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > DOCUMENT_LIMITS.fileBytes)
        throw new DocumentError("file-size");
      await release();
      consent.checked = false;
      reader.replaceChildren();
      select.replaceChildren();
      const bytes = new Uint8Array(await selected.arrayBuffer());
      checkFile(bytes);
      const identity = await documentIdentity(bytes, settings);
      const cache = await api.get(CACHE_KEY, null);
      if (disposed || currentEpoch !== epoch) return;
      const kind = /\.pdf$/i.test(selected.name)
        ? "pdf"
        : /\.epub$/i.test(selected.name)
          ? "epub"
          : "";
      const current = {
        kind,
        name: selected.name,
        bytes,
        identity,
        settings,
        index: 0,
        units: []
      };
      if (kind === "pdf") {
        try {
          const pdfjs = await import("../../assets/vendor/pdfjs/pdf.mjs");
          if (disposed || currentEpoch !== epoch) return;
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            "../../assets/vendor/pdfjs/pdf.worker.mjs",
            import.meta.url
          ).href;
          workerPort = new Worker(pdfjs.GlobalWorkerOptions.workerSrc, {
            type: "module"
          });
          pdfWorker = new pdfjs.PDFWorker({ port: workerPort });
          loadingTask = pdfjs.getDocument({
            data: bytes.slice(),
            worker: pdfWorker,
            isEvalSupported: false,
            stopAtErrors: true,
            disableFontFace: true,
            useSystemFonts: false,
            enableXfa: false,
            isImageDecoderSupported: false,
            maxImageSize: 16000000,
            canvasMaxAreaInBytes: 64000000,
            cMapUrl: new URL(
              "../../assets/vendor/pdfjs/cmaps/",
              import.meta.url
            ).href,
            cMapPacked: true,
            standardFontDataUrl: new URL(
              "../../assets/vendor/pdfjs/standard_fonts/",
              import.meta.url
            ).href
          });
          let timer;
          let rejectWorker;
          const workerFailure = new Promise((_, reject) => {
            rejectWorker = () => reject(new DocumentError("pdf-capability"));
          });
          workerPort.addEventListener("error", rejectWorker);
          workerPort.addEventListener("messageerror", rejectWorker);
          const port = workerPort;
          try {
            current.pdf = await Promise.race([
              loadingTask.promise,
              workerFailure,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new DocumentError("pdf-capability")),
                  30000
                );
              })
            ]);
          } finally {
            clearTimeout(timer);
            port.removeEventListener("error", rejectWorker);
            port.removeEventListener("messageerror", rejectWorker);
          }
          if (current.pdf.numPages > DOCUMENT_LIMITS.pages)
            throw new DocumentError("pdf-pages");
          current.count = current.pdf.numPages;
        } catch (error) {
          throw error instanceof DocumentError
            ? error
            : new DocumentError("pdf-capability");
        }
      } else if (kind === "epub") {
        current.book = parseEpub(bytes);
        current.count = current.book.chapters.length;
      } else throw new DocumentError("file-type");
      if (disposed || currentEpoch !== epoch) {
        await release();
        return;
      }
      current.queue = new TranslationQueue(
        async (text) => {
          const latest = await allowed();
          if (
            (await settingsIdentity(latest)) !== current.identity.split(":")[1]
          )
            throw new DocumentError("settings-changed");
          if (!consent.checked || disposed || state !== current)
            throw new DocumentError("consent");
          return api.translate(text, {
            skipHistory: true,
            task: "translate",
            cloudConsent: true,
            context: "A selected local document text block."
          });
        },
        async (results) => {
          if (!disposed && state === current)
            await api.set(CACHE_KEY, { identity: current.identity, results });
        },
        cache?.identity === identity &&
          cache.results &&
          JSON.stringify(cache.results).length <= DOCUMENT_LIMITS.cacheChars
          ? cache.results
          : {}
      );
      state = current;
      for (let i = 0; i < current.count; i++) {
        const option = el(
          "option",
          kind === "pdf"
            ? t(`Page ${i + 1}`, `Trang ${i + 1}`)
            : `${i + 1}. ${current.book.chapters[i].title}`
        );
        option.value = String(i);
        select.append(option);
      }
      exportButton.disabled = kind !== "epub";
      summary.textContent = `${selected.name} · ${current.count} ${kind === "pdf" ? t("pages", "trang") : t("chapters", "chương")}`;
      status(
        t(
          "File opened locally. Select a page/chapter, give consent, then translate.",
          "Đã mở file nội bộ. Chọn trang/chương, xác nhận rồi dịch."
        )
      );
      await showPage(0);
    } catch (error) {
      await release();
      showError(error);
    } finally {
      pending = false;
      file.disabled = false;
    }
  });
  exportButton.disabled = true;
  try {
    await allowed();
  } catch (error) {
    file.disabled = true;
    showError(error);
  }
  return () => {
    disposed = true;
    epoch++;
    viewEpoch++;
    listeners.forEach((remove) => remove());
    void release().catch(() => {});
    container.replaceChildren();
  };
}
