# TradingView Watchlist Sync — Setup

Automated nightly sync of the Lean Radar "breakout track" watchlist
(graduated + real breakouts + near-pivot) into a named TradingView
watchlist. Runs on the user's Mac via a LaunchAgent.

## Architecture

```
20:15 UTC (Mon-Fri)
  └─→ GitHub Actions: Lean Radar scan
        ├─→ Writes results/tv-watchlist-latest.txt to artifact
        └─→ Sends Telegram report

23:25 IDT (10 min after Lean Radar) — LaunchAgent on YOUR Mac
  └─→ npm run tv-sync
        ├─→ Downloads latest artifact via gh CLI
        ├─→ Opens TradingView in isolated Playwright Chromium
        │     (uses persistent profile at ~/.cache/svr-tv-sync/)
        ├─→ Switches to "Lean Radar" watchlist
        ├─→ Adds new symbols (additive — never removes)
        └─→ Saves screenshot to ~/Library/Logs/tv-sync-{date}.png
```

## One-time setup (5 minutes)

### Step 1 — Verify prerequisites
```bash
node --version    # ≥ 20
gh --version      # any recent version
which npm         # should print a path
```

### Step 2 — Install dependencies and Chromium
```bash
cd ~/.gemini/antigravity/projects/smart-volume-radar
npm install
npx playwright install chromium
```
(Chromium downloads ~300MB; it's a separate browser from your daily Chrome.)

### Step 3 — Create the watchlist in TradingView
1. Open https://www.tradingview.com/chart/ in your normal browser
2. In the right-hand watchlist panel, click the dropdown
3. Select "Create new list"
4. Name it **`Lean Radar`** (exact match — case-sensitive)
5. Save

### Step 4 — One-time login to the Playwright profile
```bash
cd ~/.gemini/antigravity/projects/smart-volume-radar
npm run tv-sync:login
```
This opens a separate Chromium window. Log into TradingView with your
account. **Close the window when done.** The session cookies persist in
`~/.cache/svr-tv-sync/chromium-profile/` and you won't need to log in
again unless TradingView invalidates the session (~30+ days).

### Step 5 — Test the sync (dry-run, visible browser)
```bash
npm run tv-sync:dry
```
This opens the browser, reads the latest watchlist file, prints the
diff, but does NOT modify your TradingView watchlist. Verify the
target symbols look right.

### Step 6 — Run a real sync once
```bash
npm run tv-sync
```
This runs headless and adds symbols. Check `~/Library/Logs/tv-sync.log`
and the screenshot at `~/Library/Logs/tv-sync-{date}.png`.

### Step 7 — Install the LaunchAgent
```bash
bash scripts/install-tv-sync-launchagent.sh
```
This installs and loads the agent. It will fire automatically every
Mon-Fri at 23:25 IDT.

## Daily operation

Nothing required from you. Just:
- Keep your Mac powered on at night (or wake it before 23:25 IDT —
  launchd fires missed events when the mac wakes up)
- Make sure the Chromium profile is still authenticated (renew once
  every 30+ days if needed)

To check it's still working:
```bash
tail -30 ~/Library/Logs/tv-sync.log
ls -lt ~/Library/Logs/tv-sync-*.png | head -3
```

## Troubleshooting

**"Not logged into TradingView"**
→ Run `npm run tv-sync:login` again. Cookies likely expired.

**"Watchlist 'Lean Radar' not found"**
→ Create it manually in TradingView (Step 3 above), or pass a different
name with `--watchlist "Your List Name"`.

**"DOM selector failed"**
→ TradingView changed their HTML. Update `TV_SELECTORS` at the top of
`scripts/sync-tv-watchlist.ts`. Open an issue with a screenshot.

**Want to remove the LaunchAgent**
```bash
bash scripts/install-tv-sync-launchagent.sh --uninstall
```

## Optional flags

```bash
npm run tv-sync -- --watchlist "Custom Name"   # different watchlist
npm run tv-sync -- --file path/to/list.txt     # specific file (no gh download)
npm run tv-sync -- --dry-run                   # diff only, no changes
npm run tv-sync -- --headed                    # visible browser (debug)
npm run tv-sync -- --replace                   # ALSO remove TV symbols not in target
```

## Security notes

- The Chromium profile at `~/.cache/svr-tv-sync/` is isolated from your
  daily Chrome. Compromise of one does not affect the other.
- Session cookies live only on your local disk. They are not committed
  to the repo or sent anywhere except TradingView.
- The TradingView watchlist is additive-only by default (`--replace`
  must be passed explicitly to enable removal).
