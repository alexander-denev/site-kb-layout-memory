// Tab Layout Memory — background service worker.
//
// How it works:
//   Windows keeps one keyboard layout for the whole browser, because every tab
//   lives in the same browser process. So whenever you switch to another tab
//   (or another browser window), we ask the helper program to:
//     1. read the layout that is active right now  -> that belongs to the tab you are leaving
//     2. switch to the layout remembered for the tab you are entering (if any)
//   That is exactly what Windows does per window, just one level deeper.

const HOST_NAME = "com.tablayoutmemory.host";
const DEFAULT_SETTINGS = { newTabMode: "keep", newTabLayout: "" };

// ---------------------------------------------------------------------------
// Native helper connection (request/response over one persistent port).
// An open native port also keeps this service worker alive.
// ---------------------------------------------------------------------------
let port = null;
let nextId = 1;
const pending = new Map();
let lastHostError = null;

function getPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((msg) => {
    const p = pending.get(msg && msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    lastHostError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Helper disconnected";
    port = null;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(lastHostError));
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
    lastHostError = null;
    return msg;
  });
}

// ---------------------------------------------------------------------------
// State: which layout each tab had, and which tab we think is in front.
// Mirrored to storage.session so it survives a service-worker restart
// (it is cleared when the browser closes, like Windows forgets closed windows).
// ---------------------------------------------------------------------------
let state = null;

async function getState() {
  if (!state) {
    const s = await chrome.storage.session.get(["layouts", "current"]);
    state = { layouts: s.layouts || {}, current: s.current ?? null };
  }
  return state;
}

function saveState() {
  return chrome.storage.session.set({ layouts: state.layouts, current: state.current });
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

// All events go through one queue so quick tab-hopping can't interleave.
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((e) => console.warn("[Tab Layout Memory]", e && e.message ? e.message : e));
  return queue;
}

// The core: the user is now looking at `tabId`.
async function switchTo(tabId) {
  const st = await getState();
  if (tabId == null || tabId === st.current) return;

  let target = st.layouts[tabId] || "";
  if (!target) {
    const settings = await getSettings();
    if (settings.newTabMode === "fixed" && settings.newTabLayout) target = settings.newTabLayout;
  }

  const res = await callHost("swap", { target });

  // If the browser was not the foreground app (e.g. a tab changed while you were
  // in another program), nothing was read or changed. We keep `current` as it was,
  // so the swap happens properly when the browser window gets focus again.
  if (!res.foreground) return;

  if (st.current != null && res.prev && (await tabStillOpen(st.current))) st.layouts[st.current] = res.prev;
  if (res.now) st.layouts[tabId] = res.now;
  st.current = tabId;
  await saveState();
}

async function tabStillOpen(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (_) {
    return false;
  }
}

async function activeTabOfWindow(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab ? tab.id : null;
}

// Record which tab is in front without changing anything (on install / browser start).
async function syncCurrentTab() {
  try {
    const win = await chrome.windows.getLastFocused();
    const st = await getState();
    if (st.current == null && win) {
      st.current = await activeTabOfWindow(win.id);
      await saveState();
    }
  } catch (_) { /* no windows yet */ }
}

// ---------------------------------------------------------------------------
// Browser events
// ---------------------------------------------------------------------------

// Switched tab inside a window.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  enqueue(async () => {
    const focused = await chrome.windows.getLastFocused().catch(() => null);
    // A tab changing in a background window (e.g. you closed it there) is not a
    // switch of what you are typing into; the window-focus event handles that later.
    if (focused && focused.id !== windowId) return;
    await switchTo(tabId);
  });
});

// Switched to another browser window (or came back to the browser from another app).
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // left the browser: Windows handles that
  enqueue(async () => {
    const tabId = await activeTabOfWindow(windowId);
    await switchTo(tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    const st = await getState();
    delete st.layouts[tabId];
    // `current` may still point at the closed tab until the next switch; switchTo()
    // checks the tab still exists before saving a layout for it.
    await saveState();
  });
});

// Chrome sometimes swaps a tab for a pre-rendered one with a new id.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const st = await getState();
    if (st.layouts[removedTabId]) st.layouts[addedTabId] = st.layouts[removedTabId];
    delete st.layouts[removedTabId];
    if (st.current === removedTabId) st.current = addedTabId;
    await saveState();
  });
});

chrome.runtime.onInstalled.addListener(() => enqueue(syncCurrentTab));
chrome.runtime.onStartup.addListener(() => enqueue(syncCurrentTab));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Options page asks for status / installed layouts.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "status") {
    callHost("list")
      .then((res) => sendResponse({ ok: true, layouts: res.layouts || [], active: res.active || "", hostVersion: res.version || "" }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true; // async response
  }
  if (msg && msg.type === "forget") {
    enqueue(async () => {
      const st = await getState();
      st.layouts = {};
      await saveState();
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Connect right away so the helper is ready before the first tab switch.
try { getPort(); } catch (_) { /* reported on the options page */ }
