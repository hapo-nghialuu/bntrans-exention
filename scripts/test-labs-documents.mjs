import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  zipSync,
  strToU8,
  strFromU8,
  unzipSync
} from "../extension/assets/vendor/fflate/fflate.mjs";
import {
  DOCUMENT_LIMITS,
  archivePath,
  parseXml,
  parseEpub,
  readEpubZip,
  exportEpub,
  splitText,
  pdfParagraphs,
  TranslationQueue,
  documentIdentity,
  sanitizeXhtml,
  sanitizeSvg
} from "../extension/src/experimental/document-utils.js";
import { mount } from "../extension/src/experimental/documents.js";

const dom = new JSDOM("<!doctype html><body><main></main></body>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

test("binary ePub roundtrip preserves spine, metadata, TOC links, anchors and image bytes", () => {
  const input = makeEpub();
  assert.equal(input[0], 80);
  const book = parseEpub(input);
  assert.equal(book.language, "fr");
  assert.equal(book.chapters.length, 2);
  assert.deepEqual(
    book.chapters.map((c) => c.path),
    ["OPS/one.xhtml", "OPS/two.xhtml"]
  );
  const results = {};
  book.chapters.forEach((chapter, i) =>
    chapter.blocks.forEach((block, j) =>
      splitText(block.textContent).forEach((text, k) => {
        results[`epub:${i}:${j}:${k}`] = `Synthetic translation: ${text}`;
      })
    )
  );
  const output = exportEpub(book, results, "vi");
  const view = new DataView(output.buffer);
  assert.equal(
    view.getUint16(8, true),
    0,
    "mimetype is first and uncompressed"
  );
  assert.equal(strFromU8(output.subarray(30, 38)), "mimetype");
  const entries = readEpubZip(output);
  assert.deepEqual(entries["OPS/package.opf"], book.entries["OPS/package.opf"]);
  assert.deepEqual(entries["OPS/pixel.png"], book.entries["OPS/pixel.png"]);
  assert.match(strFromU8(entries["OPS/nav.xhtml"]), /two.xhtml#chapter-two/);
  assert.match(strFromU8(entries["OPS/one.xhtml"]), /id="chapter-one"/);
  assert.match(strFromU8(entries["OPS/one.xhtml"]), /lang="vi"/);
  assert.match(strFromU8(entries["OPS/one.xhtml"]), /Premier paragraphe/);
  assert.match(strFromU8(entries["OPS/one.xhtml"]), /Synthetic translation/);
  assert.equal(parseEpub(output).chapters.length, 2);
});

test("bounded ZIP rejects paths, duplicates, oversize entries, encryption and malformed input", () => {
  assert.throws(() => archivePath("../fixture.txt"));
  assert.throws(() => archivePath("%2e%2e/fixture.txt"));
  assert.throws(() => archivePath("https://example.test/book"));
  assert.throws(() => archivePath("__proto__/fixture"));
  assert.throws(() => readEpubZip(new Uint8Array([1, 2, 3])));
  const encrypted = epubEntries();
  encrypted["META-INF/encryption.xml"] = strToU8("<encryption/>");
  assert.throws(
    () => parseEpub(makeEpub(encrypted)),
    (e) => e.code === "drm"
  );
  const large = makeEpub();
  const v = new DataView(large.buffer);
  for (let i = 0; i < large.length - 46; i++)
    if (v.getUint32(i, true) === 0x02014b50) {
      v.setUint32(i + 24, DOCUMENT_LIMITS.entryBytes + 1, true);
      break;
    }
  assert.throws(
    () => readEpubZip(large),
    (e) => e.code === "zip-limits"
  );
  const pathFixture = epubEntries();
  pathFixture["../fixture.txt"] = strToU8("bounded fixture");
  assert.throws(
    () => readEpubZip(makeEpub(pathFixture)),
    (e) => e.code === "zip-path"
  );
  const liedSize = zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "padding.txt": strToU8("a".repeat(20000))
  });
  const liedView = new DataView(liedSize.buffer);
  for (let i = 0; i < liedSize.length - 46; i++) {
    if (
      liedView.getUint32(i, true) === 0x02014b50 &&
      liedView.getUint32(i + 24, true) === 20000
    ) {
      liedView.setUint32(i + 24, 1, true);
      break;
    }
  }
  assert.throws(
    () => readEpubZip(liedSize),
    (e) => e.code === "zip-limits"
  );
});

