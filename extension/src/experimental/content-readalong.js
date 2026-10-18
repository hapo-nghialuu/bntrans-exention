(() => {
  if (window !== window.top) return;
  const sessions = new Set();
  let disposed = false;
  function connect(port) {
    if (
      port.name !== "bntrans-readalong" ||
      port.sender?.id !== chrome.runtime.id ||
      port.sender.tab ||
      !port.sender.url?.startsWith(chrome.runtime.getURL(""))
    )
      return;
    let observer,
      timer,
      epoch = 0,
      closed = false;
    const clear = () => {
      observer?.disconnect();
      clearInterval(timer);
      observer = null;
      timer = null;
    };
    const invalidate = () => {
      if (closed) return;
      clear();
      epoch++;
      try {
        port.postMessage({ type: "invalidated" });
      } catch {}
      close();
    };
    function close() {
      if (closed) return;
      closed = true;
      epoch++;
      clear();
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(close);
      window.removeEventListener("pagehide", invalidate);
      window.removeEventListener("popstate", invalidate);
      window.removeEventListener("hashchange", invalidate);
      sessions.delete(invalidate);
      port.disconnect();
    }
    async function message(payload) {
      const token = ++epoch;
      clear();
      if (
        payload?.command !== "watch" ||
        typeof payload.snapshotId !== "string" ||
        !payload.snapshotId ||
        payload.url !== location.href
      ) {
        invalidate();
        return;
      }
      const { translatorSettings: settings } = await chrome.storage.local
        .get("translatorSettings")
        .catch(() => ({}));
      if (closed || disposed || token !== epoch) return;
      if (
        settings?.enabled === false ||
        settings?.labFeatures?.readalong !== true
      ) {
        invalidate();
        return;
      }
      const url = location.href;
      observer = new MutationObserver(invalidate);
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true
      });
      timer = setInterval(() => {
        if (location.href !== url) invalidate();
      }, 250);
      try {
        port.postMessage({ type: "ready", snapshotId: payload.snapshotId });
      } catch {
        close();
      }
    }
    sessions.add(invalidate);
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(close);
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("popstate", invalidate);
    window.addEventListener("hashchange", invalidate);
  }
  function changed(changes, area) {
    if (area === "local" && changes.translatorSettings)
      for (const stop of [...sessions]) stop();
  }
  function dispose() {
    disposed = true;
    for (const stop of [...sessions]) stop();
    chrome.runtime.onConnect.removeListener(connect);
    chrome.storage.onChanged.removeListener(changed);
    window.removeEventListener("pagehide", dispose);
  }
  chrome.runtime.onConnect.addListener(connect);
  chrome.storage.onChanged.addListener(changed);
  window.addEventListener("pagehide", dispose, { once: true });
})();
