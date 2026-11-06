param(
    [string]$SaveDir = "",
    [string]$TitlePrefix = "ReadMe",
    [switch]$ShowHidden
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureProbe
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public sealed class WindowInfo
    {
        public IntPtr Handle;
        public string Title = "";
        public uint ProcessId;
        public bool Visible;
        public long ExStyle;
        public int Width;
        public int Height;
    }

    public static List<WindowInfo> ListWindows(string prefix)
    {
        var result = new List<WindowInfo>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
        {
            var text = new StringBuilder(512);
            GetWindowText(hWnd, text, text.Capacity);
            string title = text.ToString();
            if (string.IsNullOrEmpty(title) || !title.StartsWith(prefix, StringComparison.Ordinal))
            {
                return true;
            }
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            RECT rect;
            GetWindowRect(hWnd, out rect);
            result.Add(new WindowInfo
            {
                Handle = hWnd,
                Title = title,
                ProcessId = pid,
                Visible = IsWindowVisible(hWnd),
                ExStyle = GetWindowLongPtr(hWnd, -20).ToInt64(),
                Width = Math.Max(0, rect.Right - rect.Left),
                Height = Math.Max(0, rect.Bottom - rect.Top)
            });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static double[] CaptureStats(IntPtr hWnd, string path, out int width, out int height)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect))
        {
            throw new InvalidOperationException("GetWindowRect failed");
        }
        width = Math.Max(1, rect.Right - rect.Left);
        height = Math.Max(1, rect.Bottom - rect.Top);
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                IntPtr hdc = graphics.GetHdc();
                try
                {
                    PrintWindow(hWnd, hdc, 2);
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
            }
            bitmap.Save(path, ImageFormat.Png);
            long sum = 0;
            long sumSq = 0;
            long count = 0;
            long nonGray = 0;
            for (int y = 0; y < height; y += 4)
            {
                for (int x = 0; x < width; x += 4)
                {
                    Color color = bitmap.GetPixel(x, y);
                    int luma = (color.R * 299 + color.G * 587 + color.B * 114) / 1000;
                    sum += luma;
                    sumSq += luma * luma;
                    count += 1;
                    if (Math.Abs(color.R - color.G) > 6 || Math.Abs(color.G - color.B) > 6)
                    {
                        nonGray += 1;
                    }
                }
            }
            double mean = count > 0 ? (double)sum / count : 0;
            double variance = count > 0 ? ((double)sumSq / count) - (mean * mean) : 0;
            return new double[] { mean, Math.Sqrt(Math.Max(0, variance)), count > 0 ? (double)nonGray / count : 0 };
        }
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing

$windows = [CaptureProbe]::ListWindows($TitlePrefix)
if (-not $windows.Count) {
    Write-Host "NO_WINDOWS"
    exit 2
}

if ($SaveDir) {
    New-Item -ItemType Directory -Path $SaveDir -Force | Out-Null
}

foreach ($window in $windows) {
    if ($ShowHidden -and -not $window.Visible) {
        [CaptureProbe]::ShowWindow($window.Handle, 5) | Out-Null
        Start-Sleep -Milliseconds 700
        $window.Visible = $true
    }
    $toolWindow = ($window.ExStyle -band 0x80) -ne 0
    $layered = ($window.ExStyle -band 0x80000) -ne 0
    $line = "{0} | pid={1} | visible={2} | tool={3} | layered={4} | {5}x{6}" -f `
        $window.Title, $window.ProcessId, $window.Visible, $toolWindow, $layered, $window.Width, $window.Height
    Write-Host $line
    if ($SaveDir) {
        $safeName = ($window.Title -replace '[^\w\u4e00-\u9fff-]+', '_')
        $path = Join-Path $SaveDir ($safeName + ".png")
        $width = 0
        $height = 0
        $stats = [CaptureProbe]::CaptureStats($window.Handle, $path, [ref]$width, [ref]$height)
        Write-Host ("  capture mean={0:F1} std={1:F1} color={2:P1} -> {3}" -f $stats[0], $stats[1], $stats[2], $path)
    }
}