test("SVG sanitization preserves basic local vector artwork but removes scripts and remote references", () => {
  const doc = parseXml(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect id="square" width="10" height="10" fill="#123456"/><image href="https://example.test/image.png"/><script type="application/json">{}</script><path d="M0 0L1 1" fill="url(https://example.test/paint)" onclick="fixture"/></svg>'
  );
  sanitizeSvg(doc);
  const output = new XMLSerializer().serializeToString(doc);
  assert.match(output, /viewBox="0 0 10 10"/);
  assert.match(output, /id="square"/);
  assert.doesNotMatch(output, /script|https:|onclick|<image|url\(/);
  const entries = epubEntries();
  entries["OPS/vector.svg"] = strToU8(output);
  assert.equal(parseEpub(makeEpub(entries)).chapters.length, 2);
});

test("XHTML sanitization allows local links/images but no active or remote resources", () => {
  const doc = parseXml(
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title><style>p { color: red }</style></head><body><p id="hello" style="color:red" onclick="fixture">Hello</p><a href="https://example.test/">Link</a><img src="https://example.test/pixel.png"/><img src="pixel.png"/><iframe/><script type="application/json">{}</script></body></html>'
  );
  sanitizeXhtml(doc, "OPS/one.xhtml", { "OPS/pixel.png": new Uint8Array() });
  const text = new XMLSerializer().serializeToString(doc);
  assert.doesNotMatch(text, /onclick|https:|<script|<iframe|<style|style=/);
  assert.match(text, /id="hello"/);
  assert.match(text, /src="pixel.png"/);
  assert.throws(
    () => parseXml('<!DOCTYPE html [<!ENTITY fixture "bounded">]><html/>'),
    (e) => e.code === "xml-entity"
  );
  assert.throws(
    () => parseXml("<unclosed>"),
    (e) => e.code === "xml-invalid"
  );
});

test("real 10-page PDF text layer keeps page numbers and text order; empty scan page is detected", async () => {
  const pdfjs = await import("../extension/assets/vendor/pdfjs/pdf.mjs");
  const loading = pdfjs.getDocument({
    data: makePdf(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0
  });
  const pdf = await loading.promise;
  try {
    assert.equal(pdf.numPages, 10);
    for (let i = 1; i <= 10; i++) {
      const page = await pdf.getPage(i);
      const paragraphs = pdfParagraphs((await page.getTextContent()).items);
      assert.deepEqual(paragraphs, [
        `Page ${i} first paragraph.`,
        `Page ${i} second paragraph.`
      ]);
    }
  } finally {
    await loading.destroy();
  }
  const scanTask = pdfjs.getDocument({
    data: makePdf(1, true),
    isEvalSupported: false,
    verbosity: 0
  });
  try {
    const scan = await scanTask.promise;
    assert.deepEqual(
      pdfParagraphs((await (await scan.getPage(1)).getTextContent()).items),
      []
    );
  } finally {
    await scanTask.destroy();
  }
});

test("queue cancel sends no next request; checkpoints resume without retranslating completed chunks", async () => {
  let release;
  const calls = [];
  const saved = [];
  const q = new TranslationQueue(
    async (text) => {
      calls.push(text);
      return new Promise((resolve) => {
        release = () => resolve(`synthetic ${text}`);
      });
    },
    async (results) => saved.push({ ...results })
  );
  const units = [
    { id: "one", text: "one" },
    { id: "two", text: "two" }
  ];
  const run = q.run(units);
  q.cancel();
  release();
  await run;
  assert.deepEqual(calls, ["one"]);
  assert.equal(saved.length, 1);
  const resumedCalls = [];
  const resumed = new TranslationQueue(
    async (text) => {
      resumedCalls.push(text);
      return `synthetic ${text}`;
    },
    undefined,
    saved[0]
  );
  await resumed.run(units);
  await resumed.run(units);
  assert.deepEqual(resumedCalls, ["two"]);
  const failed = new TranslationQueue(async () => "");
  await assert.rejects(
    failed.run(units),
    (e) => e.code === "translation-empty"
  );
  assert.deepEqual(failed.results, {});
});

test("document/config cache identity invalidates on effective settings and chunks are bounded", async () => {
  assert.throws(() => splitText("fixture", 1));
  const bytes = makeEpub();
  assert.equal(
    await documentIdentity(bytes, { b: 2, a: 1 }),
    await documentIdentity(bytes, { a: 1, b: 2 })
  );
  assert.notEqual(
    await documentIdentity(bytes, { model: "one" }),
    await documentIdentity(bytes, { model: "two" })
  );
  assert.equal(
    await documentIdentity(bytes, { model: "one", translationHistory: [] }),
    await documentIdentity(bytes, {
      model: "one",
      translationHistory: [{ source: "synthetic", target: "fixture" }]
    })
  );
  const chunks = splitText("a".repeat(5000));
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  assert.equal(chunks.join("").length, 5000);
});

async function settle(
  predicate = () =>
    !dom.window.document.querySelector(
      "input[type=file]:disabled, button:disabled:not(:last-child)"
    )
) {
  const start = Date.now();
  for (let i = 0; i < 10 || !predicate(); i++) {
    if (Date.now() - start > 3000) throw new Error("DOM mock action timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("DOM mock: opt-in, explicit consent, ePub chapter selection, cached reopening/export and cleanup", async () => {
  const root = dom.window.document.querySelector("main");
  const calls = [],
    statuses = [],
    downloads = [];
  let saved = null;
  let enabled = false;
  const api = {
    t: (en) => en,
    settings: async () => ({
      labFeatures: { documents: enabled },
      nativeLanguageCode: "vi"
    }),
    field: (label, input) => {
      const wrap = dom.window.document.createElement("label");
      wrap.append(label, input);
      return wrap;
    },
    status: (text) => statuses.push(text),
    get: async () => saved,
    set: async (_key, value) => {
      saved = value;
    },
    translate: async (text, options) => {
      assert.equal(options.skipHistory, true);
      assert.equal(options.cloudConsent, true);
      calls.push(text);
      return `Synthetic ${text}`;
    },
    download: async (...args) => downloads.push(args)
  };
  let cleanup = await mount(root, api);
  assert.equal(root.querySelector("input[type=file]").disabled, true);
  assert.equal(calls.length, 0);
  cleanup();
  enabled = true;
  const open = async () => {
    cleanup = await mount(root, api);
    const input = root.querySelector("input[type=file]");
    const bytes = makeEpub();
    Object.defineProperty(input, "files", {
      value: [
        {
          name: "fixture.epub",
          size: bytes.length,
          arrayBuffer: async () => bytes.buffer
        }
      ]
    });
    input.dispatchEvent(new dom.window.Event("change"));
    await settle();
    assert.equal(root.querySelectorAll("select option").length, 2);
  };
  await open();
  const button = (text) =>
    Array.from(root.querySelectorAll("button")).find((node) =>
      node.textContent.includes(text)
    );
  button("Translate current").click();
  await settle();
  assert.equal(calls.length, 0);
  assert.match(statuses.at(-1), /Confirm sending/);
  root.querySelector("input[type=checkbox]").checked = true;
  button("Translate current").click();
  await settle();
  assert.equal(calls.length, 2, JSON.stringify(statuses));
  assert.ok(saved.identity && Object.keys(saved.results).length === 2);
  button("Translate current").click();
  await settle();
  assert.equal(calls.length, 2);
  button("Next").click();
  await settle();
  button("Translate current").click();
  await settle();
  assert.equal(calls.length, 4);
  button("Export bilingual").click();
  await settle();
  assert.equal(downloads.length, 1);
  assert.equal(
    parseEpub(new Uint8Array(await downloads[0][1].arrayBuffer())).chapters
      .length,
    2
  );
  const oldButton = button("Translate current");
  cleanup();
  oldButton.click();
  await settle();
  assert.equal(calls.length, 4, "cleanup removed listeners");
  await open();
  root.querySelector("input[type=checkbox]").checked = true;
  button("Translate current").click();
  await settle();
  assert.equal(
    calls.length,
    4,
    "reopening same document uses persisted checkpoint"
  );
  cleanup();
});

test("export is partial but honest: original survives without generated filler", () => {
  const book = parseEpub(makeEpub());
  const entries = unzipSync(exportEpub(book, {}));
  assert.doesNotMatch(
    strFromU8(entries["OPS/one.xhtml"]),
    /bntrans-translation/
  );
  assert.match(strFromU8(entries["OPS/one.xhtml"]), /Premier paragraphe/);
});

function epubEntries() {
  const xhtml = (title, body) =>
    strToU8(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="fr"><head><title>${title}</title></head><body>${body}</body></html>`
    );
  return {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    ),
    "OPS/package.opf": strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Fixture book</dc:title><dc:language>fr</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="pic" href="pixel.png" media-type="image/png"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`
    ),
    "OPS/one.xhtml": xhtml(
      "One",
      '<h1 id="chapter-one">Bonjour</h1><p>Premier paragraphe.</p><a href="two.xhtml#chapter-two">Next</a><img src="pixel.png" alt="pixel"/>'
    ),
    "OPS/two.xhtml": xhtml(
      "Two",
      '<h1 id="chapter-two">Deuxième</h1><p>Deuxième paragraphe.</p><a href="one.xhtml#chapter-one">Back</a>'
    ),
    "OPS/nav.xhtml": xhtml(
      "Contents",
      '<nav epub:type="toc"><ol><li><a href="one.xhtml#chapter-one">One</a></li><li><a href="two.xhtml#chapter-two">Two</a></li></ol></nav>'
    ),
    "OPS/pixel.png": Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ae8AAAAASUVORK5CYII=",
        "base64"
      )
    )
  };
}

function makeEpub(entries = epubEntries()) {
  return zipSync(entries, { mtime: new Date("2024-01-01T00:00:00Z") });
}

function makePdf(pages = 10, scan = false) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const kids = [];
  for (let i = 1; i <= pages; i++) {
    const page = objects.length + 1;
    const stream = scan
      ? ""
      : `BT /F1 12 Tf 50 750 Td (Page ${i} first paragraph.) Tj 0 -24 Td (Page ${i} second paragraph.) Tj ET`;
    kids.push(`${page} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}
