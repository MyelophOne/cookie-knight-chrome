import {
  cookieMatchesHost,
  cookieKey,
  cookieUrl,
  getHostname,
  getMessage,
  getSettings,
  getSiteDomain,
  isWhitelisted,
  normalizePattern,
  parseCookieKey,
  saveSettings
} from "./shared.js";

const tabHosts = new Map();
const CONTEXT_MENU_ID = "cookieflow-add-domain";
const CONTEXT_REMOVE_COOKIES_ID = "cookieflow-remove-cookies";
const TAB_HOSTS_KEY = "tabHosts";
const PENDING_CLEANUPS_KEY = "pendingCleanups";
const PROTECTED_SITES_KEY = "protectedSiteDomains";
const CLEANUP_ALARM_PREFIX = "cookieflow-cleanup:";
const ICON_SIZES = [16, 32, 48, 128];
const cleanupTimers = new Map();
const badgeTimers = new Map();
let cookieChangeTimer = null;
let contextMenuSync = Promise.resolve();
let protectedSiteDomains = new Set();

chrome.runtime.onInstalled.addListener(async () => {
  await hydrateTabs();
  await hydrateProtectedSiteDomains();
  await applySettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await hydrateTabs();
  await hydrateProtectedSiteDomains();
  await processOverdueCleanups();
  await clearNonWhitelistedCookiesOnStartup();
  await applySettings();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if ((areaName === "sync" || areaName === "local") && Object.keys(changes).some((key) => key in {
    iconTheme: true,
    contextMenuEnabled: true,
    quickActionEnabled: true,
    whitelist: true,
    cleanupDelaySeconds: true,
    clearLocalStorage: true,
    clearCookiesOnStartup: true,
    removePartitionedCookies: true
  })) {
    if (changes.whitelist) {
      hydrateProtectedSiteDomains();
    }
    applySettings();
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(async (tab) => {
    if (tab.url) {
      updateTrackedTab(tabId, tab.url);
      await updateContextMenuTitle(tab.url);
    }
    updateBadge(tabId);
  }).catch(() => updateBadge());
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) {
    return;
  }
  updateTrackedTab(tabId, url);
  if (tab.active) {
    updateContextMenuTitle(url);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const storedHosts = await readStoredTabHosts();
  const closedHost = tabHosts.get(tabId) || storedHosts[tabId];
  tabHosts.delete(tabId);
  delete storedHosts[tabId];
  await writeStoredTabHosts(storedHosts);

  if (!closedHost) {
    return;
  }

  await scheduleCleanup(closedHost);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(CLEANUP_ALARM_PREFIX)) {
    return;
  }

  const siteDomain = alarm.name.slice(CLEANUP_ALARM_PREFIX.length);
  runScheduledCleanup(siteDomain);
});

chrome.cookies.onChanged.addListener(() => {
  clearTimeout(cookieChangeTimer);
  cookieChangeTimer = setTimeout(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      if (active?.id) {
        scheduleBadgeUpdate(active.id);
      }
    });
  }, 750);
});

chrome.action.onClicked.addListener(async (tab) => {
  const settings = await getSettings();
  if (!settings.quickActionEnabled) {
    return;
  }

  const host = getHostname(tab.url || "");
  if (!host) {
    return;
  }

  await toggleWhitelistEntry(host);
  await updateBadge(tab.id);
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.url) {
      return;
    }

    const host = getHostname(tab.url);
    if (info.menuItemId === CONTEXT_MENU_ID) {
      const siteDomain = getSiteDomain(host);
      if (siteDomain) {
        await toggleWhitelistEntry(siteDomain);
        await updateBadge(tab.id);
      }
    }

    if (info.menuItemId === CONTEXT_REMOVE_COOKIES_ID && host) {
      await removeCookiesForHost(host, { respectWhitelist: false });
      await maybeClearLocalStorageForUrl(tab.url);
      await updateBadge(tab.id);
    }
  });
}

