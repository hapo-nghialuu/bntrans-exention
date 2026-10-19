const LABELS = {
  placeholders: ["Placeholders changed", "Biến giữ chỗ bị thay đổi"],
  urls: ["Links changed", "Liên kết bị thay đổi"],
  code: ["Code changed", "Code bị thay đổi"],
  numbers: ["Numbers changed", "Số liệu bị thay đổi"],
  markdown: ["Formatting markers changed", "Ký hiệu định dạng bị thay đổi"]
};

function normalizeNumber(value) {
  const compact = value.replace(/[\s\u00a0\u202f]/g, "");
  const last = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
  if (last < 0) return compact;
  const digitsAfter = compact.slice(last + 1).replace(/[%‰]$/, "");
  const separators = compact.match(/[.,]/g) || [];
  if (
    digitsAfter.length === 3 &&
    (separators.length === 1 || new Set(separators).size === 1)
  )
    return compact.replace(/[.,]/g, "");
  return (
    compact.slice(0, last).replace(/[.,]/g, "") + "." + compact.slice(last + 1)
  );
}

function bag(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) || 0) + 1);
  return result;
}
function extract(text) {
  const result = {
    code: [],
    urls: [],
    placeholders: [],
    numbers: [],
    markdown: []
  };
  let rest = text
    .replace(/\r\n/g, "\n")
    .replace(
      /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g,
      (_match, block, inline) => {
        result.code.push(
          block === undefined ? inline : block.replace(/^\n+|\n+$/g, "")
        );
        return " ";
      }
    );
  rest = rest.replace(/https?:\/\/[^\s<>"'`]+/gi, (value) => {
    let url = value.replace(/[.,;!?]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"]
    ])
      while (
        url.endsWith(close) &&
        url.split(close).length > url.split(open).length
      )
        url = url.slice(0, -1);
    result.urls.push(url);
    return " ";
  });
  rest = rest.replace(
    /\$\{[\w.]+\}|\{\{\s*[\w.]+\s*\}\}|\{[\w.]+\}|%\([\w]+\)[sdf]|%(?:\d+\$)?[sdfiu]/g,
    (value, offset, full) => {
      let slash = offset - 1;
      while (full[slash] === "\\") slash--;
      if (
        (offset - 1 - slash) % 2 ||
        (value.startsWith("%") && full[offset - 1] === "%")
      )
        return value;
      result.placeholders.push(value);
      return " ";
    }
  );
  result.numbers = [
    ...rest.matchAll(
      /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+|[ \u00a0\u202f]\d{3})*(?:%|‰)?(?![\p{L}\p{N}_])/gu
    )
  ].map(([number]) => normalizeNumber(number));
  const markdown = rest.replace(/\\[\s\S]/g, "");
  result.markdown =
    markdown.match(
      /\*\*|__|~~|`+|<\/?u>|(?<!\*)\*(?!\*)|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu
    ) || [];
  result.markdown.push(
    ...[...markdown.matchAll(/^\s{0,3}(#{1,6})\s+/gm)].map(
      ([, marker]) => marker
    )
  );
  result.markdown.push(
    ...[...markdown.matchAll(/^\s{0,3}([-+*]|\d+\.)\s+/gm)].map(([, marker]) =>
      /\d/.test(marker) ? "ordered-list" : marker
    )
  );
  return result;
}

export function checkTranslationQuality(source, translation) {
  if (
    typeof source !== "string" ||
    typeof translation !== "string" ||
    source.length > 100000 ||
    translation.length > 200000
  )
    return [];
  const before = extract(source),
    after = extract(translation),
    warnings = [];
  for (const kind of Object.keys(LABELS)) {
    const a = bag(before[kind]),
      b = bag(after[kind]);
    let missing = 0,
      added = 0;
    for (const [value, count] of a)
      missing += Math.max(0, count - (b.get(value) || 0));
    for (const [value, count] of b)
      added += Math.max(0, count - (a.get(value) || 0));
    if (missing || added) warnings.push({ kind, missing, added });
  }
  return warnings;
}

export function qualityWarningText(warnings, language = "en") {
  if (!Array.isArray(warnings)) return "";
  const labels = warnings
    .filter((warning) => LABELS[warning.kind])
    .map((warning) => LABELS[warning.kind][language === "vi" ? 1 : 0]);
  return labels.length
    ? `${language === "vi" ? "Cần kiểm tra" : "Review needed"}: ${labels.join(" · ")}. ${language === "vi" ? "Chỉ là cảnh báo, không tự sửa bản dịch." : "Advisory only; translation was not changed."}`
    : "";
}
