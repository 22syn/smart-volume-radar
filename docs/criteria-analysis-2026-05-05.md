# Criteria Importance Analysis — 2026-05-05

First data-driven evaluation of the 8-criteria momentum scoring layer
introduced in the Momentum Edition. Source: `monitor-list.json` (245 historical
alerts, 2026-03-23 → 2026-05-04, all bull regime).

**Methodology** — `scripts/analyze-criteria-importance.ts`:
- Replay each alert's criteria snapshot at `firstAlertDate` via
  `fetchYahooChartAsOfDate`
- Compute time-normalized forward returns at +3/+5/+10/+20 trading days
- Quintile lift per criterion (Top 20% return vs Bottom 20%)
- Chronological train/test split for cross-validation
- CSV: `results/criteria-importance.csv`

## Headline findings

| Criterion         | +3td   | +5td   | +10td   | +20td  | Train/Test stable | Verdict |
|-------------------|--------|--------|---------|--------|-------------------|---------|
| `pivotBreakout`   | 16.00x | 3.00x  | 14.00x  | 2.33x  | ✓ (∞ → 8.00x)     | 🏆 dominant |
| `bigMoveToday`    | 1.36x  | 1.21x  | 2.63x   | 2.14x  | ✓ (2.00 → 2.00x)  | ✅ strong |
| `stage2`          | 1.62x  | 1.38x  | 1.58x   | 0.79x  | ✓ (1.75 → 1.43x)  | ✅ short-term, fades by +20td |
| `tightness`       | 1.00x  | 1.26x  | 1.27x   | 1.20x  | (≈neutral both)   | + mild positive |
| `aboveGapAvwap`   | 1.11x  | 1.19x  | 0.97x   | 0.78x  | ✓ (0.92 → 0.94x)  | 🤷 neutral |
| `rvolPass` (≥2)   | 1.17x  | 0.90x  | 0.88x   | 0.33x  | ✗ flips           | ⚠️ becomes anti-predictive long-term |
| `lowRiskEntry`    | 0.67x  | 0.79x  | 0.63x   | 0.81x  | ✓ (0.79 → 0.58x)  | ⚠️ consistent anti-predictor |
| `antsAccumulation`| ∞      | ∞      | ∞       | 1.00x  | ✗ flips           | ❓ sample too small (~1% prevalence) |

## What this means

1. **`pivotBreakout` is the single most predictive criterion.** Top quintile at
   +10td had it 37% of the time vs 3% in the bottom. This contradicts the
   "wait for pullback" textbook orthodoxy and supports "buy strength at new
   highs" in this regime.

2. **`bigMoveToday` (price up ≥3% on alert day) is the most stable predictor**
   across all timeframes and across the train/test split (2.00x both halves).

3. **`stage2` helps short-to-medium term but mean-reverts by +20td.** Stocks in
   confirmed uptrend pop quickly then cool. Suggests using stage2 for swing
   horizons, dropping it for longer holds.

4. **`lowRiskEntry` (within 8% of SMA21) is consistently anti-predictive.**
   Stocks "safely" near SMA21 underperform stocks already extended. In the
   bull regime that produced this dataset, momentum continuation > base entries.

5. **`rvolPass` (RVOL ≥ 2.0/3.0 by regime) becomes harmful at +20td** (lift
   0.33x) — supports the "climactic volume = exhaustion" hypothesis. The
   2026-05-04 example (NWMD.TA RVOL 5.69x → -7.0% return) is consistent.

6. **`antsAccumulation` and infinite lifts in the train half** — sample
   prevalence is too low (~1%) to draw conclusions. Need 30+ entries before
   trusting.

## Status-of-resolution lift

The single strongest signal in the entire dataset is **graduation** — when a
Watchlist alert later promotes to Full Momentum:

| Status              | n    | Median return | Avg return |
|---------------------|------|---------------|------------|
| **graduated**       | 15   | **+24.3%**    | +22.3%     |
| manual-entry        | 20   | +6.7%         | +9.4%      |
| expired             | 29   | +4.1%         | +4.8%      |
| sma21-pullback      | 49   | +2.6%         | +2.4%      |
| monitoring (active) | 131  | +2.4%         | +5.6%      |

Graduation outperforms every other resolution outcome by a 4-10x margin.
This is the highest-confidence finding in the entire analysis.

## Caveats (read these before acting)

1. **30 days of data, all bull market.** Findings may invert in bear regimes.
   In particular, `lowRiskEntry` could plausibly flip to positive when momentum
   continuation breaks down.

2. **Train/test split is narrow.** Train was 2026-03-23 → 2026-03-27 (5 days),
   test was 2026-03-30 → 2026-04-21 (~3 weeks). Real cross-validation needs
   month-on-month splits.

3. **Sample sizes get marginal at +20td** (n=145). Magnitudes of lift are
   suggestive, not statistically settled.

4. **Survivorship bias** — current watchlist excludes tickers that were
   removed for being "uninteresting"; results don't reflect their behavior.

5. **`.TA` ticker data lag** — Yahoo's CDN lag for Tel Aviv tickers caused the
   17→27 difference between two same-day local runs (2026-05-04 22:56 UTC
   vs 2026-05-05 07:55 UTC). Some `.TA` lift values may be inflated/deflated
   by intraday data freshness.

## Decisions

### What we're NOT changing yet

- **Criteria weights / thresholds** — directional findings need ≥1 month more
  data and a real train/test window before we rebalance the score.
- **Removing criteria** — even consistently anti-predictive `lowRiskEntry`
  may be regime-dependent. Keep collecting.
- **Continuous score** — replacing the binary tier system with a
  weighted-sum score is the long-term direction, but premature given sample
  size.

### What we're implementing now (high confidence)

**Graduation alert** — when a stock transitions from Watchlist (`close`) or
Recovery to Full Momentum on a given day, surface it as a dedicated, highlighted
Telegram message. This is the +24% median signal and currently has no special
treatment in the report.

The monitor state machine already detects graduations (`status: 'graduated'`).
We just need to make the daily report flag them prominently.

### Re-evaluation cadence

Re-run `analyze-criteria-importance` monthly. By 2026-07-01 we'll have
~120 days × ~7 alerts/day ≈ 800-1000 entries — enough for honest
month-on-month train/test and to notice regime breaks.

## Next-month checklist

- [ ] Re-run analysis with ≥60 days of data
- [ ] Add SPY-relative returns (alpha vs market) to remove regime drift
- [ ] Validate `pivotBreakout` and `bigMoveToday` lifts hold across
      different month windows
- [ ] If `lowRiskEntry` stays anti-predictive across two regimes, drop it
- [ ] Decide on Momentum Score 2.0 implementation
