const $ = (id) => document.getElementById(id);

// How to name the group this page belongs to, in a sentence.
function groupName(info) {
  if (info.kind === "newtab") return "the new tab page";
  if (info.kind === "browser") return placeLabel(info.domain);
  return info.domain;
}

function describe(info, globalScope) {
  if (info.scope === "tab") {
    return {
      title: "This tab",
      note:
        globalScope === "tab" || !info.domain
          ? "The layout belongs to this tab and follows it to any site. It's forgotten when the tab or browser closes."
          : `The layout belongs to this tab while it's on ${groupName(info)}; other pages use their saved layout. It's forgotten when the tab or browser closes.`,
      label: "Keyboard layout for this tab",
    };
  }
  if (info.kind === "newtab") {
    return {
      title: "New tab page",
      note: "All new tab pages share this layout.",
      label: "Keyboard layout for new tabs",
    };
  }
  if (info.kind === "browser") {
    if (info.host === info.domain) {
      return { title: placeLabel(info.key), note: `Applies to all ${placeLabel(info.domain)}.`, label: "Keyboard layout for these pages" };
    }
    return info.scope === "host"
      ? {
          title: placeLabel(info.key),
          note: `Only this browser page. Other ${placeLabel(info.domain)} have their own layouts.`,
          label: "Keyboard layout for this page",
        }
      : {
          title: placeLabel(info.key),
          note: `Applies to all ${placeLabel(info.domain)}, including ${placeLabel(info.host)}.`,
          label: "Keyboard layout for these pages",
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

  // Per-domain choice needs a domain (or a group of browser pages).
  $("scopeBox").classList.toggle("hidden", !info.domain);
  if (info.domain) {
    const web = info.kind === "web";
    // New tab pages and local files are a single place: nothing to split.
    const noSplit = !web && info.host === info.domain;
    $("scopeTitle").textContent = `How to treat ${groupName(info)}`;
    $("scopeDomain").textContent =
      info.kind === "newtab" ? "One layout for all new tabs"
      : web ? `One layout for all of ${info.domain}`
      : `One layout for all ${placeLabel(info.domain)}`;
    $("scopeHost").textContent = web ? "Separate layout for each subdomain" : "Separate layout for each page";
    $("scopeHostRow").classList.toggle("hidden", noSplit);
    const shown = noSplit && info.scope === "host" ? "domain" : info.scope;
    for (const r of document.querySelectorAll('input[name="scope"]')) {
      r.checked = r.value === shown;
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
