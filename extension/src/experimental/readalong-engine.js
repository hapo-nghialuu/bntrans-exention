import { READING_LIMITS, ReadingError } from "./reading-context.js";

const MAX_SENTENCES = 500;
const MAX_SENTENCE_CHARS = 2000;
let owner;

export function splitReadalongSentences(
  text,
  language = "en",
  Segmenter = Intl.Segmenter
) {
  if (typeof text !== "string" || text.length > READING_LIMITS.chars)
    throw new ReadingError("source-limit");
  let parts;
  if (Segmenter) {
    try {
      parts = [
        ...new Segmenter(language || "en", { granularity: "sentence" }).segment(
          text
        )
      ].map(({ segment, index }) => ({
        start: index,
        end: index + segment.length
      }));
    } catch {}
  }
  if (!parts) {
    parts = [];
    let start = 0;
    for (const match of text.matchAll(/[.!?。！？]+["'”’»）)]*\s*|\n+/gu)) {
      const end = match.index + match[0].length;
      const prefix = text.slice(start, match.index + 1);
      if (
        match[0][0] === "." &&
        (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/iu.test(
          prefix
        ) ||
          /(?:^|\s)\p{Lu}\.$/u.test(prefix) ||
          (/\d\.$/u.test(prefix) && /\d/u.test(text[end] || "")))
      )
        continue;
      parts.push({ start, end });
      start = end;
    }
    if (start < text.length) parts.push({ start, end: text.length });
  }
  const joined = [];
  for (const part of parts) {
    const previous = joined.at(-1);
    const prefix = previous && text.slice(previous.start, previous.end).trim();
    if (
      previous &&
      (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e)\.$/iu.test(prefix) ||
        /(?:^|\s)\p{Lu}\.$/u.test(prefix))
    )
      previous.end = part.end;
    else joined.push({ ...part });
  }
  return joined
    .map(({ start, end }) => {
      const raw = text.slice(start, end);
      const left = raw.length - raw.trimStart().length;
      return {
        start: start + left,
        end: end - (raw.length - raw.trimEnd().length),
        text: raw.trim()
      };
    })
    .filter((part) => part.text)
    .map((part, i) => ({ ...part, id: `s${i + 1}` }));
}

export function prepareReadalongSource(
  source,
  language = source?.lang || "en"
) {
  if (
    !source ||
    !["website", "manual", "pdf"].includes(source.kind) ||
    !Array.isArray(source.blocks) ||
    !source.blocks.length ||
    source.blocks.length > READING_LIMITS.blocks
  )
    throw new ReadingError("source-empty");
  let chars = 0;
  const ids = new Set();
  const sentences = source.blocks.flatMap((block) => {
    if (
      typeof block.id !== "string" ||
      !block.id ||
      ids.has(block.id) ||
      typeof block.text !== "string"
    )
      throw new ReadingError("source-block");
    ids.add(block.id);
    chars += block.text.length;
    if (chars > READING_LIMITS.chars) throw new ReadingError("source-limit");
    return splitReadalongSentences(block.text, language).map((part) => {
      if (part.text.length > MAX_SENTENCE_CHARS)
        throw new ReadingError("readalong-sentence-limit");
      return {
        ...part,
        id: `${block.id}:${part.id}`,
        blockId: block.id,
        translation: ""
      };
    });
  });
  if (!sentences.length || sentences.length > MAX_SENTENCES)
    throw new ReadingError("source-limit");
  return sentences;
}

export function alignReadalongTranslation(sentences, text) {
  if (typeof text !== "string" || text.length > READING_LIMITS.chars)
    throw new ReadingError("source-limit");
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== sentences.length)
    throw new ReadingError("readalong-alignment");
  return sentences.map((sentence, i) => ({
    ...sentence,
    translation: lines[i]
  }));
}

