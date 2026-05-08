# Plan: Lean vs Experimental Scanner — 30-Day A/B Comparison

## Context

Two scanners now run in parallel at 20:15 UTC, sending to the same Telegram
chat:

- **Lean** (`stable` branch) — 3 crisp signals: consolidation breakout, RVOL
  ≥ 3, healthy pullback. Research-backed thresholds, no scoring, no fluff.
- **Experimental** (`main` branch) — Champion Score v3 with 6-state actions,
  trade plans, breakout stages, RS percentile, A/D days, BB squeeze,
  fundamentals, monitor follow-up.

Goal: measure which approach generates better forward returns over 30 days,
then decide which to keep.

## Tasks

### Phase 1: Daily logging
- ⬜ Add a per-scanner "tagged tickers" log to `results/comparison/{YYYY-MM-DD}.json` — for each scan, record `{date, scanner: 'lean'|'experimental', tickers: string[], signals: Record<ticker, signalType>}`. — **Verify:** after one scheduled run, both files exist with non-zero ticker arrays.

### Phase 2: Forward-return measurement
- ⬜ New script `scripts/compare-scanners.ts` — for each ticker logged on day D, fetch close on D+5td, D+10td, D+20td. Compute return%. Tag with which scanner alerted. — **Verify:** local run on a 5-day-old log produces a CSV with returns.

### Phase 3: Aggregation
- ⬜ Compute per-scanner stats: median return at each window, win rate, hit rate (% of stocks with positive return), best signal type within scanner. Output to `results/comparison/summary-{date}.json` and a Telegram summary. — **Verify:** unit test on synthetic data.

### Phase 4: Decision criteria (set up front, don't move goalposts)
- ⬜ Document in this file: which scanner wins?
  - **By median return at +10td** (primary)
  - **By win rate at +10td** (secondary)
  - **By signal density** — too few signals? too many?
  - **By false-positive rate** — % of alerts ending in -5% or worse
  Decision rule: if one scanner beats the other on BOTH primary and secondary
  metrics by ≥ 2 percentage points, switch fully. Otherwise keep both running
  for another 30 days.

### Phase 5: Weekly comparison Telegram message
- ⬜ Add to the existing weekly criteria-importance workflow (`.github/workflows/weekly-analysis.yml`) — also output a "Lean vs Experimental" section showing the running 30-day stats. — **Verify:** Sunday 09:00 UTC scheduled run includes the comparison line.

### Phase X: Verification
- ⬜ All tests pass.
- ⬜ Both scheduled workflows run successfully for ≥7 consecutive days.
- ⬜ First weekly comparison summary received in Telegram.
- ⬜ At day 30, decide.

## Out of scope (until day 30)

- Switching code paths.
- Killing one scanner.
- Adding new signals to either side.

The whole point is to measure, not to keep tweaking.

## Status

- 2026-05-09 — both scanners deployed. Day 0 of measurement window.
- Day 7 expected: 2026-05-16 — first weekly summary.
- Day 30 expected: 2026-06-08 — decision day.
