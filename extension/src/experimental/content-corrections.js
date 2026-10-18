/* global toMarkdown */
(() => {
  if (window !== window.top) return;
  const records = new Map();
  const protectedSelector =
    'input,textarea,select,button,form,iframe,frame,script,style,code,pre,[role="textbox"],[hidden],[inert],[autocomplete],[aria-hidden="true"],[translate="no"],.notranslate,[contenteditable]:not([contenteditable="false"])';
  let active = false,
    disposed = false,
    generation = 0,
    settings,
    observer,
    timer,
    pageUrl;
  const t = (en, vi) => (settings?.interfaceLanguage === "vi" ? vi : en);
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function safe(wrapper, original) {
    if (
      !wrapper.isConnected ||
      wrapper.getRootNode() !== document ||
      original.parentNode !== wrapper ||
      original.matches(protectedSelector) ||
      original.querySelector(
        `${protectedSelector},[data-bntrans-wrapper],[role="textbox"]`
      )
    )
      return false;
    for (let el = wrapper; el; el = el.parentElement) {
      if (el.matches(protectedSelector)) return false;
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden"
      )
        return false;
    }
    for (const el of original.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return false;
    }
    return true;
  }
  function valid(record) {
    return (
      active &&
      !disposed &&
      record.generation === generation &&
      location.href === pageUrl &&
      record.wrapper.parentNode === record.parent &&
      record.original.innerHTML === record.originalHtml &&
      record.original.nextSibling === record.originalNext &&
      record.translation.parentNode === record.wrapper &&
      record.wrapper.getAttribute("data-bntrans-source-language") ===
        record.sourceLanguage &&
      record.wrapper.getAttribute("data-bntrans-target-language") ===
        record.targetLanguage &&
      record.wrapper.querySelector("[data-bntrans-original]") ===
        record.original &&
      record.wrapper.querySelector("[data-bntrans-translation]") ===
        record.translation &&
      safe(record.wrapper, record.original) &&
      toMarkdown(record.original.childNodes) === record.text &&
      record.lineage.every(([el, parent]) => el.parentNode === parent) &&
      record.sourceNodes.every(([el, parent]) => el.parentNode === parent) &&
      record.translatedNodes.every(
        (el) => el.parentNode === record.translation
      ) &&
      record.translation.innerHTML === record.expected
    );
  }
  function restore(record) {
    if (record.applied && valid(record)) {
      record.translation.replaceChildren(...record.previous);
      record.expected = record.translation.innerHTML;
      record.translatedNodes = [...record.translation.childNodes];
      record.applied = false;
    }
  }
  function stop() {
    for (const record of records.values()) {
      restore(record);
      record.host.remove();
    }
    active = false;
    generation++;
    records.clear();
    observer?.disconnect();
    observer = null;
    clearInterval(timer);
    timer = null;
  }
  function remove(record) {
    record.host.remove();
    records.delete(record.wrapper);
  }
  function current(record) {
    if (!valid(record)) {
      remove(record);
      throw new Error(
        t(
          "Page changed. Start editing again in Labs.",
          "Trang đã đổi. Bật sửa lại trong Labs."
        )
      );
    }
  }
  function apply(record, value) {
    current(record);
    if (!value.trim() || value.length > 12000)
      throw new Error(t("Enter 1–12000 characters", "Nhập từ 1–12000 ký tự"));
    record.translation.textContent = value;
    record.expected = record.translation.innerHTML;
    record.translatedNodes = [...record.translation.childNodes];
    record.applied = true;
  }
  function attach(wrapper) {
    const sourceLanguage = wrapper.getAttribute("data-bntrans-source-language");
    const targetLanguage = wrapper.getAttribute("data-bntrans-target-language");
    const original = wrapper.querySelector(":scope > [data-bntrans-original]");
    const translation = wrapper.querySelector(
      ":scope > [data-bntrans-translation]"
    );
    if (
      !original ||
      !translation ||
      !sourceLanguage ||
      !targetLanguage ||
      translation.classList.contains("bt-loading-indicator") ||
      !translation.textContent.trim() ||
      !safe(wrapper, original)
    )
      return;
    const text = toMarkdown(original.childNodes);
    if (!text.trim() || text.length > 12000) return;
    const host = node("span");
    host.setAttribute("data-bntrans-correction-control", "true");
    host.setAttribute("translate", "no");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = node("style");
    style.textContent =
      ":host{display:inline-block;margin:2px 6px;font:13px/1.5 system-ui;color:#203040}button{font:inherit;border:1px solid #bbcad4;border-radius:5px;background:#f5f9fc;color:#203040;padding:3px 8px;margin:2px;cursor:pointer}section{display:block;max-width:480px;padding:10px;border:1px solid #bbcad4;border-radius:8px;background:#f5f9fc}textarea{display:block;box-sizing:border-box;width:100%;min-height:90px;font:inherit;padding:7px;border:1px solid #bbcad4;border-radius:5px}p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}small{display:block}";
    shadow.append(style);
    const lineage = [];
    for (let el = wrapper; el; el = el.parentNode)
      lineage.push([el, el.parentNode]);
    const sourceNodes = [];
    const walker = document.createTreeWalker(original, NodeFilter.SHOW_ALL);
    while (walker.nextNode())
      sourceNodes.push([walker.currentNode, walker.currentNode.parentNode]);
    const record = {
      wrapper,
      original,
      translation,
      host,
      text,
      sourceLanguage,
      targetLanguage,
      parent: wrapper.parentNode,
      originalNext: original.nextSibling,
      originalHtml: original.innerHTML,
      expected: translation.innerHTML,
      previous: [...translation.childNodes],
      lineage,
      sourceNodes,
      translatedNodes: [...translation.childNodes],
      generation,
      token: crypto.randomUUID(),
      applied: false
    };
    const status = node("p");
    status.setAttribute("role", "status");
    function button(label, callback, parent = shadow) {
      const el = node("button", label);
      el.type = "button";
      el.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        el.disabled = true;
        try {
          await callback();
        } catch (error) {
          status.textContent = error.message;
        } finally {
          el.disabled = false;
        }
      });
      parent.append(el);
      return el;
    }
    const editor = node("section");
    editor.hidden = true;
    editor.append(
      node(
        "small",
        `${location.hostname} · ${sourceLanguage} → ${targetLanguage}`
      ),
      node("p", original.textContent)
    );
    const input = node("textarea");
    input.maxLength = 12000;
    input.setAttribute(
      "aria-label",
      t("Corrected translation", "Bản dịch đã sửa")
    );
    editor.append(input);
    button(t("Edit translation", "Sửa bản dịch"), () => {
      current(record);
      record.token = crypto.randomUUID();
      input.value = translation.textContent;
      editor.hidden = false;
      input.focus();
    });
    button(
      t("Apply on page only", "Chỉ sửa trên trang"),
      () => {
        record.token = crypto.randomUUID();
        apply(record, input.value);
        status.textContent = t(
          "Preview only — not saved",
          "Chỉ xem trước — chưa lưu"
        );
      },
      editor
    );
    button(
      t("Save correction", "Lưu cách sửa"),
      async () => {
        current(record);
        const value = input.value;
        const token = record.token;
        if (!value.trim() || value.length > 12000)
          throw new Error("correction-invalid-text");
        const result = await chrome.runtime.sendMessage({
          type: "labs-corrections",
          payload: {
            command: "save",
            explicitSave: true,
            token: record.token,
            url: pageUrl,
            entry: {
              text: record.text,
              translation: value,
              sourceLanguage: record.sourceLanguage,
              targetLanguage: record.targetLanguage
            }
          }
        });
        current(record);
        if (record.token !== token) throw new Error("correction-cancelled");
        if (!result?.ok)
          throw new Error(result?.error || "correction-save-failed");
        apply(record, value);
        status.textContent = t(
          "Saved locally for this exact site and language pair",
          "Đã lưu cục bộ, chỉ dùng đúng website và cặp ngôn ngữ này"
        );
      },
      editor
    );
    button(
      t("Cancel", "Hủy"),
      () => {
        record.token = crypto.randomUUID();
        restore(record);
        editor.hidden = true;
        status.textContent = "";
      },
      editor
    );
    button(
      t("Restore translation", "Khôi phục bản dịch"),
      () => {
        current(record);
        record.token = crypto.randomUUID();
        restore(record);
        editor.hidden = true;
      },
      editor
    );
    editor.append(status);
    shadow.append(editor);
    records.set(wrapper, record);
    wrapper.append(host);
  }
  function scan() {
    if (!active) return;
    if (location.href !== pageUrl) {
      stop();
      return;
    }
    for (const record of records.values()) if (!valid(record)) remove(record);
    for (const wrapper of document.querySelectorAll("[data-bntrans-wrapper]")) {
      if (records.size >= 40) break;
      if (!records.has(wrapper)) attach(wrapper);
    }
  }
  async function command(payload) {
    if (payload?.command === "stop") {
      stop();
      return { ok: true };
    }
    if (payload?.command === "validate-save") {
      const record = [...records.values()].find(
        (item) => item.token === payload.token
      );
      const { translatorSettings: latest } =
        await chrome.storage.local.get("translatorSettings");
      return {
        ok:
          !!record &&
          payload.url === pageUrl &&
          latest?.enabled !== false &&
          latest?.labFeatures?.corrections === true &&
          valid(record)
      };
    }
    if (payload?.command !== "start") throw new Error("correction-command");
    stop();
    const token = generation;
    const { translatorSettings } =
      await chrome.storage.local.get("translatorSettings");
    if (
      disposed ||
      token !== generation ||
      translatorSettings?.enabled === false ||
      translatorSettings?.labFeatures?.corrections !== true
    )
      throw new Error("correction-disabled");
    settings = translatorSettings;
    if (payload.url !== location.href) throw new Error("correction-stale");
    active = true;
    pageUrl = location.href;
    scan();
    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      attributes: true,
      subtree: true
    });
    timer = setInterval(() => {
      if (location.href !== pageUrl) stop();
    }, 300);
    return { ok: true, count: records.size, url: pageUrl };
  }
  const onMessage = (message, sender, respond) => {
    if (
      message?.type !== "labs-corrections-page" ||
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    )
      return false;
    command(message.payload)
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes.translatorSettings) stop();
  };
  const dispose = () => {
    stop();
    disposed = true;
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
    window.removeEventListener("popstate", stop);
    window.removeEventListener("hashchange", stop);
    window.removeEventListener("pagehide", dispose);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  window.addEventListener("popstate", stop);
  window.addEventListener("hashchange", stop);
  window.addEventListener("pagehide", dispose, { once: true });
})();
