import {
  READING_LIMITS,
  createReadingId,
  ReadingError,
  validatePdfFile,
  validatePdfPage
} from "./reading-context.js";

export function createReadingPdf({
  loadPdfjs = () => import("../../assets/vendor/pdfjs/pdf.mjs"),
  createWorker = (url) => new Worker(url, { type: "module" })
} = {}) {
  let epoch = 0,
    viewEpoch = 0,
    task,
    port,
    worker,
    pdf;
  let name = "",
    documentId = "",
    destroyed = false;
  const live = (token) => {
    if (destroyed || token !== epoch)
      throw new ReadingError("source-cancelled");
  };
  async function close() {
    epoch++;
    viewEpoch++;
    const previous = { task, port, worker };
    task = port = worker = pdf = null;
    name = documentId = "";
    try {
      await previous.task?.destroy();
    } catch {
      /* Failed parsing must still release the explicit worker port. */
    } finally {
      try {
        previous.worker?.destroy();
      } finally {
        previous.port?.terminate();
      }
    }
  }
  return {
    async open(file) {
      validatePdfFile(file);
      const closing = close();
      const token = epoch;
      await closing;
      live(token);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        live(token);
        if (
          bytes.length !== file.size ||
          bytes.length > READING_LIMITS.fileBytes ||
          String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-"
        )
          throw new ReadingError("pdf-invalid");
        const pdfjs = await loadPdfjs();
        live(token);
        const workerUrl = new URL(
          "../../assets/vendor/pdfjs/pdf.worker.mjs",
          import.meta.url
        ).href;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        port = createWorker(workerUrl);
        worker = new pdfjs.PDFWorker({ port });
        task = pdfjs.getDocument({
          data: bytes,
          worker,
          isEvalSupported: false,
          disableAutoFetch: true,
          disableStream: true,
          useSystemFonts: false,
          disableFontFace: true,
          cMapUrl: new URL("../../assets/vendor/pdfjs/cmaps/", import.meta.url)
            .href,
          cMapPacked: true,
          standardFontDataUrl: new URL(
            "../../assets/vendor/pdfjs/standard_fonts/",
            import.meta.url
          ).href
        });
        const ownTask = task;
        let timeout, rejectWorker;
        const blocked = new Promise((_, reject) => {
          ownTask.onPassword = () => reject(new ReadingError("pdf-encrypted"));
          rejectWorker = () => reject(new ReadingError("pdf-capability"));
          timeout = setTimeout(rejectWorker, 30000);
        });
        const ownPort = port;
        ownPort.addEventListener("error", rejectWorker);
        ownPort.addEventListener("messageerror", rejectWorker);
        let loaded;
        try {
          loaded = await Promise.race([ownTask.promise, blocked]);
        } finally {
          clearTimeout(timeout);
          ownPort.removeEventListener("error", rejectWorker);
          ownPort.removeEventListener("messageerror", rejectWorker);
        }
        live(token);
        pdf = loaded;
        validatePdfPage(1, pdf.numPages);
        name = String(file.name || "PDF").slice(0, 500);
        documentId = createReadingId();
        return { documentId, title: name, pages: pdf.numPages };
      } catch (error) {
        if (token === epoch) await close();
        throw error;
      }
    },
    async capturePage(pageNumber) {
      if (!pdf) throw new ReadingError("pdf-closed");
      validatePdfPage(pageNumber, pdf.numPages);
      const token = epoch,
        view = ++viewEpoch;
      let page;
      try {
        page = await pdf.getPage(pageNumber);
        live(token);
        const content = await page.getTextContent();
        live(token);
        if (view !== viewEpoch) throw new ReadingError("source-cancelled");
        const blocks = [];
        let line = "",
          chars = 0,
          truncated = false;
        const flush = () => {
          const text = line.trim().slice(0, READING_LIMITS.chars - chars);
          if (text) {
            blocks.push({
              id: `pdf-${documentId}-p${pageNumber}-b${blocks.length + 1}`,
              page: pageNumber,
              text
            });
            chars += text.length;
          }
          line = "";
        };
        for (const item of content.items || []) {
          if (typeof item.str !== "string") continue;
          const available = READING_LIMITS.chars - chars - line.length;
          if (blocks.length >= READING_LIMITS.blocks || available <= 0) {
            truncated = true;
            break;
          }
          line += `${line ? " " : ""}${item.str}`.slice(0, available);
          if (item.str.length > available) truncated = true;
          if (item.hasEOL) flush();
        }
        if (blocks.length < READING_LIMITS.blocks) flush();
        if (!blocks.length) throw new ReadingError("pdf-no-text");
        return {
          kind: "pdf",
          mode: "page",
          documentId,
          snapshotId: createReadingId(),
          url: "",
          title: name,
          lang: "",
          page: pageNumber,
          truncated,
          blocks
        };
      } finally {
        page?.cleanup();
      }
    },
    close,
    async destroy() {
      destroyed = true;
      await close();
    }
  };
}
