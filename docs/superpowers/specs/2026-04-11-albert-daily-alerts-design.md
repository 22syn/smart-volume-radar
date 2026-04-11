# Albert Daily Alerts — Design Spec
**Version:** 1.0  
**Date:** 2026-04-11  
**Strategy basis:** @AlbertAgarunov (SEPA + IBD/CAN SLIM + Volume Price Action / Mark Minervini)

---

## 1. Goal

A daily end-of-scan script that analyses every ticker in the watchlist and prints a clear Hebrew alert per ticker — BUY / ADD / HOLD / REDUCE / SELL — based entirely on price, volume, and moving averages. No news. No emotions. No automated trading.

The script is additive: it does not replace the existing RVOL scanner; it runs alongside it as a separate npm script.

---

## 2. Scope

- **In scope:** New TypeScript script + pure analysis module + Hebrew formatter + Jest unit tests for the pure functions.
- **Out of scope (v1):** Telegram delivery, entry-price state file, intraday data, web UI.
- **Out of scope (v2, documented):** `state/entry-prices.json` for the exact "12% from entry" SELL rule.

---

## 3. File Layout

```
src/analysis/albertSignals.ts       ← pure functions: EMA, candle patterns, AVWAP, decision, formatter
scripts/albert-daily-alerts.ts      ← orchestrator: fetch → analyse → stdout
tests/albertSignals.test.ts         ← unit tests for pure functions
```

The orchestrator **does not** go through `parseYahooChartResult` / `StockData`. It fetches raw OHLCV arrays directly (same Yahoo Chart API, same `asOfDate` slicing pattern as `fetchYahooChartAsOfDate`), preserving per-bar OHLC needed for candle patterns.

---

## 4. Data Model

### 4.1 Raw Bar (internal to analysis module)

```ts
interface Bar {
  date: string;   // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

### 4.2 AlbertSignal (output of analysis)

```ts
type Recommendation = 'BUY / ADD' | 'HOLD' | 'REDUCE / SELL';
type StatusLabel =
  | 'BREAKOUT חזק'
  | 'PULLBACK מדויק'
  | 'חולשה'
  | 'CONSOLIDATION'
  | 'HOLD';

interface AlbertSignal {
  ticker: string;
  date: string;             // DD/MM/YYYY display format
  status: StatusLabel;
  recommendation: Recommendation;
  reason: string;           // Hebrew free-text, one line
  pullbackPct?: number;     // set when pullback applies
  marubozu: boolean;        // noted in reason, not a gate
  spyWeak: boolean;         // triggers ⚠️ warning line
  insufficientData: boolean;
}
```

---

## 5. Indicators — Definitions

### 5.1 EMA21

Exponential Moving Average, period 21.

- `alpha = 2 / (21 + 1) = 0.0909…`
- Seed: SMA of first 21 bars
- Roll: `EMA[i] = alpha × Close[i] + (1 − alpha) × EMA[i−1]`
- Requires ≥ 22 bars (21 seed + 1 roll minimum). Returns `undefined` if insufficient.

**Note:** The existing `sma21` field in `StockData` is SMA, not EMA. The new `calculateEMA` function is separate; it lives in `technicalAnalysis.ts` alongside the existing helpers.

### 5.2 SMA50 / SMA200

Reuse existing `calculateSMA(closes, 50)` / `calculateSMA(closes, 200)`.

### 5.3 Volume — 20-Day Average and Ratio

- `avgVol20` = mean of volumes of the **20 bars before** the current bar (not including current bar).
- `volumeRatio` = `currentVolume / avgVol20`.
- Requires ≥ 21 bars (20 history + 1 current). Returns `undefined` if insufficient.
- This is **separate** from the existing 63-day RVOL.

### 5.4 High of N Days

- `high25d` = `Math.max(...closes.slice(-26, -1))` — the 25 bars **before** the current bar.
- `high20d` = `Math.max(...closes.slice(-21, -1))` — the 20 bars **before** the current bar.

Both exclude the current bar so they can be used as breakout/pullback references.

### 5.5 52-Week High

Reuse `calculate52wHighAndConsolidation(closes).ath` — max close over last 252 bars.

### 5.6 Pullback %

`pullbackPct = ((currentClose − high25d) / high25d) × 100`

Negative value means price is below the 25d high. "Pullback 8%–15%" means `pullbackPct` is between −15 and −8 (i.e. `−15 ≤ pullbackPct ≤ −8`).

### 5.7 AVWAP from ATH Bar

Anchored VWAP anchored to the bar where the 52w ATH was last reached.

Algorithm:
1. Find `athIdx`: the last index `i` (within the 252-bar window) where `closes[i] >= ath × 0.998` (within 0.2% tolerance for float precision).
2. Require `currentIdx − athIdx ≥ 5` bars; otherwise skip AVWAP check (return `undefined`).
3. `typicalPrice[i] = (high[i] + low[i] + close[i]) / 3`
4. `AVWAP = Σ(typicalPrice × volume, from athIdx to currentIdx) / Σ(volume, same range)`
5. Condition satisfied: `currentClose > AVWAP`.

Input: full `highs[]`, `lows[]`, `closes[]`, `volumes[]` arrays (all aligned by bar index).

### 5.8 Candle Patterns (last two bars: `prev` = bars[n-2], `curr` = bars[n-1])

**Inside Candle:**  
`curr.high < prev.high AND curr.low > prev.low`

**Bullish Engulfing:**  
`curr.close > prev.open AND curr.open < prev.close AND curr.close > curr.open AND prev.close < prev.open`  
(current bar is bullish; previous bar is bearish; current body engulfs previous body)

**Marubozu (bullish):**  
Let `range = curr.high − curr.low`.  
`range > 0 AND (curr.high − curr.close) / range < 0.05 AND (curr.open − curr.low) / range < 0.05 AND curr.close > curr.open`  
(≤5% upper shadow, ≤5% lower shadow, bullish body)

Marubozu is **informational only** — included in the `reason` string when true, but not a gate condition for BUY.

---

## 6. Decision Logic

Evaluated strictly in this order. First match wins.

### 6.1 Insufficient Data Gate

If `closes.length < 60` → `{ insufficientData: true, recommendation: 'HOLD', status: 'HOLD', reason: 'לא מספיק נתונים' }`. Stop.

### 6.2 REDUCE / SELL

Trigger if **any** of:
- `currentClose < ema21` (price lost EMA21 support)
- `currentClose < sma50` (price lost 50DMA support)
- Proxy for entry-high rule: `pullbackPct < −12 AND curr.close < curr.open` (price >12% below 25d high with no bounce)

Status: `'חולשה'`  
Recommendation: `'REDUCE / SELL'`  
Reason: lists which condition(s) triggered.

### 6.3 BUY / ADD

All of the following must be true:

| Condition | Value |
|---|---|
| Volume Ratio | `≥ 4.0` |
| Candle pattern | Inside Candle **OR** Bullish Engulfing |
| Above EMA21 | `currentClose > ema21` |
| Above SMA50 | `currentClose > sma50` |
| Above SMA200 | `currentClose > sma200` |
| Entry trigger | Breakout **OR** Pullback |

**Breakout:** `currentClose >= high20d` OR `currentClose >= ath52w × 0.998`  
**Pullback:** `−15 ≤ pullbackPct ≤ −8`

**AVWAP:** When computable (≥5 bars since ATH), `currentClose > avwap` is an **additional required condition**. When not computable (ATH too recent), condition is skipped (does not block BUY).

Status: `'BREAKOUT חזק'` when breakout trigger; `'PULLBACK מדויק'` when pullback trigger.  
Recommendation: `'BUY / ADD'`

### 6.4 HOLD

Everything else.  
Status: `'HOLD'` or `'CONSOLIDATION'` (use `'CONSOLIDATION'` when `pullbackPct` is between −7 and 0, i.e. price near high but not breaking out).  
Recommendation: `'HOLD'`

---

## 7. SPY Market Filter

- Fetch `SPY` with the same `asOfDate`.
- `spyWeak = spy.close < spy.ema21 OR spy.priceChange < −1%`
- When `spyWeak = true` AND recommendation is `'BUY / ADD'`, add a warning line to the formatted output (does **not** change the recommendation to HOLD — alerts remain, user decides).

---

## 8. Output Format

Printed to stdout. One block per ticker, separated by a blank line.

```
📌 $TICKER   |   DD/MM/YYYY