if (chrome.contextMenus?.onShown) {
  chrome.contextMenus.onShown.addListener(async (info, tab) => {
    if (tab?.url) {
      await updateContextMenuTitle(tab.url);
      chrome.contextMenus.refresh();
    }
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-current-site-whitelist") {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = getHostname(tab?.url || "");
  if (host) {
    await toggleWhitelistEntry(getSiteDomain(host));
    await updateBadge(tab.id);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function handleMessage(message) {
  if (message?.type === "get-current-tab-state") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { ok: true, state: await buildTabState(tab) };
  }

  if (message?.type === "add-whitelist-entry") {
    return { ok: true, settings: await addWhitelistEntry(message.pattern) };
  }

  if (message?.type === "remove-whitelist-entry") {
    return { ok: true, settings: await removeWhitelistEntry(message.pattern) };
  }

  if (message?.type === "remove-cookie") {
    await removeCookieByKey(message.key);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { ok: true, state: await buildTabState(tab) };
  }

  if (message?.type === "remove-current-tab-cookies") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = getHostname(tab?.url || "");
    if (host) {
      await removeCookiesForHost(host, { respectWhitelist: false });
      await maybeClearLocalStorageForUrl(tab.url);
    }
    return { ok: true, state: await buildTabState(tab) };
  }

  if (message?.type === "update-settings") {
    const settings = await saveSettings(message.settings);
    await applySettings();
    return { ok: true, settings };
  }

  if (message?.type === "reset-stats") {
    const settings = await getSettings();
    return { ok: true, settings: await saveSettings({ ...settings, totalCookiesRemoved: 0 }) };
  }

  return { ok: false, error: "Unknown message" };
}

async function buildTabState(tab) {
  const settings = await getSettings();
  const host = getHostname(tab?.url || "");
  const siteDomain = getSiteDomain(host);
  const cookies = host ? await getCookiesForHost(host) : [];

  return {
    tabId: tab?.id,
    host,
    siteDomain,
    cookieCount: cookies.length,
    cookies: cookies.map(serializeCookie),
    settings,
    whitelisted: siteDomain ? isSiteProtectedNow(siteDomain, settings.whitelist) : false
  };
}

async function hydrateTabs() {
  tabHosts.clear();
  const tabs = await chrome.tabs.query({});
  tabs.forEach((tab) => {
    if (tab.url) {
      const host = getHostname(tab.url);
      if (host) {
        tabHosts.set(tab.id, host);
      }
    }
  });
  await writeStoredTabHosts(Object.fromEntries(tabHosts));
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id) {
    await updateBadge(active.id);
  }
}

async function updateTrackedTab(tabId, url) {
  const host = getHostname(url);
  const storedHosts = await readStoredTabHosts();
  if (host) {
    tabHosts.set(tabId, host);
    storedHosts[tabId] = host;
  } else {
    tabHosts.delete(tabId);
    delete storedHosts[tabId];
  }
  await writeStoredTabHosts(storedHosts);
}

async function cleanupClosedSite(hostname) {
  const settings = await getSettings();
  await ensureProtectedSiteDomains(settings);
  const siteDomain = getSiteDomain(hostname);
  const trackedHosts = await getCurrentTrackedHosts();
  const hasAnotherTab = trackedHosts.some((host) => getSiteDomain(host) === siteDomain);
  if (hasAnotherTab || isSiteProtectedNow(siteDomain, settings.whitelist)) {
    return;
  }

  await removeCookiesForHost(hostname, { respectWhitelist: true });
  await maybeClearLocalStorageForHost(hostname);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id) {
    await updateBadge(active.id);
  }
}

