import test from "node:test";
import assert from "node:assert/strict";
import {
  createReadalongEngine,
  prepareReadalongSource,
  splitReadalongSentences,
  alignReadalongTranslation
} from "../extension/src/experimental/readalong-engine.js";

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const local = {
  localService: true,
  name: "Offline",
  voiceURI: "local",
  lang: "en-US"
};
const remote = {
  localService: false,
  name: "Remote",
  voiceURI: "remote",
  lang: "en-US"
};
const source = (text = "First sentence. Second sentence!") => ({
  kind: "manual",
  lang: "en",
  blocks: [{ id: "block", text }]
});
function fixture(t, options = {}) {
  const spoken = [],
    changes = [],
    errors = [],
    prepared = [];
  const speech = {
    cancels: 0,
    pauses: 0,
    resumes: 0,
    paused: false,
    getVoices: () => [remote, local],
    speak: (utterance) => spoken.push(utterance),
    cancel() {
      this.cancels++;
    },
    pause() {
      this.pauses++;
      this.paused = true;
    },
    resume() {
      this.resumes++;
      this.paused = false;
    }
  };
  const engine = createReadalongEngine({
    speech,
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    onChange: (value) => changes.push(value),
    onError: (error) => errors.push(error),
    beforeSentence: async (sentence) => prepared.push(sentence.id),
    ...options
  });
  engine.load(prepareReadalongSource(source()));
  t.after(() => engine.dispose());
  return { engine, spoken, changes, errors, prepared, speech };
}

test("Unicode sentence IDs and UTF-16 offsets survive abbreviations, decimals, emoji and CJK", () => {
  for (const Segmenter of [Intl.Segmenter, null]) {
    const text =
      "Dr. Smith met A. Brown at 3.14. Next 😀 sentence! 你好。再见！";
    const sentences = splitReadalongSentences(text, "en", Segmenter);
    assert.deepEqual(
      sentences.map((item) => item.text),
      [
        "Dr. Smith met A. Brown at 3.14.",
        "Next 😀 sentence!",
        "你好。",
        "再见！"
      ]
    );
    assert.ok(
      sentences.every((item) => text.slice(item.start, item.end) === item.text)
    );
    assert.equal(new Set(sentences.map((item) => item.id)).size, 4);
  }
  assert.equal(
    splitReadalongSentences("Xin chào. Đây là câu hai!", "vi").length,
    2
  );
  assert.equal(
    splitReadalongSentences("First. Next!", "not a language").length,
    2
  );
});

test("preparation bounds sources, stable sentence IDs and local PDF attribution", () => {
  const pdf = {
    ...source(),
    kind: "pdf",
    page: 2,
    documentId: "doc",
    title: "Synthetic"
  };
  const a = prepareReadalongSource(pdf),
    b = prepareReadalongSource(pdf);
  assert.deepEqual(a, b);
  assert.equal(a[0].blockId, "block");
  assert.throws(
    () => prepareReadalongSource(source("x".repeat(2001))),
    /readalong-sentence-limit/
  );
  assert.throws(
    () => prepareReadalongSource(source("a".repeat(30001))),
    /source-limit/
  );
  assert.throws(
    () => prepareReadalongSource(source("Hello. ".repeat(501))),
    /source-limit/
  );
  assert.throws(
    () =>
      prepareReadalongSource({
        ...source(),
        blocks: [
          { id: "same", text: "A" },
          { id: "same", text: "B" }
        ]
      }),
    /source-block/
  );
  assert.throws(
    () => prepareReadalongSource({ ...source(), blocks: [] }),
    /source-empty/
  );
});

test("manual translation alignment requires an exact line count and does not mutate source", () => {
  const sentences = prepareReadalongSource(source());
  const aligned = alignReadalongTranslation(sentences, " Một. \n\n Hai! ");
  assert.deepEqual(
    aligned.map((item) => item.translation),
    ["Một.", "Hai!"]
  );
  assert.equal(sentences[0].translation, "");
  assert.throws(
    () => alignReadalongTranslation(sentences, "One line"),
    /readalong-alignment/
  );
  assert.throws(
    () => alignReadalongTranslation(sentences, "x".repeat(30001)),
    /source-limit/
  );
});

test("only actual start/end callbacks advance speech; no estimated-duration progression", async (t) => {
  const h = fixture(t);
  await h.engine.play({ voice: "local", speed: 1.25 });
  assert.equal(h.engine.snapshot().state, "preparing");
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].voice.localService, true);
  assert.equal(h.spoken[0].rate, 1.25);
  await tick();
  assert.equal(h.spoken.length, 1);
  h.spoken[0].onstart();
  assert.equal(h.engine.snapshot().state, "speaking");
  h.spoken[0].onend();
  await tick();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.engine.snapshot().index, 1);
  h.spoken[1].onstart();
  h.spoken[1].onend();
  await tick();
  assert.equal(h.engine.snapshot().state, "ended");
  assert.equal(h.spoken.length, 2);
  assert.deepEqual(h.prepared, ["block:s1", "block:s2"]);
});

