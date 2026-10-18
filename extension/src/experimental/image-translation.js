import { createLocalEngine, maskPixels, pixelRect } from "./ocr-utils.js";
import {
  IMAGE_LIMITS,
  imageDimensions,
  cropRegion,
  createImageTranslationSession
} from "./image-translation-utils.js";
import { createReadingFeatureApi } from "./reading-feature-api.js";

export async function mount(container, api, dependencies = {}) {
  const doc = container.ownerDocument;
  const node = (tag, text = "", className = "") => {
    const el = doc.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const panel = node("section", "", "lab-panel");
  container.append(panel);
  const initial = await api.settings();
  if (initial.enabled === false || initial.labFeatures?.image !== true) {
    panel.append(
      node(
        "p",
        api.t(
          "Enable Image translation in Labs first.",
          "Bật Dịch ảnh trên trang trong Labs trước."
        )
      )
    );
    return () => panel.remove();
  }
  const feature = createReadingFeatureApi(api, "image");
  let alive = true,
    revision = 0,
    busy = false,
    enabled = true;
  let tab,
    source,
    region,
    session,
    lines = [],
    translated = [];
  const listeners = [];
  const on = (el, event, callback) => {
    el.addEventListener(event, callback);
    listeners.push(() => el.removeEventListener(event, callback));
  };
  const button = (en, vi) => {
    const el = node("button", api.t(en, vi));
    el.type = "button";
    return el;
  };
  panel.append(
    node("h2", api.t("Translate a visible image", "Dịch ảnh đang hiển thị"))
  );
  panel.append(
    node(
      "p",
      api.t(
        "English OCR only · PNG/JPEG · no handwriting guarantee. Choose a fully visible, unobscured image. The local preview uses visible pixels, not an image download. OCR stays on this device; only reviewed lines may be sent after separate consent. Nothing is saved.",
        "OCR chỉ tiếng Anh · PNG/JPEG · không đảm bảo chữ viết tay. Chọn ảnh hiện đầy đủ, không bị che. Preview local lấy pixel đang nhìn thấy, không tải lại ảnh. OCR chỉ trên máy; chỉ gửi các dòng đã kiểm sau đồng ý riêng. Không lưu nội dung."
      )
    )
  );
  const status = node("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const toolbar = node("div", "", "lab-toolbar");
  const choose = button("Activate tab & choose image", "Mở tab và chọn ảnh");
  const restore = button("Restore & clear", "Khôi phục và xóa");
  toolbar.append(choose, restore);
  const preview = node("div");
  preview.style.position = "relative";
  preview.style.width = "fit-content";
  preview.style.maxWidth = "100%";
  const canvas = node("canvas");
  canvas.width = canvas.height = 0;
  canvas.hidden = true;
  canvas.style.cssText = "display:block;max-width:100%;height:auto";
  canvas.setAttribute(
    "aria-label",
    api.t(
      "Local image preview with OCR boxes",
      "Preview ảnh local và các khung OCR"
    )
  );
  const boxes = node("div");
  boxes.style.cssText = "position:absolute;inset:0;pointer-events:none";
  boxes.setAttribute("aria-hidden", "true");
  preview.append(canvas, boxes);
  const coordinates = node("div", "", "lab-toolbar"),
    inputs = {};
  for (const [key, en, vi] of [
    ["x", "Left (preview px)", "Trái (px preview)"],
    ["y", "Top (preview px)", "Trên (px preview)"],
    ["width", "Width (preview px)", "Rộng (px preview)"],
    ["height", "Height (preview px)", "Cao (px preview)"]
  ]) {
    const input = node("input");
    input.type = "number";
    input.min = "0";
    input.max = String(IMAGE_LIMITS.dimension);
    input.step = "1";
    input.value = "0";
    inputs[key] = input;
    coordinates.append(api.field(api.t(en, vi), input));
  }
  const crop = button("Crop rectangle", "Cắt hình chữ nhật"),
    mask = button("Mask rectangle", "Che hình chữ nhật");
  coordinates.append(crop, mask);
  const run = button(
    "Confirm preview & run local OCR",
    "Xác nhận preview và chạy OCR local"
  );
  const edits = node("div");
  const localOnly = node("input");
  localOnly.type = "checkbox";
  const consent = node("input");
  consent.type = "checkbox";
  const translate = button("Translate reviewed lines", "Dịch các dòng đã kiểm");
  const show = button("Show translated", "Hiện bản dịch"),
    original = button("Show original", "Hiện ảnh gốc");
  const actions = node("div", "", "lab-toolbar");
  actions.append(translate, show, original);
  const result = node("div", "", "lab-result");
  panel.append(
    toolbar,
    status,
    preview,
    coordinates,
    run,
    edits,
    api.field(
      api.t("Local-only text provider", "Chỉ provider text local"),
      localOnly
    ),
    api.field(
      api.t(
        "I reviewed these lines and agree to send this text for translation (never the image).",
        "Tôi đã kiểm các dòng và đồng ý gửi text để dịch (không gửi ảnh)."
      ),
      consent
    ),
    actions,
    result
  );
  const update = () => {
    choose.disabled = !enabled || busy;
    run.disabled = !enabled || busy || !source || !canvas.width;
    crop.disabled = mask.disabled = run.disabled;
    for (const input of Object.values(inputs)) input.disabled = run.disabled;
    translate.disabled =
      !enabled ||
      busy ||
      !lines.length ||
      !consent.checked ||
      lines.some((line) => !line.text.trim());
    show.disabled = !enabled || busy || !translated.length;
    original.disabled = !enabled || busy || !source;
    consent.disabled = !enabled || busy || !lines.length;
    localOnly.disabled = !enabled || busy;
    for (const input of edits.querySelectorAll("textarea"))
      input.disabled = busy;
  };
  const sendSource = async (
    command,
    extra = {},
    target = tab,
    image = source
  ) => {
    if (!target) return;
    return api.sendToTab(
      "labs-image-source",
      { command, id: image?.id, ...extra },
      target.id
    );
  };
  const clearResults = () => {
    session?.destroy();
    session = null;
    lines = [];
    translated = [];
    consent.checked = false;
    edits.replaceChildren();
    boxes.replaceChildren();
    result.replaceChildren();
  };
  const clear = () => {
    revision++;
    busy = false;
    const previousTab = tab;
    clearResults();
    source = null;
    tab = null;
    region = null;
    canvas.width = canvas.height = 0;
    canvas.hidden = true;
    void feature.cancel();
    if (previousTab)
      void sendSource("restore", {}, previousTab).catch(() => {});
    update();
  };
  const ensure = async (token, checkImage = true) => {
    await feature.assertEnabled();
    if (!alive || token !== revision) throw new Error("image-cancelled");
    const current = await api.activeTab();
    if (!tab || current.id !== tab.id || current.url !== tab.url)
      throw new Error("image-stale");
    if (checkImage && source) await sendSource("check");
    if (!alive || token !== revision) throw new Error("image-cancelled");
  };
  const execute = async (action) => {
    if (busy || !enabled || !alive) return;
    busy = true;
    const token = revision;
    update();
    try {
      await action(token);
    } catch (error) {
      if (alive && token === revision) {
        consent.checked = false;
        translated = [];
        result.replaceChildren();
        void sendSource("original").catch(() => {});
        status.textContent =
          api.t(
            "Action stopped; check the image, active tab and privacy settings. No image was sent. Reason: ",
            "Đã dừng; kiểm tra ảnh, tab đang mở và privacy. Không gửi ảnh. Lý do: "
          ) + error.message;
      }
    } finally {
      if (alive && token === revision) {
        busy = false;
        update();
      }
    }
  };
  on(choose, "click", () => {
    if (busy) return;
    clear();
    void execute(async (token) => {
      await feature.assertEnabled();
      tab = await api.activeTab();
      await ensure(token, false);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      status.textContent = api.t(
        "Click a PNG/JPEG image in the activated tab. Esc cancels. Return here to review its local preview.",
        "Bấm ảnh PNG/JPEG ở tab vừa mở. Esc để hủy. Quay lại đây kiểm preview local."
      );
      const chosen = await sendSource("choose-image");
      await ensure(token, false);
      if (!chosen?.source || chosen.source.url !== tab.url)
        throw new Error("image-stale");
      source = chosen.source;
      const captured = await api.send("labs-image-capture", {
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        imageId: source.id
      });
      await ensure(token);
      imageDimensions(captured.width, captured.height);
      if (
        typeof captured.dataUrl !== "string" ||
        !captured.dataUrl.startsWith("data:image/png;base64,") ||
        captured.dataUrl.length > IMAGE_LIMITS.bytes * 1.4
      )
        throw new Error("image-limit");
      const binary = atob(captured.dataUrl.split(",")[1]);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const bitmap = await (
        dependencies.createBitmap || globalThis.createImageBitmap
      )(new Blob([bytes], { type: "image/png" }));
      try {
        await ensure(token);
        if (
          bitmap.width !== captured.width ||
          bitmap.height !== captured.height
        )
          throw new Error("image-geometry");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      region = captured.region;
      canvas.hidden = false;
      inputs.width.value = String(canvas.width);
      inputs.height.value = String(canvas.height);
      status.textContent = api.t(
        "Preview ready. Crop or mask sensitive parts, then explicitly confirm local OCR.",
        "Preview sẵn sàng. Cắt hoặc che phần nhạy cảm, rồi xác nhận chạy OCR local."
      );
    });
  });
  const editPreview = (masked) =>
    execute(async (token) => {
      await ensure(token);
      const values = Object.fromEntries(
        Object.entries(inputs).map(([key, input]) => [key, Number(input.value)])
      );
      if (
        !Object.values(values).every(Number.isFinite) ||
        values.width <= 0 ||
        values.height <= 0
      )
        throw new Error("empty-selection");
      const rect = pixelRect(
        { x: values.x, y: values.y },
        { x: values.x + values.width, y: values.y + values.height },
        canvas.width,
        canvas.height
      );
      clearResults();
      await sendSource("original");
      const ctx = canvas.getContext("2d", { alpha: false });
      if (masked) {
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        maskPixels(image, rect);
        ctx.putImageData(image, 0, 0);
      } else {
        const image = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
        region = cropRegion(region, rect, canvas.width, canvas.height);
        canvas.width = rect.width;
        canvas.height = rect.height;
        canvas.getContext("2d", { alpha: false }).putImageData(image, 0, 0);
      }
      inputs.x.value = inputs.y.value = "0";
      inputs.width.value = String(canvas.width);
      inputs.height.value = String(canvas.height);
      status.textContent = api.t(
        "Preview changed. OCR and translation consent were reset.",
        "Preview đã đổi. Đã xóa OCR và đồng ý dịch."
      );
    });
  on(crop, "click", () => {
    void editPreview(false);
  });
  on(mask, "click", () => {
    void editPreview(true);
  });
  on(run, "click", () => {
    void execute(async (token) => {
      await ensure(token);
      clearResults();
      await sendSource("original");
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("image-encode")),
          "image/png"
        )
      );
      if (blob.size > IMAGE_LIMITS.bytes) throw new Error("image-limit");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await ensure(token);
      const engine = (dependencies.createEngine || createLocalEngine)({
        baseUrl: chrome.runtime.getURL("assets/vendor/ocr/")
      });
      session = createImageTranslationSession(engine, (text, options) =>
        feature.translate(text, options)
      );
      const recognized = await session.recognize(
        bytes,
        canvas.width,
        canvas.height,
        region
      );
      await ensure(token);
      lines = recognized;
      for (const line of lines) {
        const box = node("span", line.id.replace("line-", ""));
        const b = line.preview;
        box.style.cssText =
          "position:absolute;border:1px solid #246c96;color:#133f59;background:#ffffff30;font:10px system-ui;box-sizing:border-box";
        Object.assign(box.style, {
          left: `${b.x * 100}%`,
          top: `${b.y * 100}%`,
          width: `${b.width * 100}%`,
          height: `${b.height * 100}%`
        });
        boxes.append(box);
        const text = node("textarea");
        text.value = line.text;
        text.rows = 2;
        text.maxLength = IMAGE_LIMITS.text;
        text.spellcheck = false;
        const label =
          api.t("Line ", "Dòng ") +
          line.id.replace("line-", "") +
          ` · ${Math.round(b.x * canvas.width)},${Math.round(b.y * canvas.height)} · ${Math.round(b.width * canvas.width)}×${Math.round(b.height * canvas.height)}`;
        edits.append(api.field(label, text));
        text.dataset.lineId = line.id;
      }
      status.textContent = api.t(
        "Review each numbered box and edit its text. Translation needs a separate consent check.",
        "Kiểm từng khung đánh số và sửa text. Dịch cần tick đồng ý riêng."
      );
    });
  });
  on(edits, "input", (event) => {
    const line = lines.find((item) => item.id === event.target.dataset.lineId);
    if (!line || busy) return;
    line.text = event.target.value;
    session?.edit(line.id, line.text);
    consent.checked = false;
    translated = [];
    result.replaceChildren();
    void sendSource("original").catch(() => {});
    update();
  });
  on(consent, "change", () => {
    session?.confirm(consent.checked);
    update();
  });
  on(localOnly, "change", () => {
    consent.checked = false;
    session?.confirm(false);
    update();
  });
  on(translate, "click", () => {
    void execute(async (token) => {
      await ensure(token);
      if (!consent.checked || !session)
        throw new Error("image-consent-required");
      session.confirm(true);
      consent.checked = false;
      const value = await session.translate({
        siteUrl: source.url,
        privacyPolicy: localOnly.checked ? "local-only" : undefined
      });
      await ensure(token);
      translated = value;
      result.replaceChildren();
      for (const line of value)
        result.append(
          node("p", `${line.id.replace("line-", "")} · ${line.text}`)
        );
      status.textContent = api.t(
        "Text translated. Show it on the image when ready; long translations may be clipped to their original box.",
        "Đã dịch text. Bấm hiện lên ảnh khi sẵn sàng; bản dịch dài có thể bị cắt trong khung gốc."
      );
    });
  });
  on(show, "click", () => {
    void execute(async (token) => {
      await ensure(token);
      await sendSource("show", { lines: translated });
      await ensure(token);
    });
  });
  on(original, "click", () => {
    void execute(async (token) => {
      await ensure(token);
      await sendSource("original");
    });
  });
  on(restore, "click", () => {
    clear();
    status.textContent = api.t(
      "Original restored. Image, text and workers cleared.",
      "Đã khôi phục ảnh gốc. Xóa ảnh, text và worker."
    );
  });
  const onStorage = (changes, area) => {
    if (area !== "local" || !changes.translatorSettings) return;
    const value = changes.translatorSettings.newValue;
    enabled = value?.enabled !== false && value?.labFeatures?.image === true;
    clear();
  };
  chrome.storage.onChanged.addListener(onStorage);
  const onInvalidated = (message, sender) => {
    if (
      message?.type === "labs-image-invalidated" &&
      sender.id === chrome.runtime.id &&
      sender.tab?.id === tab?.id &&
      message.imageId === source?.id
    ) {
      clear();
      status.textContent = api.t(
        "The image changed or the page closed. Local image, text and workers were cleared.",
        "Ảnh đã đổi hoặc trang đã đóng. Đã xóa ảnh, text và worker local."
      );
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onInvalidated);
  update();
  return () => {
    alive = false;
    clear();
    void feature.dispose();
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.runtime.onMessage.removeListener(onInvalidated);
    for (const remove of listeners) remove();
    panel.remove();
  };
}
