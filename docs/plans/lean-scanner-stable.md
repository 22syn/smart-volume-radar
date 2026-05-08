# Plan: Lean Scanner — Stable Branch (3-Signal Production)

## Context

Run a stripped-down scanner alongside the experimental main: three crisp,
research-backed signals (consolidation breakout, 3x volume, healthy pullback) on
a separate `stable` branch. Same Telegram chat, same schedule, separate CI
workflow. Goal: 30-day analytical A/B comparison vs the Champion-Score scanner
to decide which approach actually generates better forward returns.

## Tasks

### Phase 1: Branch setup
- 🟩 Create branch `stable` from current `main` (commit `792e65d`). Push to origin so CI can run on it. — **Verify:** `git branch -a` shows `origin/stable`; `gh api repos/KobiHaz/StockMarketBot/branches/stable` returns 200.

### Phase 2: Three signal detectors (`src/lean/signals.ts`, new file)
- 🟩 `detectConsolidationBreakout(stock, closes, highs, lows)` — returns `{ window: '1M'|'3M'|'1Y', baseRangePct: number, brokenToday: boolean }` when ALL of: (1) range `(high−low)/mid` over the window ≤ threshold (1M=10% / 3M=15% / 1Y=25%), (2) `lastPrice > windowHigh`, (3) Stage 2 (`price > sma50 > sma200`), (4) `rvol ≥ 1.5`. Returns `null` if no window qualifies. — **Verify:** 6 unit tests on synthetic 252-bar series — one pass + one fail per window.
- 🟩 `qualifiesAsHighVolume(stock): 'extreme' | 'high' | null` — `'extreme'` when `rvol ≥ 5`, `'high'` when `rvol ≥ 3`, else `null`. — **Verify:** 3 unit tests covering both thresholds + below.
- 🟩 `qualifiesAsHealthyPullback(stock): { pctFromAth: number } | null` — passes when `−25% ≤ pctFromAth ≤ −15%` AND `price > sma200`. Returns the actual `pctFromAth` for rendering. — **Verify:** 4 unit tests (pass / too shallow / too deep / below SMA200).
- 🟩 Each detector also exports a `near*` variant returning near-miss data for the Silent Watchlist (consolidation within 2% of pivot, RVOL 2.5-3x, pullback −12% to −15%). — **Verify:** unit tests assert near-miss returns ONLY when just below the trigger.

### Phase 3: Lean entrypoint (`src/lean.ts`)
- 🟩 Minimal pipeline that reuses existing infrastructure: `loadWatchlist` → `fetchAllStocksAsOfDate` → run 3 detectors → `formatLeanReport` → `sendTelegramMessage`. **No** Champion Score, **no** action labels, **no** trade plan, **no** monitor follow-up, **no** breakout-stage classification, **no** fundamentals enrichment. — **Verify:** `npm run start:lean` runs end-to-end locally; logs show "X consolidation breakouts, Y high-volume, Z pullbacks, W silent".
- 🟩 Add `npm run start:lean` and `npm run preview:lean` to `package.json`. — **Verify:** both scripts execute without errors.

### Phase 4: Lean Telegram report (`src/lean/format.ts`)
- 🟩 `formatLeanReport(detected, near)` — header `🪶 <b>LEAN SCANNER</b>` (visually distinct from main), 4 sections: 📈 Consolidation Breakout, 🔥 High Volume (3x+ / ⚡ 5x+), 📉 Healthy Pullback, 👁️ Silent Watchlist. **One line per stock** (ticker + 1-2 key metrics). — **Verify:** snapshot test on fixture stocks; rendered output ≤ 3500 chars (single Telegram message).
- 🟩 Empty-state line when 0 stocks across all sections. Hide a section entirely when its bucket is empty (no zero-rows). — **Verify:** test passes with all-empty input — message contains "אין איתותים".

### Phase 5: CI workflow (`.github/workflows/daily-scan-lean.yml`)
- 🟩 Cron `15 20 * * 1-5` UTC (same as main scan). Same secrets. `npm run start:lean`. Telegram failure notification on error. **Important:** `branches: [stable]` so it only runs on the stable branch. — **Verify:** manual `workflow_dispatch` trigger from CLI; run completes; new Telegram message arrives at the expected chat with the 🪶 header.

### Phase X: Verification (always last)
- 🟩 `npm test` passes on the stable branch (target: ≥255 tests).
- 🟩 `npx tsc --noEmit` clean.
- 🟩 `npm run lint` zero new errors.
- 🟩 Local dry-run on real watchlist data produces all 4 sections (or empty-state).
- 🟩 Push `stable` branch + workflow + tests; CI green.
- 🟩 Companion doc `docs/plans/lean-vs-experimental-comparison.md` — metrics tracked over 30 days (Telegram-tagged tickers + their 5/10/20-td forward returns), decision criteria for which scanner wins.

## Dependencies

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase X
```

Strictly serial — each phase needs the previous.

## Out of scope
- Pattern detection (cup-handle, VCP, flat-base) — too algorithmic for "lean".
- Earnings / fundamentals — main's edge, deliberately omitted here.
- Monitor follow-up state machine, graduation alerts, persistence markers.
- Composite scoring / ranking — point of "lean" is binary signals only.

## Notes

- **No code drift.** `stable` reuses `parseYahooChartResult` and
  `fetchAllStocksAsOfDate` unchanged from main. Bug fixes in fetch propagate
  via periodic `git merge main` (or cherry-pick) into stable.
- **Thresholds are research-backed** (per 2026-05-08 review):
  - Consolidation tightness 10/15/25% follows Minervini VCP literature.
  - RVOL ≥ 3 is the IBD/professional institutional-participation threshold.
  - −15% to −25% pullback + above-SMA200 is the Stage 2 "healthy pullback"
    buy zone.
- **Comparison plan** is the actual deliverable. The lean scanner exists to
  generate signals we can measure against the experimental scanner over
  30 days. Without that measurement plan, the work is wasted.
