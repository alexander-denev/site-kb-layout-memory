// Site Layout Memory - background service worker.
//
// Every website remembers its own Windows keyboard layout, saved on disk so it
// survives browser restarts and reboots.
//
//  - "Site" = the registrable domain (mail.google.com -> google.com, bbc.co.uk stays
//    bbc.co.uk) or, if you choose, each subdomain separately. Configurable globally
//    and per domain.
//  - When you switch tab, switch browser window, come back to the browser, or a tab
//    navigates to another site, that site's layout is applied.
//  - When you change the layout while on a site, the helper reports it within a
//    quarter second and it is saved for that site straight away.

importScripts("vendor/tldts.umd.min.js");

const HOST_NAME = "com.tablayoutmemory.host";
const DEFAULT_SETTINGS = {
  scope: "domain",        // "domain" = whole site, "host" = each subdomain separately
  siteScopes: {},         // per-domain override: { "google.com": "host" }
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
//   storage.local   sites:    { "google.com": { hkl: "0x4220422", locked: true } }   (on disk)
//   storage.sync    settings  (DEFAULT_SETTINGS)                                     (on disk, synced)
//   storage.session focus:    { tabId, key, focused }   which site is in front now
// ---------------------------------------------------------------------------
async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  s.siteScopes = s.siteScopes || {};
  return s;
}

async function getSites() {
  const { sites } = await chrome.storage.local.get({ sites: {} });
  return sites;
}

async function setSites(sites) {
  await chrome.storage.local.set({ sites });
}

async function getFocus() {
  const { focus } = await chrome.storage.session.get({ focus: { tabId: null, key: null, focused: true } });
  return focus;
}

async function setFocus(focus) {
  await chrome.storage.session.set({ focus });
}

// Save `hkl` as the layout of `key` (unless the site is locked).
async function learn(key, hkl) {
  if (!key || !hkl) return;
  const sites = await getSites();
  const entry = sites[key] || {};
  if (entry.locked || entry.hkl === hkl) return;
  sites[key] = { ...entry, hkl };
  await setSites(sites);
}

// ---------------------------------------------------------------------------
// Which site is this URL?
// ---------------------------------------------------------------------------
function siteInfo(url, settings) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null; // new tab page, settings, files...
  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (!host) return null;
  const domain = tldts.getDomain(host, { allowPrivateDomains: true }) || host; // localhost, IPs -> as is
  const scope = settings.siteScopes[domain] || settings.scope;
  return { key: scope === "host" ? host : domain, domain, host, scope };
}

function savedLayout(info, sites) {
  const own = sites[info.key];
  if (own && own.hkl) return own.hkl;
  // Splitting a domain into subdomains: until a subdomain has its own layout,
  // fall back to what the whole site had.
  if (info.key !== info.domain && sites[info.domain] && sites[info.domain].hkl) return sites[info.domain].hkl;
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
  const info = siteInfo(tab.url || "", settings);
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

  const sites = await getSites();
  let target = savedLayout(info, sites);
  if (!target && settings.newSiteMode === "fixed") target = settings.newSiteLayout;

  const res = await callHost("swap", { target: target || "" });
  // Browser isn't the window in front (e.g. a tab changed while you were in another
  // program): nothing changed; it will be applied when you come back.
  if (!res.foreground) return;
  hostGen = res.gen;

  // A change you made a split second before switching may not have been reported
  // yet; the helper hands it back as `prev`.
  if (!fromOutside && focus.key && focus.key !== key && res.prev) await learn(focus.key, res.prev);
  // A site seen for the first time keeps the layout it started with.
  if (!sites[key] && res.now) await learn(key, res.now);

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
    const info = tab ? siteInfo(tab.url || "", settings) : null;
    if (!info) return { info: null };
    const sites = await getSites();
    return { info, entry: sites[info.key] || null, effective: savedLayout(info, sites) };
  },

  async sites() {
    return { sites: await getSites() };
  },

  async setSite({ key, hkl, locked }) {
    const sites = await getSites();
    const entry = { ...(sites[key] || {}) };
    if (hkl !== undefined) entry.hkl = hkl;
    if (locked !== undefined) entry.locked = !!locked;
    sites[key] = entry;
    await setSites(sites);
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
    const sites = await getSites();
    delete sites[key];
    await setSites(sites);
    return { ok: true };
  },

  async forgetAll() {
    await setSites({});
    return { ok: true };
  },

  // scope: "domain" | "host" | null (null = follow the global setting)
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
