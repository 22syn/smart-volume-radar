# Friend Watchlist → Universe Sheet Sync

**Date:** 2026-06-26
**Branch:** `feat/friend-watchlist-sync`

## Goal

Populate the radar's universe Google Sheet (`GOOGLE_SHEET_ID`, columns `Symbol | Sector`)
from a friend's **shared/public TradingView watchlists** — one watchlist per sector. The
scan pipeline is unchanged: it keeps reading the same sheet via public CSV.

## Pipeline

```
for each source { shareUrl, sector? }:
   fetchSharedWatchlistDetailed(shareUrl)  → { name, symbols }  (public HTTP, no login)
   sector = sector ?? name
   map each symbol via tvToYahoo()  → Yahoo symbol | null (null = report + skip)
collect rows (Symbol, Sector), dedup by symbol (first sector wins)
mergeUniverseSheet(GOOGLE_SHEET_ID, rows)   → APPEND only symbols not already present
   ↓                                          (never deletes/overwrites existing rows)
daily-scan reads the same sheet as today (no change)
```

**Additive only.** The sheet is the curated, ~20-sector source of truth (≈370 symbols);
these lists are a subset. The sync appends symbols missing from the sheet and never
removes or rewrites existing rows, so re-runs are idempotent and lossless.

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
- `src/services/universeSheetWriter.ts` — `mergeUniverseSheet(sheetId, rows)` via
  `googleapis` service account. Auth from `GOOGLE_SHEETS_CREDENTIALS` (path) **or**
  `GOOGLE_SHEETS_CREDENTIALS_JSON` (raw JSON, for CI secret). Reads the first tab's
  column A, **appends only symbols not already present** (`selectNewRows`); never clears
  or deletes. Seeds a `Symbol,Sector` header only if the sheet is blank.
- `scripts/sync-friend-watchlists.ts` — orchestrator + CLI. Loads
  `watchlist-sources.json`, runs the pipeline, logs added vs already-present and the full
  skipped/unmapped list, exits non-zero on per-source failure.
- `watchlist-sources.json` (gitignored) + `watchlist-sources.example.json`
  — `[{ "shareUrl": "https://www.tradingview.com/watchlists/<id>/" }]`. `sector` is
  optional; when omitted it defaults to the watchlist's own name (read from the page).
- `tests/symbolMap.test.ts`, `tests/sharedWatchlist.test.ts`,
  `tests/universeSheetWriter.test.ts` (Jest).
- `package.json` — `googleapis` dep + `sync-friend-watchlists` script.
- `.gitignore` — `watchlist-sources.json`, `*.gserviceaccount.json`.
- `.github/workflows/daily-scan.yml` — add a "Sync friend watchlists" step before
  "Run Smart Volume Radar", env: `GOOGLE_SHEET_ID`, `GOOGLE_SHEETS_CREDENTIALS_JSON`.

## Conversion safety

- A symbol that maps to `null` is **skipped and reported** (never written), mirroring the
  existing `invalidSkipped` reporting in `parseWatchlistCsv`.
- A source that reads 0 symbols is skipped. Because the merge is append-only, a transient
  miss can never delete existing universe rows; nothing-new simply appends nothing.

## Out of scope

- Bi-directional sync. Per-symbol annotations. Auto-discovering the friend's lists.
- Resolving ambiguous EURONEXT/KRX venues beyond the override table (reported instead).
