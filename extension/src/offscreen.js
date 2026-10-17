import { assertDestination } from "./common/privacy-policy.js";
import { normalizeLanguageToCode } from "./common/language-map.js";

let detector;

async function getAvailabilityForPair(sourceLanguage, targetLanguage) {
  if (!("Translator" in self)) return "unsupported";

  try {
    const status = await Translator.availability({
      sourceLanguage,
      targetLanguage
    });
    return status;
  } catch {
    return "unsupported";
  }
}

async function ensureDetector() {
  if (!("LanguageDetector" in self)) return null;

  if (detector) return detector;

  try {
    const availability = await LanguageDetector.availability();

    if (availability === "downloadable" || availability === "after-download") {
      detector = await LanguageDetector.create({
        monitor(m) {
          m.addEventListener("downloadprogress", () => {});
        }
      });

      return detector;
    }

    if (availability === "available") {
      detector = await LanguageDetector.create();
      return detector;
    }
  } catch {}

  return null;
}

async function detectLanguage(text) {
  const d = await ensureDetector();

  if (!d) return null;

  try {
    const results = await d.detect(text);

    if (Array.isArray(results) && results.length > 0) {
      return results[0];
    }
  } catch {}

  return null;
}

async function runTranslation(text, requestedSource, requestedTarget) {
  const target = normalizeLanguageToCode(requestedTarget);

  if (!target) return { ok: false, error: "Invalid target language" };

  let source = normalizeLanguageToCode(requestedSource);
  if (!source) source = null;

  if (!("Translator" in self))
    return { ok: false, error: "Translator API not supported" };

  let finalSource = source;

  if (!finalSource || finalSource === "auto") {
    const detected = await detectLanguage(text);
    finalSource = detected?.detectedLanguage || source;
  }

  if (!finalSource || finalSource === "auto") {
    return {
      ok: false,
      error: "Could not detect source language. Please select it manually."
    };
  }

  const pairSource = finalSource;
  const availability = await getAvailabilityForPair(pairSource, target);

  if (availability === "unsupported")
    return {
      ok: false,
      error: `Language pair ${pairSource} -> ${target} is not supported by Chrome Built-in AI.`
    };

  try {
    const translator = await Translator.create({
      sourceLanguage: pairSource,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener("downloadprogress", () => {});
      }
    });

    const translated = await translator.translate(text);

    return {
      ok: true,
      translation: translated,
      sourceLanguage: finalSource || "auto",
      targetLanguage: target
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || "Translation failed")
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    [
      "play-tts",
      "offscreen-tts-stop",
      "offscreen-tts-pause",
      "offscreen-tts-resume"
    ].includes(message?.type)
  ) {
    if (sender.tab || sender.url !== chrome.runtime.getURL("src/background.js"))
      return false;
  }
  if (message?.type === "offscreen-tts-stop") {
    sendResponse(stopTTS());
    return true;
  }
  if (
    message?.type === "offscreen-tts-pause" ||
    message?.type === "offscreen-tts-resume"
  ) {
    const pause = message.type === "offscreen-tts-pause";
    if (activeSpeech?.audio) {
      if (pause) activeSpeech.audio.pause();
      else {
        const session = activeSpeech;
        session.audio
          .play()
          .catch(() =>
            session.finish({ ok: false, error: "Speech resume failed" })
          );
      }
    } else if (activeSpeech) {
      if (pause) self.speechSynthesis.pause();
      else self.speechSynthesis.resume();
    }
    sendResponse({ ok: true, paused: pause });
    return true;
  }
  if (message?.type === "offscreen-translate") {
    const {
      text,
      nativeLanguageCode,
      targetLanguage,
      useAutoDetect,
      sourceLanguage
    } = message.payload || {};

    // If sourceLanguage is 'auto', we want detection.
    // If it's a specific code, use it.
    // If useAutoDetect=true, use null for auto-detection.
    // If useAutoDetect=false, use nativeLanguageCode for fixed direction.
    const requestedSource =
      sourceLanguage && sourceLanguage !== "auto"
        ? sourceLanguage
        : useAutoDetect
          ? null
          : nativeLanguageCode;

    runTranslation(text, requestedSource, targetLanguage)
      .then((r) => sendResponse(r))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );

    return true;
  }

  if (message?.type === "detect-language") {
    detectLanguage(message.payload?.text || "")
      .then((result) => {
        sendResponse({
          ok: true,
          detectedLanguage: result?.detectedLanguage || null,
          confidence: result?.confidence || 0
        });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "play-tts") {
    playTTS(message.payload || {})
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );
    return true;
  }

  return false;
});