test("remote, missing or unmarked voices are rejected before any speech", async (t) => {
  const h = fixture(t);
  assert.deepEqual(h.engine.voices(), [local]);
  for (const voice of ["remote", "unknown", ""])
    await assert.rejects(h.engine.play({ voice }), /readalong-local-voice/);
  h.speech.getVoices = () => [{ ...local, localService: undefined }];
  await assert.rejects(
    h.engine.play({ voice: "local" }),
    /readalong-local-voice/
  );
  assert.equal(h.spoken.length, 0);
});

test("pause/resume calls speech controls and pause at end never starts another sentence", async (t) => {
  const h = fixture(t);
  await h.engine.play({ voice: "local" });
  h.spoken[0].onstart();
  h.engine.pause();
  assert.equal(h.engine.snapshot().state, "paused");
  assert.equal(h.speech.pauses, 1);
  h.engine.resume();
  assert.equal(h.speech.resumes, 1);
  h.engine.pause();
  h.spoken[0].onend();
  await tick();
  assert.equal(h.spoken.length, 1);
  assert.equal(h.engine.snapshot().index, 0);
  h.engine.resume();
  await tick();
  assert.equal(h.speech.paused, false);
  assert.equal(h.speech.resumes, 2);
  assert.equal(h.spoken.length, 2);
  assert.equal(h.engine.snapshot().index, 1);
});

test("stop and seek invalidate all late start/end/error callbacks", async (t) => {
  const h = fixture(t);
  await h.engine.play({ voice: "local" });
  const old = h.spoken[0];
  h.engine.stop();
  old.onstart();
  old.onend();
  old.onerror({ error: "late" });
  await tick();
  assert.equal(h.engine.snapshot().state, "stopped");
  assert.equal(h.spoken.length, 1);
  assert.equal(h.errors.length, 0);
  h.engine.seek(1);
  await h.engine.play({ voice: "local" });
  assert.equal(h.spoken[1].text, "Second sentence!");
  h.engine.seek(0);
  h.spoken[1].onend();
  assert.equal(h.engine.snapshot().index, 0);
});

test("latest engine wins while an older preparation is still awaiting", async (t) => {
  let release;
  const first = fixture(t, {
    beforeStart: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  const second = fixture(t);
  const pending = first.engine.play({ voice: "local" });
  await second.engine.play({ voice: "local" });
  release();
  await pending;
  assert.equal(first.spoken.length, 0);
  assert.equal(second.spoken.length, 1);
  assert.equal(first.engine.snapshot().state, "stopped");
});

test("repeated Play replaces rather than queues utterances", async (t) => {
  const h = fixture(t);
  await h.engine.play({ voice: "local" });
  const old = h.spoken[0];
  await h.engine.play({ voice: "local" });
  old.onend();
  await tick();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.engine.snapshot().index, 0);
  assert.ok(h.speech.cancels >= 1);
});

test("Play after pausing and cancelling unpauses browser speech without reviving the old utterance", async (t) => {
  const h = fixture(t);
  await h.engine.play({ voice: "local" });
  const old = h.spoken[0];
  old.onstart();
  h.engine.pause();
  h.engine.stop();
  assert.equal(h.speech.paused, true);
  await h.engine.play({ voice: "local" });
  assert.equal(h.speech.paused, false);
  assert.equal(h.speech.resumes, 1);
  old.onstart();
  old.onend();
  await tick();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.engine.snapshot().index, 0);
});

test("stale source validation stops before speaking and reports the real error", async (t) => {
  const h = fixture(t, {
    beforeSentence: async () => {
      throw new Error("source-stale");
    }
  });
  await h.engine.play({ voice: "local" });
  assert.equal(h.spoken.length, 0);
  assert.equal(h.engine.snapshot().state, "error");
  assert.equal(h.errors[0].message, "source-stale");
});

test("utterance errors do not progress; disappearing local voice never cloud-falls-back", async (t) => {
  const h = fixture(t);
  await h.engine.play({ voice: "local" });
  h.spoken[0].onerror({ error: "not-allowed" });
  await tick();
  assert.equal(h.engine.snapshot().state, "error");
  assert.equal(h.errors[0].code, "readalong-speech-not-allowed");
  await h.engine.play({ voice: "local" });
  h.spoken[1].onstart();
  h.speech.getVoices = () => [remote];
  h.spoken[1].onend();
  await tick();
  assert.equal(h.spoken.length, 2);
  assert.equal(h.engine.snapshot().state, "error");
});

test("dispose cancels queued preparation and rejects any later Play", async (t) => {
  let release;
  const h = fixture(t, {
    beforeSentence: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  const pending = h.engine.play({ voice: "local" });
  await tick();
  h.engine.dispose();
  release();
  await pending;
  assert.equal(h.spoken.length, 0);
  await assert.rejects(h.engine.play({ voice: "local" }), /source-empty/);
});
