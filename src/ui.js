import {
  DEFAULT_SETTINGS,
  getSiteDomain,
  getMessage,
  getSettings,
  isValidPattern,
  isWhitelisted,
  normalizePattern,
} from "./shared.js";

const state = {
  tab: null,
  settings: DEFAULT_SETTINGS
};

document.addEventListener("DOMContentLoaded", async () => {
  localize(document);
  if (document.body.dataset.page === "popup") {
    await initPopup();
  } else {
    await initOptions();
  }
});

async function initPopup() {
  const response = await chrome.runtime.sendMessage({ type: "get-current-tab-state" });
  state.tab = response.state;
  state.settings = response.state.settings;

  bindPopupEvents();
  renderPopup();
  focusAllowInput();
}

async function initOptions() {
  state.settings = await getSettings();
  bindOptionsEvents();
  renderOptions();
}

function bindPopupEvents() {
  document.querySelector("[data-action='manual-add']").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    await addPatternFromInput(input);
  });
  document.querySelector(".popup [data-action='manual-add'] input").addEventListener("input", (event) => {
    event.currentTarget.dataset.touched = "true";
    updateAllowFormLabel();
  });
  document.querySelector("[data-action='remove-all-cookies']").addEventListener("click", removeCurrentTabCookies);
  document.querySelector("[data-action='open-options']").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

function bindOptionsEvents() {
  document.querySelector("[data-action='manual-add']").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    await addPatternFromInput(input);
  });

  document.querySelectorAll("[data-setting='iconTheme']").forEach((button) => {
    button.addEventListener("click", async () => {
      await updateSettings({ iconTheme: button.dataset.value });
    });
  });

  document.querySelector("[data-setting='quickActionEnabled']").addEventListener("change", async (event) => {
    await updateSettings({ quickActionEnabled: event.currentTarget.checked });
  });

  document.querySelector("[data-setting='clearLocalStorage']").addEventListener("change", async (event) => {
    const enabled = event.currentTarget.checked;
    if (enabled) {
      const granted = await chrome.permissions.request({ permissions: ["browsingData"] });
      if (!granted) {
        event.currentTarget.checked = false;
        return;
      }
    } else {
      await chrome.permissions.remove({ permissions: ["browsingData"] });
    }
    await updateSettings({ clearLocalStorage: enabled });
  });

  document.querySelector("[data-setting='clearCookiesOnStartup']").addEventListener("change", async (event) => {
    await updateSettings({ clearCookiesOnStartup: event.currentTarget.checked });
  });

  document.querySelector("[data-setting='removePartitionedCookies']").addEventListener("change", async (event) => {
    await updateSettings({ removePartitionedCookies: event.currentTarget.checked });
  });

  document.querySelector("[data-setting='cleanupDelaySeconds']").addEventListener("change", async (event) => {
    await updateSettings({ cleanupDelaySeconds: event.currentTarget.valueAsNumber || 0 });
  });

  document.querySelector("[data-setting='contextMenuEnabled']").addEventListener("change", async (event) => {
    const enabled = event.currentTarget.checked;
    if (enabled) {
      const granted = await chrome.permissions.request({ permissions: ["contextMenus"] });
      if (!granted) {
        event.currentTarget.checked = false;
        return;
      }
    } else {
      await chrome.permissions.remove({ permissions: ["contextMenus"] });
    }
    await updateSettings({ contextMenuEnabled: enabled });
  });

  document.querySelector("[data-action='reset-stats']").addEventListener("click", resetStats);
  document.querySelector("[data-action='export-settings']").addEventListener("click", exportSettings);
  document.querySelector("[data-action='import-settings']").addEventListener("click", () => {
    document.querySelector("[data-role='settings-file']").click();
  });
  document.querySelector("[data-action='export-whitelist']").addEventListener("click", exportWhitelist);
  document.querySelector("[data-action='import-whitelist']").addEventListener("click", () => {
    document.querySelector("[data-role='whitelist-file']").click();
  });
  document.querySelector("[data-role='settings-file']").addEventListener("change", importSettings);
  document.querySelector("[data-role='whitelist-file']").addEventListener("change", importWhitelist);
}

function renderPopup() {
  const { host, siteDomain, cookieCount, whitelisted } = state.tab;
  document.querySelector("[data-role='host']").textContent = host || "chrome://";
  document.querySelector("[data-role='host']").title = host || "";
  document.querySelector("[data-role='cookie-count']").textContent = cookieCount
    ? getMessage("cookiesActive", [String(cookieCount)])
    : getMessage("noCookies");
  document.querySelector("[data-role='status']").textContent = getMessage(whitelisted ? "protected" : "notProtected");
  document.querySelector("[data-role='status']").classList.toggle("is-protected", whitelisted);

  renderAllowForm();
  renderCookies();
}

