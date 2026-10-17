import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../extension/src/experimental/content-writing.js", import.meta.url),
  "utf8"
);

function fixture({ enabled = true, deferred = false, top = true } = {}) {
  let messageListener;
  let settingsListener;
  let finishSettings;
  let setting = enabled;
  const events = [];
  const windowListeners = new Map();
  const field = {
    tagName: "TEXTAREA",
    type: "textarea",
    value: "Before hello friend after",
    selectionStart: 7,
    selectionEnd: 19,
    selectionDirection: "backward",
    isConnected: true,
    readOnly: false,
    disabled: false,
    attributes: {},
    labels: [],
    getAttribute(name) {
      return this.attributes[name] || null;
    },
    focus() {
      this.onFocus?.();
    },
    setRangeText(text, from, to) {
      this.value = this.value.slice(0, from) + text + this.value.slice(to);
    },
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    },
    dispatchEvent(event) {
      events.push(event.type);
      this.onInput?.();
    }
  };
  function makeRange(node, from, to) {
    return {
      startContainer: node,
      endContainer: node,
      startOffset: from,
      endOffset: to,
      cloneRange() {
        return makeRange(this.startContainer, this.startOffset, this.endOffset);
      },
      toString() {
        return this.startContainer.data.slice(this.startOffset, this.endOffset);
      },
      setStart(target, offset) {
        this.startContainer = target;
        this.startOffset = offset;
      },
      setEnd(target, offset) {
        this.endContainer = target;
        this.endOffset = offset;
      }
    };
  }
  const selection = {
    rangeCount: 0,
    isCollapsed: true,
    range: null,
    getRangeAt() {
      return this.range;
    },
    removeAllRanges() {
      this.rangeCount = 0;
    },
    addRange(range) {
      this.range = range;
      this.rangeCount = 1;
      this.isCollapsed = false;
    }
  };
  const document = {
    activeElement: field,
    createRange: () => makeRange(null, 0, 0)
  };
  const window = {
    getSelection: () => selection,
    addEventListener: (event, handler) => windowListeners.set(event, handler),
    removeEventListener: (event) => windowListeners.delete(event)
  };
  window.top = top ? window : {};
  const chrome = {
    runtime: {
      id: "extension-id",
      onMessage: {
        addListener: (handler) => {
          messageListener = handler;
        },
        removeListener: (handler) => {
          if (messageListener === handler) messageListener = null;
        }
      }
    },
    storage: {
      local: {
        get: async () => {
          if (deferred)
            await new Promise((resolve) => {
              finishSettings = resolve;
            });
          return { translatorSettings: { labFeatures: { writing: setting } } };
        }
      },
      onChanged: {
        addListener: (handler) => {
          settingsListener = handler;
        },
        removeListener: () => {
          settingsListener = null;
        }
      }
    }
  };
  const context = vm.createContext({
    window,
    document,
    chrome,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    }
  });
  vm.runInContext(source, context);
  function send(payload, sender = { id: "extension-id" }) {
    return new Promise((resolve) => {
      const pending = messageListener?.(
        { type: "labs-writing-command", ...payload },
        sender,
        resolve
      );
      if (!messageListener || (pending !== true && payload.type))
        resolve(undefined);
    });
  }
  function editable(text = "hello friend") {
    const editor = {
      tagName: "DIV",
      isConnected: true,
      isContentEditable: true,
      attributes: {},
      labels: [],
      getAttribute: field.getAttribute,
      focus: field.focus,
      dispatchEvent: field.dispatchEvent,
      get textContent() {
        return node.data;
      }
    };
    const node = {
      nodeType: 3,
      isConnected: true,
      data: text,
      parentElement: editor,
      get length() {
        return this.data.length;
      },
      replaceData(from, count, value) {
        this.data =
          this.data.slice(0, from) + value + this.data.slice(from + count);
      }
    };
    editor.firstChild = node;
    editor.childNodes = [node];
    editor.closest = () => editor;
    document.activeElement = editor;
    selection.addRange(makeRange(node, 0, text.length));
    return { editor, node };
  }
  return {
    field,
    send,
    events,
    document,
    window,
    selection,
    editable,
    makeRange,
    release: () => finishSettings?.(),
    setEnabled(value) {
      setting = value;
      settingsListener?.(
        {
          translatorSettings: { newValue: { labFeatures: { writing: value } } }
        },
        "local"
      );
    },
    cleanup: () => windowListeners.get("pagehide")?.(),
    get installed() {
      return !!messageListener;
    },
    reinstall() {
      vm.runInContext(source, context);
    }
  };
}

