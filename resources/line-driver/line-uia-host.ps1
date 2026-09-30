# line-uia-host.ps1 — driver_post 的 LINE UI helper（design-v1 §2.3／§2.5、design-v2 §2.3／§6、design-v3 §8.2）。
#
# 常駐 PowerShell 5.1 程序，stdin/stdout 以 JSON Lines（UTF-8）和 main 溝通：一行一個指令、一行一個回應。
# 啟動後主動送出 id=0 的 hello。每個回應都帶 activity（beginSession 後是否有任何使用者輸入，只供 log）。
#
# 安全與隱私規則（程式碼即規格）：
#   - 影像只存在記憶體（System.Drawing.Bitmap）；hash 由 LockBits 的原始像素計算；OCR 直接把 BGRA 像素
#     複製進 SoftwareBitmap。沒有任何影像編碼、沒有任何檔案寫入。
#   - 不含任何鍵盤注入。唯一的輸入注入是 guardedClick 的滑鼠點擊（守門全過才執行）。
#   - 搜尋框只讀（readSearch），沒有任何寫入搜尋框的程式碼。
#   - 會改變 LINE 狀態的指令只有：activateLine、guardedClick、setEdit、clearEditIfEquals、focusEdit、
#     handBackFocus。每一個都在同一個指令內自行守門（安靜期、hash、核准標題）。
#   - 會把 LINE 帶到前景的只有 Raise-LineGuarded（activateLine、focusEdit 共用）：先過安靜期＋沒有按鍵按著才切換。
#   - OCR 文字只經 stdout 回給 main；本程序不寫 log。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Web.Extensions, System.Runtime.WindowsRuntime
if (-not ('LineHostNative' -as [type])) {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
public static class LineHostNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();

  public static uint LastInputTick() { var l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref l); return l.dwTime; }
  public static uint IdleMs() { return unchecked(GetTickCount() - LastInputTick()); }
  public static int WindowPid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return (int)pid; }
  public static uint WindowThread(IntPtr h) { uint pid; return GetWindowThreadProcessId(h, out pid); }
  public static bool PointOnWindow(int x, int y, IntPtr top) { var p = new POINT(); p.X = x; p.Y = y; IntPtr h = WindowFromPoint(p); return GetAncestor(h, 2) == top; }
  // 滑鼠左／右／中鍵任一按著。
  public static bool MouseButtonsDown() { return (GetAsyncKeyState(0x01) & 0x8000) != 0 || (GetAsyncKeyState(0x02) & 0x8000) != 0 || (GetAsyncKeyState(0x04) & 0x8000) != 0; }
  // 0x08–0xFE 任一鍵按著（只讀「當下是否按著」，不記錄任何內容）。
  public static bool AnyKeyDown() { for (int k = 0x08; k <= 0xFE; k++) { if ((GetAsyncKeyState(k) & 0x8000) != 0) return true; } return false; }
  // design-v2 §6.2：等到 idle ≥ minIdleMs 且沒有按鍵按著；最多等 maxWaitMs。回傳是否成立，waited 為等待時間。
  public static bool QuietGate(int minIdleMs, int maxWaitMs, bool requireNoKeys, out int waited) {
    int start = Environment.TickCount;
    while (true) {
      bool ok = IdleMs() >= (uint)minIdleMs && !MouseButtonsDown() && (!requireNoKeys || !AnyKeyDown());
      waited = Environment.TickCount - start;
      if (ok) return true;
      if (waited > maxWaitMs) return false;
      Thread.Sleep(50);
    }
  }
  // 安靜期仍然成立（動作前最後一刻的即時檢查）。
  public static bool StillQuiet(int minIdleMs, bool requireNoKeys) { return IdleMs() >= (uint)minIdleMs && !MouseButtonsDown() && (!requireNoKeys || !AnyKeyDown()); }
  // 點擊螢幕座標（左鍵），之後把游標移回原位。
  public static void ClickAt(int x, int y) {
    POINT old; GetCursorPos(out old);
    SetCursorPos(x, y); Thread.Sleep(80);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(80);
    SetCursorPos(old.X, old.Y);
  }
  public static Bitmap Capture(IntPtr h, out int left, out int top, out bool ok) {
    RECT r; GetWindowRect(h, out r); left = r.L; top = r.T;
    int w = Math.Max(1, r.R - r.L), hh = Math.Max(1, r.B - r.T);
    var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) { IntPtr hdc = g.GetHdc(); ok = PrintWindow(h, hdc, 2); g.ReleaseHdc(hdc); }
    return bmp;
  }
  public static Bitmap Crop(Bitmap src, int x, int y, int w, int h) {
    var rc = new Rectangle(x, y, Math.Max(1, w), Math.Max(1, h));
    rc.Intersect(new Rectangle(0, 0, src.Width, src.Height));
    if (rc.Width <= 0 || rc.Height <= 0) return null;
    return src.Clone(rc, PixelFormat.Format32bppArgb);
  }
  static byte[] Raw(Bitmap b, out int stride) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    stride = Math.Abs(d.Stride); var buf = new byte[stride * b.Height];
    Marshal.Copy(d.Scan0, buf, 0, buf.Length); b.UnlockBits(d); return buf;
  }
  public static string Hash(Bitmap b) {
    int s; var buf = Raw(b, out s);
    using (var sha = SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(buf)).Replace("-", ""); }
  }
  // 緊密排列的 BGRA 像素（alpha 一律 255），給 SoftwareBitmap.CreateCopyFromBuffer 用。
  public static byte[] Bgra(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int row = b.Width * 4; var buf = new byte[row * b.Height];
    for (int y = 0; y < b.Height; y++) Marshal.Copy(IntPtr.Add(d.Scan0, y * d.Stride), buf, y * row, row);
    b.UnlockBits(d);
    for (int i = 3; i < buf.Length; i += 4) buf[i] = 255;
    return buf;
  }
  // 平均亮度 0..1，以及影像是否（近乎）單色。
  public static double MeanLum(Bitmap b, out bool blank) {
    int s; var buf = Raw(b, out s); double sum = 0; int n = 0; int mn = 255, mx = 0;
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) {
      int i = y * s + x * 4; int l = (buf[i + 2] * 299 + buf[i + 1] * 587 + buf[i] * 114) / 1000;
      sum += l; n++; if (l < mn) mn = l; if (l > mx) mx = l;
    }
    blank = (mx - mn) < 8; return n == 0 ? 0 : sum / n / 255.0;
  }
  public static Bitmap Scale(Bitmap b, double f, int mode) {
    var o = new Bitmap(Math.Max(1, (int)Math.Round(b.Width * f)), Math.Max(1, (int)Math.Round(b.Height * f)), PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(o)) {
      g.InterpolationMode = mode == 2 ? InterpolationMode.HighQualityBilinear : InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = mode == 2 ? PixelOffsetMode.Half : PixelOffsetMode.HighQuality;
      g.DrawImage(b, 0, 0, o.Width, o.Height);
    }
    return o;
  }
  // 灰階取 min(R,G,B)：彩色字（例如綠色強調）變深，同時保留反鋸齒。就地修改。
  public static void MinChannel(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int s = Math.Abs(d.Stride); var buf = new byte[s * b.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length);
    for (int i = 0; i < buf.Length; i += 4) { byte v = Math.Min(buf[i], Math.Min(buf[i + 1], buf[i + 2])); buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; }
    Marshal.Copy(buf, 0, d.Scan0, buf.Length); b.UnlockBits(d);
  }
  // 亮度線性拉伸（最暗 → 0、最亮 → 255）。灰階影像。就地修改。
  public static void Stretch(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int s = Math.Abs(d.Stride); var buf = new byte[s * b.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length);
    int mn = 255, mx = 0; for (int i = 0; i < buf.Length; i += 4) { int v = buf[i + 1]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx - mn >= 8) for (int i = 0; i < buf.Length; i += 4) { byte v = (byte)((buf[i + 1] - mn) * 255 / (mx - mn)); buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; }
    Marshal.Copy(buf, 0, d.Scan0, buf.Length); b.UnlockBits(d);
  }
  public static void Invert(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    int s = Math.Abs(d.Stride); var buf = new byte[s * b.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length);
    for (int i = 0; i < buf.Length; i += 4) { buf[i] = (byte)(255 - buf[i]); buf[i + 1] = (byte)(255 - buf[i + 1]); buf[i + 2] = (byte)(255 - buf[i + 2]); }
    Marshal.Copy(buf, 0, d.Scan0, buf.Length); b.UnlockBits(d);
  }
}
'@
}
$dpi = 'unaware'
try { if ([LineHostNative]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpi = 'per_monitor_v2' } } catch {}
if ($dpi -eq 'unaware') { if ([LineHostNative]::SetProcessDPIAware()) { $dpi = 'system' } }

