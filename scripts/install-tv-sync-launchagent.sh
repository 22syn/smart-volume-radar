#!/usr/bin/env bash
# Install LaunchAgent that syncs the daily Lean Radar watchlist into TradingView.
#
# Schedule: Mon-Fri at 23:25 IDT (10 min after Lean Radar fires at 23:15 IDT).
# Mac wake-from-sleep: launchd fires missed events when the mac wakes up.
#
# To install:    bash scripts/install-tv-sync-launchagent.sh
# To uninstall:  bash scripts/install-tv-sync-launchagent.sh --uninstall

set -e
PLIST_LABEL="com.smart-volume-radar.tv-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_PATH="$(command -v npm)"
GH_PATH="$(command -v gh)"

if [ "$1" == "--uninstall" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✓ Uninstalled $PLIST_LABEL"
    exit 0
fi

if [ -z "$NPM_PATH" ]; then
    echo "❌ npm not found in PATH"
    exit 1
fi
if [ -z "$GH_PATH" ]; then
    echo "⚠️ gh CLI not found — sync will fall back to local results/ file"
fi

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>cd "${PROJECT_DIR}" &amp;&amp; npm run tv-sync &gt;&gt; ~/Library/Logs/tv-sync-launchd.log 2&gt;&amp;1</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>25</integer></dict>
        <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>25</integer></dict>
        <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>25</integer></dict>
        <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>25</integer></dict>
        <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>25</integer></dict>
    </array>

    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/tv-sync-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/tv-sync-launchd.err</string>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

plutil -lint "$PLIST_PATH" >/dev/null
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "✓ Installed $PLIST_LABEL"
echo "  schedule: Mon-Fri 23:25 IDT (10 min after Lean Radar)"
echo "  logs:     ~/Library/Logs/tv-sync.log + tv-sync-launchd.log"
echo ""
echo "Verify:"
echo "  launchctl list | grep tv-sync"
echo ""
echo "Test now (manual fire):"
echo "  launchctl start ${PLIST_LABEL}"
echo ""
echo "Uninstall:"
echo "  bash scripts/install-tv-sync-launchagent.sh --uninstall"