let activeSpeech = null;
let speechGeneration = 0;

export function stopTTS() {
  speechGeneration++;
  const previous = activeSpeech;
  activeSpeech = null;
  if (previous) {
    previous.controller?.abort();
    if (previous.audio) {
      previous.audio.pause();
      previous.audio.removeAttribute("src");
      previous.audio.load();
    }
    if (previous.local) self.speechSynthesis?.cancel();
    previous.finish({ ok: true, stopped: true });
  }
  return { ok: true, stopped: true };
}

export async function playTTS({
  text,
  lang,
  speed = 1,
  urlTemplate,
  localOnly,
  privacyPolicy
}) {
  stopTTS();
  const generation = speechGeneration;
  if (!text) throw new Error("No text to speak");
  const rate = Math.min(4, Math.max(0.24, Number(speed) || 1));
  return new Promise((resolve) => {
    let objectUrl;
    const session = {
      local: localOnly,
      controller: new AbortController(),
      finish(result) {
        if (activeSpeech === session) activeSpeech = null;
        if (session.audio) {
          session.audio.onended = null;
          session.audio.onerror = null;
        }
        if (session.utterance) {
          session.utterance.onend = null;
          session.utterance.onerror = null;
        }
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
        resolve(result);
      }
    };
    activeSpeech = session;
    (async () => {
      if (localOnly) {
        const synth = self.speechSynthesis;
        const voices = synth?.getVoices() || [];
        const voice =
          voices.find(
            (v) =>
              v.localService === true &&
              v.lang.toLowerCase() === String(lang).toLowerCase()
          ) ||
          voices.find(
            (v) =>
              v.localService === true &&
              v.lang.split("-")[0].toLowerCase() ===
                String(lang).split("-")[0].toLowerCase()
          );
        if (!voice || !("SpeechSynthesisUtterance" in self))
          throw new Error(
            "No local speech voice for this language. Install a local OS voice; cloud speech was not used."
          );
        const utterance = new self.SpeechSynthesisUtterance(text);
        session.utterance = utterance;
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.rate = rate;
        utterance.onend = () => session.finish({ ok: true, local: true });
        utterance.onerror = () =>
          session.finish({ ok: false, error: "Local speech failed" });
        synth.speak(utterance);
      } else {
        if (!privacyPolicy || !urlTemplate)
          throw new Error("Speech requires a checked destination");
        const url = urlTemplate
          .replaceAll("{text}", encodeURIComponent(text))
          .replaceAll("{lang}", encodeURIComponent(lang))
          .replaceAll("{speed}", String(rate));
        assertDestination(privacyPolicy, url);
        const response = await fetch(url, {
          redirect: "error",
          credentials: "omit",
          signal: session.controller.signal
        });
        if (!response.ok) throw new Error("Speech audio request failed");
        const blob = await response.blob();
        if (generation !== speechGeneration) return;
        objectUrl = URL.createObjectURL(blob);
        session.audio = new Audio(objectUrl);
        session.audio.onended = () => session.finish({ ok: true });
        session.audio.onerror = () =>
          session.finish({ ok: false, error: "Audio playback failed" });
        await session.audio.play();
      }
    })().catch((error) =>
      session.finish({ ok: false, error: String(error?.message || error) })
    );
  });
}