[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
$ocrLangs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
$ocr = $null
try { $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'zh-Hant-TW')) } catch { $ocr = $null }
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition
$script:baseline = $null
$script:approved = @{}      # readTitle 產生的標題 hash（本程序生命週期）
$script:snapshotId = 0

# 預先登記的前處理參數組（design-v2 §4.4）。scale：放大倍率；mode 2＝bilinear，其餘 bicubic；gray：'' 或 'minstretch'。
$ROW_CFG = @{
  R1 = @{ scale = 2.0; mode = 0; gray = 'minstretch'; invert = 'off' }
  R2 = @{ scale = 3.0; mode = 0; gray = 'minstretch'; invert = 'off' }
  R3 = @{ scale = 2.5; mode = 2; gray = 'minstretch'; invert = 'off' }
}
$TITLE_CFG = @{
  T1 = @{ scale = 2.0; mode = 0; gray = ''; invert = 'auto' }
  T2 = @{ scale = 1.0; mode = 0; gray = 'minstretch'; invert = 'auto' }
  T3 = @{ scale = 2.0; mode = 0; gray = 'minstretch'; invert = 'auto' }
}
$FULLY_VISIBLE = 0.95

function Out-Json($o) { $stdout.WriteLine($ser.Serialize($o)) }
function Activity { if ($null -eq $script:baseline) { return $false }; return ([LineHostNative]::LastInputTick() -ne $script:baseline) }
function ByClass($cls, $scope) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $cls)
  return @($scope.FindAll($TS::Descendants, $cond))
}
function RectOf($el) { $r = $el.Current.BoundingRectangle; return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }
function SameRect($a, $b) { return ([int]$a.x -eq [int]$b.x) -and ([int]$a.y -eq [int]$b.y) -and ([int]$a.w -eq [int]$b.w) -and ([int]$a.h -eq [int]$b.h) }
function Get-LineWin {
  $procs = @(Get-Process LINE -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return @{ status = 'not_running' } }
  $pids = @($procs | ForEach-Object { $_.Id })
  $tops = @($AE::RootElement.FindAll($TS::Children, $True_) | Where-Object { $pids -contains $_.Current.ProcessId })
  $wins = @($tops | Where-Object { $_.Current.ClassName -eq 'AllInOneWindow' })
  $others = @($tops | Where-Object { $_.Current.ClassName -ne 'AllInOneWindow' } | ForEach-Object { [string]$_.Current.ClassName })
  if ($wins.Count -eq 0) { return @{ status = 'no_window'; pid = [int]$pids[0] } }
  if ($wins.Count -gt 1) { return @{ status = 'multiple_windows'; pid = [int]$wins[0].Current.ProcessId; count = $wins.Count } }
  $w = $wins[0]; $h = [IntPtr]$w.Current.NativeWindowHandle
  return @{ status = 'ok'; pid = [int]$w.Current.ProcessId; hwnd = $h; el = $w; iconic = [LineHostNative]::IsIconic($h); others = $others }
}
function Need-Line { $l = Get-LineWin; if ($l.status -ne 'ok') { throw "line_$($l.status)" }; return $l }
function Snap($l) { $left = 0; $top = 0; $ok = $false; $b = [LineHostNative]::Capture($l.hwnd, [ref]$left, [ref]$top, [ref]$ok); return @{ Bmp = $b; Left = $left; Top = $top; Ok = $ok } }
function CropScreen($cap, $r) { return [LineHostNative]::Crop($cap.Bmp, [int]$r.x - $cap.Left, [int]$r.y - $cap.Top, [int]$r.w, [int]$r.h) }
function Ocr-Bitmap($bmp, $cfg, $origin) {
  # $origin：點陣圖左上角的螢幕座標。回傳的行、字都是螢幕座標。
  $work = $bmp; $disp = @()
  $blank = $false; $lum = [LineHostNative]::MeanLum($bmp, [ref]$blank)
  $es = [double]$cfg.scale
  if ($es -ne 1.0) { $work = [LineHostNative]::Scale($bmp, $es, [int]$cfg.mode); $disp += $work }
  $inv = ($cfg.invert -eq 'on') -or ($cfg.invert -eq 'auto' -and $lum -lt 0.4)
  if ($inv) { if ($work -eq $bmp) { $work = $bmp.Clone(); $disp += $work }; [LineHostNative]::Invert($work) }
  if ($cfg.gray -eq 'minstretch') { if ($work -eq $bmp) { $work = $bmp.Clone(); $disp += $work }; [LineHostNative]::MinChannel($work); [LineHostNative]::Stretch($work) }
  $bytes = [LineHostNative]::Bgra($work)
  $ibuf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
  $sb = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($ibuf, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $work.Width, $work.Height)
  $res = Await ($ocr.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $sb.Dispose(); foreach ($d in $disp) { $d.Dispose() }
  $lines = @()
  foreach ($ln in $res.Lines) {
    $words = @(); $x1 = 1e9; $y1 = 1e9; $x2 = -1e9; $y2 = -1e9
    foreach ($wd in $ln.Words) {
      $br = $wd.BoundingRect
      $wr = @{ x = [int]($origin.x + $br.X / $es); y = [int]($origin.y + $br.Y / $es); w = [int]($br.Width / $es); h = [int]($br.Height / $es) }
      $words += @{ text = $wd.Text; rect = $wr }
      $x1 = [Math]::Min($x1, $wr.x); $y1 = [Math]::Min($y1, $wr.y); $x2 = [Math]::Max($x2, $wr.x + $wr.w); $y2 = [Math]::Max($y2, $wr.y + $wr.h)
    }
    $lines += @{ text = $ln.Text; rect = @{ x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1) }; words = $words }
  }
  return @{ lines = $lines; blank = $blank }
}
function TitleRect($l) {
  $pr = RectOf (ByClass 'ChatMessagePanel' $l.el)[0]; $vr = RectOf (ByClass 'ChatMessageView' $l.el)[0]
  return @{ x = $pr.x; y = $pr.y; w = $pr.w; h = [Math]::Max(1, $vr.y - $pr.y) }
}
function TitleHashNow($l) { $tr = TitleRect $l; $cap = Snap $l; $c = CropScreen $cap $tr; $cap.Bmp.Dispose(); if ($null -eq $c) { return '' }; $h = [LineHostNative]::Hash($c); $c.Dispose(); return $h }
# readSearch 的唯讀存取點（搜尋框元素）。整個 helper 只有這裡用到它的 ClassName；只讀 ValuePattern.Current.Value，從不寫入。
function ReadSearchField($l) { return @(ByClass 'LcTextField' $l.el) }
function Edit($l) { return (ByClass 'AutoSuggestTextArea' $l.el)[0] }
function EditValue($e) { return [string]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
function NormNl([string]$s) { return ($s -replace "`r`n", "`n") -replace "`r", "`n" }
function ListItems($l) {
  $left = (ByClass 'MainChatPanel' $l.el)[0]; $list = (ByClass 'LcListView' $left)[0]
  return @{ list = $list; items = @($list.FindAll($TS::Children, $True_)) }
}
function IsSelected($it) { try { return [bool]$it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch { return $null } }
function RowGeom($li, $cap, $lr) {
  # 列的幾何、可見高度、可見部分像素 hash（同一次擷取）。
  $rows = @(); $i = 0
  foreach ($it in $li.items) {
    $r = RectOf $it
    $cy = [Math]::Max($r.y, $lr.y); $ch = [Math]::Min($r.y + $r.h, $lr.y + $lr.h) - $cy
    $hh = ''
    if ($ch -gt 0) { $c = CropScreen $cap @{ x = $r.x; y = $cy; w = $r.w; h = $ch }; if ($c) { $hh = [LineHostNative]::Hash($c); $c.Dispose() } }
    $rows += @{ index = $i; rect = $r; visibleH = [int][Math]::Max(0, $ch); hash = $hh; top = $cy }
    $i++
  }
  return ,$rows
}
function StableList($l, [int]$tries) {
  # 等列表穩定：連續兩次擷取的列簽章（index、rect、hash）相同。回傳最後一次擷取與列資料。
  $prev = $null; $stable = $false; $cap = $null; $rows = $null; $li = $null; $lr = $null
  for ($k = 0; $k -lt $tries; $k++) {
    if ($cap) { $cap.Bmp.Dispose() }
    $li = ListItems $l; $lr = RectOf $li.list; $cap = Snap $l
    $rows = RowGeom $li $cap $lr
    $sig = ($rows | ForEach-Object { '{0}:{1},{2},{3}x{4}:{5}' -f $_.index, $_.rect.x, $_.rect.y, $_.rect.w, $_.rect.h, $_.hash }) -join '|'
    if ($sig -eq $prev) { $stable = $true; break }
    $prev = $sig
    Start-Sleep -Milliseconds 300
  }
  return @{ cap = $cap; rows = $rows; li = $li; lr = $lr; stable = $stable }
}
function Refuse($id, $why, $detail, $waited) { $o = @{ id = $id; ok = $false; refusal = $why; detail = $detail; activity = (Activity) }; if ($null -ne $waited) { $o.quietWaitMs = [int]$waited }; Out-Json $o }
function Ok($id, $result, $waited) { $o = @{ id = $id; ok = $true; result = $result; activity = (Activity) }; if ($null -ne $waited) { $o.quietWaitMs = [int]$waited }; Out-Json $o }
# 守門指令開始等安靜期之前：使用者此刻不安靜 → 先送一個中途事件（不是回應），讓 UI 顯示「請暫時放開滑鼠與鍵盤…」。
function Note-QuietWait($id, $q, [bool]$keys) {
  if (-not [LineHostNative]::StillQuiet($q.min, $keys)) { Out-Json @{ id = $id; event = 'waitingForQuiet'; maxWaitMs = [int]$q.max } }
}
function QuietArgs($q) {
  $min = 500; $max = 3000; $keys = $false
  if ($null -ne $q) { if ($null -ne $q.minIdleMs) { $min = [int]$q.minIdleMs }; if ($null -ne $q.maxWaitMs) { $max = [int]$q.maxWaitMs }; if ($q.requireNoKeysDown) { $keys = $true } }
  return @{ min = $min; max = $max; keys = $keys }
}
# 切前景的安靜期下限（ms）。呼叫端只能再收緊（design-v2 §6.4：只准收緊 Q）。
$RAISE_FLOOR_MS = @{ activate = 300; focus = 500 }
# 整個 helper 唯一會把 LINE 帶到前景的地方（ShowWindow 還原、SetForegroundWindow）。review F1／design-v2 §6.2：
#   先等安靜期，而且一律要求「沒有任何按鍵按著」（不論呼叫端有沒有要求）。不通過 → 回 ok=$false，LINE 完全沒有被切換。
#   通過後立刻切換，中間沒有其他 I/O。使用者按著 Enter（自動重複）或剛連按時，重複的按鍵不會被轉送到 LINE。
function Raise-LineGuarded($id, $l, $q, [int]$floorMs, [bool]$restore) {
  $min = [Math]::Max([int]$q.min, $floorMs); $w = 0
  Note-QuietWait $id @{ min = $min; max = [int]$q.max } $true
  if (-not [LineHostNative]::QuietGate($min, [int]$q.max, $true, [ref]$w)) { return @{ ok = $false; waited = $w; min = $min } }
  if ($restore -and $l.iconic) { [void][LineHostNative]::ShowWindow($l.hwnd, 9); Start-Sleep -Milliseconds 300 }
  [void][LineHostNative]::SetForegroundWindow($l.hwnd)
  return @{ ok = $true; waited = $w; min = $min }
}

function Cmd-ReadList($id, $a, [bool]$withOcr) {
  $l = Need-Line
  $st = StableList $l 6
  $cap = $st.cap; $lr = $st.lr
  $lc = CropScreen $cap $lr
  $listBlank = $true; if ($lc) { [void][LineHostNative]::MeanLum($lc, [ref]$listBlank); $lc.Dispose() }
  if ($listBlank) { $cap.Bmp.Dispose(); Refuse $id 'capture_blank' 'list' $null; return }
  $cfgs = @(); if ($withOcr -and $a.configs) { $cfgs = @($a.configs | ForEach-Object { [string]$_ }) }
  if ($withOcr -and $null -eq $ocr) { $cap.Bmp.Dispose(); throw 'ocr_unavailable' }
  $out = @()
  for ($j = 0; $j -lt $st.rows.Count; $j++) {
    $row = $st.rows[$j]
    $o = @{ index = $row.index; rect = $row.rect; visibleH = $row.visibleH; hash = $row.hash; selected = (IsSelected $st.li.items[$j]) }
    if ($withOcr -and $row.rect.h -gt 0 -and $row.visibleH -ge $FULLY_VISIBLE * $row.rect.h) {
      $ocrOut = @{}
      foreach ($cn in $cfgs) {
        $cfg = $ROW_CFG[$cn]; if ($null -eq $cfg) { continue }
        $c = CropScreen $cap @{ x = $row.rect.x; y = $row.top; w = $row.rect.w; h = $row.visibleH }
        if ($null -eq $c) { $ocrOut[$cn] = @(); continue }
        $ro = Ocr-Bitmap $c $cfg @{ x = $row.rect.x; y = $row.top }; $c.Dispose()
        $ocrOut[$cn] = $ro.lines
      }
      $o.ocr = $ocrOut
    }
    $out += $o
  }
  $cap.Bmp.Dispose()
  $script:snapshotId++
  Ok $id @{ rows = $out; listRect = $lr; stable = $st.stable; snapshotId = $script:snapshotId } $null
}

$handlers = @{
  hello = { param($a) @{ protocol = 3; psVersion = $PSVersionTable.PSVersion.ToString(); languageMode = $ExecutionContext.SessionState.LanguageMode.ToString(); ocrLanguages = $ocrLangs; ocrEngine = ($null -ne $ocr); dpiAwareness = $dpi; pid = $PID } }
  beginSession = { param($a) $script:baseline = [LineHostNative]::LastInputTick(); @{ started = $true } }
  endSession = { param($a) $script:baseline = $null; @{ ended = $true } }
  locateLine = { param($a) $l = Get-LineWin; $o = @{ status = $l.status }
    if ($l.pid) { $o.pid = $l.pid }; if ($l.count) { $o.count = $l.count }
    if ($l.status -eq 'ok') { $o.iconic = $l.iconic; $o.otherTopLevel = @($l.others); try { $o.exeVersion = (Get-Process -Id $l.pid).MainModule.FileVersionInfo.FileVersion } catch { $o.exeVersion = $null } }
    $o }
  probeAnchors = { param($a) $l = Need-Line; $missing = @()
    if ((ReadSearchField $l).Count -ne 1) { $missing += 'search' }
    foreach ($c in 'MainChatPanel','ChatMessagePanel','ChatMessageView','MessageInputPanel','AutoSuggestTextArea','LcListView') { $n = (ByClass $c $l.el).Count
      if ($c -eq 'LcListView') { if ($n -lt 2) { $missing += $c } } elseif ($n -ne 1) { $missing += $c } }
    @{ ok = ($missing.Count -eq 0); missing = $missing } }
  readSearch = { param($a) $l = Need-Line; $sf = (ReadSearchField $l)[0]; @{ value = [string]$sf.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } }
  readEdit = { param($a) $l = Need-Line; $e = Edit $l; @{ value = (EditValue $e); hasFocus = [bool]$e.Current.HasKeyboardFocus } }
}

Out-Json @{ id = 0; ok = $true; result = (& $handlers.hello @{}); activity = $false }
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = -1
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id; $a = $req.args; if ($null -eq $a) { $a = [pscustomobject]@{} }
    switch ([string]$req.cmd) {
      'shutdown' { Ok $id @{ bye = $true } $null; exit 0 }
      'readList' { Cmd-ReadList $id $a $true }
      'readListGeometry' { Cmd-ReadList $id $a $false }
      'readTitle' {
        $l = Need-Line
        if ($null -eq $ocr) { throw 'ocr_unavailable' }
        $tr = TitleRect $l; $cap = Snap $l; $c = CropScreen $cap $tr; $cap.Bmp.Dispose()
        if ($null -eq $c) { Refuse $id 'capture_blank' 'title' $null; break }
        $h = [LineHostNative]::Hash($c); $script:approved[$h] = $true
        $blank = $false; [void][LineHostNative]::MeanLum($c, [ref]$blank)
        $by = @{}
        foreach ($cn in @($a.configs | ForEach-Object { [string]$_ })) { $cfg = $TITLE_CFG[$cn]; if ($null -eq $cfg) { continue }; $by[$cn] = (Ocr-Bitmap $c $cfg @{ x = $tr.x; y = $tr.y }).lines }
        $c.Dispose()
        Ok $id @{ byConfig = $by; stripRect = $tr; stripHash = $h; blank = $blank } $null
      }
      'waitTitleStable' {
        $l = Need-Line; $prev = $null; $sw2 = [Diagnostics.Stopwatch]::StartNew(); $done = $null
        while ($sw2.ElapsedMilliseconds -lt 2000) {
          $h = TitleHashNow $l
          if ($h -ne '' -and $h -eq $prev) { $done = $h; break }
          $prev = $h; Start-Sleep -Milliseconds 250
        }
        if ($null -eq $done) { Refuse $id 'title_changed' 'unstable' $null } else { Ok $id @{ stripHash = $done } $null }
      }
      'activateLine' {
        $l = Need-Line; $q = QuietArgs $a.quiet
        $g = Raise-LineGuarded $id $l $q $RAISE_FLOOR_MS.activate ([bool]$a.restore)
        if (-not $g.ok) { Refuse $id 'user_busy' '' $g.waited; break }
        Start-Sleep -Milliseconds 300
        Ok $id @{ foreground = ([LineHostNative]::GetForegroundWindow() -eq $l.hwnd) } $g.waited
      }
      'guardedClick' {
        $l = Need-Line; $q = QuietArgs $a.quiet; $w = 0
        $target = $a.row; $win = @($a.windowRows)
        if (-not (@($win | Where-Object { [int]$_.index -eq [int]$target.index }).Count -eq 1)) { Refuse $id 'row_changed' 'target_not_in_window' $null; break }
        # ① 安靜期（最多等 maxWaitMs）
        Note-QuietWait $id $q $false
        if (-not [LineHostNative]::QuietGate($q.min, $q.max, $false, [ref]$w)) { Refuse $id 'user_busy' '' $w; break }
        # ② 同一次擷取：所有完整可見列的 index→rect、hash 都和讀取時相同
        $li = ListItems $l; $lr = RectOf $li.list; $cap = Snap $l; $rows = RowGeom $li $cap $lr; $cap.Bmp.Dispose()
        $bad = $null
        foreach ($wr in $win) {
          $ix = [int]$wr.index
          if ($ix -lt 0 -or $ix -ge $rows.Count) { $bad = 'index'; break }
          if (-not (SameRect $rows[$ix].rect $wr.rect)) { $bad = 'rect'; break }
          if ($rows[$ix].hash -ne [string]$wr.hash) { $bad = 'hash'; break }
        }
        if ($bad) { Refuse $id 'row_changed' $bad $w; break }
        # ②' 目標列本身（row 參數）也必須和當下擷取完全相同，而且仍是完整可見列
        $tr0 = $rows[[int]$target.index]
        if (-not (SameRect $tr0.rect $target.rect) -or $tr0.hash -ne [string]$target.hash -or $tr0.rect.h -le 0 -or $tr0.visibleH -lt $FULLY_VISIBLE * $tr0.rect.h) { Refuse $id 'row_changed' 'target' $w; break }
        # ③ 點擊點的根視窗是 LINE 主視窗
        $px = [int]($tr0.rect.x + $tr0.rect.w / 2); $py = [int]($tr0.top + $tr0.visibleH / 2)
        if (-not [LineHostNative]::PointOnWindow($px, $py, $l.hwnd)) { Refuse $id 'occluded' '' $w; break }
        # ④ 動作前最後一刻：安靜期仍成立
        if (-not [LineHostNative]::StillQuiet($q.min, $false)) { Refuse $id 'user_busy' 'late' $w; break }
        if ($a.dryRun) { Ok $id @{ clicked = $false; dryRun = $true; selectedIndexAfter = $null } $w; break }
        [LineHostNative]::ClickAt($px, $py)
        if ($null -ne $script:baseline) { $script:baseline = [LineHostNative]::LastInputTick() }
        Start-Sleep -Milliseconds 300
        $after = $null; $li2 = ListItems $l; $k = 0
        foreach ($it in $li2.items) { if ((IsSelected $it) -eq $true) { $after = $k; break }; $k++ }
        Ok $id @{ clicked = $true; selectedIndexAfter = $after } $w
      }
      'setEdit' {
        $l = Need-Line; $q = QuietArgs $a.quiet; $w = 0
        if (-not $script:approved.ContainsKey([string]$a.titleHash)) { Refuse $id 'title_not_approved' '' $null; break }
        Note-QuietWait $id $q $true
        if (-not [LineHostNative]::QuietGate($q.min, $q.max, $true, [ref]$w)) { Refuse $id 'user_busy' '' $w; break }
        if ((TitleHashNow $l) -ne [string]$a.titleHash) { Refuse $id 'title_changed' '' $w; break }
        $e = Edit $l
        if ((EditValue $e) -ne '') { Refuse $id 'edit_not_empty' '' $w; break }
        if (-not [LineHostNative]::StillQuiet($q.min, $true)) { Refuse $id 'user_busy' 'late' $w; break }
        $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$a.text)
        Start-Sleep -Milliseconds 400
        Ok $id @{ readback = (EditValue (Edit $l)) } $w
      }
      'clearEditIfEquals' {
        $l = Need-Line
        if (-not $script:approved.ContainsKey([string]$a.titleHash) -or (TitleHashNow $l) -ne [string]$a.titleHash) { Refuse $id 'title_changed' '' $null; break }
        $e = Edit $l; $v = EditValue $e
        if ((NormNl $v) -ne (NormNl ([string]$a.expect))) { Refuse $id 'edit_mismatch' '' $null; break }
        $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('')
        Start-Sleep -Milliseconds 300
        if ((EditValue (Edit $l)) -eq '') { Ok $id @{ cleared = $true } $null } else { Refuse $id 'edit_mismatch' 'not_cleared' $null }
      }
      'focusEdit' {
        # review F1：切前景之前守門（安靜期 ≥ 500 ms、沒有按鍵、沒有滑鼠按鍵）。不通過 → user_busy，LINE 沒有被切換。
        $l = Need-Line; $q = QuietArgs $a.quiet
        $g = Raise-LineGuarded $id $l $q $RAISE_FLOOR_MS.focus $true
        if (-not $g.ok) { Refuse $id 'user_busy' '' $g.waited; break }
        Start-Sleep -Milliseconds 200
        if (-not $script:approved.ContainsKey([string]$a.titleHash) -or (TitleHashNow $l) -ne [string]$a.titleHash) { Refuse $id 'title_changed' '' $g.waited; break }
        # 放游標進輸入框前最後一刻：切前景之後又有輸入 → 不放游標（LINE 已在前景，detail=late）。
        if (-not [LineHostNative]::StillQuiet($g.min, $true)) { Refuse $id 'user_busy' 'late' $g.waited; break }
        (Edit $l).SetFocus()
        Ok $id @{ focused = $true } $g.waited
      }
      'handBackFocus' {
        $l = Need-Line; $target = [IntPtr][int64]([string]$a.hwnd)
        $fg = [LineHostNative]::GetForegroundWindow()
        if ($fg -ne $l.hwnd -or $target -eq [IntPtr]::Zero) { Ok $id @{ handedBack = $false; reason = 'line_not_foreground' } $null; break }
        $me = [LineHostNative]::GetCurrentThreadId(); $ft = [LineHostNative]::WindowThread($fg)
        $att = [LineHostNative]::AttachThreadInput($me, $ft, $true)
        [void][LineHostNative]::SetForegroundWindow($target)
        if ($att) { [void][LineHostNative]::AttachThreadInput($me, $ft, $false) }
        Start-Sleep -Milliseconds 150
        Ok $id @{ handedBack = ([LineHostNative]::GetForegroundWindow() -eq $target) } $null
      }
      default {
        $h = $handlers[[string]$req.cmd]
        if ($null -eq $h) { Out-Json @{ id = $id; ok = $false; error = 'unknown_cmd'; activity = (Activity) }; break }
        Ok $id (& $h $a) $null
      }
    }
  } catch {
    Out-Json @{ id = $id; ok = $false; error = [string]$_.Exception.Message; activity = (Activity) }
  }
}
