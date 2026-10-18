const STYLES = new Set(["", "natural", "formal", "literal"]);
const FIELDS = new Set([
  "hostname",
  "enabled",
  "includeSubdomains",
  "sourceLanguage",
  "targetLanguage",
  "translationStyle",
  "glossary"
]);

export function normalizeSiteProfiles(value = []) {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Invalid website profiles / Cấu hình website không hợp lệ");
  const seen = new Set();
  return value.map((profile) => {
    if (
      !profile ||
      typeof profile !== "object" ||
      Array.isArray(profile) ||
      Object.keys(profile).some((key) => !FIELDS.has(key))
    )
      throw new Error("Invalid website profile / Profile website không hợp lệ");
    if (typeof profile.hostname !== "string")
      throw new Error("Invalid hostname / Hostname không hợp lệ");
    for (const field of [
      "sourceLanguage",
      "targetLanguage",
      "translationStyle"
    ])
      if (field in profile && typeof profile[field] !== "string")
        throw new Error("Invalid profile text / Trường profile không hợp lệ");
    const hostname = profile.hostname.trim().toLowerCase().replace(/\.$/, "");
    if (
      !hostname ||
      /[\s/:?#@*]/.test(hostname) ||
      (!hostname.includes(".") && hostname !== "localhost")
    )
      throw new Error("Enter a hostname only / Chỉ nhập hostname");
    let canonical;
    try {
      canonical = new URL(`https://${hostname}`).hostname;
    } catch {
      /* validated below */
    }
    if (
      !canonical ||
      canonical.length > 253 ||
      canonical
        .split(".")
        .some(
          (part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)
        ) ||
      seen.has(canonical)
    )
      throw new Error(
        "Invalid or duplicate hostname / Hostname sai hoặc bị trùng"
      );
    seen.add(canonical);
    for (const key of ["enabled", "includeSubdomains"])
      if (key in profile && typeof profile[key] !== "boolean")
        throw new Error(
          "Invalid profile switch / Trạng thái profile không hợp lệ"
        );
    const sourceLanguage = profile.sourceLanguage || "";
    const targetLanguage = profile.targetLanguage || "";
    for (const language of [sourceLanguage, targetLanguage])
      if (
        typeof language !== "string" ||
        (language &&
          !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) &&
          language !== "auto")
      )
        throw new Error(
          "Invalid profile language / Ngôn ngữ profile không hợp lệ"
        );
    if (
      targetLanguage === "auto" ||
      !STYLES.has(profile.translationStyle || "")
    )
      throw new Error(
        "Invalid profile direction or style / Sai chiều dịch hoặc văn phong"
      );
    const glossary = profile.glossary ?? {};
    if (
      !glossary ||
      typeof glossary !== "object" ||
      Array.isArray(glossary) ||
      Object.keys(glossary).length > 200 ||
      Object.entries(glossary).some(
        ([key, text]) =>
          !key.trim() ||
          key.length > 200 ||
          typeof text !== "string" ||
          !text.trim() ||
          text.length > 1000
      )
    )
      throw new Error(
        "Invalid profile glossary / Thuật ngữ profile không hợp lệ"
      );
    return {
      hostname: canonical,
      enabled: profile.enabled !== false,
      includeSubdomains: profile.includeSubdomains === true,
      sourceLanguage,
      targetLanguage,
      translationStyle: profile.translationStyle || "",
      glossary: { ...glossary }
    };
  });
}

export function findSiteProfile(settings, siteUrl) {
  let host;
  try {
    const url = new URL(siteUrl);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  return (
    normalizeSiteProfiles(settings.websiteProfiles)
      .filter(
        (profile) =>
          profile.enabled &&
          (host === profile.hostname ||
            (profile.includeSubdomains &&
              host.endsWith(`.${profile.hostname}`)))
      )
      .sort((a, b) => b.hostname.length - a.hostname.length)[0] || null
  );
}

export function applySiteProfile(settings, payload, sender = {}) {
  if (payload.task && payload.task !== "translate")
    return { settings, payload };
  const profile = findSiteProfile(
    settings,
    sender.tab ? sender.tab.url : payload.siteUrl
  );
  if (!profile) return { settings, payload };
  return {
    settings: {
      ...settings,
      translationStyle: profile.translationStyle || settings.translationStyle,
      glossary: { ...settings.glossary, ...profile.glossary }
    },
    payload: {
      ...payload,
      ...(profile.sourceLanguage && payload.languageOverride !== true
        ? { sourceLanguage: profile.sourceLanguage }
        : {}),
      ...(profile.targetLanguage && payload.languageOverride !== true
        ? { targetLanguage: profile.targetLanguage }
        : {})
    },
    profile
  };
}
