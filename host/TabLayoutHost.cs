// Site Layout Memory - Windows helper (Chrome native messaging host).
//
// Written for the C# 5 compiler that ships inside Windows (.NET Framework 4.x),
// so it builds on any Windows 10/11 PC without installing anything.
//
// Protocol (Chrome native messaging): each message is a 4-byte little-endian
// length followed by UTF-8 JSON. Commands from the extension:
//   {"id":1,"cmd":"swap","target":"0x4220422"}  -> read the browser's current layout,
//                                                  then switch to target (if given)
//   {"id":2,"cmd":"list"}                        -> installed layouts + active one
// Events sent to the extension on their own:
//   {"event":"layout","hkl":"0x4220422","gen":5} -> you changed the layout while the
//                                                  browser was in front
// `gen` counts swaps, so the extension can drop a change report that was
// overtaken by a switch to another site.
//
// Layout handles (HKL) travel as hex strings, e.g. "0x4090409".

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

static class TabLayoutHost
{
    const string Version = "2.0.0";
    const int PollMs = 250;
    const uint WM_INPUTLANGCHANGEREQUEST = 0x0050;
    const uint TH32CS_SNAPPROCESS = 0x00000002;

    // ---- Win32 ---------------------------------------------------------------
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")] static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] list);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)] static extern int SHLoadIndirectString(string source, StringBuilder output, int size, IntPtr reserved);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct GUITHREADINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    // ---- State ---------------------------------------------------------------
    static readonly object WriteLock = new object();
    static Stream stdout;
    static HashSet<uint> browserPids = new HashSet<uint>();

    // Shared between the message loop and the watcher thread.
    static readonly object SyncLock = new object();
    static IntPtr baseline = IntPtr.Zero;   // last layout we know about
    static bool browserWasInFront = false;
    static int generation = 0;

    static int Main()
    {
        try
        {
            try { browserPids = FindBrowserProcessIds(); }
            catch (Exception ex) { Console.Error.WriteLine("TabLayoutHost: could not identify the browser process: " + ex.Message); }
            Stream stdin = Console.OpenStandardInput();
            stdout = Console.OpenStandardOutput();

            if (browserPids.Count > 0)
            {
                Thread watcher = new Thread(WatchLayout);
                watcher.IsBackground = true; // dies with the process
                watcher.Start();
            }

            while (true)
            {
                string msg = ReadMessage(stdin);
                if (msg == null) return 0; // browser closed the pipe
                string reply;
                try { reply = Handle(msg); }
                catch (Exception ex) { reply = "{\"id\":" + GetInt(msg, "id") + ",\"error\":" + Json(ex.Message) + "}"; }
                WriteMessage(reply);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("TabLayoutHost: " + ex);
            return 1;
        }
    }

    static string Handle(string msg)
    {
        string id = GetInt(msg, "id");
        string cmd = GetString(msg, "cmd");

        if (cmd == "swap") return Swap(id, GetString(msg, "target"));
        if (cmd == "list") return List(id);
        if (cmd == "ping") return "{\"id\":" + id + ",\"version\":" + Json(Version) + "}";
        return "{\"id\":" + id + ",\"error\":" + Json("unknown command: " + cmd) + "}";
    }

    // Read the layout the browser has right now, then switch to `target` if given.
    // Runs under SyncLock so the watcher never sees a half-done switch.
    static string Swap(string id, string target)
    {
        lock (SyncLock)
        {
            string reply = SwapLocked(id, target);
            return reply;
        }
    }

    static string SwapLocked(string id, string target)
    {
        IntPtr fg = IntPtr.Zero;
        uint threadId = 0, pid = 0;
        bool isBrowser = false;

        // Focus events can arrive a hair before Windows finishes bringing the window
        // to the front, so give it a moment.
        for (int attempt = 0; attempt < 8 && !isBrowser; attempt++)
        {
            if (attempt > 0) Thread.Sleep(25);
            fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) continue;
            threadId = GetWindowThreadProcessId(fg, out pid);
            isBrowser = browserPids.Count == 0 || browserPids.Contains(pid);
        }
        if (!isBrowser) return "{\"id\":" + id + ",\"foreground\":false}";

        IntPtr prev = GetKeyboardLayout(threadId);
        IntPtr now = prev;
        bool applied = false;

        if (!string.IsNullOrEmpty(target))
        {
            IntPtr wanted = ParseHkl(target);
            if (wanted != IntPtr.Zero && wanted != prev && IsInstalled(wanted))
            {
                IntPtr dest = fg;
                GUITHREADINFO info = new GUITHREADINFO();
                info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
                if (GetGUIThreadInfo(threadId, ref info) && info.hwndFocus != IntPtr.Zero) dest = info.hwndFocus;

                PostMessage(dest, WM_INPUTLANGCHANGEREQUEST, IntPtr.Zero, wanted);
                // Wait (briefly) until Windows confirms the switch.
                for (int i = 0; i < 20; i++)
                {
                    Thread.Sleep(10);
                    now = GetKeyboardLayout(threadId);
                    if (now == wanted) { applied = true; break; }
                }
            }
        }

        // From here on, only changes made after this switch count as "you changed it".
        generation++;
        baseline = now;
        browserWasInFront = true;

        return "{\"id\":" + id + ",\"foreground\":true,\"prev\":" + Json(Hex(prev)) +
               ",\"now\":" + Json(Hex(now)) + ",\"applied\":" + (applied ? "true" : "false") +
               ",\"gen\":" + generation + "}";
    }

