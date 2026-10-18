(() => {
  if (window !== window.top) return;
  let modules, selected, host, shadow, observer, timer, picking;
  let epoch = 0,
    disposed = false;
  const load = () =>
    (modules ||= Promise.all([
      import(chrome.runtime.getURL("src/experimental/reading-context.js")),
      import(
        chrome.runtime.getURL("src/experimental/image-translation-utils.js")
      )
    ]));
  const intersect = (a, b) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;
  function removeOverlay() {
    host?.remove();
    host = shadow = null;
  }
  function restore() {
    epoch++;
    const imageId = selected?.source.id;
    picking?.(new Error("image-cancelled"));
    picking = null;
    selected = null;
    removeOverlay();
    observer?.disconnect();
    observer = null;
    clearInterval(timer);
    timer = null;
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    if (imageId) {
      try {
        void chrome.runtime
          .sendMessage({ type: "labs-image-invalidated", imageId })
          .catch(() => {});
      } catch {}
    }
  }
  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      scale: window.visualViewport?.scale || 1,
      offsetLeft: window.visualViewport?.offsetLeft || 0,
      offsetTop: window.visualViewport?.offsetTop || 0
    };
  }
  function geometry(img, context, utils) {
    if (
      !context.isSafeReadingNode(img) ||
      !img.complete ||
      img.tagName !== "IMG" ||
      img.children.length
    )
      throw new Error("image-protected");
    const src = img.currentSrc || img.src;
    if (
      !/^(?:https?:|file:|data:image\/(?:png|jpeg);base64,)/i.test(src) ||
      (!src.startsWith("data:") &&
        !/\.(?:png|jpe?g)$/i.test(new URL(src).pathname))
    )
      throw new Error("image-raster-only");
    const style = getComputedStyle(img);
    for (let el = img; el; el = el.parentElement) {
      const css = getComputedStyle(el);
      if (
        (css.transform && css.transform !== "none") ||
        (css.rotate && css.rotate !== "none") ||
        (css.scale && css.scale !== "none") ||
        (css.filter && css.filter !== "none") ||
        (css.clipPath && css.clipPath !== "none") ||
        (css.maskImage && css.maskImage !== "none") ||
        (css.perspective && css.perspective !== "none") ||
        (css.zoom && css.zoom !== "1" && css.zoom !== "normal") ||
        Number(css.opacity || 1) !== 1
      )
        throw new Error("image-style-unsupported");
    }
    if (
      [
        "borderTopWidth",
        "borderBottomWidth",
        "borderLeftWidth",
        "borderRightWidth",
        "paddingTop",
        "paddingBottom",
        "paddingLeft",
        "paddingRight",
        "borderRadius"
      ].some((key) => parseFloat(style[key]) > 0)
    )
      throw new Error("image-style-unsupported");
    const bounds = img.getBoundingClientRect();
    const rect = utils.imageContentRect(
      bounds,
      img.naturalWidth,
      img.naturalHeight,
      style
    );
    const view = viewport();
    if (view.scale !== 1 || view.offsetLeft || view.offsetTop)
      throw new Error("image-viewport");
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.width > view.width ||
      rect.y + rect.height > view.height
    )
      throw new Error("image-clipped");
    for (let el = img.parentElement; el; el = el.parentElement) {
      const css = getComputedStyle(el),
        r = el.getBoundingClientRect();
      if (
        (/hidden|clip|auto|scroll/.test(css.overflowX || css.overflow || "") &&
          (rect.x < r.x || rect.x + rect.width > r.x + r.width)) ||
        (/hidden|clip|auto|scroll/.test(css.overflowY || css.overflow || "") &&
          (rect.y < r.y || rect.y + rect.height > r.y + r.height))
      )
        throw new Error("image-clipped");
    }
    return {
      src,
      rect,
      viewport: view,
      width: img.naturalWidth,
      height: img.naturalHeight,
      fit: style.objectFit || "fill",
      position: style.objectPosition || "50% 50%"
    };
  }
  function unobscured(img, rect) {
    const elements = document.querySelectorAll("*");
    if (elements.length > 12000) throw new Error("image-page-limit");
    for (const el of elements) {
      if (
        el === img ||
        el.contains(img) ||
        el === host ||
        host?.contains(el) ||
        ["SCRIPT", "STYLE", "LINK", "META", "HEAD", "TITLE"].includes(
          el.tagName
        )
      )
        continue;
      const css = getComputedStyle(el);
      if (
        css.display === "none" ||
        css.visibility === "hidden" ||
        css.visibility === "collapse" ||
        css.opacity === "0"
      )
        continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && intersect(rect, r))
        throw new Error("image-obscured");
    }
    // Reject pseudo-element overlays and verify the image at all four corners.
    for (let el = img; el; el = el.parentElement) {
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && content !== "none" && content !== "normal")
          throw new Error("image-obscured");
      }
    }
    if (document.elementFromPoint) {
      for (const [x, y] of [
        [rect.x + 0.5, rect.y + 0.5],
        [rect.x + rect.width - 0.5, rect.y + 0.5],
        [rect.x + 0.5, rect.y + rect.height - 0.5],
        [rect.x + rect.width - 0.5, rect.y + rect.height - 0.5]
      ])
        if (document.elementFromPoint(x, y) !== img)
          throw new Error("image-obscured");
    }
  }
  function current(payload, capture = false) {
    if (
      !selected ||
      payload?.id !== selected.source.id ||
      location.href !== selected.source.url ||
      !selected.img.isConnected
    )
      throw new Error("image-stale");
    if (
      (selected.img.currentSrc || selected.img.src) !== selected.source.src ||
      selected.img.naturalWidth !== selected.source.width ||
      selected.img.naturalHeight !== selected.source.height
    )
      throw new Error("image-stale");
    const value = geometry(selected.img, selected.context, selected.utils);
    for (const key of ["src", "width", "height", "fit", "position"])
      if (value[key] !== selected.source[key]) throw new Error("image-stale");
    if (
      selected.lineage.some(
        (el, index) => el !== [selected.img, ...ancestors(selected.img)][index]
      )
    )
      throw new Error("image-stale");
    if (
      capture &&
      (JSON.stringify(value.rect) !== JSON.stringify(selected.source.rect) ||
        JSON.stringify(value.viewport) !==
          JSON.stringify(selected.source.viewport))
    )
      throw new Error("image-stale");
    unobscured(selected.img, value.rect);
    return value;
  }
  function ancestors(img) {
    const all = [];
    for (let el = img.parentElement; el; el = el.parentElement) all.push(el);
    return all;
  }
  function reposition() {
    if (!selected) return;
    try {
      const { rect } = current(selected.source);
      if (host)
        Object.assign(host.style, {
          display: "block",
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`
        });
    } catch (error) {
      if (error.message === "image-clipped") {
        if (host) host.style.display = "none";
      } else restore();
    }
  }
  function watch() {
    observer = new MutationObserver((changes) => {
      if (
        changes.every(
          (change) => change.target === host || host?.contains(change.target)
        )
      )
        return;
      reposition();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    timer = setInterval(reposition, 250);
  }
  async function command(payload, background = false) {
    if (payload?.command === "restore") {
      restore();
      return { ok: true };
    }
    const token = epoch;
    const { translatorSettings: settings } =
      await chrome.storage.local.get("translatorSettings");
    if (disposed || token !== epoch) throw new Error("image-cancelled");
    if (settings?.enabled === false || settings?.labFeatures?.image !== true)
      throw new Error("image-disabled");
    if (payload?.command === "choose-image" && !background) {
      restore();
      const pickToken = epoch;
      const [context, utils] = await load();
      if (disposed || pickToken !== epoch) throw new Error("image-cancelled");
      return new Promise((resolve, reject) => {
        let timeout;
        const finish = (error, source) => {
          clearTimeout(timeout);
          document.removeEventListener("click", click, true);
          window.removeEventListener("keydown", key, true);
          picking = null;
          if (error) reject(error);
          else resolve({ ok: true, source });
        };
        const key = (event) => {
          if (event.key === "Escape") finish(new Error("image-cancelled"));
        };
        const click = (event) => {
          if (!event.isTrusted || event.button !== 0) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          try {
            if (pickToken !== epoch) throw new Error("image-cancelled");
            const img = event.target;
            const value = geometry(img, context, utils);
            unobscured(img, value.rect);
            const source = {
              id: crypto.randomUUID(),
              url: location.href,
              ...value
            };
            selected = {
              img,
              source,
              context,
              utils,
              lineage: [img, ...ancestors(img)]
            };
            watch();
            finish(null, source);
          } catch (error) {
            finish(error);
          }
        };
        picking = finish;
        document.addEventListener("click", click, true);
        window.addEventListener("keydown", key, true);
        timeout = setTimeout(
          () => finish(new Error("image-pick-timeout")),
          60000
        );
      });
    }
    if (payload?.command === "validate") {
      current(payload, true);
      return { ok: true, source: selected.source };
    }
    if (background) throw new Error("image-command");
    const value = current(payload);
    if (payload?.command === "check") return { ok: true };
    if (payload?.command === "original") {
      removeOverlay();
      return { ok: true };
    }
    if (
      payload?.command !== "show" ||
      !Array.isArray(payload.lines) ||
      !payload.lines.length ||
      payload.lines.length > selected.utils.IMAGE_LIMITS.lines
    )
      throw new Error("image-command");
    const ids = new Set();
    let length = 0;
    for (const line of payload.lines) {
      const box = line.bbox;
      if (
        typeof line.id !== "string" ||
        ids.has(line.id) ||
        typeof line.text !== "string" ||
        !line.text.trim() ||
        !box ||
        ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.x < 0 ||
        box.y < 0 ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.x + box.width > 1.000001 ||
        box.y + box.height > 1.000001
      )
        throw new Error("image-layout");
      ids.add(line.id);
      length += line.text.length;
    }
    if (length > selected.utils.IMAGE_LIMITS.text)
      throw new Error("image-text-limit");
    removeOverlay();
    host = document.createElement("div");
    host.id = "bntrans-image-overlay";
    host.setAttribute("data-bt-injected", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial;position:fixed;display:block;pointer-events:none;overflow:hidden;z-index:2147483646;contain:strict;";
    Object.assign(host.style, {
      left: `${value.rect.x}px`,
      top: `${value.rect.y}px`,
      width: `${value.rect.width}px`,
      height: `${value.rect.height}px`
    });
    shadow = host.attachShadow({ mode: "closed" });
    for (const line of payload.lines) {
      const label = document.createElement("span"),
        box = line.bbox;
      label.textContent = line.text;
      label.style.cssText =
        "position:absolute;display:flex;align-items:center;justify-content:center;box-sizing:border-box;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;background:#fffdf6;color:#182b3a;text-align:center;font-family:system-ui,sans-serif;line-height:1.12;padding:1px;";
      Object.assign(label.style, {
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
        fontSize: `clamp(6px,${box.height * 75}cqh,28px)`
      });
      shadow.append(label);
    }
    host.style.containerType = "size";
    document.documentElement.append(host);
    return { ok: true };
  }
  const onMessage = (message, sender, respond) => {
    if (
      message?.type !== "labs-image-source" ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return false;
    const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
    const background =
      !sender.url || sender.url === chrome.runtime.getURL("src/background.js");
    if (!extensionPage && !background) return false;
    command(message.payload, background)
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes.translatorSettings) restore();
  };
  const onNavigation = () => restore();
  const dispose = () => {
    disposed = true;
    restore();
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("popstate", onNavigation);
    window.removeEventListener("hashchange", onNavigation);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("popstate", onNavigation);
  window.addEventListener("hashchange", onNavigation);
})();
