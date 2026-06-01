export const DEFAULT_SETTINGS = Object.freeze({
  whitelist: [],
  iconTheme: "light",
  contextMenuEnabled: false,
  quickActionEnabled: false,
  cleanupDelaySeconds: 0,
  clearLocalStorage: false,
  clearCookiesOnStartup: false,
  removePartitionedCookies: false,
  totalCookiesRemoved: 0
});

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  "ac.at",
  "ac.cn",
  "ac.in",
  "ac.uk",
  "asn.au",
  "biz.pl",
  "co.at",
  "co.in",
  "co.jp",
  "co.kr",
  "co.nz",
  "co.th",
  "co.uk",
  "com.ar",
  "com.au",
  "com.br",
  "com.cn",
  "com.co",
  "com.es",
  "com.hk",
  "com.mx",
  "com.pl",
  "com.sg",
  "com.tr",
  "com.tw",
  "com.ua",
  "com.vn",
  "edu.au",
  "edu.br",
  "edu.cn",
  "edu.pl",
  "firm.in",
  "gen.in",
  "gov.au",
  "gov.br",
  "gov.cn",
  "gov.in",
  "gov.pl",
  "gov.uk",
  "id.au",
  "ind.in",
  "info.pl",
  "net.au",
  "net.br",
  "net.cn",
  "net.in",
  "net.nz",
  "net.pl",
  "net.uk",
  "nom.br",
  "or.jp",
  "org.au",
  "org.br",
  "org.cn",
  "org.in",
  "org.nz",
  "org.pl",
  "org.uk",
  "plc.uk",
  "sch.uk",
  "web.id"
]);

export async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS)),
    chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))
  ]);
  const stored = { ...DEFAULT_SETTINGS, ...synced, ...local };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    whitelist: sanitizeWhitelist(stored.whitelist || []),
    cleanupDelaySeconds: normalizeDelay(stored.cleanupDelaySeconds),
    totalCookiesRemoved: normalizeCounter(stored.totalCookiesRemoved)
  };
}

export async function saveSettings(nextSettings) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...nextSettings,
    whitelist: sanitizeWhitelist(nextSettings.whitelist || []),
    cleanupDelaySeconds: normalizeDelay(nextSettings.cleanupDelaySeconds),
    totalCookiesRemoved: normalizeCounter(nextSettings.totalCookiesRemoved)
  };
  await Promise.all([
    chrome.storage.sync.set(settings),
    chrome.storage.local.set(settings)
  ]);
  return settings;
}

export function getMessage(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

export function getHostname(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function getSiteDomain(hostname) {
  const host = normalizeHost(hostname);
  if (!host || host === "localhost" || isIpAddress(host)) {
    return host;
  }

  const labels = host.split(".");
  if (labels.length <= 2) {
    return host;
  }

  const suffix = labels.slice(-2).join(".");
  if (MULTI_PART_PUBLIC_SUFFIXES.has(suffix) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return suffix;
}

export function normalizePattern(input) {
  const raw = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/\.$/, "");

  if (!raw) {
    return "";
  }

  if (raw.startsWith("*.")) {
    const suffix = normalizeHost(raw.slice(2));
    return suffix ? `*.${suffix}` : "";
  }

  return normalizeHost(raw);
}

export function sanitizeWhitelist(items) {
  return [...new Set(items.map(normalizePattern).filter(isValidPattern))].sort();
}

export function isValidPattern(pattern) {
  if (!pattern) {
    return false;
  }
  if (pattern.startsWith("*.")) {
    return isValidHost(pattern.slice(2));
  }
  return isValidHost(pattern);
}

export function isWhitelisted(hostname, whitelist) {
  const host = normalizeHost(hostname);
  return sanitizeWhitelist(whitelist).some((pattern) => patternMatchesHost(pattern, host));
}

export function patternMatchesHost(pattern, hostname) {
  const host = normalizeHost(hostname);
  const normalized = normalizePattern(pattern);
  if (!host || !normalized) {
    return false;
  }

  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return host !== suffix && host.endsWith(`.${suffix}`);
  }

  return host === normalized || host.endsWith(`.${normalized}`);
}

export function cookieMatchesHost(cookie, hostname) {
  const host = normalizeHost(hostname);
  const domain = normalizeHost(cookie.domain);
  return host === domain || host.endsWith(`.${domain}`);
}

export function cookieUrl(cookie) {
  const domain = normalizeHost(cookie.domain);
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${domain}${cookie.path || "/"}`;
}

export function cookieKey(cookie) {
  return [
    cookie.storeId,
    cookie.domain,
    cookie.path,
    cookie.name,
    cookie.secure ? "1" : "0",
    JSON.stringify(cookie.partitionKey || null)
  ].map(encodeURIComponent).join("|");
}

export function parseCookieKey(key) {
  const [storeId, domain, path, name, secure, partitionKey] = String(key || "").split("|").map(decodeURIComponent);
  return {
    storeId,
    domain,
    path,
    name,
    secure: secure === "1",
    partitionKey: parsePartitionKey(partitionKey)
  };
}

export function normalizeHost(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
}

function isValidHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host || host.length > 253) {
    return false;
  }
  if (host === "localhost" || isIpAddress(host)) {
    return true;
  }
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isIpAddress(hostname) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function normalizeDelay(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(86400, Math.max(0, Math.round(number)));
}

function normalizeCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function parsePartitionKey(value) {
  if (!value || value === "null") {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
