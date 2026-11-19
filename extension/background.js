// Site Layout Memory - background service worker.
//
// Remembers a Windows keyboard layout per "place", where a place is one of:
//   domain - the registrable domain (mail.google.com -> google.com; bbc.co.uk stays bbc.co.uk)
//   host   - each subdomain separately (mail.google.com, docs.google.com)
//   tab    - each browser tab, whatever site it shows
// The choice is global, with optional per-domain overrides.
//
// Domain/subdomain layouts are saved on disk (storage.local) and survive reboots.
// Tab layouts live in storage.session: tab ids change every browser session, so
// they are forgotten when the browser closes, the way Windows forgets a closed window.
//
// When you switch tab, switch browser window, come back to the browser, or a tab
// navigates elsewhere, the layout for the new place is applied. When you change the
// layout, the helper reports it within a quarter second and it's saved immediately.

importScripts("vendor/tldts.umd.min.js");

const HOST_NAME = "com.tablayoutmemory.host";
const DEFAULT_SETTINGS = {
  scope: "domain",        // "domain" = whole site, "host" = each subdomain, "tab" = each tab
  siteScopes: {},         // per-domain override: { "google.com": "host", "chatgpt.com": "tab" }
  newSiteMode: "keep",    // "keep" = start with the active layout, "fixed" = use newSiteLayout
  newSiteLayout: "",
};

// ---------------------------------------------------------------------------
// Helper connection
// ---------------------------------------------------------------------------
let port = null;
let nextId = 1;
const pending = new Map();
let hostGen = 0; // generation of the helper's last switch; older change reports are stale

function getPort() {
  if (port) return port;
  hostGen = 0;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((msg) => {
    if (msg && msg.event === "layout") {
      enqueue(() => onLayoutChanged(msg.hkl, msg.gen));
      return;
    }
    const p = pending.get(msg && msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Helper disconnected";
    port = null;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(err));
    }
    pending.clear();
  });
  return port;
}

