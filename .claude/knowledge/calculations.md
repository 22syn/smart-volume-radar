# Calculations — Exact Formulas

Source: `src/utils/technicalAnalysis.ts`, `src/services/marketData.ts`

## Input (Yahoo Chart API)

URL: `https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=5y`
Arrays: `volumes[]`, `closes[]` — chronological, index 0 = oldest, index N-1 = today.

---

## RVOL

```
currentVolume    = volumes[volumes.length - 1]
historicalVols   = volumes.slice(0, -1)           // exclude today
lookback63       = historicalVols.slice(-63)        // ~3-month window
avgVolume        = sum(lookback63) / lookback63.length
RVOL             = currentVolume / avgVolume
```

Config: `VOLUME_RVOL_LOOKBACK = 63`. If < 63 historical days, use all available.

## Price Change (%)

```
priceChange = ((closes[-1] - closes[-2]) / closes[-2]) * 100
```

## SMA

```
SMA(prices, N) = sum(prices[length-N : length]) / N
// undefined if length < N
```
Used for SMA21, SMA50, SMA200.

## RSI — Wilder's 14-period

```
// Seed (first 14 periods — simple average)
avgGain = mean(gains[1..14])
avgLoss = mean(losses[1..14])

// Wilder's smoothing for subsequent periods
avgGain = (avgGain * 13 + currentGain) / 14
avgLoss = (avgLoss * 13 + currentLoss) / 14

RSI = 100 - (100 / (1 + avgGain/avgLoss))
// if avgLoss == 0: RSI = 100
```

Wilder's smoothing (not Cutler's). Matches TradingView.

## 52-Week High (`ath` in code)

```
lookback = closes.slice(-252)   // 252 trading days ≈ 1 year
PeriodHigh_52w = max(lookback)
```

## pctFromAth

```
pctFromAth = ((lastClose - PeriodHigh_52w) / PeriodHigh_52w) * 100
// negative when below high
```

## monthsInConsolidation

```
threshold = PeriodHigh_52w * 0.98
periodHighIndex = last index where lookback[i] >= threshold
tradingDaysSinceHigh = lookback.length - 1 - periodHighIndex
monthsInConsolidation = tradingDaysSinceHigh / 21
// if no index found: use full lookback
```

---

## Threshold Config Defaults

| Variable | Default | Used in |
|----------|---------|---------|
| `ATH_THRESHOLD_PCT` | 20 | nearAth |
| `ATH_CLOSE_THRESHOLD_PCT` | 25 | nearAthClose |
| `SMA21_TOUCH_THRESHOLD_PCT` | 3 | nearSMA21 |
| `SMA21_CLOSE_THRESHOLD_PCT` | 5 | nearSMA21Close |
| `CONSOLIDATION_MIN_MONTHS` | 6 | inConsolidationWindow |
| `CONSOLIDATION_MAX_MONTHS` | 36 | inConsolidationWindow |
| `CONSOLIDATION_CLOSE_MIN_MONTHS` | 4 | inConsolidationClose |

## Derived Booleans

```
nearAth               = |pctFromAth| ≤ 20
nearAthClose          = !nearAth AND |pctFromAth| ≤ 25
inConsolidationWindow = months ≥ 6 AND months ≤ 36
inConsolidationClose  = !window AND months ≥ 4 AND months < 6
nearSMA21             = |lastPrice - sma21| / sma21 * 100 ≤ 3
nearSMA21Close        = !nearSMA21 AND pctDiff ≤ 5
```
