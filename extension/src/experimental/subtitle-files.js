const TIME = /^(?:(\d{2,}):)?(\d{2}):(\d{2})([.,])(\d{3})$/;

export function timestampSeconds(value) {
  const match = TIME.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return NaN;
  return (
    Number(match[1] || 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[5]) / 1000
  );
}

export function parseSubtitles(input, format) {
  const raw = String(input);
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  format = format || (/^WEBVTT(?:[ \t\n]|$)/.test(text) ? "vtt" : "srt");
  if (!["srt", "vtt"].includes(format))
    throw new Error("Unsupported subtitle format / Định dạng không hỗ trợ");
  const document = {
    format,
    original: raw,
    newline,
    bom: raw.startsWith("\uFEFF"),
    blocks: [],
    cues: [],
    errors: []
  };
  const blocks = text.replace(/\n+$/, "").split(/\n[ \t]*\n/);
  if (format === "vtt" && !/^WEBVTT(?:[ \t\n]|$)/.test(text)) {
    throw new Error("Missing WEBVTT header / Thiếu header WEBVTT");
  }
  for (const [index, block] of blocks.entries()) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    if (
      format === "vtt" &&
      (index === 0 || /^(NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0]))
    ) {
      document.blocks.push({ raw: block });
      continue;
    }
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    const timing = lines[timingIndex] || "";
    const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/.exec(timing);
    const start = match ? timestampSeconds(match[1]) : NaN;
    const end = match ? timestampSeconds(match[2]) : NaN;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      (format === "vtt" &&
        (end === start ||
          !match[1].includes(".") ||
          !match[2].includes("."))) ||
      lines.length <= timingIndex + 1
    ) {
      document.errors.push({
        block: index + 1,
        message: "Invalid cue; preserved unchanged / Cue lỗi, giữ nguyên"
      });
      document.blocks.push({ raw: block, invalid: true });
      continue;
    }
    const cue = {
      id: timingIndex ? lines[0] : "",
      start,
      end,
      timing,
      text: lines.slice(timingIndex + 1).join("\n"),
      translation: "",
      status: "pending",
      error: ""
    };
    document.cues.push(cue);
    document.blocks.push({ cue });
  }
  return document;
}

function exportText(text, format) {
  const value = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\n\s*\n/g, "\n")
    .trim();
  return format === "vtt"
    ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : value;
}

export function serializeSubtitles(document, mode = "bilingual") {
  if (!["original", "bilingual", "translation"].includes(mode))
    throw new Error("Invalid export mode");
  if (mode === "original") return document.original;
  const blocks = document.blocks.map((block) => {
    if (!block.cue) return block.raw;
    const cue = block.cue;
    const translated = cue.translation
      ? exportText(cue.translation, document.format)
      : "";
    const body =
      mode === "original" || !translated
        ? cue.text
        : mode === "translation"
          ? translated
          : `${cue.text}\n${translated}`;
    return [cue.id, cue.timing, body]
      .filter((value) => value !== "")
      .join("\n");
  });
  return (
    (document.bom ? "\uFEFF" : "") +
    (blocks.join("\n\n") + "\n").replace(/\n/g, document.newline)
  );
}

export function createSubtitleQueue(
  document,
  translate,
  onProgress = () => {}
) {
  let generation = 0;
  let running = false;
  return {
    cancel() {
      generation++;
      running = false;
      for (const cue of document.cues)
        if (cue.status === "translating") cue.status = "pending";
    },
    get running() {
      return running;
    },
    async run({ limit = Infinity, options = {} } = {}) {
      if (running) return;
      running = true;
      const token = ++generation;
      let count = 0;
      try {
        for (const cue of document.cues) {
          if (token !== generation || count >= limit) break;
          if (cue.status === "done") continue;
          count++;
          cue.status = "translating";
          cue.error = "";
          onProgress(cue);
          try {
            const translated = await translate(cue.text, {
              ...options,
              skipHistory: true
            });
            if (token !== generation) break;
            if (typeof translated !== "string" || !translated.trim())
              throw new Error("Empty provider response / Provider trả rỗng");
            cue.translation = translated;
            cue.status = "done";
          } catch (error) {
            if (token !== generation) break;
            cue.status = "error";
            cue.error = error.message || String(error);
          }
          onProgress(cue);
        }
      } finally {
        if (token === generation) running = false;
      }
    }
  };
}
