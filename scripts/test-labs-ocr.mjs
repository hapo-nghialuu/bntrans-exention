import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import {
  OCR_LIMITS,
  canvasPoint,
  checkDimensions,
  createLocalEngine,
  createOcrSession,
  inspectImage,
  localWorkerOptions,
  maskPixels,
  pixelRect
} from "../extension/src/experimental/ocr-utils.js";

const baseUrl = "chrome-extension://test/assets/vendor/ocr/";
const syntheticHeader = (width, height) => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

test("reject oversized/unsupported/malformed images before decode", () => {
  assert.deepEqual(inspectImage(syntheticHeader(640, 480)), {
    width: 640,
    height: 480,
    mime: "image/png"
  });
  for (const [width, height] of [
    [0, 10],
    [8001, 10],
    [4000, 4000]
  ]) {
    assert.throws(
      () => inspectImage(syntheticHeader(width, height)),
      /image-limit/
    );
  }
  assert.throws(
    () => inspectImage(new Uint8Array(OCR_LIMITS.fileBytes + 1)),
    /file-limit/
  );
  assert.throws(
    () => inspectImage(new TextEncoder().encode("<svg/>")),
    /image-format/
  );
  assert.throws(
    () => inspectImage(syntheticHeader(10, 10).slice(0, 24)),
    /image-format/
  );
  assert.throws(
    () => inspectImage(new Uint8Array([255, 216, 255, 192, 0, 255])),
    /image-format/
  );
  const jpeg = new Uint8Array([
    255, 216, 255, 224, 0, 4, 1, 1, 255, 192, 0, 8, 8, 1, 224, 2, 128, 3
  ]);
  assert.deepEqual(inspectImage(jpeg), {
    width: 640,
    height: 480,
    mime: "image/jpeg"
  });
  assert.throws(() => checkDimensions(NaN, 2), /image-limit/);
});

test("DPR crop uses intrinsic/display scale and rounds outwards", () => {
  const start = canvasPoint(
    110,
    70,
    { left: 10, top: 20, width: 400, height: 200 },
    800,
    400
  );
  const end = canvasPoint(
    210,
    120,
    { left: 10, top: 20, width: 400, height: 200 },
    800,
    400
  );
  assert.deepEqual(pixelRect(start, end, 800, 400), {
    x: 200,
    y: 100,
    width: 200,
    height: 100
  });
  assert.deepEqual(pixelRect({ x: 2.9, y: 3.9 }, { x: 1.2, y: 1.1 }, 10, 10), {
    x: 1,
    y: 1,
    width: 2,
    height: 3
  });
  assert.throws(() => pixelRect(start, start, 800, 400), /empty-selection/);
  assert.throws(
    () => pixelRect({ x: NaN, y: 0 }, end, 800, 400),
    /empty-selection/
  );
  assert.throws(
    () => canvasPoint(1, 1, { width: 0, height: 1 }, 10, 10),
    /empty-preview/
  );
});

test("mask destroys RGB and alpha, preserving only unmasked pixels", () => {
  const image = {
    width: 3,
    height: 2,
    data: new Uint8ClampedArray(24).fill(177)
  };
  maskPixels(image, { x: 1, y: 0, width: 2, height: 1 });
  assert.deepEqual([...image.data.slice(4, 12)], [0, 0, 0, 255, 0, 0, 0, 255]);
  assert.deepEqual([...image.data.slice(12)], Array(12).fill(177));
  assert.deepEqual([...image.data.slice(0, 4)], [177, 177, 177, 177]);
});

test("OCR and provider calls require independent confirmation, never send image", async () => {
  const recognized = [];
  const sent = [];
  const session = createOcrSession(
    {
      recognize: async (bytes) => {
        recognized.push(bytes);
        return "HELLO";
      },
      terminate() {}
    },
    async (...args) => {
      sent.push(args);
      return "Xin chào";
    }
  );
  assert.equal(recognized.length, 0);
  await assert.rejects(
    session.translateText("HELLO", true),
    /confirmation-required/
  );
  assert.equal(await session.confirm(new Uint8Array([1, 2, 3])), "HELLO");
  assert.equal(sent.length, 0);
  await assert.rejects(
    session.translateText("HELLO", false),
    /confirmation-required/
  );
  assert.equal(
    await session.translateText("Edited text", true, {
      privacyPolicy: "local-only"
    }),
    "Xin chào"
  );
  assert.deepEqual(sent, [
    ["Edited text", { privacyPolicy: "local-only", skipHistory: true }]
  ]);
  session.invalidate();
  await assert.rejects(
    session.translateText("HELLO", true),
    /confirmation-required/
  );
  session.dispose();
});

