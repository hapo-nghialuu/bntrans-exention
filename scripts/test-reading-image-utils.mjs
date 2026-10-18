import test from "node:test";
import assert from "node:assert/strict";
import {
  imageContentRect,
  screenshotCrop,
  cropRegion,
  imageDimensions,
  normalizeImageLayout,
  validateImageTranslations,
  createImageTranslationSession,
  IMAGE_LIMITS
} from "../extension/src/experimental/image-translation-utils.js";
import {
  createLocalEngine,
  maskPixels
} from "../extension/src/experimental/ocr-utils.js";

const source = {
  rect: { x: 10, y: 20, width: 200, height: 100 },
  viewport: { width: 800, height: 600, scale: 1, offsetLeft: 0, offsetTop: 0 }
};
const layout = {
  lines: [
    { text: "HELLO", bbox: { x0: 10, y0: 5, x1: 110, y1: 25 } },
    { text: "WORLD", bbox: { x0: 20, y0: 30, x1: 120, y1: 50 } }
  ]
};
const bytes = new Uint8Array([1, 2, 3]);
const region = { x: 0.1, y: 0.2, width: 0.8, height: 0.5 };
const result =
  '[{"id":"line-2","text":"Thế giới"},{"id":"line-1","text":"Xin chào"}]';
function sessionWith(
  translate = async () => result,
  recognize = async () => layout
) {
  const calls = [];
  const engine = {
    recognizeLayout: (...args) => {
      calls.push(["ocr", ...args]);
      return recognize(...args);
    },
    terminate() {
      calls.push(["terminate"]);
    }
  };
  return {
    session: createImageTranslationSession(engine, async (...args) => {
      calls.push(["translate", ...args]);
      return translate(...args);
    }),
    calls
  };
}

test("crop uses actual screenshot DPR once, inward rounding excludes page pixels", () => {
  assert.deepEqual(screenshotCrop(source, 1600, 1200), {
    x: 20,
    y: 40,
    width: 400,
    height: 200,
    region: { x: 0, y: 0, width: 1, height: 1 }
  });
  const crop = screenshotCrop(
    { ...source, rect: { x: 10.2, y: 20.3, width: 200.4, height: 100.4 } },
    1600,
    1200
  );
  assert.deepEqual(
    [crop.x, crop.y, crop.width, crop.height],
    [21, 41, 400, 200]
  );
  assert(crop.region.x > 0 && crop.region.y > 0);
  assert(crop.region.width < 1 && crop.region.height < 1);
  assert.equal(screenshotCrop(source, 800, 600).width, 200);
});

test("crop refuses clipped, empty, pinch zoom, changed viewport and excessive PNG dimensions", () => {
  for (const rect of [
    { ...source.rect, x: -1 },
    { ...source.rect, y: 599 },
    { ...source.rect, width: 0 }
  ])
    assert.throws(() => screenshotCrop({ ...source, rect }, 1600, 1200));
  for (const viewport of [
    { ...source.viewport, scale: 2 },
    { ...source.viewport, offsetLeft: 1 }
  ])
    assert.throws(
      () => screenshotCrop({ ...source, viewport }, 1600, 1200),
      /viewport/
    );
  assert.throws(() => screenshotCrop(source, 1600, 900), /viewport/);
  assert.throws(() => imageDimensions(4097, 1), /image-limit/);
  assert.throws(() => imageDimensions(3000, 3000), /image-limit/);
});

test("object fit/position math preserves actual rendered pixels; cover clipping refused", () => {
  const bounds = { x: 10, y: 20, width: 300, height: 200 };
  assert.deepEqual(
    imageContentRect(bounds, 600, 200, { objectFit: "contain" }),
    { x: 10, y: 70, width: 300, height: 100 }
  );
  assert.deepEqual(
    imageContentRect(bounds, 600, 200, {
      objectFit: "contain",
      objectPosition: "0% 100%"
    }),
    { x: 10, y: 120, width: 300, height: 100 }
  );
  assert.deepEqual(imageContentRect(bounds, 100, 100, { objectFit: "none" }), {
    x: 110,
    y: 70,
    width: 100,
    height: 100
  });
  assert.deepEqual(
    imageContentRect(bounds, 100, 100, { objectFit: "scale-down" }),
    { x: 110, y: 70, width: 100, height: 100 }
  );
  assert.deepEqual(
    imageContentRect(bounds, 600, 200, { objectFit: "fill" }),
    bounds
  );
  assert.throws(
    () => imageContentRect(bounds, 600, 200, { objectFit: "cover" }),
    /image-clipped/
  );
  assert.throws(
    () => imageContentRect(bounds, 600, 200, { objectPosition: "left top" }),
    /unsupported/
  );
});

test("crop/mask retains image-space mapping and removes all masked color/alpha", () => {
  const next = cropRegion(
    region,
    { x: 20, y: 10, width: 100, height: 50 },
    200,
    100
  );
  assert.deepEqual(next, {
    x: 0.1 + 0.1 * 0.8,
    y: 0.25,
    width: 0.4,
    height: 0.25
  });
  const image = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(16).fill(91)
  };
  maskPixels(image, { x: 1, y: 0, width: 1, height: 1 });
  assert.deepEqual([...image.data.slice(4, 8)], [0, 0, 0, 255]);
  assert.equal(image.data[0], 91);
});

