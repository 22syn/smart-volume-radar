# Lean Radar — Quant Review (2026-05-10)

Mapping a 12-phase quant framework to the **Lean Radar** (`src/lean.ts` →
`src/lean/signals.ts` → 🪶 LEAN RADAR Telegram section). Phase #1 is treated
as already defined; phases #5 and #7 are out of scope.

The Lean Radar runs the same fetch pipeline as Normal Radar, then applies
three independent, research-backed signal detectors. It does **not** share
the 8-criteria momentum scorer.

Sources: `src/lean/signals.ts`, `src/lean/format.ts`, `results/scan-*.json`
(shares fetch with Normal Radar, n≈88).

---

## Phase 1 — Strategy (already exists)

Three signals + near-miss "Silent Watchlist" variant of each:

| Signal | Trigger | Heritage |
|---|---|---|
| **📈 Consolidation Breakout** | Close > window high over 1M/3M/1Y window, `baseRangePct ≤ 10/15/25%`, Stage 2 (price > SMA50 > SMA200), `RVOL ≥ 1.5` | Minervini VCP, IBD bases |
| **🔥 High Volume** | `RVOL ≥ 3.0` (high) or `≥ 5.0` (extreme), no setup constraints | Institutional participation threshold |
| **📉 Healthy Pullback** | `−25% ≤ pctFromAth ≤ −15%`, `lastPrice > SMA200` | Stage-2 buy-zone |

Edge thesis: **three orthogonal entry archetypes** — momentum breakout,
volume-shock, and constructive retracement — published as a stable section
without the noise of an 8-criterion scorer.

## Phase 2 — Backtest (almost no data exists yet)

What we have:
- Same 88-day scan history as Normal Radar (Lean detectors can be replayed
  pure-functionally over `StockData` payloads).

Gaps:
- **No lean-specific snapshot file.** Today only the Telegram report and the
  shared `scan-*.json` exist; nothing yet captures "stocks fired by lean
  detectors on day X" for forward-return study.
- No equity-curve simulation for any of the three signals.

Actions:
1. Add `writeLeanSnapshot` output to a stable schema in `results/lean/`
   (the file is already being written per `src/lean.ts`; verify it includes
   `signalKind` per ticker, not just the bundled `LeanScanResult`).
2. Replay all 88 days through `signals.ts` to backfill a historical signal
   ledger. Detectors are pure, so this is mechanical.
3. Run forward returns at +3 / +5 / +10 / +20 td per signal kind.

## Phase 3 — Risk / Reward (intuition; not yet measured)

Per-signal expected behavior we should validate, not assume:

| Signal | Hypothesized R/R | What to verify |
|---|---|---|
| Consolidation breakout (1M) | High win-rate, modest R | Failure rate when close < window high −2% within 5td |
| Consolidation breakout (1Y) | Lower win-rate, fat tail | % that double in 60td vs % that fail |
| High volume (3×) | Mixed — both accumulation and exhaustion | Median +5td and +20td return; expect bimodal |
| High volume (5×) | More skewed to exhaustion | Same — expect worse +20td |
| Healthy pullback | Slow-burn, low MFE | Median time to next 52w high |

Sizing principle that follows from the structure: **smaller in 1M
breakouts and high-volume signals (noisier), larger in 1Y breakouts and
pullbacks (rarer, more thesis-driven)**. Don't equal-weight.

## Phase 4 — Market regime (missing — same gap as Normal Radar)

Each signal has a different regime affinity:
- **Breakout** signals decay fast in chop / bear (false breakouts dominate)
- **High-volume 5×** signals **invert** in bear-stressed (selling climax,
  not buying climax)
- **Pullback** signals fail when `lastPrice > SMA200` is meaningless because
  SMA200 itself is rolling over

Wire the same `regimeDetector` proposed for Normal Radar, and:
- In `bear-stressed`: suppress 1M breakouts entirely, keep 1Y, tag 5×
  high-volume as "potential climax" instead of "high volume"
- In `chop`: emit only Healthy Pullback signals, no breakouts

## Phase 6 — Optimization (after Phase 2)

Knobs, in order of expected sensitivity:
- `BREAKOUT_MIN_RVOL` 1.5 — sweep {1.2, 1.5, 2.0}
- `CONSOLIDATION_WINDOWS.maxRangePct` (10/15/25%) — IBD pivots use 5–7%
  for the 7-week base; we're loose. Sweep tighter values for 1M.
