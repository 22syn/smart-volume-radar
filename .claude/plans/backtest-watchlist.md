# Watchlist Backtest 2026

For each ticker in the Google Sheet watchlist, walk through each trading day in 2026
(2026-01-01 → today). On each day, run `evaluateMomentumSetup`. Record the FIRST date
the ticker fired Full / Recovery / Watchlist. Compute % return from that date to today's
last close. Aggregate stats + per-ticker table.

Goal: answer "if I had followed every Full/Recovery/Watchlist alert this year, what would
my returns look like — including the losers?"

## Implementation
- Fetch each ticker's raw 5y Yahoo chart ONCE (~366 HTTP calls).
- For each trading day in window, slice locally + run `parseYahooChartResult` (sync via
  `skipTwelveData: true`) + `evaluateMomentumSetup`. No further HTTP per date.
- SPY regime: pre-compute per date from one SPY fetch.
- Output: summary table + per-ticker table sorted by return desc.
