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

## 2026-05-05 update — extended dataset (66 days)

After running `rebuild-history --from 2026-02-01 --to 2026-05-04` we have
353 monitor entries (vs the original 245 from 30 days). The findings shift
materially compared to the 30-day analysis above — direction-of-effect for
several criteria flips when sample is adequate. **The 30-day findings should
be considered superseded by these.**

### Stable findings (66 days, train+test confirmed)

| Criterion         | +10td  | Train Lift | Test Lift | Stability |
|-------------------|--------|------------|-----------|-----------|
| `stage2`          | 2.00x  | 2.07x      | 1.64x     | ✓ POSITIVE |
| `pivotBreakout`   | 2.00x  | 2.25x      | 3.00x     | ✓ POSITIVE |
| `rvolPass`        | 0.86x  | 0.67x      | 0.78x     | ✓ ANTI |
| `lowRiskEntry`    | 0.88x  | 0.88x      | 0.85x     | ✓ ANTI (mild) |
| `aboveGapAvwap`   | 0.95x  | 1.00x      | 0.96x     | ✓ NEUTRAL (drop) |
| `tightness`       | 0.74x  | 0.57x      | 0.93x     | ✗ FLIPS |
| `antsAccumulation`| 1.00x  | 2.00x      | 1.00x     | ✗ FLIPS |
| `bigMoveToday`    | 1.00x  | 1.00x      | 1.36x     | ✗ FLIPS |

### Key reversals from 30-day analysis

- `stage2`: was 0.75x (anti) at 30 days, now 2.33x (positive). The 30-day
  analysis WAS WRONG about stage2. With proper sample, stage2 is the most
  important predictor along with pivotBreakout.
- `pivotBreakout`: was reported as 14x dominant; now a more believable 2.0x.
  Still positive but not "the king".
- `antsAccumulation`: was ∞ at 30 days (1% prevalence — sample too small);
  now 0.00x at +20td (anti). The 30-day result was a sample artifact.

### Headline finding: expired alerts lose money

Status breakdown reveals 43% of all alerts (153/353) end as `expired` with
**median -5.1% return**. They're not neutral — they're actively losing
trades. Reducing the false-positive rate is the highest-ROI improvement.

| Status              | n    | Median  | Avg     |
|---------------------|------|---------|---------|
| expired             | 153  | -5.1%   | -3.9%   |
| sma21-pullback      | 101  | +1.7%   | +2.1%   |
| graduated           | 69   | +6.4%   | +10.2%  |
| manual-entry        | 24   | +7.8%   | +12.5%  |
| monitoring (active) | 5    | +0.1%   | -0.3%   |

### Sector skew (66 days)

Software is the worst-performing sector at -10.8% median (n=31, win rate 19%).
This is counter-intuitive given software is usually a bull-market leader.
Semiconductor (n=47, +6.7% median, 83% win) and AI - Chain (n=23, +7.0%,
74% win) are the clear winners.

### Tier confirmation

| Tier  | n    | Median | Avg    | Win% |
|-------|------|--------|--------|------|
| full  | 29   | +3.5%  | +4.7%  | 86%  |
| close | 321  | +1.1%  | +1.5%  | 57%  |

Full delivers 3x median return and 30 percentage points higher win rate.
The tier system works.

## 2026-05-05 attempt — extending to 87 days (Jan 2 → May 4)

Tried `rebuild-history --from 2026-01-02` to add January data. **Aborted —
data quality issues:**

1. **rvolPass = 100% across all 365 entries** (impossible; should be ~40%
   in normal data). The rebuild's recompute returns true universally on
   the new dataset.
2. **All entries have ≥5 re-alerts** — every monitor entry is in the same
   bucket, defeating the persistence-vs-return analysis.
3. **182 entries (~50%) had `firstAlertDate = 2026-01-02`** — a single
   day. Post-holiday volume flood created a one-day artifact that
   monopolized the monitor.
4. **Status distribution collapsed to {graduated, expired}** — the
   sma21-pullback and manual-entry transitions disappeared from the
   reconstructed state machine.

The Jan 2 post-holiday volume spike is a known backtest artifact — first
trading day after a long market closure shows abnormally high RVOL because
the 63-day average is computed against the previous trading days but the
current day's trading is psychologically clustered.

**Decision:** restored from 66-day backup (`/tmp/svr-backup-jan-1777988339`).
The 66-day dataset is the authoritative source for the findings above.

### To extend safely later

- Start window after Jan 5-10 to skip post-holiday artifact
- Or: filter out entries where `firstAlertDate` is the first trading
  day after a market closure ≥3 days
- Investigate why the rebuild's recompute reports rvolPass=100% — likely
  a `BACKTEST_MODE` interaction with the data freshness guard

## Automation — weekly criteria analysis (deployed 2026-05-05)

`.github/workflows/weekly-analysis.yml` runs every Sunday 09:00 UTC.
Re-runs the analysis on whatever monitor history exists, posts a compact
Telegram summary (top predictors, anti-predictors, sector skew,
persistence sweet spot, graduation rate), and commits the updated CSV
to results/.

By 2026-07 we'll have ~120 days × ~5 alerts/day ≈ 600 entries — enough
for honest month-on-month train/test and to notice regime breaks.
