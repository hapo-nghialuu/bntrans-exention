import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSubtitles,
  serializeSubtitles,
  createSubtitleQueue,
  timestampSeconds
} from "../extension/src/experimental/subtitle-files.js";
import {
  searchCues,
  cueAtTime,
  formatTime
} from "../extension/src/experimental/media.js";

const srt =
  "\uFEFFscene-α\r\n00:00:01,001 --> 00:00:03,400\r\nHello 世界\r\nDòng hai\r\n\r\n99\r\n00:02:04,000 --> 00:02:07,900\r\nNext.\r\n";
const vtt =
  "WEBVTT Example — 日本語\nKind: captions\nLanguage: en\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:fred\nwidth:40%\n\nNOTE Metadata tiếng Việt\nunchanged\n\nchapter 1\n00:01.020 --> 00:04.500 line:20% position:50%\n<v Alice>Hello</v>\n世界\n\n00:05.000 --> 00:06.000\nBye.\n";

for (const [name, input] of [
  ["srt", srt],
  ["vtt", vtt]
]) {
  test(`${name}: round-trip IDs, timestamps, metadata, multiline Unicode`, () => {
    const parsed = parseSubtitles(input);
    assert.equal(parsed.cues.length, 2);
    assert.equal(parsed.errors.length, 0);
    const output = serializeSubtitles(parsed, "original");
    assert.equal(output, input);
    for (const mode of ["bilingual", "translation"]) {
      parsed.cues[0].translation = "Xin chào 日本\nDòng hai";
      const reparsed = parseSubtitles(serializeSubtitles(parsed, mode));
      assert.deepEqual(
        reparsed.cues.map(({ id, timing, start, end }) => ({
          id,
          timing,
          start,
          end
        })),
        parsed.cues.map(({ id, timing, start, end }) => ({
          id,
          timing,
          start,
          end
        }))
      );
      assert.ok(reparsed.cues[0].text.includes("Xin chào 日本\nDòng hai"));
      assert.equal(reparsed.cues[1].text, parsed.cues[1].text);
      if (mode === "bilingual")
        assert.ok(reparsed.cues[0].text.startsWith(parsed.cues[0].text));
    }
  });
}

test("malformed cues are isolated and unchanged, valid later cues survive", () => {
  const doc = parseSubtitles(
    "1\n00:00:01,000 --> 00:00:02,000\nGood\n\nbad\n00:99:00,000 --> garbage\nBroken\n\n3\n00:00:04,000 --> 00:00:05,000\nValid\n"
  );
  assert.equal(doc.cues.length, 2);
  assert.equal(doc.errors.length, 1);
  doc.cues[1].translation = "Hợp lệ";
  assert.match(serializeSubtitles(doc), /Broken/);
  assert.match(serializeSubtitles(doc), /Hợp lệ/);
  assert.equal(parseSubtitles(serializeSubtitles(doc)).cues.length, 2);
  assert.ok(Number.isNaN(timestampSeconds("00:60:00.000")));
  assert.throws(() => parseSubtitles("not a header", "vtt"), /WEBVTT/);
});

test("translation output cannot inject extra VTT cues or markup", () => {
  const doc = parseSubtitles(vtt);
  doc.cues[0].translation = "A <b> & B\n\n00:09.000 --> 00:10.000\nFake";
  const output = serializeSubtitles(doc, "translation");
  assert.match(output, /&lt;b&gt; &amp; B/);
  assert.equal(parseSubtitles(output).cues.length, 2);
});

test("original export preserves missing final newline, extra separators and trailing cue whitespace", () => {
  for (const text of [
    srt.trimEnd() + "  ",
    vtt + "\n\n",
    "1\n00:00:00,000 --> 00:00:01,000\nUnicode 世界  "
  ]) {
    const doc = parseSubtitles(text);
    assert.equal(serializeSubtitles(doc, "original"), text);
    assert.equal(doc.cues.at(-1).text.endsWith("  "), text.endsWith("  "));
  }
});

test("preview, provider partial error and resume do not redo successful cues", async () => {
  const doc = parseSubtitles(srt);
  const requests = [];
  let failing = true;
  const queue = createSubtitleQueue(doc, async (text, options) => {
    requests.push(text);
    assert.equal(options.skipHistory, true);
    assert.equal(options.siteUrl, "https://example.test/video");
    if (text === "Next." && failing) throw new Error("synthetic failure");
    return "Dịch " + text;
  });
  await queue.run({
    limit: 1,
    options: { siteUrl: "https://example.test/video" }
  });
  assert.equal(requests.length, 1);
  await queue.run({ options: { siteUrl: "https://example.test/video" } });
  assert.equal(doc.cues[1].status, "error");
  assert.equal(doc.cues[0].status, "done");
  failing = false;
  await queue.run({ options: { siteUrl: "https://example.test/video" } });
  assert.equal(requests.length, 3);
  assert.equal(doc.cues[1].status, "done");
  assert.equal(queue.running, false);
});

test("cancel discards late responses even when resumed before old promise settles", async () => {
  const doc = parseSubtitles(srt);
  const deferred = [];
  const queue = createSubtitleQueue(
    doc,
    () => new Promise((resolve) => deferred.push(resolve))
  );
  const oldRun = queue.run({ limit: 1 });
  assert.equal(queue.running, true);
  queue.cancel();
  assert.equal(doc.cues[0].status, "pending");
  const newRun = queue.run({ limit: 1 });
  deferred[1]("New translation");
  await newRun;
  deferred[0]("Stale translation");
  await oldRun;
  assert.equal(doc.cues[0].translation, "New translation");
  assert.equal(doc.cues[0].status, "done");
  assert.equal(queue.running, false);
});

test("empty provider output remains retryable, not a fabricated successful translation", async () => {
  const doc = parseSubtitles(srt);
  await createSubtitleQueue(doc, async () => "").run({ limit: 1 });
  assert.equal(doc.cues[0].status, "error");
  assert.equal(doc.cues[0].translation, "");
});

test("transcript search covers both languages and NFC, timed cue lookup is real", () => {
  const cues = [
    { text: "Hello", translation: "Tiếng Việt", start: 1, end: 3 },
    { text: "世界", translation: "world", start: 4, end: 5 }
  ];
  assert.equal(searchCues(cues, "HELLO").length, 1);
  assert.equal(searchCues(cues, "Việt".normalize("NFD")).length, 1);
  assert.equal(searchCues(cues, "世界").length, 1);
  assert.equal(cueAtTime(cues, 2), 0);
  assert.equal(cueAtTime(cues, 3.5), -1);
  assert.equal(formatTime(124.125), "2:04.125");
});
