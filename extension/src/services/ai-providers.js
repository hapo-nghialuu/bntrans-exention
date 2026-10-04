/**
 * Default system prompt for translation with Markdown preservation
 */
const DEFAULT_SYSTEM_PROMPT = `You are a professional translator. Translate the user's text from {sourceLang} to {targetLang}.

RULES:
1. Keep all Markdown symbols (**, _, ~~, \`, \`\`\`, -, <u>) exactly as they are.
2. DO NOT translate content inside backticks (\`...\`) or code blocks (\`\`\`...\`\`\`).
3. Preserve all formatting markers in their original positions.
4. Return ONLY the translated text with preserved Markdown.`;

/**
 * Register/style guidance appended to the system prompt.
 */
const STYLE_INSTRUCTIONS = {
  literal:
    "STYLE: Stay close to the source wording and sentence structure. Preserve nuances and terminology exactly, even when the result reads less fluently.",
  formal:
    "STYLE: Use a formal, polite register appropriate for professional contexts. For Vietnamese output, prefer neutral pronouns (tôi/bạn); do not use casual particles.",
  natural:
    "STYLE: Translate naturally and fluently, prioritizing idiomatic phrasing and readability in the target language."
};

/**
 * Base class for Translation Providers
 */
class TranslationProvider {
  constructor(
    config,
    customPrompt = "",
    { style = "natural", glossary = {} } = {}
  ) {
    this.config = config;
    this.customPrompt = customPrompt;
    this.style = style;
    this.glossary = glossary;
  }

  /**
   * Build the complete system prompt with style, glossary, context and
   * custom additions
   */
  buildSystemPrompt(sourceLang, targetLang, context = "") {
    let prompt = DEFAULT_SYSTEM_PROMPT.replace(
      "{sourceLang}",
      sourceLang
    ).replace("{targetLang}", targetLang);

    const styleInstruction =
      STYLE_INSTRUCTIONS[this.style] || STYLE_INSTRUCTIONS.natural;
    prompt += `\n\n${styleInstruction}`;

    const glossaryEntries = Object.entries(this.glossary || {}).filter(
      ([term, translation]) => term.trim() && translation.trim()
    );
    if (glossaryEntries.length > 0) {
      const lines = glossaryEntries
        .map(([term, translation]) => `- ${term} → ${translation}`)
        .join("\n");
      prompt += `\n\nGLOSSARY (always translate these terms exactly as specified):\n${lines}`;
    }

    if (context && context.trim()) {
      prompt += `\n\nCONTEXT (use this to resolve ambiguity, do not translate it): ${context.trim()}`;
    }

    if (this.customPrompt && this.customPrompt.trim()) {
      prompt += `\n\nAdditional context: ${this.customPrompt.trim()}`;
    }

    return prompt;
  }

  async translate() {
    throw new Error("Not implemented");
  }
}

/**
 * Chrome Built-in AI Provider
 */
class WindowAIProvider extends TranslationProvider {
  async translate() {
    // This delegates to the offscreen document via background script
    // We return a special signal or handle it differently if needed.
    // However, since this runs in background, we can just use the existing flow
    // or we can move the offscreen logic here if we want to unify it.
    // For now, let's keep the offscreen logic separate but invoked by this provider.

    // Actually, the background script handles the offscreen messaging.
    // So this provider might just be a wrapper that says "use offscreen".
    return { useOffscreen: true };
  }
}

/**
 * Google Gemini Provider
 */
export class GeminiProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang, context = "") {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "gemini-3.1-flash-lite";

    if (!apiKey) throw new Error("Gemini API Key is missing");