test("layout uses actual line bboxes, validates bounds/limits and maps into original crop", () => {
  const lines = normalizeImageLayout(layout, 200, 100, region);
  assert.equal(lines[0].id, "line-1");
  assert.deepEqual(lines[0].preview, {
    x: 0.05,
    y: 0.05,
    width: 0.5,
    height: 0.2
  });
  assert.equal(lines[0].bbox.x, 0.1 + 0.05 * 0.8);
  assert.equal(lines[0].bbox.width, 0.4);
  for (const bad of [
    { lines: [] },
    { lines: [{ text: "bad", bbox: { x0: 0, y0: 0, x1: 201, y1: 10 } }] },
    { lines: Array(81).fill(layout.lines[0]) }
  ])
    assert.throws(() => normalizeImageLayout(bad, 200, 100), /layout/);
  assert.throws(
    () => normalizeImageLayout(layout, 200, 100, { ...region, x: 2 }),
    /layout/
  );
  assert.throws(
    () =>
      normalizeImageLayout(
        {
          lines: [
            { ...layout.lines[0], text: "A".repeat(IMAGE_LIMITS.text + 1) }
          ]
        },
        200,
        100
      ),
    /text-limit/
  );
});

test("mapping reorders only by exact ids and refuses missing/duplicate/extra/malformed translations", () => {
  const lines = normalizeImageLayout(layout, 200, 100);
  assert.deepEqual(
    validateImageTranslations(result, lines).map((line) => line.text),
    ["Xin chào", "Thế giới"]
  );
  for (const bad of [
    "```json\n[]\n```",
    "[]",
    "{}",
    '[{"id":"line-1","text":"x"},{"id":"line-1","text":"y"}]',
    '[{"id":"line-1","text":"x"},{"id":"other","text":"y"}]',
    '[{"id":"line-1","text":"x"},{"id":"line-2","text":""}]',
    "[null,null]"
  ])
    assert.throws(() => validateImageTranslations(bad, lines), /mapping/);
});

test("OCR is explicit; editable text only is sent with independent single-use consent", async () => {
  const { session, calls } = sessionWith();
  assert.equal(calls.length, 0);
  await assert.rejects(session.translate(), /consent/);
  await session.recognize(bytes, 200, 100);
  assert.equal(calls.filter(([name]) => name === "translate").length, 0);
  assert(calls.some(([name]) => name === "terminate"));
  await assert.rejects(session.translate(), /consent/);
  session.confirm(true);
  session.edit("line-1", "Reviewed <script>text</script>");
  await assert.rejects(session.translate(), /consent/);
  session.confirm(true);
  const translated = await session.translate({
    siteUrl: "https://example.test",
    ephemeral: false,
    skipHistory: false
  });
  assert.equal(translated[0].text, "Xin chào");
  const [, sent, options] = calls.find(([name]) => name === "translate");
  assert.deepEqual(JSON.parse(sent), [
    { id: "line-1", text: "Reviewed <script>text</script>" },
    { id: "line-2", text: "WORLD" }
  ]);
  assert.equal(options.ephemeral, true);
  assert.equal(options.skipHistory, true);
  assert.equal(options.labFeature, "image");
  assert.equal(options.sourceLanguage, "en");
  assert.match(options.task, /JSON/);
  assert.doesNotMatch(sent, /base64|bbox|data:image/);
  await assert.rejects(session.translate(), /consent/);
  session.destroy();
});

test("empty edited line and changed preview cannot reuse old consent/layout", async () => {
  const { session } = sessionWith();
  await session.recognize(bytes, 200, 100);
  session.edit("line-1", "");
  session.confirm(true);
  await assert.rejects(session.translate(), /text-limit/);
  session.edit("line-1", "valid");
  session.confirm(true);
  session.invalidate();
  await assert.rejects(session.translate(), /consent/);
  session.destroy();
});

test("cancel drops late local OCR and terminates worker", async () => {
  let finish;
  const { session, calls } = sessionWith(
    undefined,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = session.recognize(bytes, 200, 100);
  session.destroy();
  finish(layout);
  await assert.rejects(pending, /cancelled/);
  assert(calls.some(([name]) => name === "terminate"));
});

test("cancel drops late provider output even if remote request itself cannot be aborted", async () => {
  let finish;
  const { session } = sessionWith(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await session.recognize(bytes, 200, 100);
  session.confirm(true);
  const pending = session.translate();
  session.destroy();
  finish(result);
  await assert.rejects(pending, /cancelled/);
});

test("recognizeLayout requests genuine Tesseract blocks and preserves line/word boxes; recognize stays string", async () => {
  const messages = [];
  class Worker {
    postMessage(message) {
      messages.push(message);
      const data =
        message.action === "recognize"
          ? {
              text: "HELLO",
              blocks: [
                {
                  paragraphs: [
                    {
                      lines: [
                        {
                          ...layout.lines[0],
                          words: [{ text: "HELLO", bbox: layout.lines[0].bbox }]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          : {};
      queueMicrotask(() =>
        this.onmessage({
          data: { jobId: message.jobId, status: "resolve", data }
        })
      );
    }
    terminate() {}
  }
  const engine = createLocalEngine({
    baseUrl: "chrome-extension://test/assets/vendor/ocr/",
    WorkerClass: Worker
  });
  try {
    const value = await engine.recognizeLayout(bytes);
    assert.deepEqual(value.lines[0].bbox, layout.lines[0].bbox);
    assert.equal(value.lines[0].words[0].text, "HELLO");
    assert.equal(messages.at(-1).payload.output.blocks, true);
    assert.equal(await engine.recognize(bytes), "HELLO");
    assert.equal(messages.at(-1).payload.output.blocks, false);
    await assert.rejects(engine.recognizeLayout(bytes, "vie"), /unsupported/);
  } finally {
    engine.terminate();
  }
});
