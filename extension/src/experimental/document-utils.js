import {
  Unzip,
  UnzipInflate,
  zipSync,
  strFromU8,
  strToU8
} from "../../assets/vendor/fflate/fflate.mjs";

export const DOCUMENT_LIMITS = Object.freeze({
  fileBytes: 25 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  totalBytes: 80 * 1024 * 1024,
  entries: 2000,
  pages: 500,
  textChars: 100000,
  blockChars: 2000,
  cacheChars: 2000000
});

export class DocumentError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function checkFile(bytes) {
  if (!bytes.length || bytes.length > DOCUMENT_LIMITS.fileBytes)
    throw new DocumentError("file-size");
}

export function archivePath(value, base = "") {
  const forbidden = (text) =>
    /\\/.test(text) || Array.from(text).some((char) => char.charCodeAt(0) < 32);
  if (!value || forbidden(value) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(value))
    throw new DocumentError("zip-path");
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DocumentError("zip-path");
  }
  if (forbidden(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded))
    throw new DocumentError("zip-path");
  const result = base ? base.split("/").slice(0, -1) : [];
  for (const part of decoded.split("/")) {
    if (["__proto__", "prototype", "constructor"].includes(part))
      throw new DocumentError("zip-path");
    if (part === "..") {
      if (!result.length) throw new DocumentError("zip-path");
      result.pop();
    } else if (part && part !== ".") result.push(part);
  }
  return result.join("/");
}