    // Watches for layout changes you make (Alt+Shift, Win+Space, the taskbar) while the
    // browser is in front, and reports them right away so they are saved even if the
    // browser is closed without switching tabs first.
    static void WatchLayout()
    {
        while (true)
        {
            Thread.Sleep(PollMs);
            string evt = null;
            try
            {
                lock (SyncLock)
                {
                    IntPtr fg = GetForegroundWindow();
                    uint pid = 0, tid = 0;
                    if (fg != IntPtr.Zero) tid = GetWindowThreadProcessId(fg, out pid);
                    if (fg == IntPtr.Zero || !browserPids.Contains(pid))
                    {
                        browserWasInFront = false;
                        continue;
                    }

                    IntPtr current = GetKeyboardLayout(tid);
                    if (!browserWasInFront)
                    {
                        // Just came back to the browser: whatever layout it has now came from
                        // elsewhere, not from you choosing it on this site. The extension
                        // re-applies the site's layout on focus; don't report this one.
                        browserWasInFront = true;
                        baseline = current;
                        continue;
                    }
                    if (current != baseline && current != IntPtr.Zero)
                    {
                        baseline = current;
                        evt = "{\"event\":\"layout\",\"hkl\":" + Json(Hex(current)) + ",\"gen\":" + generation + "}";
                    }
                }
                if (evt != null) WriteMessage(evt);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("TabLayoutHost watcher: " + ex.Message);
            }
        }
    }

