import {
  parseSubtitles,
  serializeSubtitles,
  createSubtitleQueue
} from "./subtitle-files.js";

export function searchCues(cues, query) {
  const needle = String(query).normalize("NFC").toLocaleLowerCase();
  return cues.filter((cue) =>
    `${cue.text}\n${cue.translation || ""}\n${cue.speaker || ""}`
      .normalize("NFC")
      .toLocaleLowerCase()
      .includes(needle)
  );
}

export function cueAtTime(cues, time) {
  return cues.findIndex((cue) => cue.start <= time && cue.end >= time);
}

export function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.floor(value * 1000) % 1000).padStart(3, "0")}`;
}

export async function mount(container, api) {
  const t = api.t;
  let disposed = false;
  let parsed = null;
  let queue = null;
  let cues = [];
  let live = false;
  let followingFile = false;
  let sessionTab = null;
  let videoId = "";
  let timer = null;
  let sourceName = "subtitles";
  let currentTime = 0;
  let page = 0;
  let revision = 0;
  let signature = "";
  let polling = false;
  const pageSize = 60;
  const listeners = [];
  const element = (tag, text = "", className = "") => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const listen = (node, type, callback) => {
    node.addEventListener(type, callback);
    listeners.push(() => node.removeEventListener(type, callback));
  };
  const panel = element("section", "", "lab-panel");
  const heading = element(
    "h2",
    t(
      "Media · imported files & visible captions",
      "Media · tệp nhập và caption đang hiển thị"
    )
  );
  const intro = element(
    "p",
    t(
      "Import SRT/VTT or explicitly start the selected video tab. Live captions only include text observed since Start with approximate observation times, never a full historical transcript. Meet keeps only the latest sentence in memory, and requires consent for every session. Original file cues are preserved exactly; translations are plain text.",
      "Nhập SRT/VTT hoặc chủ động bắt đầu trên tab video đã chọn. Caption live chỉ gồm nội dung thấy từ lúc Bắt đầu với thời gian quan sát gần đúng, không phải transcript quá khứ đầy đủ. Meet chỉ giữ câu mới nhất trong bộ nhớ, cần đồng ý mỗi phiên. Cue gốc trong tệp được giữ nguyên; bản dịch là văn bản thuần."
    )
  );
  const status = element(
    "p",
    t(
      "Inactive. Media Labs must be enabled.",
      "Chưa chạy. Cần bật Media Labs."
    ),
    "lab-result"
  );
  status.setAttribute("role", "status");
  const setStatus = (message) => {
    if (!disposed) status.textContent = message;
  };
  const enabled = async () => {
    if ((await api.settings()).labFeatures?.media !== true)
      throw new Error(
        t("Enable Media Labs first.", "Cần bật Media Labs trước.")
      );
    if (disposed) throw new Error(t("Panel closed.", "Panel đã đóng."));
  };
  const activeTab = async () => {
    const tab = await api.activeTab();
    if (!tab?.id || !tab.url)
      throw new Error(
        t("Select a permitted tab first.", "Hãy chọn tab được cấp quyền trước.")
      );
    return tab;
  };
  async function send(command, payload = {}) {
    await enabled();
    const tab = await activeTab();
    if (sessionTab && tab.id !== sessionTab.id)
      throw new Error(
        t("Selected tab changed. Start again.", "Tab đã đổi. Hãy Bắt đầu lại.")
      );
    const result = await api.sendToTab("labs-media-command", {
      command,
      ...payload
    });
    if (!result?.ok)
      throw new Error(
        result?.error ||
          t("Media bridge unavailable.", "Bridge media không khả dụng.")
      );
    return result;
  }
  function stopPolling() {
    revision++;
    clearInterval(timer);
    timer = null;
    live = false;
    followingFile = false;
    signature = "";
  }
  async function stopLive() {
    const previousTab = sessionTab;
    stopPolling();
    sessionTab = null;
    try {
      if (previousTab && (await api.activeTab())?.id === previousTab.id)
        await api.sendToTab("labs-media-command", { command: "stop" });
    } finally {
      if (!disposed) {
        cues = parsed?.cues || [];
        videoId = "";
        render();
      }
    }
  }

  const file = element("input");
  file.type = "file";
  file.accept = ".srt,.vtt,text/vtt,application/x-subrip";
  listen(file, "change", async () => {
    try {
      await enabled();
      const selected = file.files[0];
      if (!selected) return;
      if (selected.size > 5 * 1024 * 1024)
        throw new Error(t("Maximum file size: 5 MiB.", "Tệp tối đa 5 MiB."));
      queue?.cancel();
      await stopLive();
      const token = revision;
      const content = await selected.text();
      if (disposed || token !== revision) return;
      parsed = parseSubtitles(
        content,
        /\.vtt$/i.test(selected.name) ? "vtt" : undefined
      );
      sourceName = selected.name.replace(/\.(srt|vtt)$/i, "");
      cues = parsed.cues;
      page = 0;
      queue = createSubtitleQueue(
        parsed,
        async (text, options) => {
          await enabled();
          const tab = await activeTab();
          return api.translate(text, {
            ...options,
            siteUrl: tab.url,
            skipHistory: true
          });
        },
        () => {
          render();
          const done = cues.filter((cue) => cue.status === "done").length;
          const errors = cues.filter((cue) => cue.status === "error").length;
          setStatus(
            t(
              `${done}/${cues.length} translated; ${errors} failed. Retry resumes unfinished cues.`,
              `${done}/${cues.length} đã dịch; ${errors} lỗi. Chạy lại sẽ tiếp tục cue chưa xong.`
            )
          );
        }
      );
      setStatus(
        t(
          `${cues.length} valid cues; ${parsed.errors.length} malformed blocks preserved unchanged. Missing translations export the original text.`,
          `${cues.length} cue hợp lệ; ${parsed.errors.length} block lỗi giữ nguyên. Cue chưa dịch sẽ xuất nguyên bản.`
        )
      );
      render();
    } catch (error) {
      setStatus(error.message);
    }
  });

  const fileTools = element("div", "", "lab-toolbar");
  async function translate(limit) {
    await enabled();
    if (!queue || live)
      throw new Error(
        t("Import a subtitle file first.", "Hãy nhập tệp phụ đề trước.")
      );
    await queue.run({ limit });
  }
  const preview = api.button(
    t("Translate next 3 · preview", "Dịch 3 cue tiếp · xem thử"),
    () => translate(3)
  );
  const all = api.button(
    t("Translate / retry unfinished", "Dịch / thử lại cue chưa xong"),
    () => translate(Infinity)
  );
  const cancel = api.button(t("Cancel queue", "Hủy hàng đợi"), () => {
    queue?.cancel();
    setStatus(
      t(
        "Cancelled. In-flight network calls cannot be recalled; their results are discarded. Resume to retry unfinished cues.",
        "Đã hủy. Không thể thu hồi request đã gửi; kết quả sẽ bị bỏ. Chạy tiếp để thử lại cue chưa xong."
      )
    );
    render();
  });
  const exportMode = element("select");
  for (const [value, en, vi] of [
    ["bilingual", "Bilingual", "Song ngữ"],
    ["translation", "Translation only", "Chỉ bản dịch"],
    ["original", "Original", "Nguyên bản"]
  ]) {
    const option = element("option", t(en, vi));
    option.value = value;
    exportMode.append(option);
  }
  const download = api.button(t("Export file", "Xuất tệp"), async () => {
    await enabled();
    if (!parsed)
      throw new Error(t("Import a file first.", "Hãy nhập tệp trước."));
    api.download(
      `${sourceName}.${exportMode.value}.${parsed.format}`,
      serializeSubtitles(parsed, exportMode.value),
      parsed.format === "vtt"
        ? "text/vtt;charset=utf-8"
        : "application/x-subrip;charset=utf-8"
    );
  });
  fileTools.append(
    preview,
    all,
    cancel,
    api.field(t("Export mode", "Kiểu xuất"), exportMode),
    download
  );

  const consent = element("input");
  consent.type = "checkbox";
  const consentLabel = api.field(
    t(
      "Meet: I consent to sending visible captions to my configured provider for this session. No audio capture or persistent meeting transcript.",
      "Meet: Tôi đồng ý gửi caption đang hiện tới provider đã cấu hình cho phiên này. Không thu âm hay lưu transcript họp lâu dài."
    ),
    consent
  );
  const liveTools = element("div", "", "lab-toolbar");
  const start = api.button(
    t("Start selected tab", "Bắt đầu tab đã chọn"),
    async () => {
      await enabled();
      queue?.cancel();
      await stopLive();
      const tab = await activeTab();
      const token = revision;
      const result = await send("start", {
        options: { meetingConsent: consent.checked }
      });
      if (disposed || token !== revision) {
        if ((await api.activeTab())?.id === tab.id)
          await api.sendToTab("labs-media-command", { command: "stop" });
        return;
      }
      sessionTab = tab;
      live = true;
      cues = [];
      videoId = result.videoId || "";
      page = 0;
      consent.checked = false;
      applySnapshot(result);
      if (live) timer = setInterval(() => void poll(), 1000);
    }
  );
  const stop = api.button(
    t("Stop & clear live captions", "Dừng và xóa caption live"),
    async () => {
      await stopLive();
      consent.checked = false;
      setStatus(
        t("Stopped. Live captions cleared.", "Đã dừng, xóa caption live.")
      );
    }
  );
  liveTools.append(start, stop);

  const search = element("input");
  search.type = "search";
  search.placeholder = t("Search both languages", "Tìm cả hai ngôn ngữ");
  listen(search, "input", () => {
    page = 0;
    render();
  });
  const summary = element("p");
  const list = element("div", "", "lab-list");
  const paging = element("div", "", "lab-toolbar");
  paging.append(
    api.button(t("Previous 60", "60 câu trước"), () => {
      page = Math.max(0, page - 1);
      render();
    }),
    api.button(t("Next 60", "60 câu tiếp"), () => {
      page++;
      render();
    })
  );

  function render() {
    if (disposed) return;
    const filtered = searchCues(cues, search.value);
    page = Math.min(
      page,
      Math.max(0, Math.ceil(filtered.length / pageSize) - 1)
    );
    summary.textContent = t(
      `${filtered.length}/${cues.length} cues · page ${page + 1}`,
      `${filtered.length}/${cues.length} cue · trang ${page + 1}`
    );
    list.replaceChildren();
    for (const cue of filtered.slice(page * pageSize, (page + 1) * pageSize)) {
      const card = element("article", "", "lab-card");
      card.dataset.start = String(cue.start);
      if (cue.start <= currentTime && cue.end >= currentTime)
        card.setAttribute("aria-current", "true");
      const time = api.button(
        `${formatTime(cue.start)} – ${formatTime(cue.end)}`,
        () => seek(cue)
      );
      const source = element(
        "p",
        `${cue.speaker ? cue.speaker + ": " : ""}${cue.text}`
      );
      source.style.whiteSpace = "pre-wrap";
      const translated = element(
        "p",
        cue.translation || t("Not translated", "Chưa dịch")
      );
      translated.style.whiteSpace = "pre-wrap";
      const tools = element("div", "", "lab-toolbar");
      const replay = api.button(t("Replay sentence", "Phát lại câu"), () =>
        seek(cue, true)
      );
      const save = api.button(
        t("Save sentence", "Lưu câu vào sổ từ"),
        async () => {
          await enabled();
          const config = await api.settings();
          if (config.labFeatures?.learning !== true)
            throw new Error(
              t(
                "Enable Vocabulary Labs first.",
                "Cần bật Vocabulary Labs trước khi lưu câu."
              )
            );
          if (cue.text.length > 500 || (cue.translation || "").length > 4000)
            throw new Error(
              t(
                "Choose a shorter cue: sentence maximum 500 characters, translation maximum 4000.",
                "Chọn cue ngắn hơn: câu tối đa 500 ký tự, bản dịch tối đa 4000."
              )
            );
          if (typeof api.saveVocabulary !== "function")
            throw new Error(
              t(
                "Vocabulary integration unavailable.",
                "Chưa có tích hợp sổ từ."
              )
            );
          const tab = await api.activeTab();
          await api.saveVocabulary({
            text: cue.text,
            translation: cue.translation || "",
            context: cue.text,
            url: tab?.url || "",
            sourceLanguage: config.targetLanguageCode || "en",
            targetLanguage: config.nativeLanguageCode || "vi"
          });
          setStatus(t("Sentence saved.", "Đã lưu câu."));
        }
      );
      tools.append(replay, save);
      card.append(time, source, translated, tools);
      if (cue.error) card.append(element("p", cue.error));
      list.append(card);
    }
  }

  async function seek(cue, replay = false) {
    const result = await send(replay ? "replay" : "seek", {
      time: cue.start,
      videoId: live || followingFile ? videoId : undefined,
      options: { end: cue.end }
    });
    currentTime = cue.start;
    if (live) {
      cues = [];
      page = 0;
    } else if (parsed) {
      followingFile = true;
      sessionTab = await activeTab();
      videoId = result.videoId || "";
      if (!timer) timer = setInterval(() => void poll(), 1000);
    }
    render();
  }

  function applySnapshot(result) {
    if (result.videoId !== videoId) {
      cues = [];
      videoId = result.videoId || "";
      page = 0;
    }
    cues = result.cues || [];
    currentTime = result.currentTime || 0;
    const nextSignature = JSON.stringify([result.generation, cues]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      render();
    } else {
      for (const card of list.children) {
        const cue = cues.find(
          (item) => String(item.start) === card.dataset.start
        );
        if (cue && cue.start <= currentTime && cue.end >= currentTime)
          card.setAttribute("aria-current", "true");
        else card.removeAttribute("aria-current");
      }
    }
    const statuses = {
      "captions-unavailable-enable-visible-captions": t(
        "No visible supported captions. Enable native captions; selectors may be unsupported.",
        "Không thấy caption được hỗ trợ. Hãy bật caption gốc; selector có thể chưa hỗ trợ."
      ),
      buffering: t(
        "Grouping visible caption fragments (maximum 900 ms).",
        "Đang gộp đoạn caption (tối đa 900 ms)."
      ),
      "provider-error":
        t("Provider failed: ", "Provider lỗi: ") + (result.error || ""),
      "translating-visible-captions": t(
        "Reading visible captions only.",
        "Chỉ đọc caption đang hiển thị."
      )
    };
    setStatus(
      (statuses[result.status] ||
        t(
          "Session inactive; start again when ready.",
          "Phiên chưa chạy; Bắt đầu lại khi sẵn sàng."
        )) +
        t(
          ` Requests ${result.requests || 0} / observed changes ${result.observations || 0}; provider ${result.latencyMs || 0} ms, grouping ${result.groupWaitMs || 0} ms.`,
          ` Request ${result.requests || 0} / lần đổi caption ${result.observations || 0}; provider ${result.latencyMs || 0} ms, gộp ${result.groupWaitMs || 0} ms.`
        )
    );
    if (!result.active) stopPolling();
  }

  async function poll() {
    if (disposed || (!live && !followingFile) || polling) return;
    const token = revision;
    polling = true;
    try {
      const result = await send("snapshot");
      if (!disposed && token === revision) {
        if (followingFile) {
          if (videoId !== result.videoId)
            throw new Error(
              t(
                "Video changed. Seek a file cue again to bind it.",
                "Video đã đổi. Bấm cue tệp lần nữa để gắn lại."
              )
            );
          currentTime = result.currentTime || 0;
          render();
        } else applySnapshot(result);
      }
    } catch (error) {
      if (!disposed && token === revision) {
        stopPolling();
        cues = parsed?.cues || [];
        currentTime = -1;
        sessionTab = null;
        videoId = "";
        render();
        setStatus(error.message);
      }
    } finally {
      polling = false;
    }
  }

  panel.append(
    heading,
    intro,
    api.field(
      t("Subtitle file (maximum 5 MiB)", "Tệp phụ đề (tối đa 5 MiB)"),
      file
    ),
    fileTools,
    consentLabel,
    liveTools,
    status,
    api.field(t("Search transcript", "Tìm transcript"), search),
    summary,
    list,
    paging
  );
  container.append(panel);
  render();
  return () => {
    disposed = true;
    queue?.cancel();
    void stopLive().catch(() => {});
    listeners.forEach((remove) => remove());
    panel.remove();
  };
}