// Validate the central directory before a decompressor allocates output buffers.
export function readEpubZip(bytes) {
  checkFile(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < 0 || end < bytes.length - 65557)
    throw new DocumentError("zip-invalid");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count > DOCUMENT_LIMITS.entries ||
    !count ||
    offset + size !== end
  )
    throw new DocumentError("zip-limits");
  const expected = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new DocumentError("zip-invalid");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const raw = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      local + 30 > end ||
      view.getUint32(local, true) !== 0x04034b50
    )
      throw new DocumentError("zip-invalid");
    const name = strFromU8(
      bytes.subarray(offset + 46, offset + 46 + nameLength)
    );
    const path = archivePath(name);
    if (name !== path && name !== `${path}/`)
      throw new DocumentError("zip-path");
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const localName = strFromU8(
      bytes.subarray(local + 30, local + 30 + localNameLength)
    );
    if (
      localName !== name ||
      local + 30 + localNameLength + localExtraLength + compressed >
        view.getUint32(end + 16, true)
    )
      throw new DocumentError("zip-invalid");
    if (flags & 1 || view.getUint16(local + 6, true) & 1)
      throw new DocumentError("drm");
    if (
      ![0, 8].includes(method) ||
      raw > DOCUMENT_LIMITS.entryBytes ||
      compressed > DOCUMENT_LIMITS.fileBytes ||
      (total += raw) > DOCUMENT_LIMITS.totalBytes ||
      expected.has(name)
    )
      throw new DocumentError("zip-limits");
    expected.set(name, raw);
    offset = next;
  }
  if (offset !== end) throw new DocumentError("zip-invalid");
  const entries = Object.create(null);
  const streams = [];
  const seen = new Set();
  let actualTotal = 0;
  try {
    const unzip = new Unzip((file) => {
      if (!expected.has(file.name) || seen.has(file.name))
        throw new DocumentError("zip-invalid");
      seen.add(file.name);
      streams.push(file);
      const chunks = [];
      let length = 0;
      file.ondata = (error, chunk, final) => {
        if (error)
          throw error instanceof DocumentError
            ? error
            : new DocumentError("zip-invalid");
        length += chunk.length;
        actualTotal += chunk.length;
        if (
          length > DOCUMENT_LIMITS.entryBytes ||
          actualTotal > DOCUMENT_LIMITS.totalBytes ||
          length > expected.get(file.name)
        )
          throw new DocumentError("zip-limits");
        chunks.push(chunk);
        if (final) {
          const data = new Uint8Array(length);
          let offset = 0;
          for (const part of chunks) {
            data.set(part, offset);
            offset += part.length;
          }
          entries[file.name] = data;
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    // A small compressed input slice bounds each inflater output burst, even if ZIP sizes lie.
    for (let offset = 0; offset < bytes.length; offset += 1024)
      unzip.push(
        bytes.subarray(offset, offset + 1024),
        offset + 1024 >= bytes.length
      );
  } catch (error) {
    streams.forEach((stream) => stream.terminate());
    throw error instanceof DocumentError
      ? error
      : new DocumentError("zip-invalid");
  }
  for (const [name, length] of expected)
    if (entries[name]?.length !== length)
      throw new DocumentError("zip-invalid");
  if (entries["META-INF/encryption.xml"]) throw new DocumentError("drm");
  if (
    strFromU8(entries.mimetype || new Uint8Array()) !== "application/epub+zip"
  )
    throw new DocumentError("epub-invalid");
  return entries;
}

export function parseXml(text, DOMParserClass = globalThis.DOMParser) {
  if (text.length > 1000000 || (text.match(/</g) || []).length > 30000)
    throw new DocumentError("text-limit");
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text))
    throw new DocumentError("xml-entity");
  const clean = text.replace(/<!DOCTYPE[^>]*>/gi, "");
  const doc = new DOMParserClass().parseFromString(clean, "application/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new DocumentError("xml-invalid");
  return doc;
}

function elements(doc, name) {
  return Array.from(doc.getElementsByTagNameNS("*", name));
}

export function parseEpub(
  bytes,
  DOMParserClass,
  XMLSerializerClass = globalThis.XMLSerializer
) {
  const entries = readEpubZip(bytes);
  const container = parseXml(
    strFromU8(entries["META-INF/container.xml"] || new Uint8Array()),
    DOMParserClass
  );
  const rootfile = elements(container, "rootfile")[0]?.getAttribute(
    "full-path"
  );
  const packagePath = archivePath(rootfile);
  if (!entries[packagePath]) throw new DocumentError("epub-invalid");
  const pkg = parseXml(strFromU8(entries[packagePath]), DOMParserClass);
  const manifest = new Map();
  for (const item of elements(pkg, "item")) {
    const path = archivePath(item.getAttribute("href"), packagePath);
    if (!entries[path]) throw new DocumentError("epub-missing");
    manifest.set(item.getAttribute("id"), {
      path,
      media: item.getAttribute("media-type")
    });
  }
  for (const [path, data] of Object.entries(entries)) {
    if (/\.svg$/i.test(path))
      entries[path] = strToU8(
        new XMLSerializerClass().serializeToString(
          sanitizeSvg(parseXml(strFromU8(data), DOMParserClass))
        )
      );
  }
  const chapters = elements(pkg, "itemref").map((item) => {
    const entry = manifest.get(item.getAttribute("idref"));
    if (entry?.media !== "application/xhtml+xml")
      throw new DocumentError("epub-spine");
    const doc = sanitizeXhtml(
      parseXml(strFromU8(entries[entry.path]), DOMParserClass),
      entry.path,
      entries
    );
    const blocks = textBlocks(doc);
    return {
      path: entry.path,
      doc,
      blocks,
      title: elements(doc, "title")[0]?.textContent || entry.path
    };
  });
  if (!chapters.length || chapters.length > DOCUMENT_LIMITS.pages)
    throw new DocumentError("epub-spine");
  return {
    entries,
    packagePath,
    chapters,
    manifest,
    language: elements(pkg, "language")[0]?.textContent || "",
    title: elements(pkg, "title")[0]?.textContent || "ePub"
  };
}

const XHTML_TAGS = new Set(
  "html head title meta body section article main nav aside header footer div p span h1 h2 h3 h4 h5 h6 a img picture br hr strong em b i u s small sup sub mark abbr q cite code pre blockquote ul ol li dl dt dd table caption thead tbody tfoot tr th td figure figcaption ruby rt rp".split(
    " "
  )
);
const ATTRS = new Set([
  "id",
  "class",
  "lang",
  "xml:lang",
  "dir",
  "title",
  "alt",
  "colspan",
  "rowspan",
  "epub:type",
  "xmlns",
  "xmlns:epub"
]);
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

export function safeReference(value, path, entries, image = false) {
  if (!value || /[?#]/.test(value.split("#")[0])) return null;
  if (value.startsWith("#") && !image) return value;
  try {
    const file = archivePath(value.split("#")[0], path);
    if (!Object.hasOwn(entries, file) || (image && !IMAGE.test(file)))
      return null;
    return value;
  } catch {
    return null;
  }
}

export function sanitizeXhtml(doc, path, entries) {
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    if (
      el.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      !XHTML_TAGS.has(el.localName)
    ) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (
        (name === "href" && el.localName === "a") ||
        (name === "src" && el.localName === "img")
      ) {
        if (!safeReference(attr.value, path, entries, name === "src"))
          el.removeAttribute(name);
      } else if (!ATTRS.has(name)) el.removeAttributeNode(attr);
    }
  }
  return doc;
}

export function textBlocks(doc) {
  const candidates = elements(doc, "body")[0];
  if (!candidates) throw new DocumentError("epub-invalid");
  const tags = new Set([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "blockquote",
    "div",
    "pre",
    "td",
    "dd",
    "dt",
    "figcaption"
  ]);
  const all = Array.from(candidates.getElementsByTagName("*")).filter((el) =>
    tags.has(el.localName)
  );
  const blocks = all
    .filter(
      (el) =>
        !Array.from(el.getElementsByTagName("*")).some((child) =>
          tags.has(child.localName)
        )
    )
    .filter((el) => el.textContent.trim());
  if (
    candidates.textContent.length > DOCUMENT_LIMITS.textChars ||
    blocks.length > 2000
  )
    throw new DocumentError("text-limit");
  return blocks;
}

export function sanitizeSvg(doc) {
  const tags = new Set(
    "svg g defs path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath".split(
      " "
    )
  );
  const attrs = new Set(
    "xmlns id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-rule opacity fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin offset stop-color stop-opacity gradientUnits gradientTransform font-size text-anchor".split(
      " "
    )
  );
  if (
    doc.documentElement.localName !== "svg" ||
    doc.documentElement.namespaceURI !== "http://www.w3.org/2000/svg"
  )
    throw new DocumentError("xml-invalid");
  for (const node of Array.from(doc.getElementsByTagName("*"))) {
    if (
      node.namespaceURI !== "http://www.w3.org/2000/svg" ||
      !tags.has(node.localName)
    ) {
      node.remove();
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      if (
        !attrs.has(attr.name) ||
        (attr.name !== "xmlns" && /(?:url\s*\(|[a-z]+:|[<>])/i.test(attr.value))
      )
        node.removeAttributeNode(attr);
    }
  }
  return doc;
}

export function splitText(text, limit = DOCUMENT_LIMITS.blockChars) {
  if (!Number.isInteger(limit) || limit < 2)
    throw new DocumentError("text-limit");
  const result = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let end = rest.lastIndexOf(" ", limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

export function pdfParagraphs(items) {
  const lines = [];
  let line = "",
    previous;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5] || 0;
    if (
      previous &&
      Math.abs(y - previous.y) > Math.max(2, previous.height * 0.4) &&
      line
    ) {
      lines.push(line.trim());
      line = "";
    }
    const space =
      line && !/\s$/.test(line) && !/^\s|^[,.;:!?]/.test(item.str) ? " " : "";
    line += space + item.str;
    if (item.hasEOL) {
      if (line.trim()) lines.push(line.trim());
      line = "";
    }
    previous = { y, height: item.height || 12 };
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.join("").length > DOCUMENT_LIMITS.textChars)
    throw new DocumentError("text-limit");
  return lines.flatMap((text) => splitText(text));
}

export class TranslationQueue {
  constructor(translate, checkpoint = async () => {}, results = {}) {
    this.translate = translate;
    this.checkpoint = checkpoint;
    this.results = { ...results };
    this.generation = 0;
    this.running = false;
  }
  cancel() {
    this.generation++;
  }
  async run(units, update = () => {}) {
    if (this.running) throw new DocumentError("queue-busy");
    this.running = true;
    const generation = ++this.generation;
    try {
      for (const { id, text } of units) {
        if (generation !== this.generation) break;
        if (!Object.hasOwn(this.results, id)) {
          const result = await this.translate(text);
          if (typeof result !== "string" || !result.trim())
            throw new DocumentError("translation-empty");
          if (result.length > DOCUMENT_LIMITS.textChars)
            throw new DocumentError("text-limit");
          this.results[id] = result;
          if (
            JSON.stringify(this.results).length > DOCUMENT_LIMITS.cacheChars
          ) {
            delete this.results[id];
            throw new DocumentError("cache-limit");
          }
          await this.checkpoint(this.results);
        }
        if (generation === this.generation) update(id, this.results[id]);
      }
    } finally {
      this.running = false;
    }
  }
}

const hash = async (data) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

export async function settingsIdentity(settings) {
  const stable = (value) =>
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map(stable)
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])])
          )
      : value;
  const effective = { ...settings };
  delete effective.translationHistory;
  return hash(new TextEncoder().encode(JSON.stringify(stable(effective))));
}

