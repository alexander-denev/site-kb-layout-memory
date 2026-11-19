# Tab Layout Memory

Makes each browser tab remember its own Windows keyboard layout, the way Windows can remember one per app window. If you type Ukrainian in one tab and English in another, switching tabs switches the layout back for you.

Works with Chrome, Edge, Brave and other Chromium-based browsers on Windows 10/11.

## Install (about 2 minutes)

1. Unzip this folder somewhere permanent, such as `Documents\TabLayoutMemory`. The browser runs the helper from this folder, so don't delete or move it later.
2. Double-click **Install.cmd**. It builds the small helper program with the C# compiler built into Windows and registers it with your browsers. You don't need admin rights or any downloads.
3. In the browser, open `chrome://extensions` (or `edge://extensions` or `brave://extensions`), turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder.
   The extension ID should be `nfoakjoifinjnlmanogdmmaobcjneilh`. The helper only accepts that ID.
4. Click the extension's toolbar icon to open its settings. They should say **Helper connected**.

If the settings say the helper isn't reachable, run Install.cmd again, then click the reload icon on the extension card.

## How it behaves

- **Switching tabs:** the layout you were using is saved for the tab you leave, and the layout saved for the tab you open is restored.
- **New tabs:** by default a new tab keeps the current layout, just like a new window in Windows. In settings you can make every new tab start with a specific layout instead.
- **Several browser windows:** these work the same way, because switching windows counts as switching to that window's active tab.
- **Other apps:** this tool doesn't touch them. To have Windows also remember a layout per app, turn on *Settings → Time & language → Typing → Advanced keyboard settings → "Let me use a different input method for each app window"*. The extension works with this setting on or off.
- **Memory:** the remembered layouts last until you close the browser, the same way Windows forgets a window's layout when the window closes.

## Limits

- It switches keyboard **layouts and languages** (for example EN/UK/RU). It doesn't remember IME sub-modes, such as Japanese hiragana versus half-width.
- Developer-mode extensions sometimes show a warning banner when the browser starts. You can dismiss it.
- If you switch tabs while the browser isn't the active window (for example from a script), the layout switch waits until you return to the browser.

## Uninstall

Remove the extension from the browser, double-click **Uninstall.cmd**, then delete the folder.

## How it works (for the curious)

Windows tracks one keyboard layout per app, and every tab lives inside the same browser process, so Windows can't tell tabs apart. An extension can see tab switches but can't change the Windows layout, so this project uses two parts:

- `extension/` is a Manifest V3 extension. It listens for tab and window switches and keeps a map from each tab to its layout.
- `host/TabLayoutHost.cs` is a native messaging host. On each switch it reads the browser's active layout (`GetKeyboardLayout`) and requests the new one (`WM_INPUTLANGCHANGEREQUEST`). It only acts when the browser that launched it is the window in front.