async function removeCookiesForHost(hostname, options = { respectWhitelist: true }) {
  const settings = await getSettings();
  await ensureProtectedSiteDomains(settings);
  const siteDomain = getSiteDomain(hostname);
  if (options.respectWhitelist && isSiteProtectedNow(siteDomain, settings.whitelist)) {
    return;
  }

  const cookies = await collectCookiesForSite(hostname, settings.removePartitionedCookies);
  const cookiesForSite = cookies.filter((cookie) => (
    cookieBelongsToSite(cookie, hostname, siteDomain, settings.removePartitionedCookies)
  ));

  const cookiesToRemove = cookiesForSite.filter((cookie) => {
    const cookieHost = cookie.domain.replace(/^\./, "");
    if (options.respectWhitelist && (
      isCookieProtected(cookieHost, settings.whitelist)
      || isCookiePartitionProtected(cookie, settings.whitelist)
    )) {
      return false;
    }
    return true;
  });

  const removals = await Promise.allSettled(cookiesToRemove.map(removeCookie));
  await recordRemovedCookies(removals.filter((result) => result.status === "fulfilled" && result.value).length);
}

async function maybeClearLocalStorageForHost(hostname) {
  const settings = await getSettings();
  if (!settings.clearLocalStorage) {
    return;
  }

  await removeLocalStorageForOrigin(`http://${hostname}`);
  await removeLocalStorageForOrigin(`https://${hostname}`);
}

async function maybeClearLocalStorageForUrl(url) {
  const settings = await getSettings();
  if (!settings.clearLocalStorage) {
    return;
  }
  await removeLocalStorageForOrigin(url);
}

async function removeLocalStorageForOrigin(url) {
  try {
    const origin = new URL(url).origin;
    await chrome.browsingData.remove({ origins: [origin] }, { localStorage: true });
  } catch {
    // Ignore non-web pages and unsupported origins.
  }
}

async function getCookiesForHost(hostname) {
  const settings = await getSettings();
  const siteDomain = getSiteDomain(hostname);
  const cookies = await collectCookiesForSite(hostname, settings.removePartitionedCookies);

  return cookies.filter((cookie) => (
    cookieBelongsToSite(cookie, hostname, siteDomain, settings.removePartitionedCookies)
  ));
}

async function updateBadge(tabId) {
  if (!tabId) {
    await safeActionCall(() => chrome.action.setBadgeText({ text: "" }));
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    return;
  }

  const host = getHostname(tab?.url || "");
  if (!host) {
    await safeActionCall(() => chrome.action.setBadgeText({ tabId, text: "" }));
    const settings = await getSettings();
    await setTabIcon(tabId, settings.iconTheme, false);
    return;
  }

  const settings = await getSettings();
  const whitelisted = isSiteProtectedNow(getSiteDomain(host), settings.whitelist);
  const cookies = await getCookiesForHost(host);
  if (!await tabExists(tabId)) {
    return;
  }

  const count = cookies.length > 999 ? "999+" : String(cookies.length);
  await safeActionCall(() => chrome.action.setBadgeText({ tabId, text: cookies.length ? count : "" }));
  await safeActionCall(() => chrome.action.setBadgeBackgroundColor({ tabId, color: "#167D7F" }));
  await safeActionCall(() => chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }));
  await setTabIcon(tabId, settings.iconTheme, whitelisted);
}

async function addWhitelistEntry(pattern) {
  const settings = await getSettings();
  const normalized = normalizePattern(pattern);
  const siteDomain = getPatternSiteDomain(normalized);
  if (siteDomain) {
    protectedSiteDomains.add(siteDomain);
    await persistProtectedSiteDomains();
    await clearScheduledCleanup(siteDomain);
  }
  const nextWhitelist = [...settings.whitelist, normalized];
  const saved = await saveSettings({ ...settings, whitelist: nextWhitelist });
  await hydrateProtectedSiteDomains(saved);
  await refreshActiveTabIcon();
  return saved;
}

