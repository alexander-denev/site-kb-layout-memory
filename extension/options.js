const DEFAULT_SETTINGS = { newTabMode: "keep", newTabLayout: "" };
const statusEl = document.getElementById("status");
const layoutEl = document.getElementById("layout");
const radios = [...document.querySelectorAll('input[name="mode"]')];

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  radios.forEach((r) => (r.checked = r.value === settings.newTabMode));
  layoutEl.disabled = settings.newTabMode !== "fixed";

  const res = await chrome.runtime.sendMessage({ type: "status" });
  if (res && res.ok) {
    statusEl.className = "status ok";
    statusEl.textContent = `Helper connected${res.hostVersion ? " (v" + res.hostVersion + ")" : ""}. ${res.layouts.length} keyboard layouts installed.`;
    layoutEl.innerHTML = "";
    for (const l of res.layouts) {
      const opt = document.createElement("option");
      opt.value = l.hkl;
      opt.textContent = l.name;
      layoutEl.appendChild(opt);
    }
    layoutEl.value = settings.newTabLayout || res.active || (res.layouts[0] && res.layouts[0].hkl) || "";
  } else {
    statusEl.className = "status bad";
    statusEl.innerHTML =
      "The helper program isn't reachable, so layouts can't be switched yet. " +
      "Run <b>Install.cmd</b> from the downloaded folder, then reload this extension.<br>" +
      `<span class="hint">Details: <code></code></span>`;
    statusEl.querySelector("code").textContent = (res && res.error) || "no answer";
  }
}

async function save() {
  const mode = radios.find((r) => r.checked)?.value || "keep";
  layoutEl.disabled = mode !== "fixed";
  await chrome.storage.sync.set({ newTabMode: mode, newTabLayout: layoutEl.value || "" });
}

radios.forEach((r) => r.addEventListener("change", save));
layoutEl.addEventListener("change", save);
document.getElementById("forget").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "forget" });
  document.getElementById("forgot").textContent = "Done.";
});

init();