test("capture returns only selected text and apply/undo restores full value and selection", async () => {
  const f = fixture();
  const before = f.field.value;
  const captured = await f.send({ command: "capture" });
  assert.equal(captured.text, "hello friend");
  assert.equal(captured.editable, true);
  assert.equal(f.field.value, before, "capture never writes");
  const applied = await f.send({
    command: "apply",
    id: captured.id,
    text: "dear friend"
  });
  assert.equal(applied.ok, true);
  assert.equal(f.field.value, "Before dear friend after");
  const undone = await f.send({ command: "undo", id: captured.id });
  assert.equal(undone.ok, true);
  assert.equal(f.field.value, before);
  assert.equal(f.field.selectionStart, 7);
  assert.equal(f.field.selectionEnd, 19);
  assert.equal(f.field.selectionDirection, "backward");
  assert.deepEqual(f.events, ["input", "input"]);
  assert.equal(
    (await f.send({ command: "undo", id: captured.id })).error,
    "UNDO_UNAVAILABLE"
  );
});

test("collapsed input selection captures full field, preserves plain markup literally", async () => {
  const f = fixture();
  f.field.selectionStart = f.field.selectionEnd = 3;
  const captured = await f.send({ command: "capture" });
  assert.equal(captured.text, f.field.value);
  await f.send({
    command: "apply",
    id: captured.id,
    text: '<script>alert(1)</script>\n& "quoted"'
  });
  assert.equal(f.field.value, '<script>alert(1)</script>\n& "quoted"');
  await f.send({ command: "undo", id: captured.id });
  assert.equal(f.field.selectionStart, 3);
  assert.equal(f.field.selectionEnd, 3);
});

for (const [name, setup] of [
  [
    "password",
    (field) => {
      field.tagName = "INPUT";
      field.type = "password";
    }
  ],
  [
    "autocomplete credit card",
    (field) => {
      field.attributes.autocomplete = "section-pay billing cc-number";
    }
  ],
  [
    "autocomplete credential",
    (field) => {
      field.attributes.autocomplete = "username webauthn";
    }
  ],
  [
    "autocomplete OTP",
    (field) => {
      field.attributes.autocomplete = "one-time-code";
    }
  ],
  [
    "label password",
    (field) => {
      field.labels = [{ textContent: "New password" }];
    }
  ],
  [
    "ancestor payment",
    (field) => {
      field.parentElement = {
        getAttribute: (key) =>
          key === "aria-label" ? "credit card details" : null
      };
    }
  ],
  [
    "token name",
    (field) => {
      field.attributes.name = "accessToken";
    }
  ]
]) {
  test(`capture denies ${name} without returning text`, async () => {
    const f = fixture();
    setup(f.field);
    const response = await f.send({ command: "capture" });
    assert.equal(response.error, "SENSITIVE_FIELD");
    assert.equal(response.text, undefined);
    assert.deepEqual(f.events, []);
  });
}

test("feature default off and trusted extension sender are required", async () => {
  const f = fixture({ enabled: false });
  assert.equal(
    (await f.send({ command: "capture" })).error,
    "WRITING_DISABLED"
  );
  assert.equal(
    (await f.send({ command: "capture" }, { id: "other-extension" })).error,
    "UNTRUSTED_SENDER"
  );
  assert.equal(
    (
      await f.send(
        { command: "capture" },
        { id: "extension-id", tab: { id: 2 } }
      )
    ).error,
    "UNTRUSTED_SENDER"
  );
});

