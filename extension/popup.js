const $ = (id) => document.getElementById(id);

function describe(info, globalScope) {
  if (info.scope === "tab") {
    return {
      title: "This tab",
      note:
        globalScope === "tab" || !info.domain
          ? "The layout belongs to this tab and follows it to any site. It's forgotten when the tab or browser closes."
          : `The layout belongs to this tab while it's on ${info.domain}; other sites use their saved layout. It's forgotten when the tab or browser closes.`,
      label: "Keyboard layout for this tab",
    };
  }
  if (info.scope === "host") {
    return {
      title: info.key,
      note: info.host === info.domain
        ? `Only ${info.host} itself. Its subdomains have their own layouts.`
        : `Only this subdomain. Other parts of ${info.domain} have their own layouts.`,
      label: "Keyboard layout for this subdomain",
    };
  }
  return {
    title: info.key,
    note: info.host === info.domain
      ? `Applies to ${info.domain} and all its subdomains.`
      : `Applies to all of ${info.domain}, including ${info.host}.`,
    label: "Keyboard layout for this site",
  };
}

async function render() {
  const [status, cur] = await Promise.all([ask("status"), ask("current")]);
  const layouts = status.host.layouts || [];
  if (!status.host.ok) showHostError($("error"), status.host.error);

  if (!cur.info) {
    $("nosite").classList.remove("hidden");
    $("site").classList.add("hidden");
    return;
  }
  const { info, entry, effective } = cur;
  $("site").classList.remove("hidden");
  $("nosite").classList.add("hidden");

  const d = describe(info, status.settings.scope);
  $("key").textContent = d.title;
  $("scopeNote").textContent = d.note;
  $("layoutLabel").textContent = d.label;

  fillLayoutSelect($("layout"), layouts, (entry && entry.hkl) || effective, effective ? "" : "Not saved yet");
  $("locked").checked = !!(entry && entry.locked);

  // Per-domain choice only makes sense on an actual website.
  $("scopeBox").classList.toggle("hidden", !info.domain);
  if (info.domain) {
    $("scopeTitle").textContent = `How to treat ${info.domain}`;
    $("scopeDomain").textContent = `One layout for all of ${info.domain}`;
    for (const r of document.querySelectorAll('input[name="scope"]')) {
      r.checked = r.value === info.scope;
      r.onchange = async () => {
        await ask("setDomainScope", { domain: info.domain, scope: r.value });
        render();
      };
    }
  }

  $("layout").onchange = () => {
    if ($("layout").value) ask("setSite", { key: info.key, hkl: $("layout").value });
  };
  $("locked").onchange = () =>
    ask("setSite", { key: info.key, locked: $("locked").checked, hkl: $("layout").value || undefined });
}

$("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

render();
