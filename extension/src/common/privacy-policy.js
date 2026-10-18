const MODES = new Set(["local-only", "cloud", "ask"]);

export class PrivacyError extends Error {
  constructor(reason, destination = "") {
    super(
      `Privacy blocked: ${reason}${destination ? ` (${destination})` : ""}`
    );
    this.code = "PRIVACY_BLOCKED";
    this.destination = destination;
  }
}

export function endpoint(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new PrivacyError("Invalid endpoint");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new PrivacyError(
      "Only HTTP(S) endpoints without embedded credentials are allowed"
    );
  }
  const authority = String(url)
    .match(/^https?:\/\/([^/?#]+)/i)?.[1]
    ?.toLowerCase();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(
    authority || ""
  );
  return { origin: parsed.origin, hostname: parsed.hostname, local };
}

export function hostnameMatches(hostname, rule) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  const domain = String(rule).trim().toLowerCase().replace(/\.$/, "");
  return !!domain && (host === domain || host.endsWith(`.${domain}`));
}

export function resolvePrivacy(settings, payload = {}, sender = {}) {
  // A page cannot assert consent or spoof its site with payload fields.
  const siteUrl = sender.tab ? sender.tab.url || "" : payload.siteUrl || "";
  let hostname = "";
  try {
    hostname = new URL(siteUrl).hostname;
  } catch {}
  const enabled = settings.labFeatures?.privacy === true;
  const rule = enabled
    ? (settings.privacyRules || [])
        .filter((r) => hostnameMatches(hostname, r.hostname))
        .sort((a, b) => b.hostname.length - a.hostname.length)[0]
    : null;
  let mode = rule?.mode || (enabled && settings.privacyDefaultMode) || "cloud";
  if (!MODES.has(mode)) mode = "ask";
  if (
    payload.privacyPolicy === "local-only" ||
    payload.privacyPolicy?.mode === "local-only"
  )
    mode = "local-only";
  const trusted =
    !sender.tab &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""));
  return {
    mode,
    hostname,
    providerId: rule?.providerId,
    allowedDestinations: rule?.allowedDestinations,
    cloudConsent: trusted && payload.cloudConsent === true,
    ephemeral: payload.ephemeral === true,
    incognito:
      sender.tab?.incognito === true ||
      chrome.extension?.inIncognitoContext === true
  };
}

export function assertDestination(policy = { mode: "cloud" }, url) {
  const destination = endpoint(url);
  if (policy.mode === "local-only" && !destination.local)
    throw new PrivacyError(
      "Local-only forbids network destination",
      destination.origin
    );
  if (!destination.local && policy.mode === "ask" && !policy.cloudConsent)
    throw new PrivacyError(
      "Confirm this action in the extension before sending data",
      destination.origin
    );
  if (
    Array.isArray(policy.allowedDestinations) &&
    !policy.allowedDestinations.some((item) => {
      try {
        return endpoint(item).origin === destination.origin;
      } catch {
        return false;
      }
    })
  )
    throw new PrivacyError(
      "Destination is not in this site's allowlist",
      destination.origin
    );
  return destination;
}

export function providerDestination(provider = {}) {
  const config = provider.config || {};
  switch (provider.type) {
    case "gemini-nano":
      return { local: true, origin: "built-in" };
    case "ollama":
    case "custom":
      return endpoint(config.baseUrl || "http://localhost:11434/v1");
    case "codex":
      return endpoint(config.baseUrl || "http://localhost:8787/v1");
    case "openai":
      return endpoint(config.baseUrl || "https://api.openai.com/v1");
    case "gemini":
      return endpoint("https://generativelanguage.googleapis.com");
    case "google-translate":
      return endpoint("https://translate.googleapis.com");
    case "deepl":
      return endpoint(
        config.apiKey?.endsWith(":fx")
          ? "https://api-free.deepl.com"
          : "https://api.deepl.com"
      );
    case "openrouter":
      return endpoint("https://openrouter.ai");
    case "groq":
      return endpoint("https://api.groq.com");
    case "claude":
      return endpoint("https://api.anthropic.com");
    default:
      throw new PrivacyError("Unknown provider destination");
  }
}

export function assertProvider(policy, provider) {
  const destination = providerDestination(provider);
  if (destination.origin !== "built-in")
    assertDestination(policy, destination.origin);
  return destination;
}

export function privacyResponse(error) {
  return {
    ok: false,
    error: String(error?.message || error),
    ...(error?.code === "PRIVACY_BLOCKED"
      ? {
          privacyBlocked: true,
          code: error.code,
          destination: error.destination
        }
      : {})
  };
}

export function canRetain(settings, policy, kind) {
  return (
    !policy.incognito &&
    !policy.ephemeral &&
    settings[`${kind}Enabled`] !== false &&
    settings.retentionEnabled !== false
  );
}

export function ttlMillis(settings, kind) {
  const hours = Number(
    settings[`${kind}TTLHours`] ?? (kind === "cache" ? 168 : 720)
  );
  return Number.isFinite(hours) && hours > 0 ? hours * 3600000 : 0;
}