async function removeWhitelistEntry(pattern) {
  const settings = await getSettings();
  const normalized = normalizePattern(pattern);
  const nextWhitelist = settings.whitelist.filter((item) => item !== normalized);
  const saved = await saveSettings({ ...settings, whitelist: nextWhitelist });
  await hydrateProtectedSiteDomains(saved);
  await refreshActiveTabIcon();
  return saved;
}

async function toggleWhitelistEntry(pattern) {
  const settings = await getSettings();
  const normalized = normalizePattern(pattern);
  const exists = settings.whitelist.includes(normalized);
  return exists ? removeWhitelistEntry(normalized) : addWhitelistEntry(normalized);
}

async function applySettings() {
  const settings = await getSettings();
  const icon = settings.iconTheme === "dark" ? "dark" : "light";

  await setThemeIcon(icon, false);

  await chrome.action.setPopup({
    popup: settings.quickActionEnabled ? "" : "popup.html"
  });

  await syncContextMenu(settings);
  await refreshActiveTabIcon();
}

async function readStoredTabHosts() {
  const stored = await chrome.storage.session.get({ [TAB_HOSTS_KEY]: {} });
  return stored[TAB_HOSTS_KEY] || {};
}

async function writeStoredTabHosts(hosts) {
  await chrome.storage.session.set({ [TAB_HOSTS_KEY]: hosts });
}

async function getCurrentTrackedHosts() {
  const storedHosts = await readStoredTabHosts();
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map((tab) => String(tab.id)));
  const hosts = [];

  tabs.forEach((tab) => {
    const host = getHostname(tab.url || "");
    if (host) {
      hosts.push(host);
      storedHosts[tab.id] = host;
      tabHosts.set(tab.id, host);
    }
  });

  Object.keys(storedHosts).forEach((tabId) => {
    if (!liveIds.has(String(tabId))) {
      delete storedHosts[tabId];
    }
  });
  await writeStoredTabHosts(storedHosts);

  return [...new Set([...hosts, ...Object.values(storedHosts)])].filter(Boolean);
}

async function setThemeIcon(theme, whitelisted) {
  if (typeof OffscreenCanvas === "undefined") {
    return;
  }

  const imageData = Object.fromEntries(
    ICON_SIZES.map((size) => [size, drawIconImageData(size, theme, whitelisted)])
  );
  await safeActionCall(() => chrome.action.setIcon({ imageData }));
}

async function setTabIcon(tabId, theme, whitelisted) {
  if (typeof OffscreenCanvas === "undefined") {
    return;
  }
  if (!await tabExists(tabId)) {
    return;
  }

  const imageData = Object.fromEntries(
    ICON_SIZES.map((size) => [size, drawIconImageData(size, theme, whitelisted)])
  );
  await safeActionCall(() => chrome.action.setIcon({ tabId, imageData }));
}

function drawIconImageData(size, theme, whitelisted) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  const scale = size / 128;
  const color = whitelisted
    ? "#18A66F"
    : theme === "dark" ? "#C9CED2" : "#4E5357";

  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(2.5, 15 * scale);
  context.lineCap = "round";
  context.lineJoin = "round";

  context.beginPath();
  context.arc(64 * scale, 64 * scale, 45 * scale, 0, Math.PI * 2);
  context.stroke();

  context.globalCompositeOperation = "destination-out";
  [
    [93, 30, 18],
    [105, 48, 18],
    [111, 66, 18]
  ].forEach(([x, y, radius]) => {
    context.beginPath();
    context.arc(x * scale, y * scale, radius * scale, 0, Math.PI * 2);
    context.fill();
  });
  context.globalCompositeOperation = "source-over";

  drawChip(context, 44, 43, scale);
  drawChip(context, 55, 78, scale);
  drawChip(context, 78, 66, scale);

  return context.getImageData(0, 0, size, size);
}

function drawChip(context, x, y, scale) {
  context.beginPath();
  context.arc(x * scale, y * scale, Math.max(1.5, 5 * scale), 0, Math.PI * 2);
  context.fill();
}

async function refreshActiveTabIcon() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id) {
    await updateBadge(active.id);
  }
}

