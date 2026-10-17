import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "../extension/src/experimental/ocr.js";

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.checked = false;
  }
  set innerHTML(_) {
    throw new Error("Unsafe HTML API");
  }
  append(...elements) {
    for (const child of elements) {
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this
      );
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }
  removeEventListener(name, callback) {
    if (this.listeners.get(name) === callback) this.listeners.delete(name);
  }
  async fire(name, payload = {}) {
    if (!this.disabled || ["pointercancel"].includes(name))
      return this.listeners.get(name)?.(payload);
  }
}

class Canvas extends Element {
  constructor(doc) {
    super("canvas", doc);
    this.w = this.h = 0;
    this.data = new Uint8ClampedArray();
  }
  set width(value) {
    this.w = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get width() {
    return this.w;
  }
  set height(value) {
    this.h = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height() {
    return this.h;
  }
  getContext() {
    return {
      drawImage: (source, ...args) => {
        const [sx, sy, sw, sh, dx, dy] =
          args.length === 2
            ? [0, 0, source.width, source.height, ...args]
            : args;
        for (let y = 0; y < sh; y++)
          for (let x = 0; x < sw; x++) {
            this.data.set(
              source.data.slice(
                ((y + sy) * source.width + x + sx) * 4,
                ((y + sy) * source.width + x + sx) * 4 + 4
              ),
              ((y + dy) * this.width + x + dx) * 4
            );
          }
      },
      getImageData: (sx, sy, width, height) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            data.set(
              this.data.slice(
                ((y + sy) * this.width + x + sx) * 4,
                ((y + sy) * this.width + x + sx) * 4 + 4
              ),
              (y * width + x) * 4
            );
          }
        return { width, height, data };
      },
      putImageData: (image, dx, dy) => {
        for (let y = 0; y < image.height; y++)
          for (let x = 0; x < image.width; x++) {
            this.data.set(
              image.data.slice(
                (y * image.width + x) * 4,
                (y * image.width + x) * 4 + 4
              ),
              ((y + dy) * this.width + x + dx) * 4
            );
          }
      }
    };
  }
  // For mock DOM tests only: serialize pixel bytes directly so exact redaction can be asserted.
  toBlob(callback) {
    callback(new Blob([this.data]));
  }
  getBoundingClientRect() {
    return {
      left: 10,
      top: 20,
      width: this.width / 2,
      height: this.height / 2
    };
  }
  setPointerCapture() {}
}

const all = (element) => [element, ...element.children.flatMap(all)];
const synthetic = () => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 4);
  view.setUint32(20, 4);
  return new Blob([bytes]);
};
async function setup({ enabled = true, recognize, translate, decode } = {}) {
  const doc = {
    createElement: (tag) =>
      tag === "canvas" ? new Canvas(doc) : new Element(tag, doc)
  };
  const container = new Element("main", doc);
  const calls = {
    ocr: [],
    translation: [],
    terminated: 0,
    decoded: 0,
    closed: 0
  };
  const api = {
    t: (en) => en,
    settings: async () => ({ labFeatures: { ocr: enabled } }),
    translate: async (...args) => {
      calls.translation.push(args);
      return translate ? translate(...args) : "Xin chào";
    },
    activeTab: () => ({ id: 123, url: "https://synthetic.example/" }),
    send: () => {
      throw new Error("No image/backend send allowed");
    },
    set: () => {
      throw new Error("No persistence allowed");
    }
  };
  const cleanup = await mount(container, api, {
    createImageBitmap: async (...args) => {
      calls.decoded++;
      if (decode) return decode(...args);
      const data = new Uint8ClampedArray(64);
      for (let i = 0; i < 64; i += 4) data.set([i + 1, 99, 77, 255], i);
      return {
        width: 4,
        height: 4,
        data,
        close: () => {
          calls.closed++;
        }
      };
    },
    createEngine: () => ({
      recognize: async (bytes) => {
        calls.ocr.push(bytes);
        return recognize ? recognize(bytes) : "<script>HELLO</script>";
      },
      terminate: () => {
        calls.terminated++;
      }
    })
  });
  const elements = all(container);
  const input = elements.find((element) => element.type === "file");
  const canvas = elements.find((element) => element.tagName === "CANVAS");
  const numbers = elements.filter((element) => element.type === "number");
  const select = elements.filter((element) => element.tagName === "SELECT");
  const check = elements.filter((element) => element.type === "checkbox");
  const text = elements.find((element) => element.tagName === "TEXTAREA");
  const output = elements.find((element) => element.tagName === "PRE");
  const button = (prefix) =>
    elements.find(
      (element) =>
        element.tagName === "BUTTON" && element.textContent.startsWith(prefix)
    );
  return {
    container,
    elements,
    input,
    canvas,
    numbers,
    select,
    check,
    text,
    output,
    button,
    calls,
    cleanup,
    async upload(file = synthetic()) {
      input.files = [file];
      await input.fire("change");
    },
    async rect(x, y, width, height) {
      [x, y, width, height].forEach((value, i) => {
        numbers[i].value = String(value);
      });
      await button("Apply").fire("click");
    }
  };
}

