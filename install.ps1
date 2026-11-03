# Browser Agent installer for Windows. Double-click install.cmd, which runs this file.
# Installs (or updates) the Claude Code plugin from this folder, then opens
# chrome://extensions with the folder path on the clipboard for "Load unpacked".
# Chrome only installs extensions from a folder through that page, so the last
# three clicks are yours.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Marketplace = 'browser-agent-extension'
$Plugin = "browser-agent@$Marketplace"
$Vi = (Get-UICulture).Name -like 'vi*'

function Say($en, $vi) { if ($Vi) { Write-Host $vi } else { Write-Host $en } }
function Ok($en, $vi) { Say "  OK $en" "  OK $vi" }
function Warn($en, $vi) { if ($Vi) { Write-Host "  ! $vi" -ForegroundColor Yellow } else { Write-Host "  ! $en" -ForegroundColor Yellow } }

Say 'Browser Agent installer' 'Cài đặt Browser Agent'
Say "Folder: $Dir" "Thư mục: $Dir"
Write-Host ''

if (-not (Test-Path (Join-Path $Dir 'manifest.json')) -or -not (Test-Path (Join-Path $Dir 'claude-code\server\index.js'))) {
  Say 'This script must stay in the Browser Agent folder (next to manifest.json).' 'Script này phải nằm trong thư mục Browser Agent (cạnh manifest.json).'
  exit 1
}

# ---- 1. Claude Code plugin (optional: only needed for "Control from Claude Code") ----
Say '1/2 Claude Code plugin' '1/2 Plugin Claude Code'
$nodeMajor = 0
try { $nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]' 2>$null) } catch {}
if ($nodeMajor -lt 18) {
  Warn 'Node.js 18+ not found. The plugin needs it: https://nodejs.org' 'Chưa có Node.js 18 trở lên. Plugin cần nó: https://nodejs.org'
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Warn 'Claude Code (claude) not found; skipped. Chat mode works without it. Install Claude Code, then run this again.' 'Không thấy Claude Code (claude); bỏ qua. Chế độ Chat vẫn dùng được. Cài Claude Code rồi chạy lại script này.'
} else {
  $markets = @()
  try { $markets = (& claude plugin marketplace list --json 2>$null | Out-String | ConvertFrom-Json) } catch {}
  if ($markets | Where-Object { $_.name -eq $Marketplace }) {
    & claude plugin marketplace update $Marketplace *> $null
  } else {
    & claude plugin marketplace add $Dir *> $null
    if ($LASTEXITCODE -ne 0) { Warn "Could not add the marketplace: claude plugin marketplace add `"$Dir`"" "Không thêm được marketplace: claude plugin marketplace add `"$Dir`"" }
  }
  $plugins = @()
  try { $plugins = (& claude plugin list --json 2>$null | Out-String | ConvertFrom-Json) } catch {}
  if ($plugins | Where-Object { $_.id -eq $Plugin }) {
    & claude plugin update $Plugin *> $null
    if ($LASTEXITCODE -eq 0) { Ok 'Plugin updated. In open Claude Code sessions: /mcp -> browser-agent -> Reconnect.' 'Đã cập nhật plugin. Trong các phiên Claude Code đang mở: /mcp -> browser-agent -> Reconnect.' }
    else { Warn "Could not update the plugin: claude plugin update $Plugin" "Không cập nhật được plugin: claude plugin update $Plugin" }
  } else {
    & claude plugin install $Plugin *> $null
    if ($LASTEXITCODE -eq 0) { Ok 'Plugin installed. Restart Claude Code to load it.' 'Đã cài plugin. Khởi động lại Claude Code để nạp nó.' }
    else { Warn "Could not install the plugin: claude plugin install $Plugin" "Không cài được plugin: claude plugin install $Plugin" }
  }
}
Write-Host ''

# ---- 2. Chrome extension ----
Say '2/2 Chrome extension' '2/2 Extension Chrome'
$copied = $false
try { Set-Clipboard -Value $Dir; $copied = $true } catch {}

$browsers = @(
  @{ Path = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"; Page = 'chrome://extensions' },
  @{ Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"; Page = 'chrome://extensions' },
  @{ Path = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"; Page = 'chrome://extensions' },
  @{ Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"; Page = 'edge://extensions' },
  @{ Path = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"; Page = 'edge://extensions' }
)
$opened = $false
foreach ($b in $browsers) {
  if ($b.Path -and (Test-Path $b.Path)) { Start-Process -FilePath $b.Path -ArgumentList $b.Page; $opened = $true; break }
}
if (-not $opened) { Warn 'Open chrome://extensions in Chrome yourself.' 'Tự mở chrome://extensions trong Chrome.' }

Write-Host ''
Say 'Finish in the browser (only the first time):' 'Hoàn tất trong trình duyệt (chỉ lần đầu):'
Say '  a. Turn on "Developer mode" (top right).' '  a. Bật "Developer mode" (góc trên bên phải).'
Say '  b. Click "Load unpacked".' '  b. Bấm "Load unpacked".'
if ($copied) { Say '  c. Paste the folder path (copied for you) into the address bar of the folder picker and confirm:' '  c. Dán đường dẫn thư mục (đã chép sẵn) vào thanh địa chỉ của hộp chọn thư mục rồi xác nhận:' }
else { Say '  c. Choose this folder:' '  c. Chọn thư mục này:' }
Write-Host "       $Dir"
Say 'Already installed? Click the reload icon on Browser Agent instead, then reopen the side panel.' 'Đã cài rồi? Chỉ cần bấm nút tải lại ở Browser Agent, rồi mở lại side panel.'