test("capture snapshots before settings await and rejects intervening edits", async () => {
  const f = fixture({ deferred: true });
  const promise = f.send({ command: "capture" });
  f.field.value += " user typed";
  f.release();
  assert.equal((await promise).error, "TARGET_CHANGED");
});

test("capture selection offsets are snapshotted before settings await", async () => {
  const f = fixture({ deferred: true });
  const promise = f.send({ command: "capture" });
  f.field.selectionStart = 0;
  f.field.selectionEnd = 5;
  f.release();
  assert.equal((await promise).text, "hello friend");
});

test("apply never overwrites edits, disconnected targets, or changed sensitive fields", async () => {
  for (const [mutate, code] of [
    [
      (field) => {
        field.value += " new";
      },
      "TARGET_CHANGED"
    ],
    [
      (field) => {
        field.isConnected = false;
      },
      "TARGET_DISCONNECTED"
    ],
    [
      (field) => {
        field.attributes.autocomplete = "current-password";
      },
      "SENSITIVE_FIELD"
    ],
    [
      (field) => {
        field.readOnly = true;
      },
      "READ_ONLY"
    ]
  ]) {
    const f = fixture();
    const captured = await f.send({ command: "capture" });
    mutate(f.field);
    const before = f.field.value;
    assert.equal(
      (await f.send({ command: "apply", id: captured.id, text: "replacement" }))
        .error,
      code
    );
    assert.equal(f.field.value, before);
    assert.deepEqual(f.events, []);
  }
});

test("focus handlers cannot change a field just before apply/undo", async () => {
  const f = fixture();
  const captured = await f.send({ command: "capture" });
  f.field.onFocus = () => {
    f.field.value = "focus changed";
  };
  assert.equal(
    (await f.send({ command: "apply", id: captured.id, text: "replacement" }))
      .error,
    "TARGET_CHANGED"
  );
  assert.equal(f.field.value, "focus changed");
});

test("undo does not destroy user/framework edits after apply", async () => {
  const f = fixture();
  const captured = await f.send({ command: "capture" });
  await f.send({ command: "apply", id: captured.id, text: "replacement" });
  f.field.value += " typed later";
  const edited = f.field.value;
  assert.equal(
    (await f.send({ command: "undo", id: captured.id })).error,
    "TARGET_CHANGED"
  );
  assert.equal(f.field.value, edited);
});

test("apply rejects wrong id, blank, non-string, oversized text and replay", async () => {
  const f = fixture();
  const captured = await f.send({ command: "capture" });
  assert.equal(
    (await f.send({ command: "apply", id: "wrong", text: "new" })).error,
    "SNAPSHOT_MISMATCH"
  );
  for (const text of ["", "  ", 4, "a".repeat(12001)]) {
    assert.equal(
      (await f.send({ command: "apply", id: captured.id, text })).error,
      "INVALID_TEXT"
    );
  }
  assert.equal(
    (await f.send({ command: "apply", id: captured.id, text: "new" })).ok,
    true
  );
  assert.equal(
    (await f.send({ command: "apply", id: captured.id, text: "again" })).error,
    "SNAPSHOT_MISMATCH"
  );
});

test("new capture supersedes old id and disable invalidates both apply and undo", async () => {
  const f = fixture();
  const first = await f.send({ command: "capture" });
  const second = await f.send({ command: "capture" });
  assert.notEqual(first.id, second.id);
  assert.equal(
    (await f.send({ command: "apply", id: first.id, text: "new" })).error,
    "SNAPSHOT_MISMATCH"
  );
  await f.send({ command: "apply", id: second.id, text: "new" });
  f.setEnabled(false);
  f.setEnabled(true);
  assert.equal(
    (await f.send({ command: "undo", id: second.id })).error,
    "UNDO_UNAVAILABLE"
  );
});