    const systemPrompt = this.buildSystemPrompt(
      sourceLang,
      targetLang,
      context
    );
    const prompt = `${systemPrompt}\n\nText: ${text}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "Gemini API Error");
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  }

  /**
   * OCR + translate in one shot: send the image inline and ask for a
   * delimited source/translation pair so callers can show both.
   */
  async translateImage(
    base64Png,
    targetLang,
    mimeType = "image/png",
    mode = "translate"
  ) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "gemini-3.1-flash-lite";

    if (!apiKey) throw new Error("Gemini API Key is missing");

    const prompt =
      mode === "explain"
        ? IMAGE_EXPLAIN_PROMPT(targetLang)
        : IMAGE_OCR_PROMPT(targetLang);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Png } }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || "Gemini API Error");
    }

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    return mode === "explain"
      ? { source: "", translation: raw }
      : parseImageTranslation(raw);
  }
}

/**
 * Parse "<<<SOURCE>>>...<<<TRANSLATION>>>..." model output into
 * {source, translation}. Tolerates whitespace/casing variance.
 */
function parseImageTranslation(raw) {
  // Preferred shape: {"segments":[{box:[y0,x0,y1,x1],source,translation}]}
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && Array.isArray(obj.segments)) {
      return {
        source: obj.segments
          .map((s) => s?.source || "")
          .filter(Boolean)
          .join("\n"),
        translation: obj.segments
          .map((s) => s?.translation || "")
          .filter(Boolean)
          .join("\n"),
        segments: obj.segments.filter(
          (s) =>
            s &&
            Array.isArray(s.box) &&
            s.box.length === 4 &&
            typeof s.translation === "string"
        )
      };
    }
  } catch {
    /* fall through to legacy formats */
  }
  const m = raw.match(
    /<<<SOURCE>>>\s*([\s\S]*?)\s*<<<TRANSLATION>>>\s*([\s\S]*?)\s*$/i
  );
  if (m) return { source: m[1], translation: m[2] };
  if (/<<<EMPTY>>>/i.test(raw)) return { source: "", translation: "" };
  // Fallback: treat the whole reply as the translation
  return { source: "", translation: raw };
}

const IMAGE_OCR_PROMPT = (
  targetLang
) => `Extract ALL text visible in this image and translate it to ${targetLang}.
Reply with ONLY a JSON object — no markdown fences, no extra text:
{"segments":[{"box":[yMin,xMin,yMax,xMax],"source":"...","translation":"..."}]}
Rules:
- box: bounding box of EACH text line/block in the image, normalized to 0-1000
- Merge nearby lines of the same paragraph into one segment
- If the image contains no readable text, reply: {"segments":[]}`;

const IMAGE_EXPLAIN_PROMPT = (
  targetLang
) => `Look at this image, read the text it contains, and explain its meaning concisely in ${targetLang}.
Reply with plain text only — 1-3 short paragraphs, no markdown.`;

/**
 * Shared OCR+translate for OpenAI-compatible /chat/completions endpoints
 * (OpenAI, OpenRouter, Groq, Ollama, Codex bridge, custom servers). The
 * configured model must be vision-capable or the endpoint will error.
 */
async function openAiImageTranslate(
  { baseUrl, apiKey, model, extraHeaders = {} },
  base64,
  targetLang,
  mimeType,
  mode = "translate"
) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (apiKey && apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;

  const prompt =
    mode === "explain"
      ? IMAGE_EXPLAIN_PROMPT(targetLang)
      : IMAGE_OCR_PROMPT(targetLang);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` }
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `API Error ${response.status}`;
    // Groq (and others) reject multimodal content on text-only models with
    // "messages[0].content must be a string" — translate that into an
    // actionable hint instead of leaking the raw validation error.
    if (
      /must be a string|does not support image|multimodal|vision/i.test(msg)
    ) {
      throw new Error(
        `Model "${model}" cannot read images — pick a vision-capable model in Options → Screenshot.`
      );
    }
    throw new Error(msg);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "";
  return mode === "explain"
    ? { source: "", translation: raw }
    : parseImageTranslation(raw);
}

/**
 * OpenAI Provider
 */
class OpenAIProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang, context = "") {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "gpt-4o-mini";
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";

    if (!apiKey) throw new Error("OpenAI API Key is missing");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: this.buildSystemPrompt(sourceLang, targetLang, context)
          },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "OpenAI API Error");
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  }

  async translateImage(
    base64,
    targetLang,
    mimeType = "image/png",
    mode = "translate"
  ) {
    if (!this.config.apiKey) throw new Error("OpenAI API Key is missing");
    return openAiImageTranslate(
      {
        baseUrl: this.config.baseUrl || "https://api.openai.com/v1",
        apiKey: this.config.apiKey,
        model: this.config.model || "gpt-4o-mini"
      },
      base64,
      targetLang,
      mimeType,
      mode
    );
  }
}

/**
 * DeepL Provider
 */
class DeepLProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    // DeepL API domain depends on plan: api-free.deepl.com vs api.deepl.com
    // But usually keys ending in :fx are free.
    const domain = apiKey.endsWith(":fx")
      ? "api-free.deepl.com"
      : "api.deepl.com";

    if (!apiKey) throw new Error("DeepL API Key is missing");

    const params = new URLSearchParams();
    params.append("text", text);
    params.append("source_lang", sourceLang.toUpperCase());
    params.append("target_lang", targetLang.toUpperCase());

    const response = await fetch(`https://${domain}/v2/translate`, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    if (!response.ok) {
      throw new Error("DeepL API Error: " + response.statusText);
    }

    const data = await response.json();
    return data.translations?.[0]?.text;
  }
}

/**
 * Google Translate Provider (Free, no API key required)
 */
class GoogleTranslateProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    console.log("[GoogleTranslate] Received text:", text);
    console.log("[GoogleTranslate] Text length:", text?.length);
    console.log(
      "[GoogleTranslate] Has HTML tags:",
      /<[a-z][\s\S]*>/i.test(text)
    );

    // Google Translate uses ISO 639-1 codes, 'auto' for auto-detect
    const sl = sourceLang === "auto" ? "auto" : sourceLang.toLowerCase();
    const tl = targetLang.toLowerCase();

    // Encode the text for URL
    const encodedText = encodeURIComponent(text);

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dj=1&sl=${sl}&tl=${tl}&q=${encodedText}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("Google Translate API Error: " + response.statusText);
    }

    const data = await response.json();

    // Parse the response
    // Response contains a "sentences" array where each item has "trans" field
    if (!data.sentences || !Array.isArray(data.sentences)) {
      throw new Error("Invalid response from Google Translate");
    }

    // Concatenate all translation segments
    const translation = data.sentences
      .map((sentence) => sentence.trans)
      .filter((trans) => trans) // Filter out any undefined/null values
      .join("");

    return translation;
  }
}

/**
 * Microsoft Translate Provider (Bing) - DISABLED: Requires Authorization
 * Keeping code commented for future reference if auth method is found
 */
// class MicrosoftTranslateProvider extends TranslationProvider {
//   async translate(text, sourceLang, targetLang, context = "") {
//     // Microsoft Translate uses ISO 639-1 codes
//     // For auto-detect, leave 'from' parameter empty
//     const from = sourceLang === 'auto' ? '' : sourceLang.toLowerCase();
//     const to = targetLang.toLowerCase();
//
//     const url = `https://api-edge.cognitive.microsofttranslator.com/translate?from=${from}&to=${to}&api-version=3.0`;
//
//     // Microsoft Translate expects an array of text objects
//     const requestBody = [{ Text: text }];
//
//     const response = await fetch(url, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify(requestBody)
//     });
//
//     if (!response.ok) {
//       throw new Error("Microsoft Translate API Error: " + response.statusText);
//     }
//
//     const data = await response.json();
//
//     // Parse the response
//     // Response is an array where each item has "translations" array
//     if (!Array.isArray(data) || data.length === 0) {
//       throw new Error("Invalid response from Microsoft Translate");
//     }
//
//     // Extract the translation from the first item
//     const translationItem = data[0];
//     if (!translationItem.translations || translationItem.translations.length === 0) {
//       throw new Error("No translation found in Microsoft Translate response");
//     }
//
//     return translationItem.translations[0].text;
//   }
// }

/**
 * OpenRouter Provider
 */
class OpenRouterProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang, context = "") {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "google/gemini-2.0-flash-exp:free";
    const baseUrl = "https://openrouter.ai/api/v1";

    if (!apiKey) throw new Error("OpenRouter API Key is missing");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/hapo-nghialuu/bntrans-exention", // Required by OpenRouter
        "X-Title": "BNTrans Extension" // Optional
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: this.buildSystemPrompt(sourceLang, targetLang, context)
          },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "OpenRouter API Error");
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  }

  async translateImage(
    base64,
    targetLang,
    mimeType = "image/png",
    mode = "translate"
  ) {
    if (!this.config.apiKey) throw new Error("OpenRouter API Key is missing");
    return openAiImageTranslate(
      {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: this.config.apiKey,
        model: this.config.model || "openai/gpt-4o-mini",
        extraHeaders: {
          "HTTP-Referer": "https://github.com/hapo-nghialuu/bntrans-exention",
          "X-Title": "BNTrans Extension"
        }
      },
      base64,
      targetLang,
      mimeType,
      mode
    );
  }
}

/**
 * Groq Provider (Fast inference API)
 */
class GroqProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang, context = "") {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "llama-3.3-70b-versatile";
    const baseUrl = "https://api.groq.com/openai/v1";

    if (!apiKey) throw new Error("Groq API Key is missing");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: this.buildSystemPrompt(sourceLang, targetLang, context)
          },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "Groq API Error");
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  }

  async translateImage(
    base64,
    targetLang,
    mimeType = "image/png",
    mode = "translate"
  ) {
    if (!this.config.apiKey) throw new Error("Groq API Key is missing");
    return openAiImageTranslate(
      {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: this.config.apiKey,
        // image calls need a vision model — the text default would 400
        model: this.config.model || "meta-llama/llama-4-scout-17b-16e-instruct"
      },
      base64,
      targetLang,
      mimeType,
      mode
    );
  }
}

/**
 * Custom Provider for OpenAI-compatible endpoints (Ollama, LM Studio, etc.)
 */
class CustomProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang, context = "") {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "llama3.1";
    const baseUrl = this.config.baseUrl || "http://localhost:11434/v1";

    if (!baseUrl) throw new Error("Base URL is required for Custom provider");

    const headers = {
      "Content-Type": "application/json"
    };

    // Add Authorization header only if API key is provided
    if (apiKey && apiKey.trim()) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      console.log(
        `[CustomProvider] Calling ${baseUrl}/chat/completions with model: ${model}`
      );

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: "system",
              content: this.buildSystemPrompt(sourceLang, targetLang, context)
            },
            { role: "user", content: text }
          ]
        })
      });

      console.log(`[CustomProvider] Response status: ${response.status}`);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const errorMsg = err.error?.message || response.statusText;
        console.error(`[CustomProvider] API Error:`, err);
        throw new Error(`${errorMsg} (Status: ${response.status})`);
      }

      const data = await response.json();
      console.log(`[CustomProvider] Success:`, data);
      return data.choices?.[0]?.message?.content?.trim();
    } catch (error) {
      console.error(`[CustomProvider] Fetch Error:`, error);
      // Check if it's a network/CORS error
      if (
        error.message.includes("Failed to fetch") ||
        error instanceof TypeError
      ) {
        throw new Error(
          `Cannot connect to ${baseUrl}. Make sure:\n1. Ollama is running\n2. CORS is enabled\n3. URL is correct`
        );
      }
      throw error;
    }
  }

  async translateImage(
    base64,
    targetLang,
    mimeType = "image/png",
    mode = "translate"
  ) {
    const baseUrl = this.config.baseUrl || "http://localhost:11434/v1";
    if (!baseUrl) throw new Error("Base URL is required for Custom provider");
    return openAiImageTranslate(
      {
        baseUrl,
        apiKey: this.config.apiKey,
        model: this.config.model || "llama3.1"
      },
      base64,
      targetLang,
      mimeType,
      mode
    );
  }
}

export class AIProviderService {
  constructor(settings) {
    this.settings = settings;
    this.activeProviderId = settings.activeProviderId || "builtin";
    this.providers = settings.providers || [];
    this.customPrompt = settings.customPrompt || "";
    this.translationStyle = settings.translationStyle || "natural";
    this.glossary = settings.glossary || {};

    this.activeProvider = this.providers.find(
      (p) => p.id === this.activeProviderId
    ) ||
      this.providers.find((p) => p.id === "builtin") || {
        type: "gemini-nano",
        config: {}
      };
  }

  getProvider(providerId, promptOverride) {
    let providerData = this.activeProvider;

    if (providerId) {
      providerData =
        this.providers.find((p) => p.id === providerId) || this.activeProvider;
    }

    const { type, config } = providerData;
    const prompt =
      typeof promptOverride === "string" && promptOverride.trim()
        ? promptOverride
        : this.customPrompt;
    const opts = { style: this.translationStyle, glossary: this.glossary };

    switch (type) {
      case "gemini":
        return new GeminiProvider(config, prompt, opts);
      case "openai":
        return new OpenAIProvider(config, prompt, opts);
      case "openrouter":
        return new OpenRouterProvider(config, prompt, opts);
      case "deepl":
        return new DeepLProvider(config, prompt, opts);
      case "google-translate":
        return new GoogleTranslateProvider(config, prompt, opts);
      // case "microsoft-translate":
      //   return new MicrosoftTranslateProvider(config, prompt, opts);
      case "groq":
        return new GroqProvider(config, prompt, opts);
      case "ollama":
        return new CustomProvider(config, prompt, opts);
      case "codex":
        return new CustomProvider(
          {
            baseUrl: "http://localhost:8787/v1",
            model: "codex-subscription",
            ...config
          },
          prompt,
          opts
        );
      case "custom":
        return new CustomProvider(config, prompt, opts);
      case "gemini-nano":
      default:
        return new WindowAIProvider({});
    }
  }

  async translate(
    text,
    sourceLang,
    targetLang,
    providerId,
    requestPrompt = "",
    context = ""
  ) {
    const provider = this.getProvider(providerId, requestPrompt);
    const translation = await provider.translate(
      text,
      sourceLang,
      targetLang,
      context
    );

    // If it's the special offscreen signal, return it directly
    if (
      translation &&
      typeof translation === "object" &&
      translation.useOffscreen
    ) {
      return translation;
    }

    // Find the actual provider used for metadata
    const providerData = providerId
      ? this.providers.find((p) => p.id === providerId) || this.activeProvider
      : this.activeProvider;

    return {
      translation,
      providerName: providerData.name,
      providerType: providerData.type
    };
  }
}