function renderOptions() {
  document.querySelectorAll("[data-setting='iconTheme']").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.value === state.settings.iconTheme);
  });

  document.querySelector("[data-setting='quickActionEnabled']").checked = state.settings.quickActionEnabled;
  document.querySelector("[data-setting='contextMenuEnabled']").checked = state.settings.contextMenuEnabled;
  document.querySelector("[data-setting='clearLocalStorage']").checked = state.settings.clearLocalStorage;
  document.querySelector("[data-setting='clearCookiesOnStartup']").checked = state.settings.clearCookiesOnStartup;
  document.querySelector("[data-setting='removePartitionedCookies']").checked = state.settings.removePartitionedCookies;
  document.querySelector("[data-setting='cleanupDelaySeconds']").value = state.settings.cleanupDelaySeconds;
  renderStats();
  renderWhitelist();
}

function renderAllowForm() {
  const input = document.querySelector(".popup [data-action='manual-add'] input");
  const pattern = state.tab.siteDomain || "";

  if (pattern && !input.dataset.touched) {
    input.value = pattern;
  }
  updateAllowFormLabel();
}

function renderWhitelist() {
  const list = document.querySelector("[data-role='whitelist']");
  list.textContent = "";

  if (!state.settings.whitelist.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = getMessage("emptyWhitelist");
    list.append(empty);
    return;
  }

  state.settings.whitelist.forEach((pattern) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const button = document.createElement("button");
    name.textContent = pattern;
    button.type = "button";
    button.className = "icon-button";
    button.title = getMessage("removeItem");
    button.innerHTML = trashIcon();
    button.addEventListener("click", async () => removePattern(pattern));
    item.append(name, button);
    list.append(item);
  });
}

function renderCookies() {
  const list = document.querySelector("[data-role='cookies']");
  const removeAll = document.querySelector("[data-action='remove-all-cookies']");
  list.textContent = "";
  removeAll.disabled = !state.tab.cookies.length;

  if (!state.tab.cookies.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = getMessage("emptyCookies");
    list.append(empty);
    return;
  }

  state.tab.cookies.forEach((cookie) => {
    const item = document.createElement("li");
    const details = document.createElement("div");
    const name = document.createElement("strong");
    const value = document.createElement("code");
    const meta = document.createElement("span");
    const button = document.createElement("button");

    details.className = "cookie-details";
    name.textContent = cookie.name || getMessage("unnamedCookie");
    value.textContent = cookie.value || getMessage("emptyValue");
    meta.textContent = `${cookie.domain}${cookie.path} ${cookie.httpOnly ? "HttpOnly" : ""} ${cookie.secure ? "Secure" : ""} ${cookie.partitioned ? "Partitioned" : ""}`.trim();
    name.title = cookie.name;
    value.title = cookie.value;
    meta.title = meta.textContent;

    button.type = "button";
    button.className = "icon-button";
    button.title = getMessage("removeCookie");
    button.innerHTML = trashIcon();
    button.addEventListener("click", async () => removeCookie(cookie.key));

    details.append(name, value, meta);
    item.append(details, button);
    list.append(item);
  });
}

async function togglePattern(pattern) {
  if (!pattern) {
    return;
  }
  if (exactPatternExists(pattern)) {
    await removePattern(pattern);
  } else {
    await addPattern(pattern);
  }
}

async function addPatternFromInput(input) {
  const pattern = normalizePattern(input.value);
  if (!isValidPattern(pattern)) {
    input.setCustomValidity(getMessage("invalidPattern"));
    input.reportValidity();
    return;
  }
  input.setCustomValidity("");
  if (state.tab && exactPatternExists(pattern)) {
    await removePattern(pattern);
  } else {
    await addPattern(pattern);
  }
}

async function addPattern(pattern) {
  const response = await chrome.runtime.sendMessage({ type: "add-whitelist-entry", pattern });
  state.settings = response.settings;
  if (state.tab) {
    state.tab.settings = state.settings;
    state.tab.whitelisted = isSiteDomainWhitelisted(state.tab.siteDomain);
    renderPopup();
  } else {
    renderOptions();
  }
}

async function removeCookie(key) {
  const response = await chrome.runtime.sendMessage({ type: "remove-cookie", key });
  state.tab = response.state;
  state.settings = response.state.settings;
  renderPopup();
}

