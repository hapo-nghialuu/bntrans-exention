/* BNTrans adapter; upstream worker/core files remain unmodified. */
(() => {
  const base = new URL("./", self.location.href);
  const allowed = new Set(
    [
      "worker.min.js",
      "core/tesseract-core-lstm.wasm.js",
      "core/tesseract-core-simd-lstm.wasm.js",
      "lang/eng.traineddata.gz"
    ].map((path) => new URL(path, base).href)
  );
  const local = (value) => {
    const url = new URL(typeof value === "string" ? value : value.url, base);
    if (url.protocol !== "chrome-extension:" || !allowed.has(url.href)) {
      throw new Error("Local OCR blocks non-packaged resources");
    }
    return url.href;
  };
  const nativeFetch = self.fetch.bind(self);
  const nativeImport = self.importScripts.bind(self);
  self.fetch = (input, options) => {
    // Official .wasm.js cores embed WASM as a data URL, not network code.
    if (
      typeof input === "string" &&
      input.startsWith("data:application/octet-stream;base64,") &&
      input.length < 6 * 1024 * 1024
    ) {
      return nativeFetch(input, options);
    }
    return nativeFetch(local(input), options);
  };
  self.importScripts = (...urls) => nativeImport(...urls.map(local));
  self.XMLHttpRequest = class {
    constructor() {
      throw new Error("Local OCR blocks XMLHttpRequest");
    }
  };
  self.WebSocket = self.EventSource = self.XMLHttpRequest;
  self.importScripts(new URL("worker.min.js", base).href);
})();
