# Plan: ChampionScan Phase 2 — Volume Quality + Bands + RS

## Context

After Phase 1 (Champion Score + 6-state actions + trade plan, shipped 2026-05-06),
add the next layer of pure-technical signals inspired by championscan.com:
accumulation/distribution day counts, Bollinger Bands, EMA10/EMA21, and Relative
Strength percentile vs SPY. All compute-only — no new APIs, no new dependencies.

Goal: bring our per-stock signal density closer to championscan's, with
data-driven weights from our own criteria-importance loop.

## Tasks

### Phase 1: Foundation indicators
- 🟩 Add `calculateBollingerBands(closes, period=20, mult=2)`, `calculateEMA(closes, period)`, and `countAccumulationDistributionDays(closes, volumes, lookback=25)` to `src/utils/technicalAnalysis.ts`. — **Verify:** jest unit tests on synthetic fixtures (e.g. BB middle == SMA20; A/D test where 5 days are closeUp+volUp and 3 are closeDown+volUp).
- 🟩 Extend `StockData` types (`bbUpper?, bbMid?, bbLower?, ema10?, ema21Ema?, accumulationDays?, distributionDays?`) and populate them in `parseYahooChartResult` (`src/services/marketData.ts`). — **Verify:** `npx tsc --noEmit` passes; dry-run fetch of NVDA shows all 7 fields populated.

### Phase 2: RS percentile service
- 🟩 Create `src/utils/rsPercentile.ts` exporting `computeRSPercentile(stocks, spyData)` — for each stock, compute 63-day return vs SPY and rank within watchlist 0-100. — **Verify:** unit test on 5-stock fixture: top stock gets 100, bottom gets 0.
- 🟩 Wire into pipeline in `src/index.ts` after `fetchAllStocksAsOfDate` (use SPY chart already fetched by `fetchMarketRegime`). — **Verify:** log line `RS percentile: NVDA=87, AMD=72, ...` appears in scan output.

### Phase 3: Champion Score v2
- 🟩 Update `src/utils/championScore.ts` weights:
  - `accumulationDays >= 3` → +5
  - `distributionDays >= 3` → **-10** (institutional selling warning)
  - `rsPercentile >= 80` → +5
  - BB squeeze (BB width / price < 5%) → +3
  — **Verify:** 4 new unit tests in `tests/championScore.test.ts`, each isolating one contributor.
- 🟩 Add new `CAUTION_DISTRIBUTION` action when `distributionDays >= 4` (overrides BUY/WATCH for stocks under institutional sell pressure). — **Verify:** integration test: stock with score 80 + distDays=5 returns `CAUTION_DISTRIBUTION`.

### Phase 4: Telegram block enhancements
- 🟩 Add to per-stock block in `formatSingleStockBlock` (`src/services/telegramBot.ts`):
  - `📊 A/D: 5↑/2↓ (Accumulation)` line when `accumulationDays >= 3` or `distributionDays >= 3`
  - RS percentile next to Champion Score: `87/100  ·  RS 92`
  - `🔒 BB squeeze` flag when active
  — **Verify:** `scripts/preview-report.ts` output shows all three fields rendered cleanly for 3+ fixture stocks.

### Phase X: Verification (always last)
- 🟩 `npm test` passes (target: 210+ tests after Phase 2 additions).
- 🟩 `npm run lint` reports zero new errors.
- 🟩 `npx tsc --noEmit` clean.
- 🟩 Local scan dry-run (`npm run start` with Telegram routed to test chat or stubbed) — confirm all new fields populated for 5+ stocks.
- 🟩 Commit + push, CI green on the resulting `feat(radar): Champion Score v2` commit.

## Dependencies

```
Phase 1 → Phase 3 (score uses new indicators)
Phase 2 → Phase 3 (score uses RS percentile)
Phase 3 → Phase 4 (Telegram renders the new score/action)
All →    Phase X
```

Phases 1 and 2 are independent and can be done in either order.

## Out of scope (Phase 3 candidates)

- EPS / Revenue acceleration via Finnhub fundamentals API
- Earnings-date integration + pre-earnings warnings
- Pattern detection (cup-handle, VCP, flat-base)
- Dynamic sector rank from sector ETF returns
- Portfolio tracker with P&L and sell signals

These require new API surfaces or substantially more algorithmic work; deferred
until Phase 2 has run for 1-2 weeks and we've validated the new score weights
against the weekly criteria-importance analysis.