    static string List(string id)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"id\":").Append(id).Append(",\"version\":").Append(Json(Version)).Append(",\"layouts\":[");
        IntPtr[] all = InstalledLayouts();
        for (int i = 0; i < all.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"hkl\":").Append(Json(Hex(all[i]))).Append(",\"name\":").Append(Json(LayoutName(all[i]))).Append('}');
        }
        sb.Append("]");

        IntPtr fg = GetForegroundWindow();
        uint pid;
        if (fg != IntPtr.Zero)
        {
            uint tid = GetWindowThreadProcessId(fg, out pid);
            if (browserPids.Count == 0 || browserPids.Contains(pid))
                sb.Append(",\"active\":").Append(Json(Hex(GetKeyboardLayout(tid))));
        }
        sb.Append('}');
        return sb.ToString();
    }

    // ---- Layout helpers ------------------------------------------------------
    static IntPtr[] InstalledLayouts()
    {
        int n = GetKeyboardLayoutList(0, null);
        IntPtr[] list = new IntPtr[Math.Max(n, 0)];
        if (n > 0) GetKeyboardLayoutList(n, list);
        return list;
    }

    static bool IsInstalled(IntPtr hkl)
    {
        foreach (IntPtr h in InstalledLayouts()) if (h == hkl) return true;
        return false;
    }

    // e.g. "Ukrainian (Ukraine) — Ukrainian (Enhanced)"
    static string LayoutName(IntPtr hkl)
    {
        long v = hkl.ToInt64();
        int langId = (int)(v & 0xFFFF);
        int device = (int)((v >> 16) & 0xFFFF);

        string language;
        try { language = CultureInfo.GetCultureInfo(langId).DisplayName; }
        catch { language = "Language 0x" + langId.ToString("X4"); }

        string layout = KeyboardLayoutText(device, langId);
        if (string.IsNullOrEmpty(layout) || language.IndexOf(layout, StringComparison.OrdinalIgnoreCase) >= 0) return language;
        return language + " — " + layout;
    }

    static string KeyboardLayoutText(int device, int langId)
    {
        try
        {
            using (RegistryKey root = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Keyboard Layouts"))
            {
                if (root == null) return null;
                string klid = null;
                if ((device & 0xF000) == 0xF000)
                {
                    // Variant layout: find the KLID whose "Layout Id" matches.
                    string layoutId = (device & 0x0FFF).ToString("X4");
                    foreach (string name in root.GetSubKeyNames())
                    {
                        using (RegistryKey k = root.OpenSubKey(name))
                        {
                            object lid = k == null ? null : k.GetValue("Layout Id");
                            if (lid != null && string.Equals(lid.ToString(), layoutId, StringComparison.OrdinalIgnoreCase)) { klid = name; break; }
                        }
                    }
                }
                else
                {
                    klid = (device == 0 ? langId : device).ToString("X8");
                }
                if (klid == null) return null;

                using (RegistryKey k = root.OpenSubKey(klid))
                {
                    if (k == null) return null;
                    object display = k.GetValue("Layout Display Name");
                    if (display != null)
                    {
                        StringBuilder sb = new StringBuilder(256);
                        if (SHLoadIndirectString(display.ToString(), sb, sb.Capacity, IntPtr.Zero) == 0 && sb.Length > 0) return sb.ToString();
                    }
                    object text = k.GetValue("Layout Text");
                    return text == null ? null : text.ToString();
                }
            }
        }
        catch { return null; }
    }

    static string Hex(IntPtr hkl) { return "0x" + hkl.ToInt64().ToString("X"); }

    static IntPtr ParseHkl(string s)
    {
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        long v;
        if (!long.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) return IntPtr.Zero;
        return new IntPtr(v);
    }

    // ---- Which process is "the browser"? -------------------------------------
    // The browser launches this helper (sometimes via cmd.exe), so the browser is
    // one of our ancestors. Only its windows count as "the browser is in front".
    static HashSet<uint> FindBrowserProcessIds()
    {
        HashSet<uint> result = new HashSet<uint>();
        Dictionary<uint, PROCESSENTRY32W> procs = new Dictionary<uint, PROCESSENTRY32W>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return result;
        try
        {
            PROCESSENTRY32W e = new PROCESSENTRY32W();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snap, ref e))
            {
                do { procs[e.th32ProcessID] = e; } while (Process32NextW(snap, ref e));
            }
        }
        finally { CloseHandle(snap); }

        uint current = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        for (int depth = 0; depth < 5; depth++)
        {
            PROCESSENTRY32W me;
            if (!procs.TryGetValue(current, out me)) break;
            uint parent = me.th32ParentProcessID;
            PROCESSENTRY32W p;
            if (parent == 0 || !procs.TryGetValue(parent, out p)) break;
            string exe = (p.szExeFile ?? "").ToLowerInvariant();
            if (exe != "cmd.exe" && exe != "conhost.exe") { result.Add(parent); break; }
            current = parent;
        }
        return result;
    }

    // ---- Native messaging I/O -----------------------------------------------
    static string ReadMessage(Stream input)
    {
        byte[] len = ReadExactly(input, 4);
        if (len == null) return null;
        int n = BitConverter.ToInt32(len, 0);
        if (n <= 0 || n > 1024 * 1024) return null;
        byte[] body = ReadExactly(input, n);
        return body == null ? null : Encoding.UTF8.GetString(body);
    }

    static byte[] ReadExactly(Stream input, int count)
    {
        byte[] buf = new byte[count];
        int got = 0;
        while (got < count)
        {
            int r = input.Read(buf, got, count - got);
            if (r <= 0) return null;
            got += r;
        }
        return buf;
    }

    static void WriteMessage(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        lock (WriteLock)
        {
            stdout.Write(BitConverter.GetBytes(body.Length), 0, 4);
            stdout.Write(body, 0, body.Length);
            stdout.Flush();
        }
    }

    // Messages come only from our own extension and are flat, so a tiny reader is enough.
    static string GetString(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        return m.Success ? Regex.Unescape(m.Groups[1].Value) : "";
    }

    static string GetInt(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?\\d+)");
        return m.Success ? m.Groups[1].Value : "0";
    }

    static string Json(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
