/**
 * Granularity Translation Handlers
 * Handles line-by-line and sentence-by-sentence translation modes
 * Uses Mark-and-Map (Delimiter) Strategy with Wrapper-Based Injection
 * AND Inline Grouping + Markdown-First Strategy to preserve structure
 */

/**
 * Check if a node is a Block element that should break the group
 */
function isBlockNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tagName = node.tagName.toLowerCase();
  // Known block tags
  return [
    "address",
    "article",
    "aside",
    "blockquote",
    "canvas",
    "dd",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "noscript",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "caption",
    "thead",
    "tbody",
    "tfoot",
    "ul",
    "video",
    "tr",
    "td",
    "th" // Tables are blocks for our purpose
  ].includes(tagName);
}

/**
 * Elements whose whole subtree should never be collected for translation —
 * code blocks, form controls, embedded docs and opt-out markers.
 */
const SKIP_SUBTREE_TAGS = [
  "script",
  "style",
  "noscript",
  "input",
  "button",
  "pre",
  "textarea",
  "iframe",
  "form",
  "fieldset",
  "label",
  "option",
  "datalist",
  "output",
  "progress",
  "meter",
  "canvas",
  "audio",
  "video",
  "source",
  "track",
  "svg",
  "math",
  "select",
  "kbd",
  "samp",
  "object",
  "embed",
  "template"
];

function shouldSkipSubtree(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  if (SKIP_SUBTREE_TAGS.includes(node.tagName.toLowerCase())) return true;
  if (node.getAttribute("translate") === "no") return true;
  if (node.isContentEditable) return true;
  if (node.classList?.contains("notranslate")) return true;
  if (node.hasAttribute("data-bntrans-wrapper")) return true;
  if (node.id?.startsWith("bntrans-")) return true;
  if (node.classList?.contains("bt-injected-content")) return true;
  return false;
}

function hasProtectedDescendant(node, skipSubtree = shouldSkipSubtree) {
  return Array.from(node.childNodes || []).some(
    (child) => skipSubtree(child) || hasProtectedDescendant(child, skipSubtree)
  );
}

/**
 * Get Translation Units (Groups of inline nodes)
 * @param {Element} root - Root element
 * @returns {Array<{nodes: Node[], text: string}>}
 */
function getTranslationUnits(root, skipSubtree = shouldSkipSubtree) {
  if (skipSubtree(root)) return [];
  const units = [];
  let currentGroup = [];

  function flushGroup() {
    if (currentGroup.length > 0) {
      units.push({ nodes: [...currentGroup] });
      currentGroup = [];
    }
  }

  // Iterate over direct children
  for (let node of root.childNodes) {
    // Skip comments
    if (node.nodeType === Node.COMMENT_NODE) continue;

    // Skip our own wrappers
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node.hasAttribute("data-bntrans-wrapper") ||
        node.classList.contains("bt-injected-content"))
    ) {
      flushGroup();
      continue;
    }

    // Skip scripts/styles and subtrees that must stay untranslated
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (["script", "style", "noscript"].includes(node.tagName.toLowerCase()) ||
        skipSubtree(node))
    ) {
      flushGroup();
      continue;
    }

    if (isBlockNode(node) || hasProtectedDescendant(node, skipSubtree)) {
      // Block element found: Flush current group
      flushGroup();

      // RECURSION: Dive into the block to find units inside it
      // This allows us to translate a whole list (UL) by processing its LIs
      const childUnits = getTranslationUnits(node, skipSubtree);
      units.push(...childUnits);
    } else {
      // Inline node (Text, Span, A, Code, etc.)
      // Special handling for BR
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        node.tagName.toLowerCase() === "br"
      ) {
        flushGroup();
      } else {
        currentGroup.push(node);
      }
    }
  }
  flushGroup();

  // Filter out empty units (only whitespace)
  return units.filter((unit) => {
    const text = toMarkdown(unit.nodes).trim();
    return text.length > 0;
  });
}

/**
 * Convert DOM nodes to Markdown (preserving unknown HTML)
 * @param {Node[]} nodes
 * @returns {string}
 */
// Markers for escaping < and > in text before sending to API
// Using guillemets « » which are unlikely to appear in code/text
const BRACKET_MARKERS = {
  LT: "«", // « (U+00AB) - Left-Pointing Double Angle Quotation Mark
  GT: "»" // » (U+00BB) - Right-Pointing Double Angle Quotation Mark
};

/**
 * Escape < and > in plain text to markers before sending to API
 * This prevents LLM from misinterpreting text like "<0.5%" as HTML tags
 */