- `PULLBACK_MIN_PCT / PULLBACK_MAX_PCT` (−25/−15) — sweep (−30/−10) and
  (−20/−12)
- Stage 2 definition: today is price > SMA50 > SMA200; consider adding
  SMA50 slope > 0 to filter rolled-over names

Don't sweep before regime labels exist (same caveat as Normal Radar).

## Phase 8 — Live trade setups (currently signal-only, no execution detail)

Lean format is intentionally one-line-per-stock. Without losing that:

| Signal | Entry | SL | TP |
|---|---|---|---|
| Consolidation breakout | Today's close (or buy stop at high + 0.3%) | `windowHigh × 0.93` or pivot − 1×ATR | +2R or trailing SMA21 |
| High volume | None — context only | n/a | n/a |
| Healthy pullback | Touch of SMA50 or break of 5-day high | Below SMA200 | Prior 52w high |

High-volume should stay context-only (it's a heads-up, not an entry).
For the other two, add Entry/SL/TP to the line as a discreet `· E:… S:… T:…`
suffix.

## Phase 9 — Monte Carlo (blocked on Phase 2)

Once the historical signal ledger exists, bootstrap per signal kind. The
key question MC answers for Lean: **is the three-signal mix actually
diversified?** If the equity curves of breakout/volume/pullback are
correlated > 0.6, the "three orthogonal archetypes" claim is weaker than
the framing suggests.

## Phase 10 — Drawdown (blocked on Phase 2, but cheap once unblocked)

Drawdown analysis per signal will probably reveal:
- Pullback signals have the worst average drawdown before working (by
  design — they're already down 15-25%)
- 1Y breakout has rare, severe drawdowns (failed long-term bases)
- 1M breakout has the smoothest curve but lowest absolute return

Report drawdown stats per signal, not aggregate — the mix is the whole
point.

## Phase 11 — Macro (analysis-only)

Lean Radar's audience is "I want a clean list, not commentary." Macro
shouldn't be in the Telegram output. Use it in the weekly review doc
instead (already a separate workflow).

## Phase 12 — Alpha / edge (the claim, restated)

What I'd say Lean Radar's edge is, given the design:

> Three independent textbook setups (VCP/IBD breakout, institutional-volume
> tape signature, stage-2 healthy pullback) emitted as a low-noise list, with
> a "silently watching" near-miss tier to surface signals before they fully
> trigger. The edge over the Normal Radar is **specificity and lower false-
> positive rate** at the cost of fewer signals.

The cost: we don't yet have data showing the false-positive rate **is**
lower. That's Phase 2 work.

Underexploited:
- **The Silent Watchlist itself.** Near-miss-then-trigger sequences are
  the Lean equivalent of the Normal Radar's "graduation" finding. Track
  the forward return of stocks that appeared on Silent Watchlist before
  firing a real signal vs. those that fired cold. If the pattern matches
  Normal Radar's +24.3% graduation lift, that's the headline metric for
  Lean Radar.

---

## Decisions to make (ranked by leverage)

1. **Build the historical signal ledger** (Phase 2 action 2). Lean has
   essentially no empirical record yet. Until this exists, every other
   phase is speculation. ETA: ½ day (detectors are pure → mechanical
   replay over 88 days).
2. **Measure the "Silent Watchlist → trigger" lift** (Phase 12). This is
   the most likely place a real edge is hiding, by analogy with Normal
   Radar's graduation finding. ETA: 2 hours once #1 is done.
3. **Wire the shared regime detector + per-signal suppression rules**
   (Phase 4). Bigger impact on Lean than Normal because each signal has
   different regime affinity. ETA: ½ day (shares code with Normal).
4. **Add Entry/SL/TP suffix to breakout and pullback lines** (Phase 8).
   Keep one-line format. ETA: 2 hours.
5. **Per-signal correlation check** (Phase 9 sub-question). Validate the
   "three orthogonal" framing or replace it. ETA: 1 hour once #1 done.

Not doing: full Monte Carlo, full regime sweep, IBD-tight pivot
backtest — premature until #1.

---

## Shared with Normal Radar

Three pieces of work are **shared infrastructure**, do once, both radars
benefit:
- `services/regimeDetector.ts` (Phase 4)
- `services/atrStops.ts` for ATR-based SL/TP (Phase 8)
- An equity-curve / forward-return harness that takes any tier or signal
  list as input (Phases 2, 9, 10)

Recommended order: build the shared regime detector + replay harness first,
then run all of Phases 2/3/6/9/10 across both radars in one pass.
