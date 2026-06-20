# tv_deep_dive — Design (chart + radar state)

**Date:** 2026-06-20
**Status:** Approved for planning (user delegated "proceed").
**Builds on:** `tv_screenshot` (v3/v4) and the existing radar snapshot data.

## Goal

A `tv_deep_dive` MCP tool that returns a ticker's TradingView chart image(s)
**plus** a compact text block of its current radar technical state, so Claude can
analyze the visual chart and the radar's numbers together in one call.

## Scope

In scope (v1):
1. New `tv_deep_dive({ symbol, intervals? })` MCP tool.
2. Read radar state for the ticker from on-disk JSON snapshots (no live API).
3. Reuse the existing `--screenshot` capture for the chart — **no script change**.
4. Return chart image(s) + a formatted radar-state text block (with snapshot date).

Out of scope (future): fundamentals/earnings, Finnhub news, full bull/bear thesis
generation (that stays in the `radar-deep-dive` skill, which can call this tool),
ticker→symbol mapping for foreign exchanges beyond simple normalization.

## Architecture

The MCP does the radar lookup itself: the radar/lean/monitor snapshots are plain
on-disk JSON data files, so reading them and extracting fields is trivial in JS —
no TypeScript and no domain logic. The chart reuses the script's `--screenshot`
mode (which already returns `shots[]` images), so `sync-tv-watchlist.ts` is
unchanged. All new code is in the MCP package.

```
tv_deep_dive({ symbol, intervals? })
   ├─ radarData.loadLatestRadar(REPO_DIR)  → newest results/radar-YYYY-MM-DD.json
   │   + loadLatestLean() + monitor-list.json ; findStock(snapshot, symbol)
   ├─ runTvSync(buildScreenshotArgs({symbol, intervals}))  → shots[] → image blocks
   └─ return content: [ {text: radar-state block}, image(s)… ]
```

## Data sources (on disk, repo `results/`)
- `radar-YYYY-MM-DD.json` — `.stocks[]` per-ticker `StockData` (price, rvol,
  priceChange, pctFromAth, action, breakoutStage, championScore, entryGrade,
  momentum{level,criteria{8 bools}}, sector, sectorRank, tradePlan{pivot,
  buyZoneLow/High, stopLoss, riskPct}, isHotStreak, isFatigued, plus `scanDate`).
- `lean-YYYY-MM-DD.json` — `.detections` (highVolume, pullbacks, nearConsolidation,
  consolidationBreakouts, …) to note which buckets the ticker appears in.
- `monitor-list.json` — graduation/monitoring status for the ticker (if present).

"Latest" = the file whose name matches `radar-\d{4}-\d{2}-\d{2}.json` (i.e.
**excluding** `radar-reconstructed-*.json`) with the greatest date; same for lean.

## Ticker ↔ symbol matching
`normalizeTicker(s)`: uppercase, strip a leading exchange prefix (`TASE:`,
`NASDAQ:`, etc.) and a trailing `.TA`/`.TW`/`.T` suffix, returning the base.
Match the requested `symbol` against `stock.ticker` by normalized base. US tickers
match cleanly; unmatched (often foreign) → the chart still returns with a
"not in latest radar snapshot" note rather than an error.

## MCP changes (`mcp-tv-sync`)
- **`src/radarData.js` (new):**
  - `loadLatestRadar(repoDir)` / `loadLatestLean(repoDir)` → parsed JSON or null.
  - `findStock(snapshot, symbol)` → the matching `stocks[]` entry or null.
  - `formatDeepDive({ symbol, stock, lean, monitorEntry, scanDate })` → a concise
    multi-line **text** summary (pure function, unit-tested with a fixture).
  - `loadMonitorEntry(repoDir, symbol)` → entry or null.
- **`src/tools.js`:** add `tv_deep_dive` (symbol required string; intervals optional
  array, maxItems 4 — same as screenshot). `TOOL_SPECS.tv_deep_dive = { build:
  buildScreenshotArgs, kind: 'deepdive' }` (reuses the screenshot arg-builder).
- **`index.js`:** add a `kind === 'deepdive'` branch: run the screenshot, build the
  image blocks exactly like the `image` branch, then **prepend** a text block from
  `formatDeepDive(...)` (loaded via radarData). Same isError rules as `image` for
  the chart; the radar block degrades to a "not found / no snapshot" note.

## Error handling
- Ticker not found in snapshot, or no snapshot files present → still return the
  chart, with a clear text note (date of snapshot checked, or "no radar snapshot").
- Screenshot timeout / unreadable PNGs → isError (identical to the `image` branch).
- Malformed/missing radar JSON → caught; radar block becomes a note, chart still returns.

## Testing
- **Unit (`formatDeepDive`):** given a fixture `stock` object → output contains the
  key fields (action, champion score, RVOL, momentum criteria, trade-plan levels)
  and the snapshot date; missing-stock → a clean "not found" note. `normalizeTicker`
  strips prefixes/suffixes correctly.
- **Integration (manual):** `tv_deep_dive({symbol:"NVDA"})` → chart image + a radar
  block whose numbers match `radar-*.json` for NVDA; a ticker absent from the
  snapshot → chart + "not found" note (no error).