test("canceled/unmounted sessions drop late OCR and translation callbacks", async () => {
  let resolve;
  let terminated = 0;
  const session = createOcrSession(
    {
      recognize: () =>
        new Promise((done) => {
          resolve = done;
        }),
      terminate: () => {
        terminated++;
      }
    },
    async () => "unused"
  );
  const result = session.confirm(new Uint8Array([1]));
  session.dispose();
  resolve("late synthetic OCR");
  assert.equal(await result, null);
  assert.equal(terminated, 1);
  const translating = createOcrSession(
    { recognize: async () => "hello", terminate() {} },
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await translating.confirm(new Uint8Array([1]));
  const translated = translating.translateText("hello", true);
  translating.dispose();
  resolve("late translation");
  assert.equal(await translated, null);
});

test("engine uses only local paths and cancel terminates during initialization", async () => {
  assert.throws(
    () => localWorkerOptions("https://example.com/"),
    /extension-only/
  );
  assert(
    Object.values(localWorkerOptions(baseUrl))
      .filter((value) => typeof value === "string" && value.includes("://"))
      .every((value) => value.startsWith(baseUrl))
  );
  const workers = [];
  class PendingWorker {
    constructor(url) {
      this.url = url;
      this.messages = [];
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
    }
    terminate() {
      this.terminated = true;
    }
  }
  const engine = createLocalEngine({ baseUrl, WorkerClass: PendingWorker });
  await assert.rejects(
    engine.recognize(new Uint8Array([1]), "vie"),
    /unsupported-language/
  );
  assert.equal(workers.length, 0);
  const pending = engine.recognize(new Uint8Array([1]));
  assert.equal(workers.length, 1);
  engine.terminate();
  await assert.rejects(pending, /canceled/);
  assert.equal(workers[0].terminated, true);
});

test("engine failure and timeout terminate rather than use a remote fallback", async () => {
  let current;
  class FailedWorker {
    constructor() {
      current = this;
    }
    postMessage(message) {
      queueMicrotask(() =>
        this.onmessage({
          data: { ...message, status: "reject", data: "synthetic failure" }
        })
      );
    }
    terminate() {
      this.terminated = true;
    }
  }
  const failing = createLocalEngine({ baseUrl, WorkerClass: FailedWorker });
  await assert.rejects(
    failing.recognize(new Uint8Array([1])),
    /local-engine-failed/
  );
  assert(current.terminated);
  class SilentWorker {
    constructor() {
      current = this;
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  }
  const silent = createLocalEngine({
    baseUrl,
    WorkerClass: SilentWorker,
    timeoutMs: 5
  });
  await assert.rejects(silent.recognize(new Uint8Array([1])), /engine-timeout/);
  assert(current.terminated);
});

test("worker resource guard rejects remote fetch/import/XHR and oversized embedded WASM", () => {
  const fetched = [];
  const imported = [];
  const sandbox = {
    URL,
    location: { href: `${baseUrl}offline-worker.js` },
    fetch: (url) => {
      fetched.push(url);
      return Promise.resolve();
    },
    importScripts: (...urls) => imported.push(...urls)
  };
  sandbox.self = sandbox;
  const source = readFileSync(
    new URL(
      "../extension/assets/vendor/ocr/offline-worker.js",
      import.meta.url
    ),
    "utf8"
  );
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(imported, [`${baseUrl}worker.min.js`]);
  assert.throws(() => sandbox.fetch("https://example.com/model"), /blocks/);
  assert.throws(
    () => sandbox.importScripts("data:text/javascript,alert(1)"),
    /blocks/
  );
  assert.throws(
    () => sandbox.importScripts("https://example.com/code.js"),
    /blocks/
  );
  assert.throws(
    () => sandbox.fetch(`${baseUrl}lang/vie.traineddata.gz`),
    /blocks/
  );
  assert.throws(
    () =>
      sandbox.fetch(
        "data:application/octet-stream;base64," + "A".repeat(6 * 1024 * 1024)
      ),
    /blocks/
  );
  assert.throws(() => new sandbox.XMLHttpRequest(), /blocks/);
  assert.throws(() => new sandbox.WebSocket(), /blocks/);
  sandbox.fetch(`${baseUrl}lang/eng.traineddata.gz`);
  sandbox.fetch("data:application/octet-stream;base64,AAAA");
  assert.equal(fetched.length, 2);
});

test("bundled assets and licensing are present", () => {
  const dir = new URL("../extension/assets/vendor/ocr/", import.meta.url);
  for (const path of [
    "worker.min.js",
    "TESSERACT-LICENSE.md",
    "worker.min.js.LICENSE.txt",
    "CORE-LICENSE",
    "TESSDATA-LICENSE",
    "lang/eng.traineddata.gz"
  ]) {
    assert(readFileSync(new URL(path, dir)).length > 50);
  }
  assert.equal(readdirSync(new URL("core/", dir)).length, 4);
  const hash = (path) =>
    createHash("sha256")
      .update(readFileSync(new URL(path, dir)))
      .digest("hex");
  assert.equal(
    hash("TESSDATA-LICENSE"),
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
  );
  const module = readFileSync(
    new URL("../extension/src/experimental/ocr.js", import.meta.url),
    "utf8"
  );
  assert(
    !/translate-image|capture-visible|\.send\(|\.set\(|localStorage|innerHTML|eval\(/.test(
      module
    )
  );
});

export { syntheticHeader };
