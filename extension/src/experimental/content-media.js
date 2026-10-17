(() => {
  "use strict";
  if (globalThis.BNTransMedia) return;

  function mergeText(previous, next) {
    if (!previous || next.startsWith(previous)) return next;
    if (previous.endsWith(next)) return previous;
    const a = previous.split(/\s+/);
    const b = next.split(/\s+/);
    for (let length = Math.min(a.length, b.length); length > 0; length--) {
      if (a.slice(-length).join(" ") === b.slice(0, length).join(" "))
        return [...a, ...b.slice(length)].join(" ");
    }
    return `${previous}\n${next}`;
  }

  function sentenceEnded(text, language = "en") {
    if (!/[.!?。！？…]["'”’」』)]*\s*$/u.test(text)) return false;
    if (typeof Intl.Segmenter !== "function") return true;
    try {
      return (
        [
          ...new Intl.Segmenter(language === "auto" ? undefined : language, {
            granularity: "sentence"
          }).segment(text)
        ].length > 0
      );
    } catch {
      return true;
    }
  }

  function createGrouper({
    emit,
    delay = 900,
    language = "en",
    schedule = setTimeout,
    unschedule = clearTimeout
  }) {
    let pending = null;
    let timer = null;
    function flush() {
      if (timer !== null) unschedule(timer);
      timer = null;
      if (!pending) return;
      const group = pending;
      pending = null;
      emit(group);
    }
    return {
      push(cue) {
        if (pending && pending.speaker !== cue.speaker) flush();
        pending = pending
          ? {
              ...pending,
              text: mergeText(pending.text, cue.text),
              end: cue.end,
              key: cue.key,
              revision: cue.revision,
              count: pending.count + 1
            }
          : { ...cue, count: 1 };
        if (timer === null) timer = schedule(flush, delay);
        if (sentenceEnded(cue.text, language)) flush();
      },
      flush,
      clear() {
        if (timer !== null) unschedule(timer);
        timer = null;
        pending = null;
      }
    };
  }

  function adapterFor(hostname) {
    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com"))
      return {
        name: "youtube",
        selector: ".ytp-caption-segment",
        root: ".html5-video-player"
      };
    if (hostname === "netflix.com" || hostname.endsWith(".netflix.com"))
      return {
        name: "netflix",
        selector: ".player-timedtext-text-container",
        root: ".watch-video"
      };
    if (hostname === "meet.google.com")
      return {
        name: "meet",
        selector:
          ".a4cQT .ygicle, .a4cQT .bh44bd, [role='region'][aria-label='Captions'] .ygicle, .iTTPOb",
        speaker: ".zs7s8d",
        root: ".a4cQT, .iTTPOb, [role='region'][aria-label='Captions']"
      };
    return null;
  }

  function visible(node) {
    if (
      !node ||
      !node.getClientRects().length ||
      node.closest("[hidden], [aria-hidden='true']")
    )
      return false;
    const style = getComputedStyle(node);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function readCaption(adapter, doc = document) {
    const nodes = [...doc.querySelectorAll(adapter.selector)].filter(visible);
    const selected = adapter.name === "meet" ? nodes.slice(-1) : nodes;
    const text = selected
      .map((node) => node.innerText?.trim())
      .filter(Boolean)
      .join("\n");
    const speakerNode =
      adapter.name === "meet"
        ? selected[0]
            ?.closest(".nMcdL, .iTTPOb")
            ?.querySelector(".zs7s8d, .NWpY1d, .KcIKyf")
        : null;
    const fallbackSpeakers =
      adapter.speaker && nodes.length === 1
        ? [...doc.querySelectorAll(adapter.speaker)].filter(visible)
        : [];
    const speaker =
      speakerNode && visible(speakerNode)
        ? speakerNode.innerText.trim()
        : fallbackSpeakers.length === 1
          ? fallbackSpeakers[0].innerText?.trim() || ""
          : "";
    return { text: text.slice(0, 8000), speaker };
  }

  function createRenderer(doc = document) {
    let element = null;
    return {
      show(text, parent) {
        if (!element) {
          element = doc.createElement("div");
          element.dataset.bntransMedia = "true";
          element.setAttribute("role", "status");
          element.style.cssText =
            "position:fixed;bottom:12%;left:15%;width:70%;z-index:2147483646;text-align:center;color:#fff;background:#15212fed;padding:8px;white-space:pre-line;pointer-events:none;font:18px/1.4 sans-serif;border-radius:6px;";
          (parent || doc.body).appendChild(element);
        }
        element.textContent = text;
      },
      clear() {
        element?.remove();
        element = null;
      },
      owns(node) {
        return Boolean(element && (node === element || element.contains(node)));
      }
    };
  }

  globalThis.BNTransMedia = {
    mergeText,
    sentenceEnded,
    createGrouper,
    adapterFor,
    readCaption,
    createRenderer
  };
  if (
    typeof chrome === "undefined" ||
    !chrome.runtime?.onMessage ||
    window.top !== window
  )
    return;

  let session = null;
  let lifecycle = 0;
  let generation = 0;
  let replayCleanup = null;
  let replayHeartbeat = 0;
  let state = {
    supported: false,
    status: "inactive",
    cues: [],
    videoId: "",
    generation: 0
  };
  const renderer = createRenderer();
  const settings = async () =>
    (await chrome.storage.local.get("translatorSettings")).translatorSettings ||
    {};
  const identity = () =>
    `${location.origin}${location.pathname}${new URLSearchParams(location.search).get("v") || ""}`;

  function stop(reason = "stopped") {
    const wasActive = Boolean(session);
    replayCleanup?.();
    lifecycle++;
    generation++;
    if (session) {
      session.observer.disconnect();
      clearInterval(session.interval);
      session.grouper.clear();
      session.video?.removeEventListener("seeking", session.seeked);
      session.video?.removeEventListener("timeupdate", session.timeupdate);
      window.removeEventListener("pagehide", session.leave);
      window.removeEventListener("popstate", session.leave);
      window.removeEventListener("yt-navigate-start", session.leave);
    }
    renderer.clear();
    session = null;
    state = {
      ...state,
      active: false,
      status: reason,
      error: "",
      cues: [],
      generation
    };
    globalThis.BNTransMedia.active = false;
    if (wasActive)
      document.dispatchEvent(new CustomEvent("bntrans-media-state"));
  }

  function invalidate(reason) {
    replayCleanup?.();
    generation++;
    renderer.clear();
    if (!session) return;
    session.grouper.clear();
    session.lastKey = "";
    session.pending = null;
    session.replayEnd = null;
    state = {
      ...state,
      generation,
      status: reason,
      error: "",
      cues: [],
      currentTime: session.video?.currentTime || 0
    };
  }

  async function translateGroup(group, current) {
    if (current.busy) {
      current.pending = group;
      return;
    }
    current.busy = true;
    const token = generation;
    const started = Date.now();
    try {
      const config = await settings();
      if (
        session !== current ||
        token !== generation ||
        config.labFeatures?.media !== true ||
        current.lastKey !== group.key ||
        current.captionRevision !== group.revision
      )
        return;
      state.requests++;
      const response = await chrome.runtime.sendMessage({
        type: "translate",
        payload: {
          text: group.text,
          sourceLanguage: config.targetLanguageCode || "auto",
          targetLanguage: config.nativeLanguageCode || "vi",
          siteUrl: location.href,
          skipHistory: true,
          task: "translate",
          context: "",
          ephemeral: true
        }
      });
      if (
        session !== current ||
        token !== generation ||
        identity() !== state.videoId ||
        current.lastKey !== group.key ||
        current.captionRevision !== group.revision
      )
        return;
      if (!response?.ok || !response.result?.translation)
        throw new Error(
          response?.error || "Provider unavailable / Provider không khả dụng"
        );
      const translation = String(response.result.translation);
      state.latencyMs = Date.now() - started;
      state.groupWaitMs = started - group.observedAt;
      state.status = "translating-visible-captions";
      const cue = {
        id: `${generation}:${++current.sequence}`,
        start: group.start,
        end: group.end,
        text: group.text,
        translation,
        speaker: group.speaker
      };
      state.cues =
        current.adapter.name === "meet"
          ? [cue]
          : [...state.cues, cue].slice(-500);
      current.displayed = { cue, key: group.key };
      renderer.show(
        `${group.speaker ? group.speaker + "\n" : ""}${translation}`,
        document.fullscreenElement
      );
    } catch (error) {
      if (
        session === current &&
        token === generation &&
        current.captionRevision === group.revision
      ) {
        state.status = "provider-error";
        state.error = error.message;
        renderer.clear();
      }
    } finally {
      current.busy = false;
      if (session === current && current.pending) {
        const next = current.pending;
        current.pending = null;
        void translateGroup(next, current);
      }
    }
  }

  function scan() {
    const current = session;
    if (!current) return;
    if (Date.now() - current.heartbeat > 5000) {
      stop("panel-disconnected");
      return;
    }
    if (
      identity() !== state.videoId ||
      (current.video && current.video !== document.querySelector("video"))
    ) {
      stop("navigation-start-again");
      return;
    }
    const captionRoot = document.querySelector(current.adapter.root);
    if (current.adapter.name === "meet" && !visible(captionRoot)) {
      renderer.clear();
      if (current.hadCaptionRoot) {
        stop("meeting-or-captions-ended-start-again");
        return;
      }
    }
    if (visible(captionRoot)) current.hadCaptionRoot = true;
    const { text, speaker } = readCaption(current.adapter);
    const key = `${speaker}\u0000${text}`;
    const time =
      current.video?.currentTime ?? (Date.now() - current.started) / 1000;
    if (current.displayed?.key === current.lastKey)
      current.displayed.cue.end = Math.max(current.displayed.cue.end, time);
    if (!text) {
      if (current.lastKey) {
        current.lastKey = "";
        renderer.clear();
      }
      state.status = "captions-unavailable-enable-visible-captions";
      if (current.adapter.name === "meet") state.cues = [];
      return;
    }
    if (key === current.lastKey) return;
    renderer.clear();
    current.lastKey = key;
    current.captionRevision++;
    if (current.adapter.name === "meet") state.cues = [];
    state.observations++;
    state.status = "buffering";
    current.grouper.push({
      key,
      revision: current.captionRevision,
      text,
      speaker,
      start: time,
      end: time,
      observedAt: Date.now()
    });
  }

  async function start(payload) {
    stop();
    const operation = lifecycle;
    const config = await settings();
    if (operation !== lifecycle) return state;
    if (config.labFeatures?.media !== true)
      throw new Error("Enable Labs media first / Cần bật Labs media");
    const adapter = adapterFor(location.hostname);
    if (!adapter || (payload.adapter && payload.adapter !== adapter.name))
      throw new Error("Unsupported site / Trang không hỗ trợ");
    if (adapter.name === "meet" && payload.options?.meetingConsent !== true)
      throw new Error(
        "Meeting requires session consent / Cần đồng ý cho cuộc họp này"
      );
    const video = document.querySelector("video");
    if (adapter.name !== "meet" && !video)
      throw new Error("No accessible video / Không thấy video truy cập được");
    const current = {
      adapter,
      video,
      lastKey: "",
      started: Date.now(),
      heartbeat: Date.now(),
      sequence: 0,
      captionRevision: 0,
      busy: false,
      pending: null,
      hadCaptionRoot: false
    };
    current.grouper = createGrouper({
      language: config.targetLanguageCode || "en",
      emit: (group) => void translateGroup(group, current)
    });
    current.seeked = () => {
      if (
        current.expectedSeek !== undefined &&
        Math.abs(video.currentTime - current.expectedSeek) < 0.5
      ) {
        current.expectedSeek = undefined;
        return;
      }
      invalidate("seek-reset");
    };
    current.timeupdate = () => {
      state.currentTime = video.currentTime;
    };
    current.leave = () => stop("navigation-start-again");
    current.observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !renderer.owns(mutation.target))) scan();
    });
    session = current;
    globalThis.BNTransMedia.active = true;
    document.dispatchEvent(new CustomEvent("bntrans-media-state"));
    state = {
      active: true,
      supported: true,
      adapter: adapter.name,
      status: "starting",
      cues: [],
      videoId: identity(),
      generation,
      requests: 0,
      observations: 0,
      latencyMs: 0,
      groupWaitMs: 0,
      ephemeral: true
    };
    current.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "style"]
    });
    current.interval = setInterval(scan, 500);
    video?.addEventListener("seeking", current.seeked);
    video?.addEventListener("timeupdate", current.timeupdate);
    window.addEventListener("pagehide", current.leave);
    window.addEventListener("popstate", current.leave);
    window.addEventListener("yt-navigate-start", current.leave);
    scan();
    return state;
  }

  async function command(payload) {
    if (payload.command === "start")
      return { ok: true, ...(await start(payload)) };
    if (payload.command === "stop") {
      stop();
      return { ok: true, ...state };
    }
    if (payload.command === "snapshot") {
      if (session) session.heartbeat = Date.now();
      replayHeartbeat = Date.now();
      scan();
      return {
        ok: true,
        ...state,
        videoId: identity(),
        currentTime: document.querySelector("video")?.currentTime || 0
      };
    }
    if (!["seek", "replay"].includes(payload.command))
      throw new Error("Unknown media command");
    const config = await settings();
    if (config.labFeatures?.media !== true) throw new Error("Media disabled");
    const video = session?.video || document.querySelector("video");
    const adapter = adapterFor(location.hostname);
    if (!video || !adapter || adapter.name === "meet")
      throw new Error("Seeking unavailable / Không thể tua video");
    if (payload.videoId && payload.videoId !== identity())
      throw new Error("Video changed / Video đã đổi");
    const time = Number(payload.time);
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      (Number.isFinite(video.duration) && time > video.duration)
    )
      throw new Error("Invalid seek time");
    invalidate("seek-reset");
    if (session) session.expectedSeek = time;
    video.currentTime = time;
    if (payload.command === "replay") {
      const end = Number(payload.options?.end);
      if (Number.isFinite(end) && end > time) {
        const replayId = identity();
        replayHeartbeat = Date.now();
        const pauseAtEnd = () => {
          if (video.currentTime >= end) {
            video.pause();
            replayCleanup?.();
          }
        };
        const cleanup = () => {
          clearInterval(replayInterval);
          video.removeEventListener("timeupdate", pauseAtEnd);
          window.removeEventListener("pagehide", cleanup);
          replayCleanup = null;
        };
        const replayInterval = setInterval(() => {
          if (identity() !== replayId || Date.now() - replayHeartbeat > 5000)
            cleanup();
        }, 500);
        replayCleanup = cleanup;
        video.addEventListener("timeupdate", pauseAtEnd);
        window.addEventListener("pagehide", cleanup, { once: true });
      }
      try {
        await video.play();
      } catch (error) {
        replayCleanup?.();
        throw error;
      }
    }
    return {
      ok: true,
      ...state,
      videoId: identity(),
      currentTime: video.currentTime
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "labs-media-command") return;
    if (sender.id !== chrome.runtime.id || sender.tab) {
      respond({ ok: false, error: "Extension UI only" });
      return;
    }
    command(message.payload || {})
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local" || !changes.translatorSettings) return;
    const next = changes.translatorSettings.newValue || {};
    if (next.labFeatures?.media !== true) stop("disabled");
    else if (session) {
      stop("settings-changed-start-again");
    }
  });
})();
