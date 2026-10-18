export const READING_FEATURES = Object.freeze([
  "corrections",
  "ask",
  "image",
  "compare",
  "readalong"
]);
export const READING_LIMITS = Object.freeze({
  blocks: 40,
  chars: 30000,
  visited: 50000,
  fileBytes: 25 * 1024 * 1024,
  pages: 500
});

export class ReadingError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createReadingId(cryptoObject = globalThis.crypto) {
  return [...cryptoObject.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

const forbidden =
  "script,style,noscript,template,form,input,textarea,select,option,button,iframe,frame,object,embed,canvas,svg,video,audio,[role='textbox'],[role='searchbox'],[role='combobox'],[data-bntrans-translation],[data-bt-injected],[data-bt-original],.bt-hover-translation,.bt-injected-content";
const blocks =
  "p,div,article,section,main,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,figcaption";
const ids = new WeakMap();
let nextId = 0;
function nodeId(node) {
  if (!ids.has(node)) ids.set(node, ++nextId);
  return ids.get(node);
}
function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}

export function isSafeReadingNode(node) {
  const doc = node?.ownerDocument;
  if (!doc || !node.isConnected || node.getRootNode() !== doc) return false;
  for (
    let el = node.nodeType === 1 ? node : node.parentElement;
    el;
    el = el.parentElement
  ) {
    if (
      el.matches(forbidden) ||
      el.id?.startsWith("bntrans-") ||
      [...el.classList].some(
        (name) => name.startsWith("bt-") || name.startsWith("bntrans-")
      ) ||
      el.hasAttribute("hidden") ||
      el.hasAttribute("inert") ||
      el.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
      el.getAttribute("translate")?.toLowerCase() === "no" ||
      el.classList.contains("notranslate") ||
      el.hasAttribute("autocomplete") ||
      (el.hasAttribute("contenteditable") &&
        el.getAttribute("contenteditable")?.toLowerCase() !== "false")
    )
      return false;
    const style = doc.defaultView.getComputedStyle(el);
    const original =
      el.hasAttribute("data-bntrans-original") &&
      el.parentElement?.hasAttribute("data-bntrans-wrapper");
    if (
      (style.display === "none" && !original) ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      style.opacity === "0"
    )
      return false;
    if (
      el !== node &&
      el.hasAttribute("data-bntrans-wrapper") &&
      ![...el.children].some(
        (child) =>
          child.hasAttribute("data-bntrans-original") && child.contains(node)
      )
    )
      return false;
  }
  return true;
}

export function splitReadingSentences(text, language = "en") {
  if (typeof text !== "string" || text.length > READING_LIMITS.chars)
    throw new ReadingError("source-limit");
  let segments;
  try {
    segments = Array.from(
      new Intl.Segmenter(language || "en", { granularity: "sentence" }).segment(
        text
      ),
      ({ segment, index }) => ({
        text: segment,
        start: index,
        end: index + segment.length
      })
    );
  } catch {
    segments = [...text.matchAll(/[^.!?。！？\n]+(?:[.!?。！？]+|\n|$)/gu)].map(
      (match) => ({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length
      })
    );
  }
  return segments
    .filter((part) => part.text.trim())
    .map((part, index) => ({
      ...part,
      id: `s${index + 1}`
    }));
}

export function validatePdfFile(file) {
  if (
    !file ||
    !Number.isInteger(file.size) ||
    file.size < 5 ||
    file.size > READING_LIMITS.fileBytes ||
    typeof file.arrayBuffer !== "function"
  )
    throw new ReadingError("file-size");
  if (file.type && file.type !== "application/pdf")
    throw new ReadingError("pdf-invalid");
}
export function validatePdfPage(page, count) {
  if (!Number.isInteger(count) || count < 1 || count > READING_LIMITS.pages)
    throw new ReadingError("pdf-pages");
  if (!Number.isInteger(page) || page < 1 || page > count)
    throw new ReadingError("pdf-page");
}

export function captureReadingSnapshot(doc, mode = "selection") {
  if (!["selection", "article"].includes(mode))
    throw new ReadingError("source-mode");
  let selection;
  if (mode === "selection") {
    const selected = doc.defaultView.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed)
      throw new ReadingError("source-selection");
    selection = selected.getRangeAt(0).cloneRange();
  }
  const root =
    mode === "article"
      ? doc.querySelector("article,main,[role='main']") || doc.body
      : doc.body;
  if (!root || !isSafeReadingNode(root)) throw new ReadingError("source-empty");
  const records = new Map();
  let visited = 0,
    segment = 0,
    chars = 0,
    group,
    truncated = false;
  const flush = () => {
    if (!group) return;
    const raw = group.parts.map((part) => part.value).join("");
    const left = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) {
      const available = READING_LIMITS.chars - chars;
      const value = text.slice(0, available);
      if (value) {
        const id = `web-${nodeId(group.parts[0].node)}-${hash(value)}-${group.parts[0].offset}`;
        records.set(id, { ...group, text: value, left });
        chars += value.length;
      }
      if (text.length > available) truncated = true;
    }
    group = null;
  };
  const walker = doc.createTreeWalker(root, 5, {
    acceptNode(node) {
      if (++visited > READING_LIMITS.visited) return 1;
      if (!isSafeReadingNode(node)) {
        segment++;
        return 2;
      }
      return node.nodeType === 3 ? 1 : 3;
    }
  });
  let node;
  while ((node = walker.nextNode())) {
    if (visited > READING_LIMITS.visited) {
      truncated = true;
      break;
    }
    if (selection && !selection.intersectsNode(node)) {
      segment++;
      continue;
    }
    const offset =
      selection?.startContainer === node ? selection.startOffset : 0;
    const end =
      selection?.endContainer === node ? selection.endOffset : node.data.length;
    const value = node.data.slice(offset, end);
    if (!value) continue;
    const block = node.parentElement.closest(blocks) || root;
    if (group && (group.block !== block || group.segment !== segment)) flush();
    if (
      records.size >= READING_LIMITS.blocks ||
      chars >= READING_LIMITS.chars
    ) {
      truncated = true;
      break;
    }
    group ||= { block, segment, parts: [] };
    group.parts.push({
      node,
      value,
      offset,
      original: node.data,
      lineage: ancestors(node)
    });
    if (
      group.parts.reduce((sum, part) => sum + part.value.length, 0) >=
      READING_LIMITS.chars - chars
    ) {
      flush();
      truncated = true;
      break;
    }
  }
  if (records.size < READING_LIMITS.blocks && chars < READING_LIMITS.chars)
    flush();
  if (!records.size) throw new ReadingError("source-empty");
  const source = {
    kind: "website",
    mode,
    snapshotId: createReadingId(doc.defaultView.crypto),
    url: doc.URL,
    title: doc.title.slice(0, 500),
    lang: (doc.documentElement.lang || "").slice(0, 80),
    truncated,
    blocks: [...records].map(([id, record]) => ({ id, text: record.text }))
  };
  return { source, records };
}