async function scheduleCleanup(hostname) {
  const siteDomain = getSiteDomain(hostname);
  const settings = await getSettings();
  await ensureProtectedSiteDomains(settings);
  if (isSiteProtectedNow(siteDomain, settings.whitelist)) {
    await clearScheduledCleanup(siteDomain);
    return;
  }

  const delayMs = Math.max(0, settings.cleanupDelaySeconds) * 1000;
  const runAt = Date.now() + delayMs;
  const pending = await readPendingCleanups();
  pending[siteDomain] = { hostname, runAt };
  await writePendingCleanups(pending);

  clearTimeout(cleanupTimers.get(siteDomain));
  await chrome.alarms.clear(`${CLEANUP_ALARM_PREFIX}${siteDomain}`);
  if (delayMs === 0) {
    await runScheduledCleanup(siteDomain);
    return;
  }

  await chrome.alarms.create(`${CLEANUP_ALARM_PREFIX}${siteDomain}`, { when: runAt });
  cleanupTimers.set(siteDomain, setTimeout(() => {
    cleanupTimers.delete(siteDomain);
    runScheduledCleanup(siteDomain);
  }, delayMs));
}

async function clearScheduledCleanup(siteDomain) {
  const pending = await readPendingCleanups();
  if (siteDomain in pending) {
    delete pending[siteDomain];
    await writePendingCleanups(pending);
  }
  clearTimeout(cleanupTimers.get(siteDomain));
  cleanupTimers.delete(siteDomain);
  await chrome.alarms.clear(`${CLEANUP_ALARM_PREFIX}${siteDomain}`);
}

function scheduleBadgeUpdate(tabId) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(tabId, setTimeout(() => {
    badgeTimers.delete(tabId);
    updateBadge(tabId);
  }, 750));
}

async function tabExists(tabId) {
  if (!tabId) {
    return false;
  }
  return Boolean(await chrome.tabs.get(tabId).catch(() => null));
}

async function safeActionCall(action) {
  try {
    await action();
  } catch {
    // Tabs can disappear between async cookie reads and action updates.
  }
}

async function removeCookieByKey(key) {
  const { storeId, domain, path, name, secure, partitionKey } = parseCookieKey(key);
  if (!domain || !name) {
    return;
  }
  await chrome.cookies.remove({
    url: cookieUrl({ domain, path, secure }),
    name,
    storeId,
    ...(partitionKey ? { partitionKey } : {})
  }).then((result) => recordRemovedCookies(result ? 1 : 0));
}

