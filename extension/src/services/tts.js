export class TTSService {
  async play(text, lang, speed = 1, options = {}) {
    if (!text) return { ok: false, error: "No text to speak" };
    const result = await chrome.runtime.sendMessage({
      type: "tts-play",
      payload: { ...options, text, lang, speed }
    });
    if (!result?.ok)
      throw new Error(result?.error || "Speech service unavailable");
    return result;
  }

  stop() {
    return chrome.runtime.sendMessage({ type: "tts-stop" });
  }
  pause() {
    return chrome.runtime.sendMessage({ type: "tts-pause" });
  }
  resume() {
    return chrome.runtime.sendMessage({ type: "tts-resume" });
  }
}

export const tts = new TTSService();
