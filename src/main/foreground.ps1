$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class PacelineForeground {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string ExecutablePath(uint processId) {
    var handle = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) return "";
    try {
      var path = new StringBuilder(32768); uint size = (uint)path.Capacity;
      return QueryFullProcessImageName(handle, 0, path, ref size) ? path.ToString() : "";
    } finally { CloseHandle(handle); }
  }
  public static string Classify(string name, string text, string executablePath) {
    name = (name ?? "").ToLowerInvariant();
    text = text ?? "";
    if (name == "codex") return "codex";
    // The Store Codex desktop app is ChatGPT.exe; its package distinguishes it from ChatGPT.
    if (name == "chatgpt" && Regex.IsMatch(executablePath ?? "", @"^[a-z]:\\(?:[^\\]+\\)*WindowsApps\\OpenAI\.Codex_\d+(?:\.\d+){3}_(?:x64|arm64|x86)__2p2nqsd0c76g0\\app\\ChatGPT\.exe$", RegexOptions.IgnoreCase)) return "codex";
    if (name == "claude") return "claude";
    if (Regex.IsMatch(name, "^(chrome|msedge|firefox|brave|opera|vivaldi)$")) {
      var browser = @"(?:\s*[-|—–]\s*(?:Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|Vivaldi))?$";
      if (Regex.IsMatch(text, @"(?:^|[|—–-]\s*)Claude" + browser, RegexOptions.IgnoreCase)) return "claude";
      if (Regex.IsMatch(text, @"(?:^|[|—–-]\s*)Codex(?:\s*[-|—–]\s*ChatGPT)?" + browser, RegexOptions.IgnoreCase)) return "codex";
    }
    if (Regex.IsMatch(name, "^(windowsterminal|conhost|openconsole|powershell|pwsh|cmd)$")) {
      if (Regex.IsMatch(text, @"(?:^[^\p{L}\p{N}]*|[|—–-]\s*)Claude Code(?:$|[\s|—–:-])", RegexOptions.IgnoreCase)) return "claude";
      if (Regex.IsMatch(text, @"(?:^[^\p{L}\p{N}]*|[|—–-]\s*)Codex(?:$|[\s|—–:-])", RegexOptions.IgnoreCase)) return "codex";
    }
    return "";
  }
  public static string ReadProvider() {
    try {
      var hwnd = GetForegroundWindow();
      uint processId; GetWindowThreadProcessId(hwnd, out processId);
      string name;
      using (var process = Process.GetProcessById((int)processId)) name = process.ProcessName.ToLowerInvariant();
      var executablePath = name == "chatgpt" ? ExecutablePath(processId) : "";
      var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
      // Titles and executable paths stay in this helper; only the provider leaves it.
      return Classify(name, title.ToString(), executablePath);
    } catch { }
    return "";
  }
}
'@
Write-Output '{"ready":true}'
while ($true) {
  if ($pacelineParentId -and -not (Get-Process -Id $pacelineParentId -ErrorAction SilentlyContinue)) { break }
  $provider = [PacelineForeground]::ReadProvider()
  if ($provider) { Write-Output ('{"provider":"' + $provider + '"}') }
  else { Write-Output '{"provider":null}' }
  Start-Sleep -Milliseconds 900
}
