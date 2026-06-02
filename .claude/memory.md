# Memory — Smart Volume Radar

Decisions, resolved issues, and active context across sessions.

## Key Decisions

| Date | Decision | Reason |
|------|----------|--------|
| Mar 2026 | p-limit for concurrency (3–5 tickers, 2 news) | Replace sequential sleep; better throughput |
| Mar 2026 | Google Sheet watchlist (not tickers.json) | Single source of truth for ticker list |
| Mar 2026 | logger only, no console.log | Consistent structured output |
| Mar 2026 | O(1) sectorMap via Map | Performance for large watchlists |
| Mar 2026 | Wilder's RSI (not Cutler's) | Matches TradingView standard |

## Resolved Issues

- **Hardening complete:** p-limit, logger, config validation all in place
- **RSI formula:** Switched from simple average (Cutler) to Wilder's smoothing — more accurate

## Active Context

- Weekly evaluate-setups workflow active (Sunday 10:00 UTC)
- Daily scan writes to results/ + CI artifact upload
- LLM summary optional (controlled by ENABLE_LLM_SUMMARY env var)
- **Telegram is momentum-only** (deployed 2026-05-05) — Full / Recovery /
  Watchlist tiers; legacy 3-path scanner still drives JSON history for backtest

## Empirical findings — 2026-05-05

First data-driven evaluation of momentum criteria, n=244 alerts (2026-03-23
→ 2026-05-04, all bull). Source: `scripts/analyze-criteria-importance.ts`.
Full report: `docs/criteria-analysis-2026-05-05.md`.

**Strong predictors (+10td lift):**
- `pivotBreakout`: 14.0x — single most dominant criterion
- `bigMoveToday`: 2.6x — most stable across timeframes & train/test
- `stage2`: 1.6x at +10td, fades to 0.79x by +20td (mean reversion)

**Anti-predictors:**
- `lowRiskEntry`: 0.63x at +10td, consistent across timeframes — stocks
  "safely" near SMA21 underperform extended ones in this bull regime
- `rvolPass` (≥2): becomes anti-predictive at +20td (0.33x) — supports
  "climactic volume = exhaustion" hypothesis

**Highest-confidence signal:** graduation Watchlist→Full = +24.3% median
return vs +2-7% for any other resolution status. This drove the decision
to add a dedicated graduation alert in the Telegram report (2026-05-05).

**Don't act on yet:** criteria weights / thresholds — narrow train/test
window (5d train) and bull-only regime mean magnitudes aren't settled.
Re-evaluate in ~30 days when sample is ~500+ entries.