test("feature flag is off by default; no image controls/worker when disabled", async () => {
  const ui = await setup({ enabled: false });
  assert.equal(ui.input, undefined);
  assert.equal(ui.calls.ocr.length, 0);
  assert.equal(ui.calls.decoded, 0);
  ui.cleanup();
  assert.equal(ui.container.children.length, 0);
});

test("upload + opaque mask preview before confirmation; only consented edited text translated", async () => {
  const ui = await setup();
  await ui.upload();
  assert.equal(ui.calls.closed, 1);
  assert.equal(ui.calls.ocr.length, 0);
  assert.equal(ui.calls.translation.length, 0);
  await ui.rect(1, 1, 2, 2);
  assert.deepEqual(
    [...ui.canvas.data.slice(20, 28)],
    [0, 0, 0, 255, 0, 0, 0, 255]
  );
  assert.equal(ui.calls.ocr.length, 0);
  await ui.button("Confirm").fire("click");
  assert.equal(ui.calls.ocr.length, 1);
  assert.deepEqual([...ui.calls.ocr[0]], [...ui.canvas.data]);
  assert.equal(ui.calls.translation.length, 0);
  assert.equal(ui.text.value, "<script>HELLO</script>");
  assert.equal(ui.check[0].checked, true, "local-only default");
  ui.text.value = "reviewed synthetic text";
  await ui.text.fire("input");
  assert(ui.button("Translate").disabled);
  ui.check[1].checked = true;
  await ui.check[1].fire("change");
  await ui.button("Translate").fire("click");
  assert.deepEqual(ui.calls.translation, [
    [
      "reviewed synthetic text",
      {
        sourceLanguage: "en",
        ephemeral: true,
        siteUrl: "https://synthetic.example/",
        privacyPolicy: "local-only",
        cloudConsent: false,
        skipHistory: true
      }
    ]
  ]);
  assert.equal(ui.output.textContent, "Xin chào");
  ui.check[0].checked = false;
  await ui.check[0].fire("change");
  assert.equal(
    ui.check[1].checked,
    false,
    "Policy change requires fresh consent"
  );
  await ui.button("Translate").fire("click");
  assert.equal(ui.calls.translation.length, 1);
  ui.check[1].checked = true;
  await ui.check[1].fire("change");
  await ui.button("Translate").fire("click");
  assert.deepEqual(ui.calls.translation[1], [
    "reviewed synthetic text",
    {
      sourceLanguage: "en",
      ephemeral: true,
      siteUrl: "https://synthetic.example/",
      privacyPolicy: undefined,
      cloudConsent: true,
      skipHistory: true
    }
  ]);
  ui.text.value = "new synthetic text";
  await ui.text.fire("input");
  assert.equal(
    ui.check[1].checked,
    false,
    "Text change requires fresh consent"
  );
  await ui.button("Translate").fire("click");
  assert.equal(ui.calls.translation.length, 2);
  ui.cleanup();
});