function callHost(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error("Helper did not answer in time"));
    }, 3000);
    pending.set(id, { resolve, reject, timer });
    try {
      getPort().postMessage({ id, cmd, ...args });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  }).then((msg) => {
    if (msg.error) throw new Error(msg.error);
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Storage
//   storage.local   sites:    { "google.com": { hkl: "0x4220422", locked: true } }  (on disk)
//   storage.session tabs:     { "tab:1234":   { hkl: "0x4090409" } }               (memory, this session)
//   storage.sync    settings  (DEFAULT_SETTINGS)                                    (on disk, synced)
//   storage.session focus:    { tabId, key, focused }   which place is in front now
// ---------------------------------------------------------------------------
async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  s.siteScopes = s.siteScopes || {};
  return s;
}

const tabKey = (tabId) => "tab:" + tabId;
const isTabKey = (key) => typeof key === "string" && key.startsWith("tab:");

// Each key lives in exactly one place: tab keys in session storage, sites on disk.
function areaFor(key) {
  return isTabKey(key)
    ? { area: chrome.storage.session, name: "tabs" }
    : { area: chrome.storage.local, name: "sites" };
}

async function getMap(key) {
  const { area, name } = areaFor(key);
  const got = await area.get({ [name]: {} });
  return got[name] || {};
}

async function getEntry(key) {
  if (!key) return null;
  return (await getMap(key))[key] || null;
}

// entry = null deletes it
async function setEntry(key, entry) {
  const { area, name } = areaFor(key);
  const map = await getMap(key);
  if (entry) map[key] = entry;
  else delete map[key];
  await area.set({ [name]: map });
}

async function getSites() {
  const { sites } = await chrome.storage.local.get({ sites: {} });
  return sites;
}

async function getTabEntries() {
  const { tabs } = await chrome.storage.session.get({ tabs: {} });
  return tabs;
}

async function getFocus() {
  const { focus } = await chrome.storage.session.get({ focus: { tabId: null, key: null, focused: true } });
  return focus;
}

async function setFocus(focus) {
  await chrome.storage.session.set({ focus });
}

// Save `hkl` as the layout of `key` (unless that place is locked).
async function learn(key, hkl) {
  if (!key || !hkl) return;
  const entry = (await getEntry(key)) || {};
  if (entry.locked || entry.hkl === hkl) return;
  await setEntry(key, { ...entry, hkl });
}

// ---------------------------------------------------------------------------
// Which place is this tab?
// Returns { key, scope, domain, host } or null for "leave the layout alone".
// ---------------------------------------------------------------------------
function placeInfo(tab, settings) {
  let u = null;
  try { u = new URL(tab.url || ""); } catch (_) { /* no URL yet */ }
  const isWeb = u && (u.protocol === "http:" || u.protocol === "https:") && u.hostname;

  if (!isWeb) {
    // New tab page, browser settings, local files: no domain. They only get a
    // layout when everything is per tab.
    return settings.scope === "tab" ? { key: tabKey(tab.id), scope: "tab", domain: null, host: null } : null;
  }

  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const domain = tldts.getDomain(host, { allowPrivateDomains: true }) || host; // localhost, IPs -> as is
  const scope = settings.siteScopes[domain] || settings.scope;
  const key = scope === "tab" ? tabKey(tab.id) : scope === "host" ? host : domain;
  return { key, scope, domain, host };
}

async function savedLayout(info) {
  const own = await getEntry(info.key);
  if (own && own.hkl) return own.hkl;
  // A domain just split into subdomains: until a subdomain has its own layout,
  // use what the whole domain had. (Tabs start fresh, like new windows.)
  if (info.scope === "host" && info.key !== info.domain) {
    const whole = await getEntry(info.domain);
    if (whole && whole.hkl) return whole.hkl;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.warn("[Site Layout Memory]", e && e.message ? e.message : e));
  return queue;
}

// `tab` is now what you're looking at.
//   force:       apply even if it's the same site as before (focus came back)
//   fromOutside: the active layout came from another app, so don't save it for any site
async function focusOn(tab, { force = false, fromOutside = false } = {}) {
  if (!tab) return;
  const focus = await getFocus();
  const settings = await getSettings();
  const info = placeInfo(tab, settings);
  const key = info ? info.key : null;

  if (!info) {
    // Not a website: leave the layout as it is and don't remember anything.
    await setFocus({ ...focus, tabId: tab.id, key: null });
    return;
  }
  if (!force && key === focus.key) {
    await setFocus({ ...focus, tabId: tab.id });
    return;
  }

  const known = !!(await getEntry(key));
  let target = await savedLayout(info);
  if (!target && settings.newSiteMode === "fixed") target = settings.newSiteLayout;

  const res = await callHost("swap", { target: target || "" });
  // Browser isn't the window in front (e.g. a tab changed while you were in another
  // program): nothing changed; it will be applied when you come back.
  if (!res.foreground) return;
  hostGen = res.gen;

  // A change you made a split second before switching may not have been reported
  // yet; the helper hands it back as `prev`.
  if (!fromOutside && focus.key && focus.key !== key && res.prev) await learn(focus.key, res.prev);
  // A place seen for the first time keeps the layout it started with.
  if (!known && res.now) await learn(key, res.now);

  await setFocus({ ...focus, tabId: tab.id, key, focused: true });
}

async function onLayoutChanged(hkl, gen) {
  if (gen !== hostGen) return; // reported before our last switch: belonged to the previous site
  const focus = await getFocus();
  if (focus.key && focus.focused !== false) await learn(focus.key, hkl);
}

async function activeTab(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab || null;
}

async function lastFocusedWindowId() {
  try { return (await chrome.windows.getLastFocused()).id; } catch (_) { return null; }
}

async function reapplyFront(fromOutside) {
  const win = await lastFocusedWindowId();
  if (win == null) return;
  await focusOn(await activeTab(win), { force: true, fromOutside });
}

// ---------------------------------------------------------------------------
// Browser events
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  enqueue(async () => {
    if ((await lastFocusedWindowId()) !== windowId) return; // background window; handled on focus
    await focusOn(await chrome.tabs.get(tabId));
  });
});