function escapeTextBrackets(text) {
  if (!text) return text;
  return text
    .replace(/</g, BRACKET_MARKERS.LT)
    .replace(/>/g, BRACKET_MARKERS.GT);
}

/**
 * Tokens that must survive translation verbatim.
 * Wrapped in backticks so the LLM treats them as code and does not touch them.
 */
const PROTECTED_TOKEN_PATTERN =
  /(\{\{?[^{}\s]+\}?\}|[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/[^\s]+|@[\w][\w.-]*|#[\w][\w-]*|%[sd])/g;

function protectInlineTokens(text) {
  if (!text) return text;
  return text.replace(PROTECTED_TOKEN_PATTERN, "`$1`");
}

/**
 * Convert DOM nodes to Markdown (preserving unknown HTML)
 * @param {Node[] | NodeList} nodes
 * @returns {string}
 */
function toMarkdown(nodes) {
  let md = "";
  // Handle NodeList or Array
  const nodeList = nodes instanceof NodeList ? Array.from(nodes) : nodes;

  nodeList.forEach((node) => {
    if (shouldSkipSubtree(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // Escape < and > in text to prevent LLM confusion, and wrap tokens
      // that must not be translated (placeholders, links, mentions) in
      // backticks
      md += protectInlineTokens(escapeTextBrackets(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();

      // Handle Void Elements (no children)
      if (["img", "br", "hr", "input", "meta", "link"].includes(tag)) {
        if (tag === "br") md += "\n";
        return;
      }

      // Process children recursively
      const childMarkdown = toMarkdown(node.childNodes);

      switch (tag) {
        case "b":
        case "strong":
          md += `**${childMarkdown}**`;
          break;
        case "i":
        case "em":
          md += `*${childMarkdown}*`;
          break;
        case "code":
          // For code, we usually want to prevent translation.
          // Using backticks tells the LLM to ignore it.
          // We use textContent here because Markdown code blocks don't support internal HTML.
          // This means we lose syntax highlighting inside inline code, but we protect the code from translation.
          md += `\`${childMarkdown}\``;
          break;
        case "a":
          // Keep link text in brackets to hint it's a link
          md += `[${childMarkdown}]`;
          break;
        default:
          md += childMarkdown;
      }
    }
  });
  return md;
}

const DELIMITER = " ||| ";

function buildDelimiterPrompt() {
  return `Translate the following Markdown text segments. The segments are separated by "${DELIMITER}". Keep the delimiter "${DELIMITER}" in the output at the exact same positions. Preserve Markdown syntax (**, *, \`, []) and HTML tags. Do not translate code inside \`\`. Return the full translated string with delimiters.`;
}

function buildBasePayload(settings) {
  return {
    nativeLanguageCode: settings.nativeLanguageCode || "en",
    targetLanguage: settings.nativeLanguageCode || "vi",
    sourceLanguage: settings.targetLanguageCode || "en",
    useAutoDetect: false
  };
}

/**
 * A segment is suspicious when the "translation" is identical to the source:
 * likely the translator skipped it (unless it is non-letter content like
 * numbers or very short text).
 */
function looksUntranslated(source, translation) {
  const s = (source || "").trim();
  const t = (translation || "").trim();
  return s.length > 3 && s === t && /\p{L}/u.test(s);
}

function translationControlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function requestSegmentTranslations(
  segments,
  settings,
  requestTranslation,
  control = {}
) {
  const current = control.isCurrent || (() => true);
  const check = () => {
    if (!current())
      throw translationControlError("cancelled", "Translation cancelled");
  };
  const request = async (payload) => {
    check();
    const response = await requestTranslation(payload);
    check();
    if (!response?.ok || !response.result?.translation)
      throw new Error(response?.error || "Translation failed");
    return response.result.translation.trim();
  };
  const basePayload = buildBasePayload(settings);
  const maxRetries = control.maxRetries ?? 1;
  const retries = new Array(segments.length).fill(0);
  let translated = new Array(segments.length).fill("");
  const mapLimited = async (indices, callback) => {
    let cursor = 0;
    let failed = false;
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(control.concurrency || 2, indices.length) },
        async () => {
          while (cursor < indices.length && !failed) {
            check();
            const i = indices[cursor++];
            try {
              await callback(i);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
        }
      )
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  try {
    const result = await request({
      ...basePayload,
      text: segments.join(DELIMITER),
      customPrompt: buildDelimiterPrompt()
    });
    translated = result.split(/\|\|\|/).map((s) => s.trim());
    if (translated.length !== segments.length) {
      translated = new Array(segments.length).fill("");
      if (!maxRetries) throw new Error("Delimiter mismatch; retries disabled");
      await mapLimited(
        segments.map((_, i) => i),
        async (i) => {
          retries[i]++;
          translated[i] = await request({ ...basePayload, text: segments[i] });
        }
      );
    }
    const qaIndices = segments
      .map((_, i) => i)
      .filter(
        (i) =>
          retries[i] < maxRetries &&
          looksUntranslated(segments[i], translated[i])
      );
    qaIndices.forEach((i) => {
      translated[i] = "";
    });
    await mapLimited(qaIndices, async (i) => {
      retries[i]++;
      translated[i] = await request({ ...basePayload, text: segments[i] });
    });
    check();
    const unchanged = segments.some((source, i) =>
      looksUntranslated(source, translated[i])
    );
    if (unchanged) {
      translated = translated.map((value, i) =>
        looksUntranslated(segments[i], value) ? "" : value
      );
      throw new Error("Translator returned unchanged text after retry");
    }
    return translated;
  } catch (error) {
    error.partialTranslations = translated;
    throw error;
  }
}

function injectUnitWrappers(units) {
  const wrappers = [];
  units.forEach((unit, sourceIndex) => {
    const firstNode = unit.nodes[0];
    const parent = firstNode?.parentNode;
    if (
      !parent ||
      firstNode.isConnected === false ||
      !unit.nodes.every((node) => node.parentNode === parent)
    )
      return;
    const sourceMarkdown = toMarkdown(unit.nodes);
    const wrapper = document.createElement("span");
    wrapper.setAttribute("data-bntrans-wrapper", "true");
    wrapper.style.display = "inline";
    const originalSpan = document.createElement("span");
    originalSpan.setAttribute("data-bntrans-original", "true");
    const translationSpan = document.createElement("span");
    translationSpan.setAttribute("data-bntrans-translation", "true");
    translationSpan.className = "bt-loading-indicator";
    translationSpan.textContent = "…";
    const separator = document.createElement("br");
    parent.insertBefore(wrapper, firstNode);
    unit.nodes.forEach((node) => originalSpan.appendChild(node));
    wrapper.append(originalSpan, separator, translationSpan);
    wrappers.push({
      wrapper,
      originalSpan,
      translationSpan,
      separator,
      sourceIndex,
      sourceMarkdown,
      unit
    });
  });
  return wrappers;
}

function markTranslationError(wrappers, error) {
  wrappers.forEach(({ translationSpan }) => {
    translationSpan.classList.remove("bt-loading-indicator");
    translationSpan.textContent = error?.message || "Translation failed";
  });
}

/**
 * Handle line-by-line translation (Wrapper-Based + Block-List Grouping + Markdown)
 */
// eslint-disable-next-line no-unused-vars -- called from content-script.js
async function handleLineByLineTranslate(
  element,
  text,
  settings,
  createPlaceholder,
  updateContent,
  requestTranslation,
  cache
) {
  // 1. Check if already translated
  if (element.hasAttribute("data-bntrans-translated")) {
    return;
  }

  // 2. Get Translation Units (Groups)
  const units = getTranslationUnits(element);

  if (units.length === 0) {
    console.log("[Granularity] No translation units found");
    return;
  }

  // 3. Inject Wrappers with Loading Indicators
  const wrappers = injectUnitWrappers(units);

  // Mark element
  element.setAttribute("data-bntrans-translated", "line");
  element.classList.add("bt-hover-translated");

  // 4. Prepare text with Delimiters (Markdown conversion)
  const originalMarkdowns = units.map((u) => toMarkdown(u.nodes));
  const combinedText = originalMarkdowns.join(DELIMITER);

  // Cache key: full source text, not just its length
  const cacheKey = `line-md-${combinedText}-${settings.nativeLanguageCode}-${settings.activeProviderId}`;

  let translatedSegments;
  if (cache.has(cacheKey)) {
    translatedSegments = cache.get(cacheKey);
  } else {
    try {
      translatedSegments = await requestSegmentTranslations(
        originalMarkdowns,
        settings,
        requestTranslation
      );
      cache.set(cacheKey, translatedSegments);
    } catch (err) {
      markTranslationError(wrappers, err);
      return;
    }
  }

  // 5. Update Wrappers with Translations
  updateWrappers(wrappers, translatedSegments, settings);
}

/**
 * Split a Markdown string into sentences using Intl.Segmenter.
 * Falls back to the whole string when the API is unavailable.
 */
function splitIntoSentences(markdown, locale) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return [markdown];
  }
  try {
    const segmenter = new Intl.Segmenter(locale || undefined, {
      granularity: "sentence"
    });
    const sentences = [...segmenter.segment(markdown)]
      .map((s) => s.segment.trim())
      .filter((s) => s.length > 0);
    return sentences.length > 0 ? sentences : [markdown];
  } catch {
    return [markdown];
  }
}

/**
 * Handle sentence-by-sentence translation.
 * Same wrapper injection as line mode, but each unit's Markdown is split into
 * sentences first, so every sentence is translated as an isolated segment
 * (cleaner boundaries for the translator) then re-grouped per unit.
 */
// eslint-disable-next-line no-unused-vars -- called from content-script.js
async function handleSentenceBySentenceTranslate(
  element,
  text,
  settings,
  createPlaceholder,
  updateContent,
  requestTranslation,
  cache
) {
  if (element.hasAttribute("data-bntrans-translated")) {
    return;
  }

  const units = getTranslationUnits(element);

  if (units.length === 0) {
    console.log("[Granularity] No translation units found");
    return;
  }

  const wrappers = injectUnitWrappers(units);

  element.setAttribute("data-bntrans-translated", "sentence");
  element.classList.add("bt-hover-translated");

  // Split each unit's Markdown into sentences; keep unit index per sentence
  // so translated sentences can be re-grouped under their own unit.
  const sourceLocale = settings.targetLanguageCode || "en";
  const sentences = [];
  const sentenceUnitIndex = [];

  units.forEach((unit, unitIndex) => {
    const unitMarkdown = toMarkdown(unit.nodes);
    splitIntoSentences(unitMarkdown, sourceLocale).forEach((sentence) => {
      sentences.push(sentence);
      sentenceUnitIndex.push(unitIndex);
    });
  });

  const combinedText = sentences.join(DELIMITER);
  const cacheKey = `sentence-md-${combinedText}-${settings.nativeLanguageCode}-${settings.activeProviderId}`;

  let translatedSentences;
  if (cache.has(cacheKey)) {
    translatedSentences = cache.get(cacheKey);
  } else {
    try {
      translatedSentences = await requestSegmentTranslations(
        sentences,
        settings,
        requestTranslation
      );
      cache.set(cacheKey, translatedSentences);
    } catch (err) {
      markTranslationError(wrappers, err);
      return;
    }
  }

  // Re-group translated sentences per unit; each sentence on its own line
  const unitTranslations = units.map(() => []);
  translatedSentences.forEach((sentence, i) => {
    const unitIndex = sentenceUnitIndex[i];
    if (unitIndex !== undefined) {
      unitTranslations[unitIndex].push(sentence);
    }
  });

  updateWrappers(
    wrappers,
    unitTranslations.map((parts) => parts.join("<br>")),
    settings
  );
}

function updateWrappers(wrappers, translations, settings) {
  const textColor = settings.hoverInjectStyle?.textColor || "#b42318";
  const fontSize = settings.hoverInjectStyle?.fontSize || "0.95em";
  wrappers.forEach(
    (
      {
        wrapper,
        originalSpan,
        translationSpan,
        sourceIndex,
        sourceMarkdown,
        unit
      },
      i
    ) => {
      if (
        wrapper.isConnected === false ||
        (unit &&
          (!unit.nodes.every((node) => node.parentNode === originalSpan) ||
            toMarkdown(unit.nodes) !== sourceMarkdown))
      )
        return;
      const translation = translations?.[sourceIndex ?? i];
      if (!translation) return;
      translationSpan.classList.remove("bt-loading-indicator");
      translationSpan.style.lineHeight = "1.4";
      translationSpan.style.whiteSpace = "pre-wrap";
      translationSpan.style.color = textColor;
      translationSpan.style.fontSize = fontSize;
      translationSpan.replaceChildren();
      const text = translation
        .replaceAll(BRACKET_MARKERS.LT, "<")
        .replaceAll(BRACKET_MARKERS.GT, ">");
      // Provider HTML remains literal text; only this Markdown subset becomes DOM.
      for (const token of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g)) {
        const marker = token.startsWith("**")
          ? "**"
          : token.startsWith("*")
            ? "*"
            : token.startsWith("`")
              ? "`"
              : "";
        if (
          !marker ||
          !token.endsWith(marker) ||
          token.length <= marker.length * 2
        ) {
          translationSpan.appendChild(document.createTextNode(token));
        } else {
          const el = document.createElement(
            marker === "**" ? "b" : marker === "*" ? "i" : "code"
          );
          el.textContent = token.slice(marker.length, -marker.length);
          translationSpan.appendChild(el);
        }
      }
    }
  );
}
