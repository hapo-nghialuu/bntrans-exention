(() => {
  if (window.top !== window) return;
  let cleanup,
    generation = 0;
  const listener = (message, sender, respond) => {
    if (
      message?.type !== "open-quick-actions" ||
      sender.id !== chrome.runtime.id
    )
      return;
    const own = ++generation;
    cleanup?.();
    import(chrome.runtime.getURL("src/common/quick-actions.js"))
      .then((module) => (own === generation ? module.openQuickActions() : null))
      .then((close) => {
        if (own !== generation) close?.();
        else cleanup = close;
        respond({ ok: true });
      })
      .catch((error) => {
        alert(error.message);
        respond({ ok: false, error: error.message });
      });
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  window.addEventListener(
    "pagehide",
    () => {
      ++generation;
      cleanup?.();
      chrome.runtime.onMessage.removeListener(listener);
    },
    { once: true }
  );
})();
