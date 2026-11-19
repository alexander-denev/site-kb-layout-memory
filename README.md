# Site Layout Memory

Remembers your Windows keyboard layout **per domain, per subdomain, or per tab**. If you write Ukrainian on one site and English on another, switching tabs, navigating, or coming back to the browser switches the layout for you. Domain and subdomain layouts are saved to disk, so they survive browser restarts and reboots. Tab layouts last until the tab or browser closes.

Works with Chrome, Edge, Brave and other Chromium-based browsers on Windows 10/11.

## Install (about 60 seconds)

1. Unzip this folder somewhere permanent, such as `Documents\SiteLayoutMemory`. The browser runs the helper from this folder, so don't move or delete it later.
2. Double-click **Install.cmd**. It builds the small helper program with the C# compiler built into Windows and registers it with your browsers. You don't need admin rights or any downloads.
3. Open `chrome://extensions` (or `edge://extensions` or `brave://extensions`), turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder.
   The extension ID should be `nfoakjoifinjnlmanogdmmaobcjneilh`. The helper only accepts that ID.
4. Pin the extension and click its icon. If the popup shows a red "helper isn't reachable" message, run Install.cmd again, then reload the extension.

The browser will say the extension can "read your browsing history". It needs that to see which site a tab is on. Nothing leaves your computer: the site list is stored in your browser profile.

## How it behaves

- **Three ways to remember**, chosen in settings and overridable per domain from the popup:
  - **Each domain** (default): `mail.google.com` and `docs.google.com` share `google.com`'s layout. Domains like `bbc.co.uk` and `rozetka.com.ua` are recognized correctly using the Public Suffix List. Kept after restart.
  - **Each subdomain**: `mail.google.com` and `docs.google.com` each have their own. Kept after restart.
  - **Each tab**: the layout belongs to the tab and follows it to any site, the way Windows does per window. Two tabs on the same site can differ. The new tab page and browser pages get one too. Forgotten when the tab or browser closes, because tab IDs change every session.
  - **Mixing them:** e.g. per-domain everywhere, but per-tab on `google.com`. Then each Google tab has its own layout, and when a tab moves to another site it gets that site's saved layout. When it returns to Google, it gets its own tab layout back.
- **Saving:** when you change the layout on a site (Alt+Shift, Win+Space, the taskbar), it's saved for that site within about a quarter second.
- **Applying:** a site's layout is applied when you switch to its tab, when a tab navigates to it, when you switch browser windows, and when you come back to the browser from another app. That last one undoes any layout change made in the other app.
- **New sites:** by default a site you haven't visited keeps the current layout, and that layout is saved for it. In settings you can make every new site start with one layout instead.
- **Locking:** the popup's **Always use this layout here** option stops a site from saving your changes. Use it for a site where you switch layouts temporarily but always want to come back to one.
- **Non-website pages:** in domain or subdomain mode, the new tab page, browser settings and local files leave the layout as it is. In per-tab mode they remember a layout like any other tab.
- **Saved sites list:** the settings page shows every remembered site, where you can change, lock or forget each one.
- **Other apps:** this tool doesn't affect them. Windows' own "Let me use a different input method for each app window" setting can be on or off.

## Limits

- It switches keyboard **layouts and languages** (EN/UK/RU…). It doesn't remember IME sub-modes such as Japanese hiragana versus half-width.
- Developer-mode extensions may show a warning banner when the browser starts. Dismiss it; don't click "disable".
- If you remove a keyboard layout from Windows, sites saved with it simply aren't switched until you choose another layout for them.

## Uninstall

Remove the extension from the browser (this also deletes its saved sites), double-click **Uninstall.cmd**, then delete the folder.

## Technical notes

- `extension/background.js` turns each tab into a key: the domain or subdomain, using [tldts](https://github.com/remusao/tldts) (MIT, bundled in `vendor/`), or `tab:<id>`. Site keys are stored in `chrome.storage.local`, which is written to disk in your browser profile. Tab keys are stored in `chrome.storage.session`, which is kept in memory and cleared when the browser closes. A tab's entry is deleted when the tab closes. Settings live in `chrome.storage.sync`.
- `host/TabLayoutHost.cs` is a native messaging host that the browser starts with the extension. It switches layouts by posting `WM_INPUTLANGCHANGEREQUEST` to the browser window and reads them with `GetKeyboardLayout`. A watcher thread checks the layout every 250 ms while the browser is the window in front and reports changes, so they're saved even if you close the browser right after changing layout. Every switch increments a counter, so a change reported just before a switch can't be saved to the wrong site.
- Nothing starts with Windows. The installer only writes registry keys under `HKCU\Software\<browser>\NativeMessagingHosts`, and the browser launches the helper itself.
