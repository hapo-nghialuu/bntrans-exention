(() => {
  if (window !== window.top) return;
  const features = new Set([
    "corrections",
    "ask",
    "image",
    "compare",
    "readalong"
  ]);
  const snapshots = new Map();
  let modulePromise, observer, timer, sheet;
  let disposed = false,
    epoch = 0;
  const load = () =>
    (modulePromise ||= import(
      chrome.runtime.getURL("src/experimental/reading-context.js")
    ));
  const key = (feature) => `bntrans-reading-${feature}`;
  function clear(feature) {
    if (feature) {
      snapshots.delete(feature);
      globalThis.CSS?.highlights?.delete(key(feature));
    } else {
      for (const name of features)
        globalThis.CSS?.highlights?.delete(key(name));
      snapshots.clear();
    }
    if (!snapshots.size) {
      observer?.disconnect();
      observer = null;
      clearInterval(timer);
      timer = null;
      if (sheet)
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (item) => item !== sheet
        );
      sheet = null;
    }
  }
  function invalidate() {
    epoch++;
    clear();
  }
  function watch(context) {
    if (observer) return;
    const url = location.href;
    observer = new MutationObserver(() => {
      try {
        for (const snapshot of snapshots.values()) {
          for (const block of snapshot.source.blocks)
            context.validateReadingSnapshot(document, snapshot, {
              snapshotId: snapshot.source.snapshotId,
              url: snapshot.source.url,
              blockId: block.id
            });
        }
      } catch {
        invalidate();
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
    timer = setInterval(() => {
      if (location.href !== url) invalidate();
    }, 300);
  }
  async function command(payload) {
    const feature = payload?.feature;
    if (!features.has(feature)) throw new Error("source-feature");
    if (payload.command === "clear") {
      const current = snapshots.get(feature);
      if (
        payload.snapshotId &&
        current?.source.snapshotId !== payload.snapshotId
      )
        throw new Error("source-stale");
      epoch++;
      clear(feature);
      return { ok: true };
    }
    const token = epoch;
    const { translatorSettings: settings } =
      await chrome.storage.local.get("translatorSettings");
    if (disposed || token !== epoch) throw new Error("source-cancelled");
    if (
      settings?.enabled === false ||
      settings?.labFeatures?.[feature] !== true
    )
      throw new Error("source-disabled");
    const context = await load();
    if (disposed || token !== epoch) throw new Error("source-cancelled");
    if (payload.command === "capture") {
      clear(feature);
      const snapshot = context.captureReadingSnapshot(document, payload.mode);
      snapshots.set(feature, snapshot);
      watch(context);
      return { ok: true, source: snapshot.source };
    }
    if (!["jump", "highlight"].includes(payload.command))
      throw new Error("source-command");
    const snapshot = snapshots.get(feature);
    const range = context.readingSnapshotRange(document, snapshot, payload);
    if (payload.command === "highlight") {
      if (
        !globalThis.CSS?.highlights ||
        !globalThis.Highlight ||
        !document.adoptedStyleSheets
      )
        throw new Error("source-highlight-unsupported");
      if (!sheet) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(
          [...features]
            .map(
              (name) =>
                `::highlight(${key(name)}){background:#d6ebff;color:#152f48}`
            )
            .join("\n")
        );
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      CSS.highlights.set(key(feature), new Highlight(range));
    }
    if (payload.command === "jump" || payload.jump === true)
      range.startContainer.parentElement?.scrollIntoView({
        block: "center",
        behavior: "auto"
      });
    return { ok: true, blockId: payload.blockId };
  }
  const onMessage = (message, sender, respond) => {
    if (
      message?.type !== "labs-reading-source" ||
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    )
      return false;
    command(message.payload)
      .then(respond)
      .catch((error) =>
        respond({ ok: false, error: error.code || error.message })
      );
    return true;
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes.translatorSettings) invalidate();
  };
  function dispose() {
    disposed = true;
    invalidate();
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("popstate", invalidate);
    window.removeEventListener("hashchange", invalidate);
  }
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("popstate", invalidate);
  window.addEventListener("hashchange", invalidate);
})();
