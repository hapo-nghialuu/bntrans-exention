import test from "node:test";
import assert from "node:assert/strict";
import { createReadingPdf } from "../extension/src/experimental/reading-documents.js";
import {
  validatePdfFile,
  validatePdfPage
} from "../extension/src/experimental/reading-context.js";
import { tick } from "./test-labs-provider-harness.mjs";

const file = (text = "%PDF-synthetic") => ({
  size: text.length,
  name: "synthetic.pdf",
  type: "application/pdf",
  async arrayBuffer() {
    return new TextEncoder().encode(text).buffer;
  }
});
function fixture({
  pages = 3,
  items = [
    { str: "Synthetic line one.", hasEOL: true },
    { str: "Second line.", hasEOL: true }
  ],
  loading,
  content,
  workerError = false,
  encrypted = false
} = {}) {
  const calls = [],
    ports = [];
  let task;
  const pdf = {
    numPages: pages,
    async getPage(page) {
      calls.push(["page", page]);
      return {
        async getTextContent() {
          return content ? content() : { items };
        },
        cleanup() {
          calls.push(["cleanup", page]);
        }
      };
    }
  };
  const reader = createReadingPdf({
    async loadPdfjs() {
      return {
        GlobalWorkerOptions: {},
        PDFWorker: class {
          constructor({ port }) {
            assert.ok(ports.includes(port));
          }
          destroy() {
            calls.push(["worker-destroy"]);
          }
        },
        getDocument(options) {
          calls.push(["open", options]);
          task = {
            promise: loading || Promise.resolve(pdf),
            async destroy() {
              calls.push(["task-destroy"]);
            }
          };
          if (encrypted) queueMicrotask(() => task.onPassword());
          if (workerError)
            queueMicrotask(() => ports.at(-1).listeners.get("error")());
          return task;
        }
      };
    },
    createWorker(url) {
      assert.match(url, /\/assets\/vendor\/pdfjs\/pdf.worker.mjs$/);
      const port = {
        listeners: new Map(),
        addEventListener(type, fn) {
          this.listeners.set(type, fn);
        },
        removeEventListener(type) {
          this.listeners.delete(type);
        },
        terminate() {
          calls.push(["terminate"]);
        }
      };
      ports.push(port);
      return port;
    }
  });
  return { reader, calls, ports, pdf };
}

test("PDF validates file bytes/type, magic, page count and explicit 1-based selected page", async () => {
  for (const value of [
    undefined,
    { size: 0 },
    { ...file(), size: 25 * 1024 * 1024 + 1 },
    { ...file(), type: "image/png" }
  ])
    assert.throws(() => validatePdfFile(value));
  for (const [page, count] of [
    [1, 501],
    [1, 0],
    [0, 5],
    [6, 5],
    [1.5, 5],
    [1, NaN]
  ])
    assert.throws(() => validatePdfPage(page, count));
  const h = fixture();
  await assert.rejects(h.reader.open(file("NOT-PDF")), /pdf-invalid/);
  assert.equal(h.calls.length, 0);
  await h.reader.destroy();
});

test("PDF opens locally without extraction until capture; only selected page with stable attribution", async () => {
  const h = fixture();
  const opened = await h.reader.open(file());
  assert.equal(opened.pages, 3);
  assert.equal(h.calls.filter((call) => call[0] === "page").length, 0);
  const a = await h.reader.capturePage(2);
  const b = await h.reader.capturePage(2);
  assert.equal(a.kind, "pdf");
  assert.equal(a.url, "");
  assert.equal(a.title, "synthetic.pdf");
  assert.equal(a.page, 2);
  assert.equal(a.blocks.length, 2);
  assert.ok(
    a.blocks.every((block) => block.page === 2 && block.id.includes("-p2-"))
  );
  assert.deepEqual(a.blocks, b.blocks);
  assert.notEqual(a.snapshotId, b.snapshotId);
  assert.deepEqual(
    h.calls.filter((call) => call[0] === "page"),
    [
      ["page", 2],
      ["page", 2]
    ]
  );
  const options = h.calls.find((call) => call[0] === "open")[1];
  assert.equal(options.isEvalSupported, false);
  assert.equal(options.disableAutoFetch, true);
  assert.ok(options.cMapUrl.startsWith("file:"));
  assert.equal(options.url, undefined);
  await assert.rejects(h.reader.capturePage(4), /pdf-page/);
  await h.reader.close();
  assert.ok(h.calls.some((call) => call[0] === "task-destroy"));
  assert.ok(h.calls.some((call) => call[0] === "worker-destroy"));
  assert.ok(h.calls.some((call) => call[0] === "terminate"));
  assert.equal(h.ports[0].listeners.size, 0);
  await assert.rejects(h.reader.capturePage(1), /pdf-closed/);
});

