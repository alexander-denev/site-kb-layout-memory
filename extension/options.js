const $ = (id) => document.getElementById(id);
let layouts = [];

async function render() {
  const status = await ask("status");
  layouts = status.host.layouts || [];
  const s = status.settings;

  if (status.host.ok) {
    $("status").className = "status ok";
    $("status").textContent = `Helper connected${status.host.version ? " (v" + status.host.version + ")" : ""}. ${layouts.length} keyboard layouts installed.`;
  } else {
    $("status").className = "status bad";
    showHostError($("status"), status.host.error);
  }

  for (const r of document.querySelectorAll('input[name="scope"]')) r.checked = r.value === s.scope;
  for (const r of document.querySelectorAll('input[name="newSite"]')) r.checked = r.value === s.newSiteMode;
  fillLayoutSelect($("newSiteLayout"), layouts, s.newSiteLayout || status.host.active || (layouts[0] && layouts[0].hkl));
  $("newSiteLayout").disabled = s.newSiteMode !== "fixed";

  // Per-domain overrides
  const tbody = $("overrides");
  tbody.innerHTML = "";
  const entries = Object.entries(s.siteScopes || {}).sort(([a], [b]) => a.localeCompare(b));
  $("overridesBox").classList.toggle("hidden", entries.length === 0);
  for (const [domain, scope] of entries) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = domain;
    tr.insertCell().textContent = scope === "host" ? "Each subdomain separately" : "Whole domain";
    const btn = document.createElement("button");
    btn.textContent = "Use default";
    btn.onclick = async () => { await ask("setDomainScope", { domain, scope: null }); render(); };
    tr.insertCell().appendChild(btn);
  }

  await renderSites();
}

async function renderSites() {
  const { sites } = await ask("sites");
  const filter = $("filter").value.trim().toLowerCase();
  const keys = Object.keys(sites).sort((a, b) => a.localeCompare(b));
  $("count").textContent = keys.length ? `(${keys.length})` : "";
  const tbody = $("sites");
  tbody.innerHTML = "";
  for (const key of keys.filter((k) => !filter || k.includes(filter))) {
    const entry = sites[key];
    const tr = tbody.insertRow();
    tr.insertCell().textContent = key;

    const sel = document.createElement("select");
    fillLayoutSelect(sel, layouts, entry.hkl, entry.hkl ? "" : "Not set");
    sel.onchange = () => ask("setSite", { key, hkl: sel.value });
    tr.insertCell().appendChild(sel);

    const lock = document.createElement("input");
    lock.type = "checkbox";
    lock.checked = !!entry.locked;
    lock.onchange = () => ask("setSite", { key, locked: lock.checked });
    tr.insertCell().appendChild(lock);

    const del = document.createElement("button");
    del.textContent = "Forget";
    del.onclick = async () => { await ask("deleteSite", { key }); renderSites(); };
    tr.insertCell().appendChild(del);
  }
}

for (const r of document.querySelectorAll('input[name="scope"]')) {
  r.onchange = async () => { await ask("setGlobalScope", { scope: r.value }); render(); };
}
for (const r of document.querySelectorAll('input[name="newSite"]')) {
  r.onchange = async () => {
    await chrome.storage.sync.set({ newSiteMode: r.value, newSiteLayout: $("newSiteLayout").value });
    $("newSiteLayout").disabled = r.value !== "fixed";
  };
}
$("newSiteLayout").onchange = () => chrome.storage.sync.set({ newSiteLayout: $("newSiteLayout").value });
$("filter").oninput = renderSites;
$("forgetAll").onclick = async () => {
  if (!confirm("Forget the saved layout of every site?")) return;
  await ask("forgetAll");
  renderSites();
};

render();
