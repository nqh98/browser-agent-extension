#!/usr/bin/env bash
# Browser Agent installer for macOS and Linux. Run from the cloned folder:  ./install.sh
# Installs (or updates) the Claude Code plugin from this folder, then opens
# chrome://extensions with the folder path on the clipboard for "Load unpacked".
# Chrome only installs extensions from a folder through that page, so the last
# three clicks are yours.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
MARKETPLACE="browser-agent-extension"
PLUGIN="browser-agent@$MARKETPLACE"

case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in vi*) VI=1 ;; *) VI=0 ;; esac
say() { if [ "$VI" = 1 ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
ok() { say "  ✓ $1" "  ✓ $2"; }
warn() { say "  ! $1" "  ! $2"; }

say "Browser Agent installer" "Cài đặt Browser Agent"
say "Folder: $DIR" "Thư mục: $DIR"
echo

if [ ! -f "$DIR/manifest.json" ] || [ ! -f "$DIR/claude-code/server/index.js" ]; then
  say "This script must stay in the Browser Agent folder (next to manifest.json)." \
      "Script này phải nằm trong thư mục Browser Agent (cạnh manifest.json)."
  exit 1
fi

# ---- 1. Claude Code plugin (optional: only needed for "Control from Claude Code") ----
say "1/2 Claude Code plugin" "1/2 Plugin Claude Code"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js 18+ not found. The plugin needs it: https://nodejs.org" \
       "Chưa có Node.js 18 trở lên. Plugin cần nó: https://nodejs.org"
fi
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code (claude) not found; skipped. Chat mode works without it. Install Claude Code, then run this again." \
       "Không thấy Claude Code (claude); bỏ qua. Chế độ Chat vẫn dùng được. Cài Claude Code rồi chạy lại script này."
else
  if claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": \"$MARKETPLACE\""; then
    claude plugin marketplace update "$MARKETPLACE" >/dev/null 2>&1
  else
    claude plugin marketplace add "$DIR" >/dev/null 2>&1 \
      || warn "Could not add the marketplace: claude plugin marketplace add \"$DIR\"" \
              "Không thêm được marketplace: claude plugin marketplace add \"$DIR\""
  fi
  if claude plugin list --json 2>/dev/null | grep -q "\"id\": \"$PLUGIN\""; then
    if claude plugin update "$PLUGIN" >/dev/null 2>&1; then
      ok "Plugin updated. In open Claude Code sessions: /mcp → browser-agent → Reconnect." \
         "Đã cập nhật plugin. Trong các phiên Claude Code đang mở: /mcp → browser-agent → Reconnect."
    else
      warn "Could not update the plugin: claude plugin update $PLUGIN" \
           "Không cập nhật được plugin: claude plugin update $PLUGIN"
    fi
  elif claude plugin install "$PLUGIN" >/dev/null 2>&1; then
    ok "Plugin installed. Restart Claude Code to load it." \
       "Đã cài plugin. Khởi động lại Claude Code để nạp nó."
  else
    warn "Could not install the plugin: claude plugin install $PLUGIN" \
         "Không cài được plugin: claude plugin install $PLUGIN"
  fi
fi
echo

# ---- 2. Chrome extension ----
say "2/2 Chrome extension" "2/2 Extension Chrome"
COPIED=0
if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$DIR" | pbcopy && COPIED=1
elif command -v wl-copy >/dev/null 2>&1; then printf '%s' "$DIR" | wl-copy && COPIED=1
elif command -v xclip >/dev/null 2>&1; then printf '%s' "$DIR" | xclip -selection clipboard && COPIED=1
elif command -v xsel >/dev/null 2>&1; then printf '%s' "$DIR" | xsel --clipboard --input && COPIED=1
fi

OPENED=0
if [ "$(uname)" = Darwin ]; then
  for app in "Google Chrome" "Microsoft Edge" "Chromium" "Brave Browser"; do
    if open -Ra "$app" 2>/dev/null; then
      page="chrome://extensions"; [ "$app" = "Microsoft Edge" ] && page="edge://extensions"
      open -a "$app" --args "$page" && OPENED=1 && break
    fi
  done
else
  for bin in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
    if command -v "$bin" >/dev/null 2>&1; then
      page="chrome://extensions"; case "$bin" in microsoft-edge*) page="edge://extensions" ;; esac
      nohup "$bin" "$page" >/dev/null 2>&1 &
      OPENED=1
      break
    fi
  done
fi
[ "$OPENED" = 1 ] || warn "Open chrome://extensions in Chrome yourself." "Tự mở chrome://extensions trong Chrome."

echo
say "Finish in the browser (only the first time):" "Hoàn tất trong trình duyệt (chỉ lần đầu):"
say "  a. Turn on \"Developer mode\" (top right)." "  a. Bật \"Developer mode\" (góc trên bên phải)."
say "  b. Click \"Load unpacked\"." "  b. Bấm \"Load unpacked\"."
if [ "$COPIED" = 1 ]; then
  say "  c. Paste the folder path (copied for you) and confirm:" "  c. Dán đường dẫn thư mục (đã chép sẵn) rồi xác nhận:"
else
  say "  c. Choose this folder:" "  c. Chọn thư mục này:"
fi
echo "       $DIR"
if [ "$(uname)" = Darwin ]; then
  say "     (in the folder picker: ⌘⇧G, then ⌘V)" "     (trong hộp chọn thư mục: ⌘⇧G, rồi ⌘V)"
else
  say "     (in the folder picker: Ctrl+L, then Ctrl+V)" "     (trong hộp chọn thư mục: Ctrl+L, rồi Ctrl+V)"
fi
say "Already installed? Click ↻ on Browser Agent instead, then reopen the side panel." \
    "Đã cài rồi? Chỉ cần bấm ↻ ở Browser Agent, rồi mở lại side panel."
