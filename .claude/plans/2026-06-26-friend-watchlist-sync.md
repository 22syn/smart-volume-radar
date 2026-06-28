# Friend Watchlist → Universe Sheet Sync

**Date:** 2026-06-26
**Branch:** `feat/friend-watchlist-sync`

## Goal

Populate the radar's universe Google Sheet (`GOOGLE_SHEET_ID`, columns `Symbol | Sector`)
from a friend's **shared/public TradingView watchlists** — one watchlist per sector. The
scan pipeline is unchanged: it keeps reading the same sheet via public CSV.

## Pipeline

```
for each source { sector, shareUrl }:
   fetchSharedWatchlist(shareUrl)   → TradingView symbols  (public HTTP, no login)
   map each via tvToYahoo()         → Yahoo symbol | null (null = report + skip)
collect rows (Symbol, Sector=sector), dedup by symbol (first sector wins)
writeUniverseSheet(GOOGLE_SHEET_ID, rows)   → overwrite Symbol|Sector
   ↓
daily-scan reads the same sheet as today (no change)
```

Runs as a **CI step before the scan** in `daily-scan.yml`. Also runnable manually via
`npm run sync-friend-watchlists`.

## Files (ESM, `.js` import extensions, `logger`, no `console.log`/`any`)

- `src/services/sharedWatchlist.ts` — `extractSymbols(html)`, `fetchSharedWatchlist(url)`.
  Port of the tradingview-mcp module: parse `window.initData` `"symbols":[...]`, drop
  `###` section headers / non-`:` rows.
- `src/services/symbolMap.ts` — `tvToYahoo(tvSymbol): string | null`. Full exchange map
  (US, TASE, XETR, LSE, SIX, MIL, VIE, TWSE, KRX, BMFBOVESPA, BME, Tokyo `.T`,
  Thailand `.BK`, HKEX `.HK`, ASX `.AX`, TSX `.TO`/`.V`, NSE `.NS`, BSE `.BO`).
  US → strip prefix, `.`→`-` (class shares). EURONEXT → `EURONEXT_OVERRIDES` table
  (e.g. ASML→.AS); unknown EURONEXT or unknown exchange → `null`.
- `src/services/universeSheetWriter.ts` — `writeUniverseSheet(sheetId, rows)` via
  `googleapis` service account. Auth from `GOOGLE_SHEETS_CREDENTIALS` (path) **or**
  `GOOGLE_SHEETS_CREDENTIALS_JSON` (raw JSON, for CI secret). Writes header
  `Symbol,Sector` + rows to the first tab; clears `A:B` first.
- `scripts/sync-friend-watchlists.ts` — orchestrator + CLI. Loads
  `watchlist-sources.json`, runs the pipeline, logs a per-sector summary and the full
  skipped/unmapped list, exits non-zero on hard failure.
- `watchlist-sources.json` (gitignored) + `watchlist-sources.example.json`
  — `[{ "shareUrl": "https://www.tradingview.com/watchlists/<id>/" }]`. `sector` is
  optional; when omitted it defaults to the watchlist's own name (read from the page).
- `tests/symbolMap.test.ts`, `tests/sharedWatchlist.test.ts` (Jest).
- `package.json` — `googleapis` dep + `sync-friend-watchlists` script.
- `.gitignore` — `watchlist-sources.json`, `*.gserviceaccount.json`.
- `.github/workflows/daily-scan.yml` — add a "Sync friend watchlists" step before
  "Run Smart Volume Radar", env: `GOOGLE_SHEET_ID`, `GOOGLE_SHEETS_CREDENTIALS_JSON`.

## Conversion safety

- A symbol that maps to `null` is **skipped and reported** (never written), mirroring the
  existing `invalidSkipped` reporting in `parseWatchlistCsv`.
- A source that reads 0 symbols is skipped (no write) so a transient miss never wipes the
  universe. If ALL sources fail / total rows is 0 → hard fail, no write.

## Out of scope

- Bi-directional sync. Per-symbol annotations. Auto-discovering the friend's lists.
- Resolving ambiguous EURONEXT/KRX venues beyond the override table (reported instead).