function serializeCookie(cookie) {
  return {
    key: cookieKey(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    partitioned: Boolean(cookie.partitionKey),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    expirationDate: cookie.expirationDate
  };
}

function cookieBelongsToSite(cookie, hostname, siteDomain, includePartitioned) {
  const cookieHost = cookie.domain.replace(/^\./, "");
  const domainMatches = cookieMatchesHost(cookie, hostname) || getSiteDomain(cookieHost) === siteDomain;

  if (!cookie.partitionKey) {
    return domainMatches;
  }

  if (!includePartitioned) {
    return false;
  }

  return domainMatches || getCookiePartitionSiteDomain(cookie) === siteDomain;
}

async function collectCookiesForSite(hostname, includePartitioned) {
  const siteDomain = getSiteDomain(hostname);
  const queries = [
    chrome.cookies.getAll({ domain: siteDomain })
  ];

  if (hostname && hostname !== siteDomain) {
    queries.push(chrome.cookies.getAll({ domain: hostname }));
  }

  if (includePartitioned && siteDomain) {
    queries.push(...getPartitionKeyCandidates(siteDomain, hostname).map((partitionKey) => (
      chrome.cookies.getAll({ partitionKey }).catch(() => [])
    )));
  }

  const results = await Promise.all(queries);
  return uniqueCookies(results.flat());
}

function getPartitionKeyCandidates(siteDomain, hostname) {
  const topLevelSites = [...new Set([
    `https://${siteDomain}`,
    `http://${siteDomain}`,
    hostname ? `https://${hostname}` : "",
    hostname ? `http://${hostname}` : ""
  ].filter(Boolean))];

  return topLevelSites.flatMap((topLevelSite) => [
    { topLevelSite },
    { topLevelSite, hasCrossSiteAncestor: true },
    { topLevelSite, hasCrossSiteAncestor: false }
  ]);
}

function uniqueCookies(cookies) {
  const seen = new Set();
  return cookies.filter((cookie) => {
    const key = cookieKey(cookie);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getCookiePartitionSiteDomain(cookie) {
  const topLevelSite = cookie.partitionKey?.topLevelSite;
  return topLevelSite ? getSiteDomain(getHostname(topLevelSite)) : "";
}

async function runScheduledCleanup(siteDomain) {
  const pending = await readPendingCleanups();
  const cleanup = pending[siteDomain];
  if (!cleanup) {
    return;
  }

  const settings = await getSettings();
  await ensureProtectedSiteDomains(settings);
  if (isSiteProtectedNow(siteDomain, settings.whitelist)) {
    delete pending[siteDomain];
    await writePendingCleanups(pending);
    return;
  }

  delete pending[siteDomain];
  await writePendingCleanups(pending);
  await cleanupClosedSite(cleanup.hostname);
}

async function processOverdueCleanups() {
  const pending = await readPendingCleanups();
  const now = Date.now();
  await Promise.all(Object.entries(pending).map(async ([siteDomain, cleanup]) => {
    if (cleanup.runAt <= now) {
      await runScheduledCleanup(siteDomain);
    } else {
      await chrome.alarms.create(`${CLEANUP_ALARM_PREFIX}${siteDomain}`, { when: cleanup.runAt });
    }
  }));
}

async function readPendingCleanups() {
  const stored = await chrome.storage.session.get({ [PENDING_CLEANUPS_KEY]: {} });
  return stored[PENDING_CLEANUPS_KEY] || {};
}

async function writePendingCleanups(cleanups) {
  await chrome.storage.session.set({ [PENDING_CLEANUPS_KEY]: cleanups });
}

async function syncContextMenu(settings) {
  contextMenuSync = contextMenuSync.then(() => syncContextMenuNow(settings));
  return contextMenuSync.catch(() => {});
}

async function syncContextMenuNow(settings) {
  if (!chrome.contextMenus) {
    return;
  }

  const hasPermission = await chrome.permissions.contains({ permissions: ["contextMenus"] });
  if (!hasPermission) {
    return;
  }

  await removeContextMenuItem(CONTEXT_MENU_ID);
  await removeContextMenuItem(CONTEXT_REMOVE_COOKIES_ID);

  if (settings.contextMenuEnabled) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    await createContextMenuItem({
      id: CONTEXT_MENU_ID,
      title: await getContextWhitelistTitle(active?.url || ""),
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
    await createContextMenuItem({
      id: CONTEXT_REMOVE_COOKIES_ID,
      title: getMessage("contextRemoveCookies"),
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
  }
}

async function createContextMenuItem(item) {
  const created = await createContextMenu(item);
  if (!created) {
    await updateContextMenu(item.id, { title: item.title });
  }
}

async function removeContextMenuItem(id) {
  await removeContextMenu(id);
}

async function updateContextMenuTitle(url) {
  const settings = await getSettings();
  if (!settings.contextMenuEnabled || !chrome.contextMenus) {
    return;
  }
  const hasPermission = await chrome.permissions.contains({ permissions: ["contextMenus"] });
  if (!hasPermission) {
    return;
  }
  try {
    await updateContextMenu(CONTEXT_MENU_ID, {
      title: await getContextWhitelistTitle(url)
    });
  } catch {
    // The item may not exist yet; syncContextMenu will recreate it.
  }
}

function createContextMenu(item) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(item, () => {
      const error = chrome.runtime.lastError;
      resolve(!error);
    });
  });
}

function removeContextMenu(id) {
  return new Promise((resolve) => {
    chrome.contextMenus.remove(id, () => {
      const error = chrome.runtime.lastError;
      resolve(!error);
    });
  });
}

function updateContextMenu(id, changes) {
  return new Promise((resolve) => {
    chrome.contextMenus.update(id, changes, () => {
      const error = chrome.runtime.lastError;
      resolve(!error);
    });
  });
}

async function getContextWhitelistTitle(url) {
  const host = getHostname(url);
  const siteDomain = getSiteDomain(host);
  const settings = await getSettings();
  return siteDomain && isSiteProtectedNow(siteDomain, settings.whitelist)
    ? getMessage("contextRemoveDomain")
    : getMessage("contextAddDomain");
}

function isSiteProtected(siteDomain, whitelist) {
  return isWhitelisted(siteDomain, whitelist)
    || whitelist.some((pattern) => getPatternSiteDomain(pattern) === siteDomain);
}

function isSiteProtectedNow(siteDomain, whitelist) {
  return protectedSiteDomains.has(siteDomain) || isSiteProtected(siteDomain, whitelist);
}

function isCookieProtected(cookieHost, whitelist) {
  const siteDomain = getSiteDomain(cookieHost);
  return isSiteProtected(siteDomain, whitelist) || isWhitelisted(cookieHost, whitelist);
}

function isCookiePartitionProtected(cookie, whitelist) {
  const partitionSiteDomain = getCookiePartitionSiteDomain(cookie);
  return Boolean(partitionSiteDomain && isSiteProtectedNow(partitionSiteDomain, whitelist));
}

function getPatternSiteDomain(pattern) {
  return getSiteDomain(normalizePattern(pattern).replace(/^\*\./, ""));
}

async function hydrateProtectedSiteDomains(settings = null) {
  const currentSettings = settings || await getSettings();
  protectedSiteDomains = new Set(
    currentSettings.whitelist.map(getPatternSiteDomain).filter(Boolean)
  );
  await persistProtectedSiteDomains();
}

async function ensureProtectedSiteDomains(settings) {
  const session = await chrome.storage.session.get({ [PROTECTED_SITES_KEY]: [] });
  protectedSiteDomains = new Set([
    ...(session[PROTECTED_SITES_KEY] || []),
    ...settings.whitelist.map(getPatternSiteDomain).filter(Boolean)
  ]);
}

async function persistProtectedSiteDomains() {
  const domains = [...protectedSiteDomains].filter(Boolean);
  await chrome.storage.session.set({ [PROTECTED_SITES_KEY]: domains });
}

async function clearNonWhitelistedCookiesOnStartup() {
  const settings = await getSettings();
  if (!settings.clearCookiesOnStartup) {
    return;
  }
  await ensureProtectedSiteDomains(settings);

  const cookies = await chrome.cookies.getAll({});
  const cookiesToRemove = cookies.filter((cookie) => {
    const host = cookie.domain.replace(/^\./, "");
    if (isCookieProtected(host, settings.whitelist) || isCookiePartitionProtected(cookie, settings.whitelist)) {
      return false;
    }
    if (cookie.partitionKey && !settings.removePartitionedCookies) {
      return false;
    }
    return true;
  });

  const removals = await Promise.allSettled(cookiesToRemove.map(removeCookie));
  await recordRemovedCookies(removals.filter((result) => result.status === "fulfilled" && result.value).length);
}

function removeCookie(cookie) {
  return chrome.cookies.remove({
    url: cookieUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
  });
}

async function recordRemovedCookies(count) {
  if (!count) {
    return;
  }
  const settings = await getSettings();
  await saveSettings({ ...settings, totalCookiesRemoved: settings.totalCookiesRemoved + count });
}
