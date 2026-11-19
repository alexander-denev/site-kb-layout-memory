// Shared by the popup and the settings page.
function ask(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function layoutName(hkl, layouts) {
  const found = layouts.find((l) => l.hkl.toLowerCase() === String(hkl).toLowerCase());
  return found ? found.name : hkl ? `Layout ${hkl} (not installed)` : "";
}

// Fill a <select> with the installed layouts; keeps an unknown saved value visible.
function fillLayoutSelect(select, layouts, value, placeholder) {
  select.innerHTML = "";
  if (placeholder) select.add(new Option(placeholder, ""));
  for (const l of layouts) select.add(new Option(l.name, l.hkl));
  if (value && !layouts.some((l) => l.hkl.toLowerCase() === value.toLowerCase())) {
    select.add(new Option(layoutName(value, layouts), value));
  }
  select.value = value || "";
}

function showHostError(el, error) {
  el.classList.remove("hidden");
  el.innerHTML =
    "The helper program isn't reachable, so layouts can't be read or switched. " +
    "Run <b>Install.cmd</b> from the downloaded folder, then reload the extension. " +
    '<br><span class="hint">Details: <code></code></span>';
  el.querySelector("code").textContent = error || "no answer";
}