test("single-node contenteditable applies safe plain text and restores original range", async () => {
  const f = fixture();
  const { node } = f.editable("hello friend");
  f.selection.range.startOffset = 6;
  const captured = await f.send({ command: "capture" });
  assert.equal(captured.text, "friend");
  await f.send({ command: "apply", id: captured.id, text: "<b>world</b>\n&" });
  assert.equal(node.data, "hello <b>world</b>\n&");
  assert.equal(f.selection.range.startOffset, 6);
  await f.send({ command: "undo", id: captured.id });
  assert.equal(node.data, "hello friend");
  assert.equal(f.selection.range.startOffset, 6);
  assert.equal(f.selection.range.endOffset, 12);
});

test("contenteditable Undo preserves backward selection when supported", async () => {
  const f = fixture();
  const { node } = f.editable("hello friend");
  f.selection.anchorNode = node;
  f.selection.anchorOffset = 12;
  f.selection.focusOffset = 0;
  let restored;
  f.selection.setBaseAndExtent = (...args) => {
    restored = args;
  };
  const captured = await f.send({ command: "capture" });
  await f.send({ command: "apply", id: captured.id, text: "new text" });
  await f.send({ command: "undo", id: captured.id });
  assert.deepEqual(restored, [node, 12, node, 0]);
});

test("feature disabled while settings are pending rejects capture without text", async () => {
  const f = fixture({ deferred: true });
  const response = f.send({ command: "capture" });
  f.setEnabled(false);
  f.release();
  const result = await response;
  assert.equal(result.error, "WRITING_DISABLED");
  assert.equal(result.text, undefined);
});

test("blank/oversized captures, unsupported input selections and unknown commands fail safely", async () => {
  const f = fixture();
  f.field.value = " ";
  f.field.selectionStart = f.field.selectionEnd = 0;
  assert.equal((await f.send({ command: "capture" })).error, "EMPTY_TEXT");
  f.field.value = "a".repeat(12001);
  assert.equal((await f.send({ command: "capture" })).error, "TEXT_TOO_LONG");
  f.field.selectionStart = null;
  assert.equal(
    (await f.send({ command: "capture" })).error,
    "UNSUPPORTED_FIELD"
  );
  assert.equal(
    (await f.send({ command: "invented-command" })).error,
    "UNKNOWN_COMMAND"
  );
});

test("contenteditable node replacement and rich markup are rejected", async () => {
  const f = fixture();
  const { editor, node } = f.editable();
  const captured = await f.send({ command: "capture" });
  editor.firstChild = { ...node };
  assert.equal(
    (await f.send({ command: "apply", id: captured.id, text: "new" })).error,
    "TARGET_CHANGED"
  );
  editor.childNodes.push({ nodeType: 1 });
  assert.equal(
    (await f.send({ command: "capture" })).error,
    "RICH_TEXT_UNSUPPORTED"
  );
});

test("ordinary connected page selection is preview-only", async () => {
  const f = fixture();
  const { editor, node } = f.editable();
  editor.isContentEditable = false;
  editor.closest = () => null;
  const captured = await f.send({ command: "capture" });
  assert.equal(captured.editable, false);
  assert.equal(captured.text, node.data);
  assert.equal(
    (await f.send({ command: "apply", id: captured.id, text: "new" })).error,
    "READ_ONLY_SELECTION"
  );
  assert.equal(node.data, "hello friend");
});

test("only installs once, top frame only, and releases message/settings listeners on pagehide", () => {
  const child = fixture({ top: false });
  assert.equal(child.installed, false);
  const f = fixture();
  f.reinstall();
  assert.equal(f.installed, true);
  f.cleanup();
  assert.equal(f.installed, false);
  f.reinstall();
  assert.equal(f.installed, true);
});