function ancestors(node) {
  const result = [];
  for (let parent = node.parentNode; parent; parent = parent.parentNode)
    result.push(parent);
  return result;
}

export function validateReadingSnapshot(doc, snapshot, request) {
  const source = snapshot?.source;
  if (
    !source ||
    request.snapshotId !== source.snapshotId ||
    request.url !== source.url ||
    doc.URL !== source.url
  )
    throw new ReadingError("source-stale");
  const record = snapshot.records.get(request.blockId);
  if (!record) throw new ReadingError("source-block");
  for (const part of record.parts) {
    const lineage = ancestors(part.node);
    if (
      !isSafeReadingNode(part.node) ||
      part.node.data !== part.original ||
      lineage.length !== part.lineage.length ||
      lineage.some((parent, i) => parent !== part.lineage[i])
    )
      throw new ReadingError("source-stale");
  }
  // Re-capture just the original range to reject newly inserted or newly protected text.
  const span = doc.createRange();
  const first = record.parts[0],
    last = record.parts.at(-1);
  span.setStart(first.node, first.offset);
  span.setEnd(last.node, last.offset + last.value.length);
  if (span.toString() !== record.parts.map((part) => part.value).join(""))
    throw new ReadingError("source-stale");
  return record;
}

export function readingSnapshotRange(doc, snapshot, request) {
  const record = validateReadingSnapshot(doc, snapshot, request);
  const start = request.start ?? 0,
    end = request.end ?? record.text.length;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > record.text.length
  )
    throw new ReadingError("source-range");
  const range = doc.createRange();
  let position = 0,
    started = false;
  for (const part of record.parts) {
    const a = record.left + start - position,
      b = record.left + end - position;
    if (!started && a >= 0 && a < part.value.length) {
      range.setStart(part.node, part.offset + a);
      started = true;
    }
    if (started && b > 0 && b <= part.value.length) {
      range.setEnd(part.node, part.offset + b);
      return range;
    }
    position += part.value.length;
  }
  throw new ReadingError("source-stale");
}
