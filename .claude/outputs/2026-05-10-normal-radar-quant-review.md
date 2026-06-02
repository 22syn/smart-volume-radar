# Normal Radar — Quant Review (2026-05-10)

Mapping a 12-phase quant framework to the **Normal Radar** (`src/index.ts`
pipeline → `monitor-list.json` + Telegram momentum tiers). Strategy phase #1 is
treated as **already defined** by the existing rules; phases #5 and #7 are
out of scope (this is a signal generator, not an allocator).

Sources: `src/utils/setup.ts`, `scripts/analyze-criteria-importance.ts`,
`docs/criteria-analysis-2026-05-05.md`, `results/scan-*.json` (n≈88,
2026-01-05 → 2026-05-08).

---

## Phase 1 — Strategy (already exists)

| Tier | Rule |
|---|---|
| **Full 🎯** | `RVOL ≥ MIN_RVOL` ∧ `nearSMA21` ∧ `nearAth` ∧ `inConsolidationWindow` |
| **Close 👀** | `RVOL ≥ MIN_RVOL` ∧ (`nearSMA21` ∨ close) ∧ (`nearAth` ∨ close) ∧ (`inConsolidationWindow` ∨ close) |
| **Momentum (Telegram, deployed 2026-05-05)** | 8-criteria scoring: `pivotBreakout`, `bigMoveToday`, `stage2`, `tightness`, `aboveGapAvwap`, `rvolPass`, `lowRiskEntry`, `antsAccumulation` |

Edge thesis: capture **stage-2 continuation breakouts** in liquid names where
unusual volume + proximity to 52w high + tight consolidation cluster on the
same day.

## Phase 2 — Backtest (partial data exists)

What we have:
- `scripts/evaluate-setups.ts` — weekly forward-return job
- `scripts/evaluate-setups-30d.ts` — 30-day window
- `scripts/analyze-criteria-importance.ts` — quintile lift per criterion
- 88 daily scan snapshots + `monitor-list.json` (245 alerts to 2026-05-04)

Gaps:
- **No equity curve** for any one tier (Full vs Close vs Momentum)
  treated as a tradable strategy with fixed sizing + SL/TP.
- All data is **bull-regime only.** No bear/chop sample.
- No transaction cost / slippage model.

Action: add `scripts/equity-curve.ts` that, per tier, simulates "$10k, 1% risk,
SL = entry × (1 − ATR mult), TP = +3R, hold until SL/TP/30td" on the historical
alert set. Report CAGR / Sharpe / MaxDD / win rate / avg R.

## Phase 3 — Risk / Reward (mostly settled empirically)

From the 2026-05-05 study (n=244, all bull):

| Criterion | +10td lift | Verdict |
|---|---|---|
| `pivotBreakout` | **14.0×** | dominant — keep, weight up |
| `bigMoveToday` | 2.6× | most stable across timeframes |
| `stage2` | 1.6× → 0.79× by +20td | swing-only |
| `rvolPass (≥2)` | 0.88× → 0.33× by +20td | **anti-predictive long-term** — exhaustion hypothesis |
| `lowRiskEntry` | 0.63× (+10td) | **consistent anti-predictor** in this regime |

Recommendation:
1. Drop `lowRiskEntry` from the Full-setup gate, or invert its sign in the
   Momentum scorer. It's hurting us in continuation regimes.
2. Add a tier-aware **hold-horizon cap**: stage2 + rvolPass alerts should be
   sized for ≤+10td, not +20td.
3. Record an explicit **R-multiple** per alert in `monitor-list.json` once #2
   adds SL/TP.

## Phase 4 — Market regime (missing — high-leverage add)

Current pipeline has **no regime gate**. All findings above are bull-only,
so a regime flip is the single biggest unknown.

