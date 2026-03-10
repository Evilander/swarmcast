# SwarmCast Weather Widget Launcher
# Opens widget.html as a compact, always-on-top window using Edge WebView2
# Usage: powershell -ExecutionPolicy Bypass -File widget-launcher.ps1
# Requires: Windows 10/11 with Edge WebView2 runtime (ships with Win11)

param(
    [string]$Url = "http://127.0.0.1:3777/widget.html",
    [int]$Width = 340,
    [int]$Height = 480,
    [switch]$BottomRight
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "SwarmCast"
$form.Width = $Width
$form.Height = $Height
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(15, 18, 24)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual

# Position: bottom-right of primary screen by default
if ($BottomRight -or -not $PSBoundParameters.ContainsKey('BottomRight')) {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Left = $screen.Right - $Width - 12
    $form.Top = $screen.Bottom - $Height - 12
}

# Use WebBrowser control as fallback (WebView2 requires separate NuGet package)
$browser = New-Object System.Windows.Forms.WebBrowser
$browser.Dock = [System.Windows.Forms.DockStyle]::Fill
$browser.ScrollBarsEnabled = $false
$browser.ScriptErrorsSuppressed = $true
$browser.IsWebBrowserContextMenuEnabled = $false

# Navigate to widget
$browser.Navigate($Url)

$form.Controls.Add($browser)

# Allow dragging the window
$dragging = $false
$dragStart = [System.Drawing.Point]::Empty

$form.Add_MouseDown({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $script:dragging = $true
        $script:dragStart = $e.Location
    }
})

$form.Add_MouseMove({
    param($s, $e)
    if ($script:dragging) {
        $form.Left += $e.X - $script:dragStart.X
        $form.Top += $e.Y - $script:dragStart.Y
    }
})

$form.Add_MouseUp({
    $script:dragging = $false
})

# Right-click to close
$form.Add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
        $form.Close()
    }
})

# Escape to close
$form.KeyPreview = $true
$form.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        $form.Close()
    }
})

[System.Windows.Forms.Application]::Run($form)