סטטוס: <StatusLabel>
המלצה: <Recommendation>
[⚠️ שוק: SPY מתחת ל-EMA21 — זהירות מוגברת]   ← only when spyWeak + BUY/ADD

סיבה: <reason string>

[💡 Pullback של X.X% — באונס מדויק על EMA21]  ← only when pullback applies
[💡 PAYtience!]                                  ← only on HOLD
```

**Reason string examples:**
- `"אנגולפינג + 4.2x ווליום + מעל EMA21 + 50DMA + 200DMA + AVWAP ATH + פריצה ל-ATH חדש"`
- `"Inside Candle מרבוזו + 5.1x ווליום + מעל EMA21 + 50DMA + 200DMA + Pullback מדויק"`
- `"מתחת ל-EMA21 — חולשה"`

---

## 9. Minimum Data Requirements

| Indicator | Min Bars |
|---|---|
| Gate | 60 |
| EMA21 | 22 |
| SMA50 | 50 |
| SMA200 | 200 |
| High 25d | 26 |
| Volume Ratio 20d | 21 |
| AVWAP | athIdx + 5 |

If SMA50 or SMA200 are undefined (insufficient history despite passing the 60-bar gate), the corresponding "above SMAx" conditions are treated as **not met** — BUY cannot trigger without all three MA conditions.

---

## 10. Running the Script

```bash
# Scan today's close
npx tsx scripts/albert-daily-alerts.ts

# Scan a specific date
npx tsx scripts/albert-daily-alerts.ts --date 2026-04-10
```

Add to `package.json` scripts:
```json
"albert-alerts": "tsx scripts/albert-daily-alerts.ts"
```

Requires: `GOOGLE_SHEET_ID` env var (watchlist). No other API keys needed.

---

## 11. Testing

Unit tests in `tests/albertSignals.test.ts` covering:

- EMA21 correctness (known values vs. manual calculation)
- Each candle pattern (positive + negative cases)
- AVWAP with and without sufficient history
- Decision logic: BUY, HOLD, SELL, REDUCE, insufficient data
- SPY weak flag
- Hebrew formatter output structure

---

## 12. v2 Enhancements (out of scope now)

- `state/entry-prices.json`: written after each BUY/ADD alert; read next day for exact "−12% from entry" SELL rule.
- `--telegram` flag: sends output via existing Telegram bot.
- Sector grouping in output.