// Same tab, new site (link, typed address, redirect).
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url || !tab.active) return;
  enqueue(async () => {
    if ((await lastFocusedWindowId()) !== tab.windowId) return;
    await focusOn(tab);
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  enqueue(async () => {
    const focus = await getFocus();
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await setFocus({ ...focus, focused: false }); // went to another app
      return;
    }
    const fromOutside = focus.focused === false;
    await setFocus({ ...focus, focused: true });
    // Coming back from another app (which may have changed the layout), or
    // switching browser windows: put this site's layout back.
    await focusOn(await activeTab(windowId), { force: true, fromOutside });
  });
});

// Per-tab layouts: forget a tab when it closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(() => setEntry(tabKey(tabId), null));
});

// Chrome sometimes swaps a tab for a pre-rendered one with a new id: carry the layout over.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const entry = await getEntry(tabKey(removedTabId));
    if (entry) await setEntry(tabKey(addedTabId), entry);
    await setEntry(tabKey(removedTabId), null);
    const focus = await getFocus();
    if (focus.key === tabKey(removedTabId)) await setFocus({ ...focus, tabId: addedTabId, key: tabKey(addedTabId) });
  });
});

chrome.runtime.onStartup.addListener(() => enqueue(() => reapplyFront(true)));
chrome.runtime.onInstalled.addListener(() => enqueue(() => reapplyFront(true)));

// ---------------------------------------------------------------------------
// Popup / settings page requests (all changes go through the queue)
// ---------------------------------------------------------------------------
const handlers = {
  async status() {
    let host = { ok: false, error: "", layouts: [], active: "" };
    try {
      const res = await callHost("list");
      host = { ok: true, layouts: res.layouts || [], active: res.active || "", version: res.version || "" };
    } catch (e) {
      host.error = e.message || String(e);
    }
    return { host, settings: await getSettings() };
  },

  async current() {
    const settings = await getSettings();
    const win = await lastFocusedWindowId();
    const tab = win == null ? null : await activeTab(win);
    const info = tab ? placeInfo(tab, settings) : null;
    if (!info) return { info: null };
    return { info, entry: await getEntry(info.key), effective: await savedLayout(info) };
  },

  async sites() {
    return { sites: await getSites(), tabCount: Object.keys(await getTabEntries()).length };
  },

  async setSite({ key, hkl, locked }) {
    const entry = { ...((await getEntry(key)) || {}) };
    if (hkl !== undefined) entry.hkl = hkl;
    if (locked !== undefined) entry.locked = !!locked;
    await setEntry(key, entry);
    if (hkl !== undefined) {
      const focus = await getFocus();
      if (focus.key === key) {
        const res = await callHost("swap", { target: hkl });
        if (res.foreground) hostGen = res.gen;
      }
    }
    return { ok: true };
  },

  async deleteSite({ key }) {
    await setEntry(key, null);
    return { ok: true };
  },

  async forgetAll() {
    await chrome.storage.local.set({ sites: {} });
    await chrome.storage.session.set({ tabs: {} });
    return { ok: true };
  },

  // scope: "domain" | "host" | "tab" | null (null = follow the global setting)
  async setDomainScope({ domain, scope }) {
    const settings = await getSettings();
    const siteScopes = { ...settings.siteScopes };
    if (scope && scope !== settings.scope) siteScopes[domain] = scope;
    else delete siteScopes[domain];
    await chrome.storage.sync.set({ siteScopes });
    await reapplyFront(true);
    return { ok: true };
  },

  async setGlobalScope({ scope }) {
    const settings = await getSettings();
    const siteScopes = {};
    // Keep only overrides that still differ from the new global choice.
    for (const [d, s] of Object.entries(settings.siteScopes)) if (s !== scope) siteScopes[d] = s;
    await chrome.storage.sync.set({ scope, siteScopes });
    await reapplyFront(true);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  enqueue(async () => {
    try { sendResponse(await fn(msg)); }
    catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
  });
  return true;
});

// Connect right away: the helper starts watching for layout changes immediately.
try { getPort(); } catch (_) { /* shown in the popup / settings page */ }
