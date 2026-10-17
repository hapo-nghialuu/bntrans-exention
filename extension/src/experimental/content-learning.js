(() => {
  if (globalThis.__bntransLearningCleanup)
    globalThis.__bntransLearningCleanup();
  const KEY = "bntransLabs:vocabulary";
  const SKIP =
    "input,textarea,select,option,button,form,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='searchbox'],[aria-hidden='true'],[hidden],script,style,noscript,pre,code,kbd,samp,svg,canvas,audio,video,[data-bntrans-learning],[data-bntrans-sensitive],[autocomplete='one-time-code'],[autocomplete*='password']";
  let settings = {},
    active = false,
    disposed = false,
    generation = 0,
    modulePromise,
    frequencyPromise,
    store,
    unsubscribe,
    observer,
    timer,
    actionHost,
    snapshot;
  const marked = new Set();
  const t = (en, vi) => (settings.interfaceLanguage === "vi" ? vi : en);
  const allowed = (node) => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(
      element && !element.closest(SKIP) && !element.isContentEditable
    );
  };
  const load = () =>
    (modulePromise ||= import(
      chrome.runtime.getURL("src/experimental/learning-store.js")
    ));
  const loadFrequency = () =>
    (frequencyPromise ||= import(
      chrome.runtime.getURL("src/experimental/learning-frequency.js")
    ));
  function errorNotice() {
    if (actionHost?.shadowRoot) {
      const status = actionHost.shadowRoot.querySelector("[role='status']");
      if (status)
        status.textContent = t(
          "Could not save; open Learning Labs to check storage.",
          "Không lưu được; mở Learning Labs để kiểm tra bộ nhớ."
        );
    }
  }
  function capture() {
    if (!active) return null;
    if (document.activeElement && !allowed(document.activeElement)) return null;
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount !== 1 ||
      !allowed(selection.anchorNode) ||
      !allowed(selection.focusNode)
    )
      return null;
    const range = selection.getRangeAt(0),
      selected = selection.toString().trim();
    if (!selected || selected.length > 500) return null;
    const common =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!allowed(common)) return null;
    const forbidden = common.querySelectorAll(SKIP);
    if (forbidden.length > 500) return null;
    for (const node of forbidden) {
      if (range.intersectsNode(node)) return null;
    }
    const block =
      common.closest("p,li,blockquote,figcaption,td,h1,h2,h3,h4") || common;
    let surrounding = "",
      count = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        allowed(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    while (walker.nextNode() && count++ < 300 && surrounding.length < 6000)
      surrounding += walker.currentNode.textContent;
    const index = surrounding.indexOf(selected);
    const context =
      index >= 0
        ? surrounding
            .slice(
              Math.max(0, index - 500),
              Math.min(surrounding.length, index + selected.length + 500)
            )
            .slice(0, 2000)
        : selected;
    return {
      text: selected,
      context,
      url: location.href,
      sourceLanguage:
        document.documentElement.lang || settings.targetLanguageCode || "en",
      targetLanguage: settings.nativeLanguageCode || "vi"
    };
  }
  function removeAction() {
    actionHost?.remove();
    actionHost = null;
    snapshot = null;
  }
  function selectionChanged(event) {
    if (!event.isTrusted || event.target === actionHost) return;
    if (!active || disposed) return;
    const entry = capture();
    if (!entry) {
      removeAction();
      return;
    }
    removeAction();
    snapshot = entry;
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    actionHost = document.createElement("span");
    actionHost.dataset.bntransLearning = "action";
    actionHost.style.cssText = `position:fixed;z-index:2147483646;left:${Math.max(8, Math.min(innerWidth - 240, rect.left))}px;top:${Math.max(8, Math.min(innerHeight - 70, rect.bottom + 6))}px;`;
    const shadow = actionHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ":host{all:initial}div{display:flex;gap:6px;align-items:center;padding:6px;background:#152332;color:#fff;border:1px solid #7695b5;border-radius:6px;font:12px/1.4 system-ui;max-width:320px}button{font:inherit;color:inherit;background:transparent;border:1px solid #7695b5;border-radius:4px;padding:4px 8px;cursor:pointer}button:focus-visible{outline:2px solid #c1defa}span{max-width:200px}";
    const box = document.createElement("div"),
      button = document.createElement("button"),
      close = document.createElement("button"),
      status = document.createElement("span");
    button.type = close.type = "button";
    button.textContent = t("Save to BNTrans", "Lưu vào BNTrans");
    close.textContent = t("Close", "Đóng");
    status.setAttribute("role", "status");
    box.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      const value = snapshot;
      if (!value || !active) return;
      button.disabled = true;
      try {
        const module = await load();
        const item = await module.saveVocabulary(value);
        if (disposed || !active) return;
        status.textContent = t(
          "Saved. Edit meaning in Learning Labs.",
          "Đã lưu. Sửa nghĩa trong Learning Labs."
        );
        button.textContent = t("Saved", "Đã lưu");
        snapshot = null;
        // Only our own user action emits this informational event; never trust page events as writes.
        document.dispatchEvent(
          new CustomEvent("bntrans-labs-selection", {
            detail: { ...value, id: item.id, saved: true }
          })
        );
      } catch {
        errorNotice();
        button.disabled = false;
      }
    });
    close.addEventListener("click", removeAction);
    box.append(button, close, status);
    shadow.append(style, box);
    document.documentElement.append(actionHost);
  }
  function restore() {
    observer?.disconnect();
    for (const mark of marked) {
      const parent = mark.parentNode;
      if (parent) {
        mark.replaceWith(document.createTextNode(mark.textContent));
        parent.normalize();
      }
    }
    marked.clear();
  }
  function observe() {
    if (active && observer && document.body)
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
      });
  }
  async function highlight() {
    if (!active || disposed || !store) return;
    const token = generation;
    const [module, frequency, state] = await Promise.all([
      load(),
      loadFrequency(),
      store.read()
    ]);
    if (!active || disposed || token !== generation) return;
    restore();
    if (!state.highlightEnabled) {
      observe();
      return;
    }
    if (!document.body) {
      observe();
      return;
    }
    const savedUnknown = module.highlightTokens(state);
    const known = new Set(
      module
        .normalizeVocabulary(state)
        .items.filter(
          (item) =>
            !item.deletedAt &&
            item.known &&
            /^en(?:-|$)/i.test(item.sourceLanguage) &&
            /^[a-z]+(?:['’-][a-z]+)*$/i.test(item.text)
        )
        .map((item) => item.text.toLowerCase())
    );
    const englishPage = /^en(?:-|$)/i.test(document.documentElement.lang || "");
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          allowed(node) && node.textContent.length < 10000
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT
      }
    );
    const nodes = [];
    let scanned = 0;
    while (walker.nextNode() && scanned++ < 4000)
      nodes.push(walker.currentNode);
    let total = 0;
    for (const node of nodes) {
      const text = node.textContent,
        matches = [
          ...text.matchAll(/[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*/gu)
        ].filter((v) =>
          frequency.shouldHighlightEnglishWord(
            v[0],
            state.highlightLevel,
            savedUnknown,
            known,
            englishPage
          )
        );
      if (!matches.length || !node.parentNode) continue;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        if (total++ >= 500) break;
        fragment.append(
          document.createTextNode(text.slice(offset, match.index))
        );
        const mark = document.createElement("mark");
        mark.dataset.bntransLearning = "highlight";
        mark.textContent = match[0];
        mark.title = t(
          "Unknown or uncommon · click to mark known / ignore",
          "Từ chưa biết hoặc ít gặp · bấm để đánh dấu đã biết / bỏ qua"
        );
        mark.tabIndex = 0;
        mark.setAttribute("role", "button");
        const ignore = (event) => {
          if (!event.isTrusted || !active) return;
          if (event.type === "keydown" && !["Enter", " "].includes(event.key))
            return;
          event.preventDefault();
          event.stopPropagation();
          const word = match[0].toLowerCase();
          store
            .update((current) => {
              let next = current,
                found = false;
              for (const item of module.normalizeVocabulary(current).items) {
                if (
                  !item.deletedAt &&
                  /^en(?:-|$)/i.test(item.sourceLanguage) &&
                  item.text.toLowerCase() === word
                ) {
                  next = module.saveItem(
                    next,
                    { ...item, known: true },
                    Date.now(),
                    item.id
                  );
                  found = true;
                }
              }
              return found
                ? next
                : module.saveItem(next, {
                    text: word,
                    sourceLanguage: "en",
                    known: true
                  });
            })
            .catch(errorNotice);
        };
        mark.addEventListener("click", ignore);
        mark.addEventListener("keydown", ignore);
        mark.style.cssText =
          "background:transparent;color:inherit;text-decoration:underline;text-decoration-color:#b77a19;text-decoration-style:dotted;text-underline-offset:3px;";
        fragment.append(mark);
        marked.add(mark);
        offset = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(text.slice(offset)));
      node.replaceWith(fragment);
      if (total >= 500) break;
    }
    observe();
  }
  const schedule = () => {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => highlight().catch(errorNotice), 300);
  };
  async function configure(next) {
    settings = next || {};
    const enabled = settings.labFeatures?.learning === true;
    if (!enabled) {
      generation++;
      active = false;
      clearTimeout(timer);
      restore();
      removeAction();
      unsubscribe?.();
      unsubscribe = null;
      store?.dispose();
      store = null;
      document.removeEventListener("pointerup", selectionChanged);
      document.removeEventListener("keyup", selectionChanged);
      return;
    }
    if (active || disposed) return;
    const token = ++generation;
    active = true;
    try {
      const module = await load();
      if (!active || disposed || token !== generation) return;
      store = module.createVocabularyStore(module.chromeVocabularyApi(), {
        onError: errorNotice
      });
      unsubscribe = store.subscribe(schedule);
      observer = new MutationObserver(schedule);
      document.addEventListener("pointerup", selectionChanged);
      document.addEventListener("keyup", selectionChanged);
      schedule();
    } catch {
      active = false;
      errorNotice();
    }
  }
  const changed = (event, area) => {
    if (area !== "local") return;
    if (event.translatorSettings)
      configure(event.translatorSettings.newValue).catch(errorNotice);
    if (event[KEY]) schedule();
  };
  const message = (request, sender, respond) => {
    if (request?.type !== "labs-learning-command") return;
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    const result =
      request.payload?.command === "capture" || request.command === "capture"
        ? capture()
        : null;
    respond(
      result
        ? { ok: true, ...result }
        : {
            ok: false,
            error: t(
              "No safe selection or Learning is disabled",
              "Không có vùng chọn an toàn hoặc Learning đang tắt"
            )
          }
    );
    return false;
  };
  chrome.storage.onChanged.addListener(changed);
  chrome.runtime.onMessage.addListener(message);
  chrome.storage.local
    .get("translatorSettings")
    .then((v) => configure(v.translatorSettings))
    .catch(errorNotice);
  globalThis.__bntransLearningCleanup = () => {
    disposed = true;
    generation++;
    active = false;
    clearTimeout(timer);
    restore();
    removeAction();
    unsubscribe?.();
    store?.dispose();
    document.removeEventListener("pointerup", selectionChanged);
    document.removeEventListener("keyup", selectionChanged);
    chrome.storage.onChanged.removeListener(changed);
    chrome.runtime.onMessage.removeListener(message);
    delete globalThis.__bntransLearningCleanup;
  };
})();
