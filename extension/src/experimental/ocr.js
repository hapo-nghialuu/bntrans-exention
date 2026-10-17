import {
  OCR_LIMITS,
  canvasPoint,
  checkDimensions,
  createLocalEngine,
  createOcrSession,
  inspectImage,
  maskPixels,
  pixelRect
} from "./ocr-utils.js";

export async function mount(container, api, dependencies = {}) {
  const doc = container.ownerDocument;
  const t = (en, vi) => api.t(en, vi);
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const panel = node("section", "", "lab-panel");
  container.append(panel);
  const settings = await api.settings();
  if (settings.labFeatures?.ocr !== true) {
    panel.append(
      node(
        "p",
        t(
          "Enable the OCR experiment in Labs first.",
          "Hãy bật thử nghiệm OCR trong Labs trước."
        )
      )
    );
    return () => panel.remove();
  }
  let alive = true;
  let revision = 0;
  let busy = false;
  let session;
  let startPoint;
  const listeners = [];
  const on = (element, event, callback) => {
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  };
  const status = node("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const say = (en, vi) => {
    if (alive) status.textContent = t(en, vi);
  };
  const field = (en, vi, element) => {
    const label = node("label", "", "lab-field");
    label.append(node("span", t(en, vi)), element);
    return label;
  };
  const button = (en, vi) => {
    const element = node("button", t(en, vi));
    element.type = "button";
    return element;
  };
  const file = node("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg";
  const language = node("select");
  for (const [value, en, vi] of [
    ["eng", "English — packaged offline", "Tiếng Anh — có sẵn offline"],
    ["vie", "Vietnamese — unavailable", "Tiếng Việt — chưa hỗ trợ"],
    ["other", "Other languages — unavailable", "Ngôn ngữ khác — chưa hỗ trợ"]
  ]) {
    const option = node("option", t(en, vi));
    option.value = value;
    language.append(option);
  }
  language.value = "eng";
  const tool = node("select");
  for (const [value, en, vi] of [
    ["mask", "Opaque mask", "Che kín"],
    ["crop", "Crop to rectangle", "Cắt theo hình chữ nhật"]
  ]) {
    const option = node("option", t(en, vi));
    option.value = value;
    tool.append(option);
  }
  tool.value = "mask";
  const canvas = node("canvas");
  canvas.width = canvas.height = 0;
  canvas.hidden = true;
  canvas.style.maxWidth = "100%";
  canvas.style.height = "auto";
  canvas.style.touchAction = "none";
  canvas.setAttribute(
    "aria-label",
    t(
      "Sanitized OCR preview. Use rectangle fields for keyboard editing.",
      "Preview ảnh OCR đã che. Có thể sửa bằng các ô tọa độ."
    )
  );
  const coordinates = node("div", "", "lab-toolbar");
  const rectInputs = {};
  for (const [key, en, vi] of [
    ["x", "Left (image px)", "Trái (px ảnh)"],
    ["y", "Top (image px)", "Trên (px ảnh)"],
    ["width", "Width (image px)", "Rộng (px ảnh)"],
    ["height", "Height (image px)", "Cao (px ảnh)"]
  ]) {
    const input = node("input");
    input.type = "number";
    input.min = "0";
    input.max = String(OCR_LIMITS.dimension);
    input.step = "1";
    input.value = "0";
    rectInputs[key] = input;
    coordinates.append(field(en, vi, input));
  }
  const apply = button("Apply rectangle", "Áp dụng hình chữ nhật");
  coordinates.append(apply);
  const run = button(
    "Confirm preview & run local OCR",
    "Xác nhận preview và chạy OCR local"
  );
  const cancel = button("Cancel & clear", "Hủy và xóa");
  const text = node("textarea", "", "lab-result");
  text.rows = 8;
  text.maxLength = OCR_LIMITS.text;
  text.spellcheck = false;
  const consent = node("input");
  consent.type = "checkbox";
  const localOnly = node("input");
  localOnly.type = "checkbox";
  localOnly.checked = true;
  const translate = button(
    "Translate edited text only",
    "Chỉ dịch văn bản đã sửa"
  );
  const result = node("pre", "", "lab-result");
  const toolbar = node("div", "", "lab-toolbar");
  toolbar.append(run, cancel);
  panel.append(
    node(
      "h2",
      t(
        "Private local OCR · English only",
        "OCR local riêng tư · chỉ tiếng Anh"
      )
    ),
    node(
      "p",
      t(
        "Local Tesseract.js; no image is sent to a provider. PNG/JPEG only, up to 8 MiB / 12 MP / 8000 px per axis. Offline model is packaged; no cloud fallback.",
        "Tesseract.js chạy local; không gửi ảnh đến provider. Chỉ PNG/JPEG, tối đa 8 MiB / 12 MP / 8000 px mỗi chiều. Model có sẵn offline; không fallback cloud."
      )
    ),
    node(
      "p",
      t(
        "Direct tab capture is unavailable: the current capture handler cannot verify the selected tab. Upload an image or a saved screenshot instead.",
        "Chưa hỗ trợ chụp tab trực tiếp: handler hiện tại không xác thực đúng tab được chọn. Hãy tải ảnh hoặc ảnh chụp đã lưu."
      )
    ),
    field("Choose local image", "Chọn ảnh trên máy", file),
    field(
      "Image language (not translation target)",
      "Ngôn ngữ trong ảnh (không phải ngôn ngữ dịch)",
      language
    ),
    field("Drag tool", "Công cụ kéo vùng", tool),
    node(
      "p",
      t(
        "Drag a rectangle on the preview or enter image-pixel coordinates. Masks replace pixels with solid black immediately; crop discards outside pixels. Neither can be undone: upload again to start over. Review the exact preview before confirming OCR.",
        "Kéo hình chữ nhật trên preview hoặc nhập tọa độ pixel ảnh. Che kín thay pixel bằng màu đen ngay lập tức; crop xóa phần ngoài. Không thể hoàn tác: tải lại ảnh để bắt đầu lại. Xem kỹ preview trước khi xác nhận OCR."
      )
    ),
    canvas,
    coordinates,
    toolbar,
    status,
    field(
      "Recognized text — review and edit before translation",
      "Văn bản nhận dạng — kiểm tra và sửa trước khi dịch",
      text
    ),
    field(
      "Keep text translation local-only (provider must support it)",
      "Chỉ dịch text bằng provider local (phải có provider phù hợp)",
      localOnly
    ),
    field(
      "I agree to send this edited TEXT to the configured translation provider, subject to site privacy policy. No image is sent.",
      "Tôi đồng ý gửi VĂN BẢN đã sửa đến provider dịch theo policy riêng tư của site. Không gửi ảnh.",
      consent
    ),
    translate,
    result
  );

  const update = () => {
    if (!alive) return;
    file.disabled = language.disabled = tool.disabled = busy;
    for (const input of Object.values(rectInputs)) input.disabled = busy;
    apply.disabled = busy || !canvas.width;
    run.disabled = busy || !canvas.width || language.value !== "eng";
    translate.disabled = busy || !text.value.trim() || !consent.checked;
    text.disabled = consent.disabled = localOnly.disabled = busy;
  };
  const clearResults = () => {
    session?.invalidate();
    text.value = "";
    consent.checked = false;
    result.textContent = "";
    update();
  };
  const reset = () => {
    revision++;
    startPoint = null;
    session?.dispose();
    session = null;
    busy = false;
    canvas.width = canvas.height = 0;
    canvas.hidden = true;
    file.value = "";
    clearResults();
  };
  const error = (err) => {
    const messages = {
      "file-limit": [
        "Image must be 8 MiB or smaller.",
        "Ảnh phải không quá 8 MiB."
      ],
      "image-limit": [
        "Image exceeds 12 MP or 8000 px per axis.",
        "Ảnh vượt 12 MP hoặc 8000 px mỗi chiều."
      ],
      "image-format": [
        "Only valid PNG/JPEG images are supported.",
        "Chỉ hỗ trợ ảnh PNG/JPEG hợp lệ."
      ],
      "empty-selection": [
        "Select a non-empty rectangle.",
        "Hãy chọn vùng có diện tích lớn hơn 0."
      ]
    };
    const message = messages[err?.message] || [
      "Local OCR failed or was canceled. Check packaged assets and MV3 WASM CSP; no cloud fallback occurred. Upload again to retry.",
      "OCR local lỗi hoặc đã hủy. Kiểm tra assets đóng gói và CSP WASM của MV3; không fallback cloud. Tải lại ảnh để thử lại."
    ];
    say(...message);
  };
  const applyRect = (rect) => {
    if (!canvas.width || busy) return;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (tool.value === "mask") {
      const pixels = context.getImageData(
        rect.x,
        rect.y,
        rect.width,
        rect.height
      );
      maskPixels(pixels, {
        x: 0,
        y: 0,
        width: rect.width,
        height: rect.height
      });
      context.putImageData(pixels, rect.x, rect.y);
    } else {
      const cropped = doc.createElement("canvas");
      cropped.width = rect.width;
      cropped.height = rect.height;
      cropped
        .getContext("2d")
        .drawImage(
          canvas,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          rect.width,
          rect.height
        );
      canvas.width = rect.width;
      canvas.height = rect.height;
      context.drawImage(cropped, 0, 0);
      cropped.width = cropped.height = 0;
    }
    revision++;
    clearResults();
    say(
      "Preview updated irreversibly. Review it before local OCR.",
      "Đã thay đổi preview không thể hoàn tác. Xem lại trước khi OCR local."
    );
  };
  on(file, "change", async () => {
    const uploaded = file.files?.[0];
    reset();
    if (!uploaded) return;
    const token = revision;
    busy = true;
    update();
    let bitmap;
    try {
      if (uploaded.size > OCR_LIMITS.fileBytes) throw new Error("file-limit");
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      if (!alive || token !== revision) return;
      const info = inspectImage(bytes);
      const decode =
        dependencies.createImageBitmap || globalThis.createImageBitmap;
      if (!decode) throw new Error("decode-unsupported");
      bitmap = await decode(new Blob([bytes], { type: info.mime }), {
        imageOrientation: "none"
      });
      if (!alive || token !== revision) return;
      checkDimensions(bitmap.width, bitmap.height);
      if (bitmap.width !== info.width || bitmap.height !== info.height)
        throw new Error("image-format");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      canvas.hidden = false;
      const createEngine = dependencies.createEngine || createLocalEngine;
      const engine = createEngine({
        baseUrl: new URL("../../assets/vendor/ocr/", import.meta.url).href
      });
      session = createOcrSession(engine, (value, options) =>
        api.translate(value, options)
      );
      say(
        "Image stays on this device. Crop/mask and confirm the preview to start OCR.",
        "Ảnh chỉ ở trên máy. Crop/che và xác nhận preview để bắt đầu OCR."
      );
    } catch (err) {
      if (alive && token === revision) error(err);
    } finally {
      bitmap?.close();
      if (alive && token === revision) {
        busy = false;
        update();
      }
    }
  });
  on(language, "change", () => {
    clearResults();
    if (language.value !== "eng")
      say(
        "This language is not packaged. Local OCR supports English only; no cloud fallback.",
        "Ngôn ngữ này chưa có model. OCR local chỉ hỗ trợ tiếng Anh; không fallback cloud."
      );
    update();
  });
  on(apply, "click", () => {
    try {
      const rect = Object.fromEntries(
        Object.entries(rectInputs).map(([key, input]) => [
          key,
          Number(input.value)
        ])
      );
      if (
        Object.values(rect).some((value) => !Number.isFinite(value)) ||
        rect.width <= 0 ||
        rect.height <= 0
      )
        throw new Error("empty-selection");
      applyRect(
        pixelRect(
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
          canvas.width,
          canvas.height
        )
      );
    } catch (err) {
      error(err);
    }
  });
  on(canvas, "pointerdown", (event) => {
    if (busy || !canvas.width || event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    startPoint = canvasPoint(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      canvas.width,
      canvas.height
    );
  });
  on(canvas, "pointerup", (event) => {
    if (!startPoint || busy) return;
    const start = startPoint;
    startPoint = null;
    try {
      const end = canvasPoint(
        event.clientX,
        event.clientY,
        canvas.getBoundingClientRect(),
        canvas.width,
        canvas.height
      );
      applyRect(pixelRect(start, end, canvas.width, canvas.height));
    } catch (err) {
      error(err);
    }
  });
  on(canvas, "pointercancel", () => {
    startPoint = null;
  });
  on(run, "click", async () => {
    if (busy || !session || language.value !== "eng" || !canvas.width) return;
    const token = revision;
    busy = true;
    text.value = "";
    consent.checked = false;
    result.textContent = "";
    update();
    say(
      "Running local OCR. No image leaves this extension.",
      "Đang chạy OCR local. Không gửi ảnh ra khỏi extension."
    );
    try {
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("encode-failed")),
          "image/png"
        )
      );
      if (!alive || token !== revision) return;
      if (blob.size > OCR_LIMITS.encodedBytes) throw new Error("file-limit");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!alive || token !== revision) return;
      const value = await session.confirm(bytes);
      if (!alive || token !== revision || value === null) return;
      text.value = value;
      say(
        value.trim()
          ? "OCR finished. Review text; translation requires separate consent."
          : "No text detected. Try a sharper English image.",
        value.trim()
          ? "OCR hoàn tất. Kiểm tra text; dịch cần đồng ý riêng."
          : "Không tìm thấy text. Thử ảnh tiếng Anh rõ hơn."
      );
    } catch (err) {
      if (alive && token === revision) error(err);
    } finally {
      if (alive && token === revision) {
        busy = false;
        update();
      }
    }
  });
  on(text, "input", () => {
    consent.checked = false;
    result.textContent = "";
    update();
  });
  on(consent, "change", update);
  on(localOnly, "change", () => {
    consent.checked = false;
    update();
  });
  on(translate, "click", async () => {
    if (busy || !session || !consent.checked || !text.value.trim()) return;
    const token = revision;
    busy = true;
    update();
    try {
      let tab = null;
      try {
        tab = await api.activeTab();
      } catch {
        // Uploaded images can use the default profile without a website tab.
      }
      if (!alive || token !== revision) return;
      const value = await session.translateText(text.value, consent.checked, {
        sourceLanguage: "en",
        ephemeral: true,
        siteUrl: tab?.url,
        privacyPolicy: localOnly.checked ? "local-only" : undefined,
        cloudConsent: !localOnly.checked
      });
      if (!alive || token !== revision || value === null) return;
      result.textContent = value;
      say(
        "Text translation finished; no image was sent.",
        "Đã dịch text; không gửi ảnh."
      );
    } catch {
      if (alive && token === revision)
        say(
          "Text translation failed or privacy policy blocked it. No image was sent; no OCR cloud fallback.",
          "Dịch text lỗi hoặc bị policy chặn. Không gửi ảnh; không fallback OCR cloud."
        );
    } finally {
      if (alive && token === revision) {
        busy = false;
        update();
      }
    }
  });
  on(cancel, "click", () => {
    reset();
    say("Canceled. Image and text cleared.", "Đã hủy. Xóa ảnh và text.");
  });
  update();
  return () => {
    alive = false;
    reset();
    for (const remove of listeners) remove();
    panel.remove();
  };
}