async function removeCurrentTabCookies() {
  const response = await chrome.runtime.sendMessage({ type: "remove-current-tab-cookies" });
  state.tab = response.state;
  state.settings = response.state.settings;
  renderPopup();
}

async function removePattern(pattern) {
  const normalized = normalizePattern(pattern);
  const response = await chrome.runtime.sendMessage({ type: "remove-whitelist-entry", pattern: normalized });
  state.settings = response.settings;
  if (state.tab) {
    state.tab.settings = state.settings;
    state.tab.whitelisted = isSiteDomainWhitelisted(state.tab.siteDomain);
    renderPopup();
  } else {
    renderOptions();
  }
}

async function updateSettings(partial) {
  const response = await chrome.runtime.sendMessage({
    type: "update-settings",
    settings: { ...state.settings, ...partial }
  });
  state.settings = response.settings;
  renderOptions();
}

async function resetStats() {
  const response = await chrome.runtime.sendMessage({ type: "reset-stats" });
  state.settings = response.settings;
  renderStats();
}

function renderStats() {
  const target = document.querySelector("[data-role='stats-total']");
  if (!target) {
    return;
  }
  target.textContent = getMessage("statsTotalCookiesRemoved", [String(state.settings.totalCookiesRemoved)]);
}

function exportSettings() {
  const { whitelist, ...settings } = state.settings;
  downloadJson("cookieflow-settings.json", {
    type: "cookieflow-settings",
    version: 1,
    settings
  });
}

function exportWhitelist() {
  downloadJson("cookieflow-whitelist.json", {
    type: "cookieflow-whitelist",
    version: 1,
    whitelist: state.settings.whitelist
  });
}

async function importSettings(event) {
  const data = await readJsonFile(event.currentTarget);
  if (!data) {
    return;
  }
  const imported = data.settings || data;
  const { whitelist, ...settingsOnly } = imported;
  state.settings = await updateSettingsDirect({ ...state.settings, ...settingsOnly });
  renderOptions();
}

async function importWhitelist(event) {
  const data = await readJsonFile(event.currentTarget);
  if (!data) {
    return;
  }
  const whitelist = Array.isArray(data) ? data : data.whitelist;
  if (!Array.isArray(whitelist)) {
    return;
  }
  state.settings = await updateSettingsDirect({ ...state.settings, whitelist });
  renderOptions();
}

async function updateSettingsDirect(settings) {
  const response = await chrome.runtime.sendMessage({
    type: "update-settings",
    settings
  });
  return response.settings;
}

function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function readJsonFile(input) {
  const [file] = input.files || [];
  input.value = "";
  if (!file) {
    return null;
  }
  return file.text().then((text) => JSON.parse(text)).catch(() => null);
}

function focusAllowInput() {
  const input = document.querySelector(".popup [data-action='manual-add'] input");
  if (!input || !state.tab.siteDomain || state.tab.whitelisted) {
    return;
  }
  input.focus();
  input.setSelectionRange(0, 0);
}

function updateAllowFormLabel() {
  const input = document.querySelector(".popup [data-action='manual-add'] input");
  const label = document.querySelector("[data-role='allow-label']");
  const submit = document.querySelector("[data-role='allow-submit']");
  if (!input || !label || !submit) {
    return;
  }

  const pattern = normalizePattern(input.value) || state.tab.siteDomain;
  const exists = pattern && exactPatternExists(pattern);
  label.textContent = getMessage(exists ? "removeDomainFromWhitelist" : "addDomainToWhitelist");
  submit.textContent = getMessage(exists ? "remove" : "add");
  submit.classList.toggle("is-danger", Boolean(exists));
}

function localize(root) {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = getMessage(node.dataset.i18n);
  });

  root.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.placeholder = getMessage(node.dataset.i18nPlaceholder);
  });

  root.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.title = getMessage(node.dataset.i18nTitle);
  });
}

function exactPatternExists(pattern) {
  return state.settings.whitelist.includes(normalizePattern(pattern));
}

function isSiteDomainWhitelisted(siteDomain) {
  if (!siteDomain) {
    return false;
  }
  return isWhitelisted(siteDomain, state.settings.whitelist)
    || state.settings.whitelist.some((pattern) => getSiteDomain(pattern.replace(/^\*\./, "")) === siteDomain);
}

function trashIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h4m-7 3h10m-8 3v6m6-6v6M8 8l.7 11h6.6L16 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
