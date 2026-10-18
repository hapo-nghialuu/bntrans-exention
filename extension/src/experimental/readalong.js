import { createReadingFeatureApi } from "./reading-feature-api.js";
import { createReadingPdf } from "./reading-documents.js";
import { READING_LIMITS, ReadingError } from "./reading-context.js";
import {
  alignReadalongTranslation,
  createReadalongEngine,
  prepareReadalongSource
} from "./readalong-engine.js";

export async function mount(container, api) {
  const doc = container.ownerDocument,
    win = doc.defaultView;
  const t = (en, vi) => api.t(en, vi);
  const feature = createReadingFeatureApi(api, "readalong");
  const pdf = createReadingPdf();
  let alive = true,
    generation = 0,
    source,
    sentences = [],
    expired = false;
  let watch,
    pdfInfo,
    selectedTab,
    translating = false;
  const panel = doc.createElement("div");
  panel.className = "lab-panel";
  const note = doc.createElement("p");
  note.className = "lab-muted";
  note.textContent = t(
    "Preview first. Play reads the original using a browser-reported local voice only; no cloud speech, recording or automatic translation. Translate sends only the chosen sentence through your configured provider and privacy policy. Nothing is saved unless you choose Save to vocabulary.",
    "Xem trước rồi mới Phát. Chỉ đọc bản gốc bằng giọng trình duyệt báo là local; không giọng cloud, ghi âm hay tự dịch. Dịch chỉ gửi câu đang chọn qua provider và chính sách riêng tư đã cấu hình. Chỉ lưu khi bro bấm Lưu vào sổ từ."
  );
  const status = doc.createElement("p");
  status.className = "lab-muted";
  status.setAttribute("role", "status");
  const provenance = doc.createElement("p");
  provenance.className = "lab-muted";
  const preview = doc.createElement("ol");
  preview.className = "lab-list";
  preview.setAttribute(
    "aria-label",
    t("Sentence preview", "Xem trước từng câu")
  );
  const active = doc.createElement("p");
  active.setAttribute("aria-live", "polite");
  const original = doc.createElement("textarea");
  original.maxLength = READING_LIMITS.chars;
  const pasted = doc.createElement("textarea");
  pasted.maxLength = READING_LIMITS.chars;
  const language = doc.createElement("input");
  language.value = "en";
  language.maxLength = 35;
  const targetLanguage = doc.createElement("input");
  targetLanguage.value = "vi";
  targetLanguage.maxLength = 35;
  const voice = doc.createElement("select");
  const speed = doc.createElement("select");
  for (const value of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    const option = doc.createElement("option");
    option.value = String(value);
    option.textContent = `${value}×`;
    option.selected = value === 1;
    speed.append(option);
  }
  const pdfFile = doc.createElement("input");
  pdfFile.type = "file";
  pdfFile.accept = "application/pdf,.pdf";
  const page = doc.createElement("input");
  page.type = "number";
  page.min = "1";
  page.value = "1";
  const pdfLabel = doc.createElement("p");
  pdfLabel.className = "lab-muted";
  const controls = doc.createElement("div");
  controls.className = "lab-toolbar";
  const rows = [];
  const errors = {
    "readalong-local-voice": t(
      "No local voice available. Install an offline system voice, then refresh voices. Remote voices are not used.",
      "Chưa có giọng local. Cài giọng hệ thống offline rồi làm mới giọng. Không sử dụng giọng remote."
    ),
    "readalong-alignment": t(
      "Use exactly one non-empty translation line per preview sentence.",
      "Mỗi câu xem trước cần đúng một dòng bản dịch không rỗng."
    ),
    "readalong-sentence-limit": t(
      "A sentence exceeds 2,000 characters. Shorten the manual text or select a smaller passage.",
      "Một câu dài quá 2.000 ký tự. Rút ngắn văn bản nhập hoặc chọn đoạn nhỏ hơn."
    ),
    "source-stale": t(
      "The source changed or was cleared. Capture it again before playing.",
      "Nguồn đã đổi hoặc bị xóa. Lấy lại nguồn trước khi phát."
    ),
    "readalong-watch": t(
      "Website monitoring is unavailable. Reload the website with this extension enabled.",
      "Không giám sát được website. Tải lại website khi extension đang bật."
    ),
    "readalong-learning": t(
      "Enable Vocabulary before explicitly saving a sentence.",
      "Bật Học từ trước khi chủ động lưu câu."
    )
  };
  function report(error) {
    if (!alive) return;
    status.textContent =
      errors[error.code || error.message] || String(error.message || error);
    api.status(status.textContent, "error");
  }
  function stopWatch() {
    const previous = watch;
    watch = null;
    previous?.close();
  }
  function clearHighlight() {
    if (source?.kind === "website") {
      expired = true;
      void feature.clear();
    }
  }
  function stop() {
    generation++;
    translating = false;
    engine.stop();
    stopWatch();
    clearHighlight();
    void feature.cancel();
    if (source?.kind === "website")
      status.textContent = t(
        "Stopped. Capture the website source again before Play.",
        "Đã dừng. Lấy lại nguồn website trước khi phát."
      );
    updateControls();
  }
  function sourceChanged() {
    stop();
    expired = true;
    report(new ReadingError("source-stale"));
    updateControls();
  }
  async function monitorWebsite(token) {
    stopWatch();
    const tab = await api.activeTab();
    if (tab.id !== selectedTab?.id || tab.url !== source.url)
      throw new ReadingError("source-stale");
    if (!alive || token !== generation)
      throw new ReadingError("source-cancelled");
    await new Promise((resolve, reject) => {
      const port = chrome.tabs.connect(tab.id, {
        name: "bntrans-readalong",
        frameId: 0
      });
      let ready = false,
        closed = false;
      const timer = win.setTimeout(() => {
        close();
        reject(new ReadingError("readalong-watch"));
      }, 2500);
      function close() {
        if (closed) return;
        closed = true;
        win.clearTimeout(timer);
        port.onMessage.removeListener(message);
        port.onDisconnect.removeListener(disconnected);
        port.disconnect();
        if (!ready) reject(new ReadingError("source-cancelled"));
      }
      function disconnected() {
        if (closed) return;
        close();
        if (ready) sourceChanged();
        else reject(new ReadingError("readalong-watch"));
      }
      function message(value) {
        if (!alive || token !== generation) {
          close();
          return;
        }
        if (value.type === "ready" && value.snapshotId === source.snapshotId) {
          ready = true;
          win.clearTimeout(timer);
          resolve();
        } else if (value.type === "invalidated") {
          close();
          sourceChanged();
          reject(new ReadingError("source-stale"));
        }
      }
      watch = { close };
      port.onMessage.addListener(message);
      port.onDisconnect.addListener(disconnected);
      port.postMessage({
        command: "watch",
        url: source.url,
        snapshotId: source.snapshotId
      });
    });
  }
  const engine = createReadalongEngine({
    speech: win.speechSynthesis,
    Utterance: win.SpeechSynthesisUtterance,
    async beforeStart() {
      const token = generation;
      await feature.assertEnabled();
      if (expired) throw new ReadingError("source-stale");
      if (source.kind === "website") await monitorWebsite(token);
      try {
        await api.send("tts-stop");
      } catch {
        if (alive)
          status.textContent = t(
            "Could not stop the older speech tool; stop it manually if it is playing.",
            "Không dừng được công cụ đọc cũ; hãy dừng thủ công nếu đang phát."
          );
      }
      if (!alive || token !== generation)
        throw new ReadingError("source-cancelled");
    },
    async beforeSentence(sentence) {
      const token = generation;
      await feature.assertEnabled();
      if (!alive || token !== generation)
        throw new ReadingError("source-cancelled");
      if (expired) throw new ReadingError("source-stale");
      if (source.kind === "website")
        await feature.highlight(source, sentence.blockId, {
          start: sentence.start,
          end: sentence.end,
          jump: true
        });
    },
    onChange(value) {
      if (!alive) return;
      active.textContent = sentences.length
        ? t(
            `Sentence ${value.index + 1} of ${sentences.length}`,
            `Câu ${value.index + 1} / ${sentences.length}`
          )
        : "";
      const states = {
        idle: t("Ready to preview", "Sẵn sàng xem trước"),
        preparing: t("Preparing speech…", "Đang chuẩn bị đọc…"),
        speaking: t(
          "Reading original · local voice",
          "Đang đọc bản gốc · giọng local"
        ),
        paused: t("Paused", "Tạm dừng"),
        stopped: t("Stopped", "Đã dừng"),
        ended: t("Finished", "Đã đọc xong"),
        error: t("Reading stopped", "Đã dừng đọc")
      };
      status.textContent = states[value.state];
      rows.forEach((row, i) => {
        const current = i === value.index;
        row.item.toggleAttribute("data-active", current);
        if (current && ["speaking", "paused"].includes(value.state))
          row.item.setAttribute("aria-current", "step");
        else row.item.removeAttribute("aria-current");
        row.item.style.borderLeft = current
          ? "3px solid var(--bt-color-blue)"
          : "3px solid transparent";
      });
      if (["stopped", "ended", "error"].includes(value.state)) {
        stopWatch();
        clearHighlight();
      }
      updateControls();
    },
    onError: report
  });
  function refreshVoices() {
    const previous = voice.value;
    voice.replaceChildren();
    const local = engine.voices();
    for (const item of local) {
      const option = doc.createElement("option");
      option.value = item.voiceURI;
      option.textContent = `${item.name} · ${item.lang}`;
      voice.append(option);
    }
    if (local.some((item) => item.voiceURI === previous))
      voice.value = previous;
    if (!local.length) {
      const option = doc.createElement("option");
      option.textContent = t("No local voices", "Chưa có giọng local");
      option.value = "";
      voice.append(option);
    }
    if (!local.length) status.textContent = errors["readalong-local-voice"];
    updateControls();
  }
  function renderPreview() {
    preview.replaceChildren();
    rows.length = 0;
    for (const sentence of sentences) {
      const item = doc.createElement("li");
      item.className = "lab-result";
      const text = doc.createElement("p");
      text.textContent = sentence.text;
      text.lang = language.value;
      const translation = doc.createElement("p");
      translation.className = "lab-muted";
      translation.lang = targetLanguage.value;
      translation.textContent =
        sentence.translation ||
        t(
          "No translation · paste aligned text or explicitly translate this sentence",
          "Chưa có bản dịch · dán từng dòng hoặc chủ động dịch câu này"
        );
      item.append(text, translation);
      preview.append(item);
      rows.push({ item, translation });
    }
    updateControls();
  }
  function updateControls() {
    const value = engine.snapshot();
    const has = Boolean(sentences.length);
    play.disabled = !has || expired || !voice.value || translating;
    pause.disabled = value.state !== "speaking";
    resume.disabled = value.state !== "paused";
    previous.disabled = !has || value.index <= 0 || translating;
    next.disabled = !has || value.index >= sentences.length - 1 || translating;
    translate.disabled = !has || expired || translating;
    save.disabled = !has || translating;
  }
  const action = (en, vi, fn) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = t(en, vi);
    button.addEventListener("click", async () => {
      if (!alive || button.disabled) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        await fn();
      } catch (error) {
        report(error);
      } finally {
        if (alive) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
          updateControls();
        }
      }
    });
    return button;
  };
  async function accept(nextSource, token) {
    if (!alive || token !== generation) return;
    const prepared = prepareReadalongSource(
      nextSource,
      language.value || nextSource.lang
    );
    if (!alive || token !== generation) return;
    source = nextSource;
    sentences = prepared;
    expired = false;
    provenance.textContent =
      nextSource.kind === "website"
        ? `${nextSource.title} · ${nextSource.url}`
        : nextSource.kind === "pdf"
          ? `${nextSource.title} · ${t("Page", "Trang")} ${nextSource.page}`
          : t(
              "Manual text · only this preview",
              "Văn bản nhập · chỉ bản xem trước này"
            );
    if (nextSource.truncated)
      provenance.textContent += t(
        " · limited excerpt",
        " · trích đoạn giới hạn"
      );
    renderPreview();
    engine.load(sentences);
  }
  async function capture(mode) {
    stop();
    const token = generation;
    await pdf.close();
    if (!alive || token !== generation) return;
    pdfInfo = null;
    pdfLabel.textContent = "";
    const tab = await api.activeTab();
    if (!alive || token !== generation) return;
    const captured = await feature.capture(mode);
    if (!alive || token !== generation) return;
    selectedTab = tab;
    await accept(captured, token);
  }
  const play = action("Play original", "Phát bản gốc", async () => {
    await engine.play({ voice: voice.value, speed: Number(speed.value) });
  });
  const pause = action("Pause", "Tạm dừng", () => engine.pause());
  const resume = action("Resume", "Tiếp tục", async () => {
    const token = generation;
    await feature.assertEnabled();
    if (!alive || token !== generation) return;
    if (expired) throw new ReadingError("source-stale");
    if (source.kind === "website") {
      const sentence = sentences[engine.snapshot().index];
      await feature.highlight(source, sentence.blockId, {
        start: sentence.start,
        end: sentence.end
      });
    }
    if (!alive || token !== generation) return;
    engine.resume();
  });
  async function seek(delta) {
    stopWatch();
    engine.seek(engine.snapshot().index + delta);
    const sentence = sentences[engine.snapshot().index];
    if (source.kind === "website" && !expired) {
      try {
        await feature.highlight(source, sentence.blockId, {
          start: sentence.start,
          end: sentence.end,
          jump: true
        });
      } catch (error) {
        sourceChanged();
        throw error;
      }
    }
  }
  const previous = action("Previous", "Câu trước", () => seek(-1));
  const next = action("Next", "Câu sau", () => seek(1));
  const translate = action(
    "Translate this sentence",
    "Dịch câu này",
    async () => {
      const initial = generation;
      await feature.assertEnabled();
      if (!alive || initial !== generation) return;
      if (expired) throw new ReadingError("source-stale");
      engine.seek(engine.snapshot().index);
      stopWatch();
      const index = engine.snapshot().index,
        sentence = sentences[index],
        token = ++generation;
      translating = true;
      updateControls();
      try {
        const options = {
          sourceLanguage: language.value || "auto",
          targetLanguage: targetLanguage.value || "vi"
        };
        if (source.kind !== "website") options.siteUrl = "";
        else
          await feature.jump(source, sentence.blockId, {
            start: sentence.start,
            end: sentence.end
          });
        const translated = await feature.translate(sentence.text, options);
        if (
          !alive ||
          token !== generation ||
          sentences[index]?.id !== sentence.id
        )
          return;
        if (source.kind === "website")
          await feature.jump(source, sentence.blockId, {
            start: sentence.start,
            end: sentence.end
          });
        if (!alive || token !== generation) return;
        if (translated.length > READING_LIMITS.chars)
          throw new ReadingError("source-limit");
        sentence.translation = translated;
        rows[index].translation.textContent = translated;
      } finally {
        if (alive && token === generation) {
          translating = false;
          updateControls();
        }
      }
    }
  );
  const save = action(
    "Save sentence to vocabulary",
    "Lưu câu vào sổ từ",
    async () => {
      const token = generation;
      const sentence = sentences[engine.snapshot().index];
      const url = source?.kind === "website" ? source.url : "";
      const settings = await feature.assertEnabled();
      if (!alive || token !== generation) return;
      if (settings.labFeatures?.learning !== true)
        throw new ReadingError("readalong-learning");
      if (!sentence) throw new ReadingError("source-empty");
      if (sentence.text.length > 500 || sentence.translation.length > 4000)
        throw new Error(
          t(
            "Vocabulary supports sentences up to 500 characters and translations up to 4,000. Nothing was saved.",
            "Sổ từ hỗ trợ câu tối đa 500 ký tự và bản dịch tối đa 4.000. Chưa lưu gì."
          )
        );
      await api.saveVocabulary({
        text: sentence.text,
        translation: sentence.translation,
        sourceLanguage: language.value || "en",
        targetLanguage: targetLanguage.value || "vi",
        url,
        tags: ["readalong"]
      });
      if (alive)
        status.textContent = t("Saved to vocabulary", "Đã lưu vào sổ từ");
    }
  );
  controls.append(
    previous,
    play,
    pause,
    resume,
    action("Stop", "Dừng", stop),
    next
  );
  const sources = doc.createElement("div");
  sources.className = "lab-toolbar";
  sources.append(
    action("Preview website selection", "Xem vùng đã chọn", () =>
      capture("selection")
    ),
    action("Preview article paragraphs", "Xem đoạn trong bài", () =>
      capture("article")
    )
  );
  const manual = action("Preview manual text", "Xem văn bản nhập", async () => {
    stop();
    const token = generation;
    await feature.assertEnabled();
    if (!alive || token !== generation) return;
    await pdf.close();
    if (!alive || token !== generation) return;
    pdfInfo = null;
    pdfLabel.textContent = "";
    await accept(
      {
        kind: "manual",
        lang: language.value,
        title: "",
        url: "",
        blocks: [{ id: "manual", text: original.value }]
      },
      token
    );
  });
  const align = action(
    "Apply pasted translation",
    "Ghép bản dịch đã dán",
    () => {
      if (!sentences.length) throw new ReadingError("source-empty");
      generation++;
      translating = false;
      stopWatch();
      engine.seek(engine.snapshot().index);
      sentences = alignReadalongTranslation(sentences, pasted.value);
      renderPreview();
    }
  );
  const pdfOpen = action("Open local PDF", "Mở PDF local", async () => {
    stop();
    const token = generation;
    await feature.assertEnabled();
    if (!alive || token !== generation) return;
    const info = await pdf.open(pdfFile.files?.[0]);
    if (!alive || token !== generation) return;
    pdfInfo = info;
    page.value = "1";
    page.max = String(info.pages);
    pdfLabel.textContent = `${info.title} · ${info.pages} ${t("pages; choose a page, then preview", "trang; chọn trang rồi xem trước")}`;
  });
  const pdfPreview = action(
    "Preview chosen PDF page",
    "Xem trang PDF đã chọn",
    async () => {
      if (!pdfInfo) throw new ReadingError("pdf-closed");
      stop();
      const token = generation;
      await feature.assertEnabled();
      if (!alive || token !== generation) return;
      const captured = await pdf.capturePage(Number(page.value));
      await accept(captured, token);
    }
  );
  panel.append(
    note,
    sources,
    api.field(t("Original language code", "Mã ngôn ngữ gốc"), language),
    api.field(
      t(
        "Manual text (preview before Play)",
        "Văn bản nhập (xem trước rồi phát)"
      ),
      original
    ),
    manual,
    api.field(
      t("Local PDF · text layer only", "PDF local · chỉ lớp văn bản"),
      pdfFile
    ),
    pdfOpen,
    pdfLabel,
    api.field(t("PDF page", "Trang PDF"), page),
    pdfPreview,
    provenance,
    api.field(
      t("Local voice (original language)", "Giọng local (ngôn ngữ gốc)"),
      voice
    ),
    action("Refresh local voices", "Làm mới giọng local", refreshVoices),
    api.field(t("Speed (next Play)", "Tốc độ (lần phát tiếp)"), speed),
    controls,
    status,
    active,
    api.field(
      t("Translation language code", "Mã ngôn ngữ dịch"),
      targetLanguage
    ),
    translate,
    api.field(
      t(
        "Pasted translation · one non-empty line per preview sentence",
        "Dán bản dịch · một dòng không rỗng cho mỗi câu xem trước"
      ),
      pasted
    ),
    align,
    save,
    preview,
    action("Clear preview", "Xóa bản xem trước", async () => {
      stop();
      source = null;
      sentences = [];
      rows.length = 0;
      preview.replaceChildren();
      original.value =
        pasted.value =
        provenance.textContent =
        active.textContent =
        pdfLabel.textContent =
          "";
      pdfFile.value = "";
      pdfInfo = null;
      await pdf.close();
      updateControls();
    })
  );
  container.append(panel);
  refreshVoices();
  const onStorage = (changes, area) => {
    if (area === "local" && changes.translatorSettings) {
      stop();
      void pdf.close();
    }
  };
  const onTarget = () => {
    if (source?.kind === "website") sourceChanged();
  };
  const onTab = (id, changes) => {
    if (
      source?.kind === "website" &&
      id === selectedTab?.id &&
      (changes.url || changes.status === "loading")
    )
      sourceChanged();
  };
  const onRemoved = (id) => {
    if (source?.kind === "website" && id === selectedTab?.id) sourceChanged();
  };
  const target = doc.getElementById("lab-target");
  chrome.storage.onChanged.addListener(onStorage);
  chrome.tabs.onUpdated?.addListener(onTab);
  chrome.tabs.onRemoved?.addListener(onRemoved);
  target?.addEventListener("change", onTarget);
  win.speechSynthesis?.addEventListener("voiceschanged", refreshVoices);
  function cleanup() {
    if (!alive) return;
    stop();
    alive = false;
    engine.dispose();
    void feature.dispose();
    void pdf.destroy();
    source = null;
    sentences = [];
    original.value = pasted.value = "";
    preview.replaceChildren();
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.tabs.onUpdated?.removeListener(onTab);
    chrome.tabs.onRemoved?.removeListener(onRemoved);
    target?.removeEventListener("change", onTarget);
    win.speechSynthesis?.removeEventListener("voiceschanged", refreshVoices);
    win.removeEventListener("pagehide", cleanup);
    win.removeEventListener("hashchange", cleanup);
    panel.remove();
  }
  win.addEventListener("pagehide", cleanup, { once: true });
  win.addEventListener("hashchange", cleanup, { once: true });
  return cleanup;
}
