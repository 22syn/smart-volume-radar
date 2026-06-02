# Indicator Data Sources — Fetch vs Calculate

Compares APIs that provide pre-calculated technical indicators vs. local calculation.

---

## Summary

| Indicator | Fetch Available? | Best Source | Notes |
|-----------|------------------|-------------|-------|
| **RVOL** | Partial | Twelve Data Quote | `volume / average_volume` from quote endpoint |
| **RSI** | ✅ Yes | Twelve Data, Alpha Vantage, Finnhub | Pre-calculated |
| **SMA21** | ✅ Yes | Twelve Data, Alpha Vantage, Finnhub | Pre-calculated |
| **ATH** | Partial | Twelve Data Quote (52w high) | True ATH: calculate from history; 52w high is a common proxy |

---

## 1. Twelve Data (already integrated)

**Env var:** `TWELVE_DATA_API_KEY`

| Indicator | Endpoint | Example |
|-----------|----------|---------|
| RSI | `GET /rsi` | `?symbol=AAPL&interval=1day&time_period=14` |
| SMA21 | `GET /sma` | `?symbol=AAPL&interval=1day&time_period=21&series_type=close` |
| RVOL | From `GET /quote` | `rvol = volume / average_volume` |
| 52w High (ATH proxy) | From `GET /quote` | `fifty_two_week.high` |

**Pros:** Already integrated, free tier, RSI/SMA/RVOL/52w high all available
**Cons:** Rate limits on free tier; 52w high ≠ true all-time high

---

## 2. Alpha Vantage (not integrated)

**Env var:** `ALPHAVANTAGE_API_KEY` (free at alphavantage.co)

| Indicator | Endpoint |
|-----------|----------|
| RSI | `GET /query?function=RSI&symbol=AAPL&interval=daily&time_period=14` |
| SMA | `GET /query?function=SMA&symbol=AAPL&interval=daily&time_period=21&series_type=close` |

**Pros:** 50+ technical indicators, official provider
**Cons:** Free tier ~25 req/day; may need multiple calls per symbol

---

## 3. Finnhub (already used for news)

**Env var:** `FINNHUB_API_KEY`

| Indicator | Endpoint |
|-----------|----------|
| RSI, SMA | `/indicator` — Technical indicators API |
| Quote | `/quote` — volume, price, etc. |
| Candles | `/stock/candle` — OHLCV for custom calculations |

**Pros:** Single key for news + indicators
**Cons:** Need to verify exact indicator params and rate limits per plan

---

## 4. RVOL — No Dedicated Endpoint

No mainstream free API exposes "relative volume" as a standalone metric. Always derived as:

```
RVOL = current_volume / average_volume
```

RVOL is always calculated from raw volume, regardless of data source.

---

## Current Implementation

| Scenario | RSI | SMA21 | RVOL | ATH/52w |
|----------|-----|-------|------|---------|
| **Yahoo primary** | Fetched from Twelve Data* | Fetched from Twelve Data* | Calculated | Calculated from 5y history |
| **Twelve Data fallback** | Fetched | Fetched | From quote | 52w high from quote |

\* When `USE_FETCHED_INDICATORS` is not `false` and `TWELVE_DATA_API_KEY` is set.

**Config:**
- `USE_FETCHED_INDICATORS` — Set to `false` to always calculate RSI/SMA locally (default: `true`)

**Recommendation:** Keep `TWELVE_DATA_API_KEY` set and `USE_FETCHED_INDICATORS=true`. Yahoo remains primary data source; Twelve Data provides pre-calculated indicators.
