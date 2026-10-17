import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads";
import { deflateSync, crc32, gunzipSync } from "node:zlib";
import { createLocalEngine } from "../extension/src/experimental/ocr-utils.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseUrl = "chrome-extension://bntrans/assets/vendor/ocr/";
const vendor = join(root, "extension/assets/vendor/ocr");

if (!isMainThread) {
  const pathFor = (url) => {
    const resource = new URL(url);
    if (
      !resource.href.startsWith(baseUrl) ||
      resource.search ||
      resource.hash
    ) {
      throw new Error("Test blocks all network / non-local resources");
    }
    parentPort.postMessage({ resource: resource.href });
    return join(
      vendor,
      decodeURIComponent(resource.pathname.split("/ocr/")[1])
    );
  };
  const sandbox = {
    URL,
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    WebAssembly,
    WorkerGlobalScope: class {},
    TextDecoder,
    TextEncoder,
    performance,
    console,
    setTimeout,
    clearTimeout,
    atob,
    btoa,
    location: { href: workerData.url },
    fetch: async (url) =>
      url.startsWith("data:application/octet-stream;base64,")
        ? new Response(Buffer.from(url.split(",")[1], "base64"))
        : new Response(readFileSync(pathFor(url))),
    postMessage: (data) => parentPort.postMessage({ result: data }),
    addEventListener: (name, callback) => {
      if (name === "message")
        parentPort.on("message", (data) => callback({ data }));
    }
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: true }
  });
  sandbox.importScripts = (...urls) => {
    for (const url of urls) {
      vm.runInContext(readFileSync(pathFor(url), "utf8"), context, {
        filename: url
      });
    }
  };
  vm.runInContext(readFileSync(pathFor(workerData.url), "utf8"), context);
} else {
  const resources = [];
  class BrowserWorker {
    constructor(url) {
      this.worker = new Worker(new URL(import.meta.url), {
        workerData: { url }
      });
      this.worker.on("message", (message) => {
        if (message.resource) resources.push(message.resource);
        else {
          if (message.result.status === "reject")
            console.error(
              "Synthetic engine rejection:",
              message.result.action,
              message.result.data
            );
          this.onmessage?.({ data: message.result });
        }
      });
      this.worker.on("error", (error) => {
        console.error(error);
        this.onerror?.(error);
      });
    }
    postMessage(data) {
      this.worker.postMessage(data);
    }
    terminate() {
      void this.worker.terminate();
    }
  }

  // Synthetic block lettering, generated entirely in memory (no user data/fonts).
  const font = {
    H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"]
  };
  const phrase = "HELLO WORLD";
  const scale = 8;
  const width = (phrase.length * 6 + 8) * scale;
  const height = 19 * scale;
  const rows = Buffer.alloc(height * (width + 1), 255);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  for (const [index, char] of [...phrase].entries()) {
    for (const [y, row] of (font[char] || []).entries()) {
      for (const [x, pixel] of [...row].entries()) {
        if (pixel !== "1") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            rows[
              ((y + 6) * scale + sy) * (width + 1) +
                1 +
                (index * 6 + x + 4) * scale +
                sx
            ] = 0;
          }
        }
      }
    }
  }
  const chunk = (name, bytes) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const encode = () =>
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0))
    ]);
  const png = encode();
  const model = gunzipSync(
    readFileSync(join(vendor, "lang/eng.traineddata.gz")),
    { maxOutputLength: 5 * 1024 * 1024 }
  );
  assert.equal(model.length, 4113088);
  const engine = createLocalEngine({
    baseUrl,
    WorkerClass: BrowserWorker,
    timeoutMs: 30_000
  });
  try {
    const text = await engine.recognize(new Uint8Array(png));
    assert.match(
      text,
      /HELLO\s+WORLD/i,
      `Real engine output: ${JSON.stringify(text)}`
    );
    const second = await engine.recognize(new Uint8Array(png));
    assert.equal(second, text, "Cached worker can run a second job");
    for (let y = 6 * scale; y < 13 * scale; y++) {
      for (let x = 40 * scale; x < 70 * scale; x++) {
        rows[y * (width + 1) + 1 + x] = 0;
      }
    }
    const redacted = await engine.recognize(new Uint8Array(encode()));
    assert.match(
      redacted,
      /HELL[OD]/i,
      "Unmasked word remains recognizable; block-font O/D ambiguity is acceptable"
    );
    assert.doesNotMatch(
      redacted,
      /WORLD/i,
      "Opaque masked word must not be recognized"
    );
    assert(resources.some((url) => url.endsWith("eng.traineddata.gz")));
    assert(resources.some((url) => /tesseract-core.*lstm.wasm.js$/.test(url)));
    assert(resources.every((url) => url.startsWith(baseUrl)));
    assert.equal(
      resources.filter((url) => url.endsWith("eng.traineddata.gz")).length,
      1
    );
    console.log(
      `PASS actual packaged Tesseract.js 5.1.1 / English OCR: ${JSON.stringify(text.trim())}`
    );
    console.log(
      "PASS worker reuse, bounded bundled model, no network (only extension-local resource shim)"
    );
    console.log(
      `PASS actual OCR after opaque masking: ${JSON.stringify(redacted.trim())}; dynamic JS code generation blocked`
    );
  } finally {
    engine.terminate();
  }
}