export function createReadalongEngine({
  speech = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  beforeStart = async () => {},
  beforeSentence = async () => {},
  onChange = () => {},
  onError = () => {}
} = {}) {
  let sentences = [],
    index = 0,
    generation = 0,
    disposed = false;
  let state = "idle",
    current,
    voiceURI = "",
    rate = 1,
    waiting = false;
  const voices = () =>
    speech?.getVoices?.().filter((voice) => voice.localService === true) || [];
  const snapshot = () => ({
    state,
    index,
    sentence: sentences[index] || null,
    rate
  });
  const emit = () => onChange(snapshot());
  function stop(next = "stopped") {
    generation++;
    waiting = false;
    current = null;
    if (owner === engine) {
      owner = null;
      speech?.cancel();
    }
    state = next;
    emit();
  }
  function fail(error, token) {
    if (token !== generation || disposed) return;
    stop("error");
    onError(error);
  }
  async function speak(token) {
    try {
      const sentence = sentences[index];
      await beforeSentence(sentence, index);
      if (token !== generation || disposed || owner !== engine) return;
      const voice = voices().find((item) => item.voiceURI === voiceURI);
      if (!voice || !Utterance) throw new ReadingError("readalong-local-voice");
      const utterance = new Utterance(sentence.text);
      current = utterance;
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = rate;
      const live = () =>
        !disposed &&
        token === generation &&
        current === utterance &&
        owner === engine;
      utterance.onstart = () => {
        if (live()) {
          state = "speaking";
          emit();
        }
      };
      utterance.onpause = () => {
        if (live()) {
          state = "paused";
          emit();
        }
      };
      utterance.onresume = () => {
        if (live()) {
          state = "speaking";
          emit();
        }
      };
      utterance.onend = () => {
        if (!live()) return;
        current = null;
        if (index + 1 >= sentences.length) {
          owner = null;
          state = "ended";
          emit();
        } else {
          if (state === "paused") {
            waiting = true;
            emit();
            return;
          }
          index++;
          state = "preparing";
          emit();
          void speak(token);
        }
      };
      utterance.onerror = (event) => {
        if (live())
          fail(
            new ReadingError(`readalong-speech-${event.error || "error"}`),
            token
          );
      };
      speech.speak(utterance);
    } catch (error) {
      fail(error, token);
    }
  }
  const engine = {
    voices,
    snapshot,
    load(value) {
      if (disposed) throw new ReadingError("source-cancelled");
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.length > MAX_SENTENCES ||
        value.some(
          (item) =>
            typeof item.text !== "string" ||
            !item.text.trim() ||
            item.text.length > MAX_SENTENCE_CHARS
        )
      )
        throw new ReadingError("source-limit");
      stop("idle");
      sentences = value;
      index = 0;
      emit();
    },
    async play({ voice, speed = rate } = {}) {
      if (disposed || !sentences.length) throw new ReadingError("source-empty");
      if (
        !speech ||
        !Utterance ||
        !voices().some((item) => item.voiceURI === voice)
      )
        throw new ReadingError("readalong-local-voice");
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
        throw new ReadingError("readalong-rate");
      if (owner && owner !== engine) owner.stop();
      stop("preparing");
      owner = engine;
      voiceURI = voice;
      rate = speed;
      const token = generation;
      state = "preparing";
      emit();
      try {
        await beforeStart();
        if (token !== generation || disposed || owner !== engine) return;
        if (speech.paused) speech.resume();
        await speak(token);
      } catch (error) {
        fail(error, token);
      }
    },
    pause() {
      if (owner === engine && state === "speaking") {
        speech.pause();
        state = "paused";
        emit();
      }
    },
    resume() {
      if (owner === engine && state === "paused") {
        speech.resume();
        if (waiting) {
          waiting = false;
          index++;
          state = "preparing";
          emit();
          void speak(generation);
          return;
        }
        state = "speaking";
        emit();
      }
    },
    seek(next) {
      if (!Number.isInteger(next) || next < 0 || next >= sentences.length)
        return;
      stop("idle");
      index = next;
      emit();
    },
    stop,
    dispose() {
      stop();
      disposed = true;
      sentences = [];
    }
  };
  return engine;
}
