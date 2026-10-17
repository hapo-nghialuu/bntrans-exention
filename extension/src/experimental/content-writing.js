(() => {
  if (window.top !== window || globalThis.__bntransWritingInstalled) return;
  globalThis.__bntransWritingInstalled = true;

  const MAX_TEXT = 12000;
  const TTL = 10 * 60 * 1000;
  let snapshot = null;
  let undo = null;
  let serial = 0;
  let epoch = 0;

  function fail(code) {
    throw new Error(code);
  }

  function sensitive(element) {
    for (let node = element; node?.getAttribute; node = node.parentElement) {
      if (
        node.tagName === "INPUT" &&
        node.type !== "text" &&
        node.type !== "search"
      ) {
        return true;
      }
      const autocomplete = (
        node.getAttribute("autocomplete") || ""
      ).toLowerCase();
      if (
        /(?:^|\s)(?:cc-\S+|username|current-password|new-password|one-time-code|webauthn)(?:\s|$)/.test(
          autocomplete
        )
      )
        return true;
      const description = ["name", "id", "placeholder", "aria-label"]
        .map((key) => node.getAttribute(key) || "")
        .concat(Array.from(node.labels || [], (label) => label.textContent))
        .join(" ");
      if (
        /(?:password|passcode|credential|credit.?card|card.?number|card.?holder|\bcard\b|\bcc(?:num|n)?\b|\bpan\b|payment|security.?code|\bcvv\b|\bcvc\b|\botp\b|\bssn\b|\biban\b|api.?key|access.?token|secret|user.?name|login)/i.test(
          description
        )
      )
        return true;
    }
    return false;
  }

  function capture() {
    const element = document.activeElement;
    if (sensitive(element)) fail("SENSITIVE_FIELD");
    let result;
    if (element && ["INPUT", "TEXTAREA"].includes(element.tagName)) {
      if (element.readOnly || element.disabled) fail("READ_ONLY");
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end))
        fail("UNSUPPORTED_FIELD");
      const from = start === end ? 0 : start;
      const to = start === end ? element.value.length : end;
      result = {
        kind: "input",
        element,
        value: element.value,
        from,
        to,
        selection: {
          start,
          end,
          direction: element.selectionDirection || "none"
        },
        text: element.value.slice(from, to),
        editable: true
      };
    } else {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed)
        fail("NO_SELECTION");
      const range = selection.getRangeAt(0).cloneRange();
      const startElement =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      const endElement =
        range.endContainer.nodeType === 1
          ? range.endContainer
          : range.endContainer.parentElement;
      if (sensitive(startElement) || sensitive(endElement))
        fail("SENSITIVE_FIELD");
      const editor = startElement?.closest("[contenteditable]");
      if (editor?.isContentEditable) {
        if (
          editor.childNodes.length !== 1 ||
          editor.firstChild.nodeType !== 3 ||
          range.startContainer !== editor.firstChild ||
          range.endContainer !== editor.firstChild
        )
          fail("RICH_TEXT_UNSUPPORTED");
        result = {
          kind: "contenteditable",
          element: editor,
          node: editor.firstChild,
          value: editor.textContent,
          from: range.startOffset,
          to: range.endOffset,
          backward:
            selection.anchorNode === range.startContainer &&
            selection.anchorOffset === range.endOffset &&
            selection.focusOffset === range.startOffset,
          range,
          text: range.toString(),
          editable: true
        };
      } else {
        result = {
          kind: "selection",
          range,
          text: range.toString(),
          editable: false
        };
      }
    }
    if (!result.text.trim()) fail("EMPTY_TEXT");
    if (result.text.length > MAX_TEXT) fail("TEXT_TOO_LONG");
    result.serial = ++serial;
    result.id = `${Date.now()}-${result.serial}`;
    result.created = Date.now();
    return result;
  }

  function valid(state, expected) {
    if (!state || Date.now() - state.created > TTL) fail("SNAPSHOT_EXPIRED");
    const element = state.element;
    if (!element?.isConnected) fail("TARGET_DISCONNECTED");
    if (sensitive(element)) fail("SENSITIVE_FIELD");
    if (state.kind === "input") {
      if (element.readOnly || element.disabled) fail("READ_ONLY");
      if (element.value !== expected) fail("TARGET_CHANGED");
    } else {
      if (
        !element.isContentEditable ||
        element.childNodes.length !== 1 ||
        element.firstChild !== state.node ||
        !state.node.isConnected ||
        state.node.data !== expected
      )
        fail("TARGET_CHANGED");
    }
  }

  function notify(element) {
    element.dispatchEvent(
      new Event("input", { bubbles: true, composed: true })
    );
  }

  function apply(id, text) {
    const state = snapshot;
    if (!state || state.id !== id) fail("SNAPSHOT_MISMATCH");
    if (!state.editable) fail("READ_ONLY_SELECTION");
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT)
      fail("INVALID_TEXT");
    valid(state, state.value);
    const applied =
      state.value.slice(0, state.from) + text + state.value.slice(state.to);
    const element = state.element;
    element.focus({ preventScroll: true });
    // Focus handlers may synchronously change a controlled field.
    valid(state, state.value);
    if (state.kind === "input") {
      element.setRangeText(text, state.from, state.to, "select");
    } else {
      state.node.replaceData(state.from, state.to - state.from, text);
      const range = document.createRange();
      range.setStart(state.node, state.from);
      range.setEnd(state.node, state.from + text.length);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
    undo = { ...state, applied };
    snapshot = null;
    notify(element);
    return { ok: true, id, text, editable: true, kind: state.kind };
  }

  function restore(id) {
    const state = undo;
    if (!state || state.id !== id) fail("UNDO_UNAVAILABLE");
    valid(state, state.applied);
    state.element.focus({ preventScroll: true });
    valid(state, state.applied);
    if (state.kind === "input") {
      state.element.setRangeText(
        state.value,
        0,
        state.applied.length,
        "preserve"
      );
      state.element.setSelectionRange(
        state.selection.start,
        state.selection.end,
        state.selection.direction
      );
    } else {
      state.node.replaceData(0, state.node.length, state.value);
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(state.node, state.from);
      range.setEnd(state.node, state.to);
      selection.removeAllRanges();
      if (state.backward && selection.setBaseAndExtent) {
        selection.setBaseAndExtent(
          state.node,
          state.to,
          state.node,
          state.from
        );
      } else selection.addRange(range);
    }
    undo = null;
    notify(state.element);
    return { ok: true, id, text: state.text, kind: state.kind, editable: true };
  }

  function onMessage(message, sender, respond) {
    if (message?.type !== "labs-writing-command") return;
    if (sender.id !== chrome.runtime.id || sender.tab) {
      respond({ ok: false, error: "UNTRUSTED_SENDER" });
      return;
    }
    let pending;
    const requestEpoch = epoch;
    try {
      // Snapshot before the asynchronous settings read, never after it.
      if (message.command === "capture") pending = capture();
    } catch (error) {
      respond({ ok: false, error: error.message });
      return;
    }
    chrome.storage.local
      .get("translatorSettings")
      .then(({ translatorSettings }) => {
        if (
          requestEpoch !== epoch ||
          translatorSettings?.labFeatures?.writing !== true
        )
          fail("WRITING_DISABLED");
        if (pending) {
          if (pending.serial !== serial) fail("CAPTURE_SUPERSEDED");
          if (pending.editable) valid(pending, pending.value);
          else if (
            !pending.range.startContainer.isConnected ||
            !pending.range.endContainer.isConnected ||
            pending.range.toString() !== pending.text
          )
            fail("TARGET_CHANGED");
          snapshot = pending;
          undo = null;
          return {
            ok: true,
            id: pending.id,
            text: pending.text,
            editable: pending.editable,
            kind: pending.kind
          };
        }
        if (message.command === "apply") return apply(message.id, message.text);
        if (message.command === "undo") return restore(message.id);
        fail("UNKNOWN_COMMAND");
      })
      .then(respond)
      .catch((error) =>
        respond({ ok: false, error: error.message || "WRITING_FAILED" })
      );
    return true;
  }

  function onSettings(changes, area) {
    if (
      area === "local" &&
      changes.translatorSettings &&
      changes.translatorSettings.newValue?.labFeatures?.writing !== true
    ) {
      snapshot = null;
      undo = null;
      epoch++;
    }
  }

  function cleanup() {
    snapshot = null;
    undo = null;
    epoch++;
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onSettings);
    window.removeEventListener("pagehide", cleanup);
    delete globalThis.__bntransWritingInstalled;
  }
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onSettings);
  window.addEventListener("pagehide", cleanup);
})();
