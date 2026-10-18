import { readSettings } from "../common/settings-storage.js";
import { inspectImage } from "./ocr-utils.js";
import { IMAGE_LIMITS, screenshotCrop } from "./image-translation-utils.js";

function pngBytes(dataUrl, maxBytes) {
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:image/png;base64,") ||
    dataUrl.length > Math.ceil((maxBytes * 4) / 3) + 64
  )
    throw new Error("image-capture-format");
  const binary = atob(dataUrl.slice("data:image/png;base64,".length));
  if (binary.length > maxBytes) throw new Error("image-limit");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (inspectImage(bytes).mime !== "image/png")
    throw new Error("image-capture-format");
  return bytes;
}

function toDataUrl(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:image/png;base64,${btoa(value)}`;
}

export function registerImageHandlers({
  chromeApi = globalThis.chrome,
  settings = readSettings,
  createBitmap = globalThis.createImageBitmap,
  Canvas = globalThis.OffscreenCanvas
} = {}) {
  let epoch = 0,
    closed = false,
    capturing = false;
  const invalidate = () => {
    epoch++;
  };
  const onStorage = (changes, area) => {
    if (area === "local" && changes.translatorSettings) invalidate();
  };
  const onUpdated = (_id, changes) => {
    if (changes.url || changes.status === "loading") invalidate();
  };
  const listeners = [
    [chromeApi.storage.onChanged, onStorage],
    [chromeApi.tabs.onActivated, invalidate],
    [chromeApi.tabs.onUpdated, onUpdated],
    [chromeApi.tabs.onRemoved, invalidate],
    [chromeApi.windows.onFocusChanged, invalidate]
  ];
  for (const [event, listener] of listeners) event.addListener(listener);
  async function capture(payload, sender) {
    if (closed || capturing) throw new Error("image-capture-busy");
    if (
      sender.id !== chromeApi.runtime.id ||
      sender.tab ||
      !sender.url?.startsWith(chromeApi.runtime.getURL("pages/"))
    )
      throw new Error("image-sender");
    if (
      !Number.isInteger(payload?.tabId) ||
      !Number.isInteger(payload.windowId) ||
      typeof payload.url !== "string" ||
      !/^(https?|file):/i.test(payload.url) ||
      typeof payload.imageId !== "string"
    )
      throw new Error("image-target");
    const token = epoch;
    const assertTarget = async () => {
      const config = await settings();
      if (config.enabled === false || config.labFeatures?.image !== true)
        throw new Error("image-disabled");
      const tab = await chromeApi.tabs.get(payload.tabId);
      const win = await chromeApi.windows.get(payload.windowId);
      const active = await chromeApi.tabs.query({
        active: true,
        windowId: payload.windowId
      });
      if (closed || token !== epoch) throw new Error("image-cancelled");
      if (
        !tab.active ||
        tab.windowId !== payload.windowId ||
        tab.url !== payload.url ||
        !win.focused ||
        win.id !== payload.windowId ||
        active.length !== 1 ||
        active[0].id !== payload.tabId ||
        active[0].url !== payload.url
      )
        throw new Error("image-tab-not-active");
    };
    const validate = async () => {
      const response = await chromeApi.tabs.sendMessage(
        payload.tabId,
        {
          type: "labs-image-source",
          payload: { command: "validate", id: payload.imageId }
        },
        { frameId: 0 }
      );
      if (
        !response?.ok ||
        response.source?.id !== payload.imageId ||
        response.source.url !== payload.url
      )
        throw new Error(response?.error || "image-stale");
      return response.source;
    };
    capturing = true;
    let bitmap;
    try {
      await assertTarget();
      const source = await validate();
      await assertTarget();
      const screenshot = await chromeApi.tabs.captureVisibleTab(
        payload.windowId,
        { format: "png" }
      );
      await assertTarget();
      const next = await validate();
      if (JSON.stringify(next) !== JSON.stringify(source))
        throw new Error("image-stale");
      const bytes = pngBytes(screenshot, 8 * 1024 * 1024);
      const dimensions = inspectImage(bytes);
      const crop = screenshotCrop(source, dimensions.width, dimensions.height);
      if (typeof createBitmap !== "function" || typeof Canvas !== "function")
        throw new Error("image-capture-capability");
      bitmap = await createBitmap(new Blob([bytes], { type: "image/png" }));
      if (
        bitmap.width !== dimensions.width ||
        bitmap.height !== dimensions.height
      )
        throw new Error("image-capture-format");
      const canvas = new Canvas(crop.width, crop.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("image-capture-capability");
      context.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height
      );
      const blob = await canvas.convertToBlob({ type: "image/png" });
      if (blob.size > IMAGE_LIMITS.bytes) throw new Error("image-limit");
      const result = new Uint8Array(await blob.arrayBuffer());
      const checked = inspectImage(result);
      if (checked.width !== crop.width || checked.height !== crop.height)
        throw new Error("image-capture-format");
      await assertTarget();
      if (JSON.stringify(await validate()) !== JSON.stringify(source))
        throw new Error("image-stale");
      await assertTarget();
      return {
        ok: true,
        dataUrl: toDataUrl(result),
        width: crop.width,
        height: crop.height,
        region: crop.region
      };
    } finally {
      bitmap?.close();
      capturing = false;
    }
  }
  const onMessage = (message, sender, respond) => {
    if (message?.type !== "labs-image-capture") return false;
    capture(message.payload, sender)
      .then(respond)
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  };
  chromeApi.runtime.onMessage.addListener(onMessage);
  return () => {
    closed = true;
    invalidate();
    chromeApi.runtime.onMessage.removeListener(onMessage);
    for (const [event, listener] of listeners) event.removeListener(listener);
  };
}