test("oversized page count, scan, encrypted PDF and worker failure report errors and cleanup", async () => {
  const large = fixture({ pages: 501 });
  await assert.rejects(large.reader.open(file()), /pdf-pages/);
  assert.ok(large.calls.some((call) => call[0] === "terminate"));
  const scan = fixture({ items: [] });
  await scan.reader.open(file());
  await assert.rejects(scan.reader.capturePage(1), /pdf-no-text/);
  assert.ok(scan.calls.some((call) => call[0] === "cleanup"));
  await scan.reader.destroy();
  for (const options of [{ workerError: true }, { encrypted: true }]) {
    const h = fixture({ loading: new Promise(() => {}), ...options });
    await assert.rejects(h.reader.open(file()), /pdf-capability|pdf-encrypted/);
    assert.ok(h.calls.some((call) => call[0] === "terminate"));
  }
});

test("PDF source respects 40-block/30000-character bounds", async () => {
  for (const items of [
    Array.from({ length: 45 }, () => ({ str: "Synthetic", hasEOL: true })),
    [{ str: "a".repeat(40000), hasEOL: true }]
  ]) {
    const h = fixture({ items });
    await h.reader.open(file());
    const source = await h.reader.capturePage(1);
    assert.ok(source.blocks.length <= 40);
    assert.ok(
      source.blocks.reduce((sum, block) => sum + block.text.length, 0) <= 30000
    );
    assert.equal(source.truncated, true);
    await h.reader.destroy();
  }
});

test("closing PDF drops late page results and late open cannot replace a newer document", async () => {
  let finish;
  const h = fixture({
    content: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  });
  await h.reader.open(file());
  const page = h.reader.capturePage(2);
  while (!finish) await tick();
  await h.reader.close();
  finish({ items: [{ str: "Late", hasEOL: true }] });
  await assert.rejects(page, /source-cancelled/);
  assert.ok(h.calls.some((call) => call[0] === "cleanup"));
  let release;
  const pending = fixture({
    loading: new Promise((resolve) => {
      release = resolve;
    })
  });
  const open = pending.reader.open(file());
  while (!pending.calls.length) await tick();
  await pending.reader.close();
  release(pending.pdf);
  await assert.rejects(open, /source-cancelled/);
  await assert.rejects(pending.reader.capturePage(1), /pdf-closed/);
  await pending.reader.destroy();
  await assert.rejects(pending.reader.open(file()), /source-cancelled/);
});

test("helper extracts a real bundled PDF.js text layer on only the explicitly selected page", async () => {
  const pdfjs = await import("../extension/assets/vendor/pdfjs/pdf.mjs");
  const selected = [];
  const reader = createReadingPdf({
    loadPdfjs: async () => ({
      GlobalWorkerOptions: pdfjs.GlobalWorkerOptions,
      PDFWorker: class {
        destroy() {}
      },
      getDocument(options) {
        options = { ...options };
        delete options.worker;
        const task = pdfjs.getDocument({ ...options, verbosity: 0 });
        const promise = task.promise.then((pdf) => {
          const getPage = pdf.getPage.bind(pdf);
          pdf.getPage = (number) => {
            selected.push(number);
            return getPage(number);
          };
          return pdf;
        });
        return { promise, destroy: () => task.destroy() };
      }
    }),
    createWorker: () => ({
      addEventListener() {},
      removeEventListener() {},
      terminate() {}
    })
  });
  const stream = "BT /F1 12 Tf 50 750 Td (Real synthetic PDF text.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  try {
    assert.equal((await reader.open(file(pdf))).pages, 2);
    assert.deepEqual(selected, []);
    const source = await reader.capturePage(2);
    assert.deepEqual(selected, [2]);
    assert.equal(source.blocks[0].text, "Real synthetic PDF text.");
    assert.equal(source.blocks[0].page, 2);
  } finally {
    await reader.destroy();
  }
});