Add `services/regimeDetector.ts`:
- SPY: `close > SMA200` ∧ `SMA50 > SMA200` → `bull`; else `bear`
- VIX: `< 18` → calm, `18–25` → normal, `> 25` → stressed
- Output: `{regime: 'bull-calm' | 'bull-stressed' | 'chop' | 'bear-stressed'}`

Wire to:
- Telegram header (visible context)
- Tier suppression: in `bear-stressed` skip Full alerts on stocks where
  `lowRiskEntry = false` (the anti-predictive finding is bull-conditional)
- A `regime` field on each `monitor-list.json` entry so the next criteria
  study can stratify.

## Phase 6 — Optimization (do after Phase 4)

Top three knobs to sweep once we have regime tags:
- `MIN_RVOL` ∈ {1.5, 2.0, 2.5, 3.0}
- ATH proximity band: 8% → {3, 5, 8, 12}
- Consolidation window length: keep 60d but sweep tightness allowance

Constraint: **don't sweep before regime labels exist** or we'll overfit the
bull sample we already analyzed.

## Phase 8 — Live trade setups (already shipped, missing entry/SL/TP)

The Telegram report currently lists tickers with criteria badges. What's
missing for actionability:
- Explicit **entry trigger** (e.g., "buy stop at today's high + 0.5%")
- **Stop** (ATR-based or % below pivot)
- **Profit target** (R-multiple or trailing SMA21)

Cheapest add: extend `formatters.ts` to render `Entry / SL / TP` per Full
alert, computed from ATR(14) on the same StockData payload already in
memory.

## Phase 9 — Monte Carlo (do after Phase 2 equity curve)

Bootstrap the alert R-multiples 10,000× to bound:
- Probability of >20% drawdown
- Probability of negative-return year
- Worst-case quarter

Until the equity curve script exists this is blocked.

## Phase 10 — Drawdown (data we already have, never plotted)

From `monitor-list.json`, computable today:
- Longest losing streak by alert
- Median time-to-recovery on `manual-entry` outcomes
- Sector concentration of losses (sector map is already there)

Quick win: 30-line script over `monitor-list.json` → markdown table.

## Phase 11 — Macro (analysis-only, not a hard gate)

Layer Fed funds + CPI surprise + ISM on the dashboard for human context.
Not a code gate — too noisy to filter on directly with the sample sizes
we have.

## Phase 12 — Alpha / edge (the actual claim, restated)

What the empirical data says the **Normal Radar's edge is**:

> Pivot breakouts (price closes above tight 52w base) in stage-2 liquid names,
> held ≤10 trading days. The well-known "buy on pullback to support" criterion
> (`lowRiskEntry`) is a **drag** in this regime, and the textbook RVOL ≥ 2 rule
> becomes harmful past 2 weeks of hold time. Best forward return in the entire
> dataset is "graduation" — when a Close/Watchlist alert later promotes to Full,
> median +24.3%, vs +2–7% for every other resolution.

Underexploited:
- **The graduation event itself** is more predictive than any single criterion.
  Today there's a dedicated graduation alert (added 2026-05-05). It should
  drive a higher tier / louder ping than a fresh Full alert.

---

## Decisions to make (ranked by leverage)

1. **Build the regime detector + tag history** (Phase 4). Unlocks every other
   phase being non-bull-overfit. ETA: ½ day.
2. **Add ATR-based SL/TP to Telegram output** (Phase 8). Makes the radar
   directly tradable. ETA: ½ day.
3. **Build the equity-curve simulator** (Phase 2). Prerequisite for Phases
   9 and 10 to be quantitative rather than narrative. ETA: 1 day.
4. **Re-weight or drop `lowRiskEntry`** (Phase 3 + 6). Cheap, evidence-based,
   but should wait until #1 so we don't overfit. ETA: 1 hour after #1.
5. **Document the graduation edge** in the Telegram header (Phase 12). Free.

Not doing yet: portfolio allocation (#5/#7), macro-as-filter (#11) — better
spent on the five above first.