test("crop destroys outside pixels and pointer mask maps DPR correctly", async () => {
  const ui = await setup();
  await ui.upload();
  const original = ui.canvas.data.slice();
  ui.select[1].value = "crop";
  await ui.rect(1, 1, 2, 2);
  assert.equal(ui.canvas.width, 2);
  assert.equal(ui.canvas.height, 2);
  assert.deepEqual(
    [...ui.canvas.data.slice(0, 8)],
    [...original.slice(20, 28)]
  );
  ui.select[1].value = "mask";
  await ui.canvas.fire("pointerdown", {
    button: 0,
    clientX: 10,
    clientY: 20,
    pointerId: 1,
    preventDefault() {}
  });
  await ui.canvas.fire("pointerup", {
    clientX: 10.5,
    clientY: 20.5,
    pointerId: 1
  });
  assert.deepEqual([...ui.canvas.data.slice(0, 4)], [0, 0, 0, 255]);
  await ui.button("Confirm").fire("click");
  assert.equal(
    ui.calls.ocr[0].length,
    16,
    "Only cropped 2x2 RGBA reaches mock OCR"
  );
  ui.cleanup();
});

test("oversized files/dimensions fail before decode; unsupported language never starts OCR", async () => {
  const ui = await setup();
  await ui.upload({
    size: 9 * 1024 * 1024,
    arrayBuffer: () => {
      throw new Error("Must not read");
    }
  });
  assert.equal(ui.calls.decoded, 0);
  const bytes = new Uint8Array(await synthetic().arrayBuffer());
  new DataView(bytes.buffer).setUint32(16, 9000);
  await ui.upload(new Blob([bytes]));
  assert.equal(ui.calls.decoded, 0);
  await ui.upload();
  ui.select[0].value = "vie";
  await ui.select[0].fire("change");
  assert(ui.button("Confirm").disabled);
  assert(
    all(ui.container).some((element) =>
      element.textContent.includes("supports English only")
    )
  );
  assert.equal(ui.calls.ocr.length, 0);
  ui.cleanup();
});

test("cancel/unmount terminates OCR and drops late results; clears pixel memory/listeners", async () => {
  let resolve;
  const ui = await setup({
    recognize: () =>
      new Promise((done) => {
        resolve = done;
      })
  });
  await ui.upload();
  const running = ui.button("Confirm").fire("click");
  while (!resolve) await new Promise((done) => setImmediate(done));
  await ui.button("Cancel").fire("click");
  assert.equal(ui.canvas.width, 0);
  assert.equal(ui.calls.terminated, 1);
  resolve("late OCR must not appear");
  await running;
  assert.equal(ui.text.value, "");
  assert.equal(ui.calls.translation.length, 0);
  ui.cleanup();
  assert(ui.elements.every((element) => element.listeners.size === 0));
  assert.equal(ui.container.children.length, 0);
});

test("unmount during bitmap decode closes late bitmap without touching DOM", async () => {
  let resolve;
  let closed = 0;
  const ui = await setup({
    decode: () =>
      new Promise((done) => {
        resolve = done;
      })
  });
  const loading = ui.upload();
  while (!resolve) await new Promise((done) => setImmediate(done));
  ui.cleanup();
  resolve({
    width: 4,
    height: 4,
    close: () => {
      closed++;
    }
  });
  await loading;
  assert.equal(closed, 1);
  assert.equal(ui.canvas.width, 0);
  assert.equal(ui.container.children.length, 0);
});

test("OCR failure stays local, and changing pixels invalidates consent/text", async () => {
  const failed = await setup({
    recognize: async () => {
      throw new Error("synthetic engine failure");
    }
  });
  await failed.upload();
  await failed.button("Confirm").fire("click");
  assert.equal(failed.text.value, "");
  assert.equal(failed.calls.translation.length, 0);
  assert(
    all(failed.container).some((element) =>
      element.textContent.includes("no cloud fallback occurred")
    )
  );
  failed.cleanup();
  const ui = await setup();
  await ui.upload();
  await ui.button("Confirm").fire("click");
  ui.check[1].checked = true;
  await ui.check[1].fire("change");
  await ui.rect(0, 0, 1, 1);
  assert.equal(ui.text.value, "");
  assert.equal(ui.check[1].checked, false);
  assert(ui.button("Translate").disabled);
  ui.cleanup();
});
