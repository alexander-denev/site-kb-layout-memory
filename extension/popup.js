const $ = (id) => document.getElementById(id);

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

  $("key").textContent = info.key;
  $("scopeNote").textContent =
    info.scope === "host"
      ? info.host === info.domain
        ? `Only ${info.host} itself. Its subdomains have their own layouts.`
        : `Only this subdomain. Other parts of ${info.domain} have their own layouts.`
      : info.host === info.domain
        ? `Applies to ${info.domain} and all its subdomains.`
        : `Applies to all of ${info.domain}, including ${info.host}.`;

  fillLayoutSelect($("layout"), layouts, (entry && entry.hkl) || effective, effective ? "" : "Not saved yet");
  $("locked").checked = !!(entry && entry.locked);

  $("scopeTitle").textContent = `How to treat ${info.domain}`;
  $("scopeDomain").textContent = `One layout for all of ${info.domain}`;
  for (const r of document.querySelectorAll('input[name="scope"]')) r.checked = r.value === info.scope;

  $("layout").onchange = () => {
    if ($("layout").value) ask("setSite", { key: info.key, hkl: $("layout").value });
  };
  $("locked").onchange = () =>
    ask("setSite", { key: info.key, locked: $("locked").checked, hkl: $("layout").value || undefined });
  for (const r of document.querySelectorAll('input[name="scope"]')) {
    r.onchange = async () => {
      await ask("setDomainScope", { domain: info.domain, scope: r.value });
      render();
    };
  }
}

$("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

render();
