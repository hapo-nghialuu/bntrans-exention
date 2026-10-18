export const OCR_LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  encodedBytes: 50 * 1024 * 1024,
  pixels: 12_000_000,
  dimension: 8000,
  text: 50_000
});

export function checkDimensions(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > OCR_LIMITS.dimension ||
    height > OCR_LIMITS.dimension ||
    width * height > OCR_LIMITS.pixels
  ) {
    throw new Error("image-limit");
  }
  return { width, height };
}

// Read dimensions before decoding; do not accept SVG, animation or remote URLs.
export function inspectImage(bytes) {
  if (!bytes.length || bytes.length > OCR_LIMITS.fileBytes) {
    throw new Error("file-limit");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.every((value, i) => bytes[i] === value)) {
    if (
      bytes.length < 33 ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452
    ) {
      throw new Error("image-format");
    }
    return {
      ...checkDimensions(view.getUint32(16), view.getUint32(20)),
      mime: "image/png"
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
        return {
          ...checkDimensions(
            view.getUint16(offset + 5),
            view.getUint16(offset + 3)
          ),
          mime: "image/jpeg"
        };
      }
      offset += size;
    }
  }
  throw new Error("image-format");
}

export function canvasPoint(clientX, clientY, bounds, width, height) {
  if (!bounds.width || !bounds.height) throw new Error("empty-preview");
  // Intrinsic/display ratio already includes screenshot DPR; never multiply twice.
  return {
    x: Math.max(
      0,
      Math.min(width, ((clientX - bounds.left) * width) / bounds.width)
    ),
    y: Math.max(
      0,
      Math.min(height, ((clientY - bounds.top) * height) / bounds.height)
    )
  };
}

export function pixelRect(start, end, width, height) {
  if (![start.x, start.y, end.x, end.y, width, height].every(Number.isFinite)) {
    throw new Error("empty-selection");
  }
  const x = Math.max(0, Math.floor(Math.min(start.x, end.x)));
  const y = Math.max(0, Math.floor(Math.min(start.y, end.y)));
  const right = Math.min(width, Math.ceil(Math.max(start.x, end.x)));
  const bottom = Math.min(height, Math.ceil(Math.max(start.y, end.y)));
  if (right <= x || bottom <= y) throw new Error("empty-selection");
  return { x, y, width: right - x, height: bottom - y };
}

export function maskPixels(image, rect) {
  const { width, height, data } = image;
  const r = pixelRect(
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    width,
    height
  );
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return image;
}

export function localWorkerOptions(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== "chrome-extension:") throw new Error("extension-only");
  return {
    workerPath: new URL("offline-worker.js", base).href,
    corePath: new URL("core/", base).href,
    langPath: new URL("lang/", base).href.replace(/\/$/, ""),
    gzip: true,
    cacheMethod: "none",
    legacyCore: false,
    legacyLang: false
  };
}

// Pinned Tesseract.js 5.1.1 worker protocol, with cancellable initialization.
export function createLocalEngine({
  baseUrl,
  WorkerClass = globalThis.Worker,
  timeoutMs = 90_000
} = {}) {
  const options = localWorkerOptions(baseUrl);
  let worker;
  let closed = false;
  let sequence = 0;
  let ready;
  const pending = new Map();
  const stop = (reason = new Error("canceled")) => {
    closed = true;
    worker?.terminate();
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(reason);
    }
    pending.clear();
  };
  const job = (action, payload) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error("canceled"));
      const jobId = `local-ocr-${++sequence}`;
      const timer = setTimeout(
        () => stop(new Error("engine-timeout")),
        timeoutMs
      );
      pending.set(jobId, { resolve, reject, timer });
      worker.postMessage({
        workerId: "bntrans-local-ocr",
        jobId,
        action,
        payload
      });
    });
  const initialize = async () => {
    if (closed) throw new Error("canceled");
    worker = new WorkerClass(options.workerPath);
    worker.onmessage = ({ data: message }) => {
      const entry = pending.get(message.jobId);
      if (!entry || message.status === "progress") return;
      clearTimeout(entry.timer);
      pending.delete(message.jobId);
      if (message.status === "resolve") entry.resolve(message.data);
      else {
        entry.reject(new Error("local-engine-failed"));
        stop(new Error("local-engine-failed"));
      }
    };
    worker.onerror = () => stop(new Error("local-engine-failed"));
    worker.onmessageerror = () => stop(new Error("local-engine-failed"));
    await job("load", {
      options: { lstmOnly: true, corePath: options.corePath, logging: false }
    });
    await job("loadLanguage", {
      langs: "eng",
      options: { ...options, lstmOnly: true }
    });
    await job("initialize", { langs: "eng", oem: 1, config: {} });
  };
  return {
    async recognizeLayout(pngBytes, language = "eng") {
      if (language !== "eng") throw new Error("unsupported-language");
      if (!(pngBytes instanceof Uint8Array)) throw new Error("image-format");
      if (!pngBytes.length || pngBytes.length > OCR_LIMITS.encodedBytes)
        throw new Error("file-limit");
      ready ||= initialize();
      await ready;
      const result = await job("recognize", {
        image: pngBytes,
        options: {},
        output: { text: true, blocks: true, hocr: false, tsv: false }
      });
      const lines = (result.blocks || []).flatMap((block) =>
        (block.paragraphs || []).flatMap((paragraph) =>
          (paragraph.lines || []).map((line) => ({
            text: String(line.text || ""),
            bbox: line.bbox,
            words: (line.words || []).map((word) => ({
              text: String(word.text || ""),
              bbox: word.bbox
            }))
          }))
        )
      );
      return { text: String(result.text || ""), lines };
    },
    async recognize(pngBytes, language = "eng") {
      if (language !== "eng") throw new Error("unsupported-language");
      if (!(pngBytes instanceof Uint8Array)) throw new Error("image-format");
      if (!pngBytes.length || pngBytes.length > OCR_LIMITS.encodedBytes)
        throw new Error("file-limit");
      ready ||= initialize();
      await ready;
      const result = await job("recognize", {
        image: pngBytes,
        options: {},
        output: { text: true, blocks: false, hocr: false, tsv: false }
      });
      return String(result.text || "").slice(0, OCR_LIMITS.text);
    },
    terminate: stop
  };
}

export function createOcrSession(engine, translate) {
  let revision = 0;
  let alive = true;
  let confirmed = false;
  let recognized = false;
  let busy = false;
  return {
    invalidate() {
      revision++;
      confirmed = recognized = false;
    },
    async confirm(pngBytes) {
      if (!alive || busy) throw new Error("canceled");
      confirmed = true;
      recognized = false;
      busy = true;
      const token = revision;
      try {
        const text = await engine.recognize(pngBytes);
        if (!alive || token !== revision) return null;
        recognized = true;
        return text;
      } finally {
        busy = false;
      }
    },
    async translateText(text, consent, options = {}) {
      if (!alive || !confirmed || !recognized || !consent) {
        throw new Error("confirmation-required");
      }
      if (!text.trim() || text.length > OCR_LIMITS.text)
        throw new Error("text-limit");
      const token = revision;
      const result = await translate(text, { ...options, skipHistory: true });
      return alive && token === revision ? result : null;
    },
    dispose() {
      alive = false;
      revision++;
      engine.terminate();
    }
  };
}