export async function documentIdentity(bytes, settings) {
  return `${await hash(bytes)}:${await settingsIdentity(settings)}`;
}

export function exportEpub(
  book,
  results,
  targetLanguage = "",
  XMLSerializerClass = globalThis.XMLSerializer
) {
  const entries = Object.create(null);
  const serialize = (doc) => new XMLSerializerClass().serializeToString(doc);
  // Keep metadata, manifest/spine, TOC and assets. Strip active markup/CSS even in non-spine files.
  for (const [path, data] of Object.entries(book.entries)) {
    if (/\.(?:xhtml|html|htm)$/i.test(path))
      entries[path] = strToU8(
        serialize(sanitizeXhtml(parseXml(strFromU8(data)), path, book.entries))
      );
    else if (/\.(?:css|js)$/i.test(path)) entries[path] = strToU8("");
    else entries[path] = data;
  }
  for (const [index, chapter] of book.chapters.entries()) {
    const doc = chapter.doc.cloneNode(true);
    const blocks = textBlocks(doc);
    for (const [blockIndex, block] of blocks.entries()) {
      const parts = splitText(block.textContent);
      const translated = parts.map(
        (_, chunk) => results[`epub:${index}:${blockIndex}:${chunk}`]
      );
      if (!translated.every((text) => typeof text === "string" && text.trim()))
        continue;
      const p = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
      p.setAttribute("class", "bntrans-translation");
      if (/^[a-z\d-]{1,35}$/i.test(targetLanguage))
        p.setAttribute("lang", targetLanguage);
      p.textContent = translated.join("\n");
      if (
        ["li", "td", "th", "dd", "dt", "figcaption"].includes(block.localName)
      )
        block.appendChild(p);
      else block.parentNode.insertBefore(p, block.nextSibling);
    }
    entries[chapter.path] = strToU8(serialize(doc));
  }
  const ordered = { mimetype: [strToU8("application/epub+zip"), { level: 0 }] };
  for (const [path, data] of Object.entries(entries))
    if (path !== "mimetype") ordered[path] = data;
  return zipSync(ordered, { level: 6 });
}
