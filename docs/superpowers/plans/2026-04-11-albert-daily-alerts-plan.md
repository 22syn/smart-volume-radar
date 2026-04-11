# Albert Daily Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily EOD alert script (`scripts/albert-daily-alerts.ts`) that analyses every watchlist ticker and prints a Hebrew BUY/ADD/HOLD/REDUCE/SELL recommendation per ticker, based on EMA21, SMA50, SMA200, Volume Ratio 20d, candle patterns, AVWAP, and SPY context.

**Architecture:** A pure-functions analysis module (`src/analysis/albertSignals.ts`) receives raw OHLCV bar arrays and returns typed signals. An orchestrator script fetches raw Yahoo data for every ticker (bypassing `StockData` to preserve per-bar OHLC), runs the analysis module, and prints formatted Hebrew output to stdout.

**Tech Stack:** TypeScript 5 ESM, tsx, Jest, Yahoo Finance Chart API (direct HTTP — no new libraries needed)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/utils/technicalAnalysis.ts` | Modify (add export) | Add `calculateEMA` alongside existing SMA/RSI |
| `src/analysis/albertSignals.ts` | Create | All pure analysis: types, candle patterns, vol ratio, AVWAP, decision, formatter |
| `scripts/albert-daily-alerts.ts` | Create | Orchestrator: fetch → analyse → stdout |
| `tests/technicalAnalysis.test.ts` | Modify (add tests) | EMA21 unit tests |
| `tests/albertSignals.test.ts` | Create | All other unit tests |
| `package.json` | Modify | Add `albert-alerts` script |

---

## Task 1: EMA21 in technicalAnalysis.ts

**Files:**
- Modify: `src/utils/technicalAnalysis.ts` (add after `calculateSMA`)
- Modify: `tests/technicalAnalysis.test.ts` (add `describe('calculateEMA', ...)`)

- [ ] **Step 1: Write the failing test**

Add at the bottom of `tests/technicalAnalysis.test.ts`:

```typescript
describe('calculateEMA', () => {
    it('returns undefined when fewer than period+1 bars', () => {
        // period=3 needs 4 bars minimum (3 seed + 1 roll)
        expect(calculateEMA([1, 2, 3], 3)).toBeUndefined();
    });

    it('returns undefined when exactly period bars (no roll yet)', () => {
        expect(calculateEMA([10, 20, 30], 3)).toBeUndefined();
    });

    it('calculates EMA correctly with period=3', () => {
        // alpha = 2/(3+1) = 0.5
        // seed  = (1+2+3)/3 = 2.0
        // EMA[3] = 0.5*4 + 0.5*2.0 = 3.0
        // EMA[4] = 0.5*5 + 0.5*3.0 = 4.0
        expect(calculateEMA([1, 2, 3, 4, 5], 3)).toBeCloseTo(4.0, 5);
    });

    it('handles longer series without error', () => {
        const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
        const result = calculateEMA(prices, 21);
        expect(typeof result).toBe('number');
        expect(result!).toBeGreaterThan(100);
    });
});
```

Also add `calculateEMA` to the import at the top of the test file:

```typescript
import {
    calculateSMA,
    calculateRSI,
    calculate52wHighAndConsolidation,
    isNearSMA,
    computeNewlogicTags,
    calculateEMA,
} from '../src/utils/technicalAnalysis.js';
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/technicalAnalysis.test.ts --no-coverage
```

Expected: FAIL — `calculateEMA is not a function` (or not exported).

- [ ] **Step 3: Implement `calculateEMA` in `src/utils/technicalAnalysis.ts`**

Add after the `calculateSMA` function (before the `TRADING_DAYS_PER_MONTH` constant):

```typescript
/**
 * Calculate Exponential Moving Average (EMA)
 * Seed: SMA of first `period` bars. Roll: alpha * price + (1-alpha) * prev.
 * Returns undefined when fewer than period+1 bars are available.
 */
export function calculateEMA(prices: number[], period: number): number | undefined {
    if (prices.length < period + 1) return undefined;
    const alpha = 2 / (period + 1);
    const seed = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let ema = seed;
    for (let i = period; i < prices.length; i++) {
        ema = alpha * prices[i]! + (1 - alpha) * ema;
    }
    return ema;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/technicalAnalysis.test.ts --no-coverage
```

Expected: PASS (all existing + new EMA tests green).

- [ ] **Step 5: Commit**

```bash
git add src/utils/technicalAnalysis.ts tests/technicalAnalysis.test.ts
git commit -m "feat: add calculateEMA to technicalAnalysis"
```

---

## Task 2: Types + Candle Patterns

**Files:**
- Create: `src/analysis/albertSignals.ts`
- Create: `tests/albertSignals.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/albertSignals.test.ts`:

```typescript
import {
    detectCandlePatterns,
} from '../src/analysis/albertSignals.js';
import type { Bar } from '../src/analysis/albertSignals.js';

function bar(o: number, h: number, l: number, c: number, v = 1_000_000): Bar {
    return { date: '2026-01-01', open: o, high: h, low: l, close: c, volume: v };
}

describe('detectCandlePatterns', () => {
    describe('insideCandle', () => {
        it('true when curr fits inside prev range', () => {
            const prev = bar(90, 110, 85, 100);
            const curr = bar(95, 105, 88, 102);
            expect(detectCandlePatterns(prev, curr).insideCandle).toBe(true);
        });

        it('false when curr high exceeds prev high', () => {
            const prev = bar(90, 110, 85, 100);
            const curr = bar(95, 115, 88, 112);
            expect(detectCandlePatterns(prev, curr).insideCandle).toBe(false);
        });

        it('false when curr low is below prev low', () => {
            const prev = bar(90, 110, 85, 100);
            const curr = bar(95, 105, 80, 102);
            expect(detectCandlePatterns(prev, curr).insideCandle).toBe(false);
        });
    });

    describe('bullishEngulfing', () => {
        it('true when curr bullish body engulfs prev bearish body', () => {
            // prev: open=105, close=95 (bearish)
            // curr: open=93, close=107 (bullish, engulfs prev body)
            const prev = bar(105, 108, 92, 95);
            const curr = bar(93, 110, 91, 107);
            expect(detectCandlePatterns(prev, curr).bullishEngulfing).toBe(true);
        });

        it('false when prev was bullish (not bearish)', () => {
            const prev = bar(95, 108, 92, 105); // prev closes above open = bullish
            const curr = bar(93, 110, 91, 107);
            expect(detectCandlePatterns(prev, curr).bullishEngulfing).toBe(false);
        });

        it('false when curr does not open below prev close', () => {
            // curr opens above prev close
            const prev = bar(105, 108, 92, 95);
            const curr = bar(97, 110, 91, 107); // curr.open=97 > prev.close=95
            expect(detectCandlePatterns(prev, curr).bullishEngulfing).toBe(false);
        });
    });

    describe('marubozu', () => {
        it('true when shadows are tiny (< 5% of range)', () => {
            // open=100, close=110, high=110.2, low=99.9 — nearly no shadow
            const prev = bar(80, 82, 78, 79);
            const curr = bar(100, 110.2, 99.9, 110);
            // range = 110.2 - 99.9 = 10.3
            // upper shadow = 110.2 - 110 = 0.2 → 0.2/10.3 = 1.9% < 5% ✓
            // lower shadow = 100 - 99.9 = 0.1 → 0.1/10.3 = 0.97% < 5% ✓
            expect(detectCandlePatterns(prev, curr).marubozu).toBe(true);
        });

        it('false when bearish (close < open)', () => {
            const prev = bar(80, 82, 78, 79);
            const curr = bar(110, 110.2, 99.9, 100); // bearish
            expect(detectCandlePatterns(prev, curr).marubozu).toBe(false);
        });

        it('false when upper shadow is large', () => {
            // open=100, high=120, close=105, low=99 — big upper shadow
            const prev = bar(80, 82, 78, 79);
            const curr = bar(100, 120, 99, 105);
            // upper shadow = 120-105=15, range=21 → 71% > 5%
            expect(detectCandlePatterns(prev, curr).marubozu).toBe(false);
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: FAIL — module `src/analysis/albertSignals.js` not found.

- [ ] **Step 3: Create `src/analysis/albertSignals.ts` with types and `detectCandlePatterns`**

```typescript
/**
 * Albert Daily Alerts — Analysis Module
 * Pure functions for SEPA/Minervini-style EOD signal generation.
 */

import { calculateEMA, calculateSMA, calculate52wHighAndConsolidation } from '../utils/technicalAnalysis.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Bar {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export type Recommendation = 'BUY / ADD' | 'HOLD' | 'REDUCE / SELL';

export type StatusLabel =
    | 'BREAKOUT חזק'
    | 'PULLBACK מדויק'
    | 'חולשה'
    | 'CONSOLIDATION'
    | 'HOLD';

export interface AlbertSignal {
    ticker: string;
    date: string;
    status: StatusLabel;
    recommendation: Recommendation;
    reason: string;
    pullbackPct?: number;
    marubozu: boolean;
    spyWeak: boolean;
    insufficientData: boolean;
}

export interface CandleResult {
    insideCandle: boolean;
    bullishEngulfing: boolean;
    marubozu: boolean;
}

// ─── Candle Patterns ──────────────────────────────────────────────────────────

/**
 * Detect candle patterns from the last two bars.
 * prev = bars[n-2], curr = bars[n-1].
 */
export function detectCandlePatterns(prev: Bar, curr: Bar): CandleResult {
    const insideCandle = curr.high < prev.high && curr.low > prev.low;

    const bullishEngulfing =
        curr.close > curr.open &&
        prev.close < prev.open &&
        curr.open < prev.close &&
        curr.close > prev.open;

    const range = curr.high - curr.low;
    const marubozu =
        range > 0 &&
        curr.close > curr.open &&
        (curr.high - curr.close) / range < 0.05 &&
        (curr.open - curr.low) / range < 0.05;

    return { insideCandle, bullishEngulfing, marubozu };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: PASS (all candle pattern tests).

- [ ] **Step 5: Commit**

```bash
git add src/analysis/albertSignals.ts tests/albertSignals.test.ts
git commit -m "feat: add Bar types and detectCandlePatterns"
```

---

## Task 3: Volume Ratio 20d + High Lookbacks

**Files:**
- Modify: `src/analysis/albertSignals.ts` (add 2 functions)
- Modify: `tests/albertSignals.test.ts` (add 2 describe blocks)

- [ ] **Step 1: Write the failing tests**

Add to `tests/albertSignals.test.ts`:

```typescript
import {
    detectCandlePatterns,
    computeVolumeRatio20,
    computeHighNDays,
} from '../src/analysis/albertSignals.js';

// ... existing tests ...

describe('computeVolumeRatio20', () => {
    it('returns undefined when fewer than 21 volumes', () => {
        expect(computeVolumeRatio20(Array(20).fill(1_000_000))).toBeUndefined();
    });

    it('returns ratio of current to 20d avg', () => {
        // 20 prior bars at 1_000_000 each; current = 4_000_000
        const volumes = [...Array(20).fill(1_000_000), 4_000_000];
        expect(computeVolumeRatio20(volumes)).toBeCloseTo(4.0, 5);
    });

    it('uses only 20 bars before current (not all history)', () => {
        // 5 old bars at 10 (irrelevant), 20 at 1_000_000, current at 2_000_000
        const volumes = [...Array(5).fill(10), ...Array(20).fill(1_000_000), 2_000_000];
        // avgVol20 = avg of last 20 before current = 1_000_000
        expect(computeVolumeRatio20(volumes)).toBeCloseTo(2.0, 5);
    });

    it('returns undefined when avgVol20 is 0', () => {
        const volumes = [...Array(20).fill(0), 1_000_000];
        expect(computeVolumeRatio20(volumes)).toBeUndefined();
    });
});

describe('computeHighNDays', () => {
    it('returns undefined when fewer than n+1 bars', () => {
        expect(computeHighNDays([100, 110, 120], 3)).toBeUndefined(); // needs 4
    });

    it('returns max of n bars before current (excludes current)', () => {
        // closes: [80, 90, 95, 120, 100] — n=3 means last 3 before current=[90,95,120]
        const closes = [80, 90, 95, 120, 100];
        expect(computeHighNDays(closes, 3)).toBe(120);
    });

    it('current bar is excluded from high', () => {
        // If current=999 and prior 3 are [10,20,30], high should be 30 not 999
        const closes = [10, 20, 30, 999];
        expect(computeHighNDays(closes, 3)).toBe(30);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: FAIL — `computeVolumeRatio20 is not a function`.

- [ ] **Step 3: Add functions to `src/analysis/albertSignals.ts`**

Add after `detectCandlePatterns`:

```typescript
// ─── Volume ───────────────────────────────────────────────────────────────────

/**
 * Volume ratio: current bar / avg of 20 prior bars.
 * Requires ≥ 21 volumes. Returns undefined if insufficient or avgVol is zero.
 */
export function computeVolumeRatio20(volumes: number[]): number | undefined {
    if (volumes.length < 21) return undefined;
    const prior20 = volumes.slice(-21, -1);
    const avgVol20 = prior20.reduce((a, b) => a + b, 0) / 20;
    if (avgVol20 <= 0) return undefined;
    return volumes[volumes.length - 1]! / avgVol20;
}

// ─── Price Lookbacks ──────────────────────────────────────────────────────────

/**
 * Max close over n bars immediately before the current bar (current excluded).
 * Requires closes.length >= n + 1.
 */
export function computeHighNDays(closes: number[], n: number): number | undefined {
    if (closes.length < n + 1) return undefined;
    const history = closes.slice(-(n + 1), -1);
    return Math.max(...history);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/albertSignals.ts tests/albertSignals.test.ts
git commit -m "feat: add computeVolumeRatio20 and computeHighNDays"
```

---

## Task 4: AVWAP from ATH Bar

**Files:**
- Modify: `src/analysis/albertSignals.ts` (add `computeAVWAP`)
- Modify: `tests/albertSignals.test.ts` (add `describe('computeAVWAP', ...)`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/albertSignals.test.ts`:

```typescript
import {
    detectCandlePatterns,
    computeVolumeRatio20,
    computeHighNDays,
    computeAVWAP,
} from '../src/analysis/albertSignals.js';

// ... existing tests ...

describe('computeAVWAP', () => {
    function makeArrays(n: number, highVal: number, athAt: number) {
        // All bars at price 100, except athAt index which is highVal (the ATH)
        const closes = Array(n).fill(100);
        const highs  = Array(n).fill(101);
        const lows   = Array(n).fill(99);
        const vols   = Array(n).fill(1_000_000);
        closes[athAt] = highVal;
        highs[athAt]  = highVal + 1;
        return { closes, highs, lows, vols };
    }

    it('returns undefined when fewer than 22 closes', () => {
        const { closes, highs, lows, vols } = makeArrays(20, 120, 10);
        expect(computeAVWAP(closes, highs, lows, vols)).toBeUndefined();
    });

    it('returns undefined when ATH bar is within 5 bars of current', () => {
        // 252 bars, ATH at index 248 (4 bars before end at 251)
        const { closes, highs, lows, vols } = makeArrays(252, 120, 248);
        expect(computeAVWAP(closes, highs, lows, vols)).toBeUndefined();
    });

    it('returns a number when ATH is far enough back', () => {
        // 252 bars, ATH at index 100 (151 bars before end)
        const { closes, highs, lows, vols } = makeArrays(252, 120, 100);
        const result = computeAVWAP(closes, highs, lows, vols);
        expect(typeof result).toBe('number');
        expect(result!).toBeGreaterThan(0);
    });

    it('AVWAP is roughly typical price when volume is uniform', () => {
        // 50 bars all at exactly H=101, L=99, C=100, V=1M
        // typical = (101+99+100)/3 = 100; AVWAP = 100
        const closes = Array(50).fill(100);
        const highs  = Array(50).fill(101);
        const lows   = Array(50).fill(99);
        const vols   = Array(50).fill(1_000_000);
        // ATH = 100 at index 0; 49 bars before end — enough
        // Window = last 50 bars = all of them; athIdx = 0
        const result = computeAVWAP(closes, highs, lows, vols);
        // 49 bars after athIdx; currentIdx-athIdx = 49 >= 5 ✓
        expect(result).toBeCloseTo(100, 1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: FAIL — `computeAVWAP is not a function`.

- [ ] **Step 3: Add `computeAVWAP` to `src/analysis/albertSignals.ts`**

Add after `computeHighNDays`:

```typescript
// ─── AVWAP ────────────────────────────────────────────────────────────────────

/**
 * Anchored VWAP from the last 52w ATH bar (within 252-bar window).
 * Returns undefined when: fewer than 22 closes, ATH bar not found,
 * or ATH occurred fewer than 5 bars before current.
 */
export function computeAVWAP(
    closes: number[],
    highs: number[],
    lows: number[],
    volumes: number[],
): number | undefined {
    if (closes.length < 22) return undefined;

    const ATH_WINDOW = 252;
    const wC = closes.slice(-ATH_WINDOW);
    const wH = highs.slice(-ATH_WINDOW);
    const wL = lows.slice(-ATH_WINDOW);
    const wV = volumes.slice(-ATH_WINDOW);

    const ath = Math.max(...wC);
    const athThreshold = ath * 0.998;

    let athIdx = -1;
    for (let i = wC.length - 1; i >= 0; i--) {
        if (wC[i]! >= athThreshold) {
            athIdx = i;
            break;
        }
    }
    if (athIdx < 0) return undefined;

    const currentIdx = wC.length - 1;
    if (currentIdx - athIdx < 5) return undefined;

    let sumTPV = 0;
    let sumVol = 0;
    for (let i = athIdx; i <= currentIdx; i++) {
        const tp = (wH[i]! + wL[i]! + wC[i]!) / 3;
        sumTPV += tp * wV[i]!;
        sumVol += wV[i]!;
    }
    return sumVol > 0 ? sumTPV / sumVol : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/albertSignals.ts tests/albertSignals.test.ts
git commit -m "feat: add computeAVWAP anchored from 52w ATH bar"
```

---

## Task 5: Decision Engine — `computeAlbertSignal`

**Files:**
- Modify: `src/analysis/albertSignals.ts` (add `computeAlbertSignal`)
- Modify: `tests/albertSignals.test.ts` (add decision engine tests)

- [ ] **Step 1: Write the failing tests**

Add to `tests/albertSignals.test.ts`:

```typescript
import {
    detectCandlePatterns,
    computeVolumeRatio20,
    computeHighNDays,
    computeAVWAP,
    computeAlbertSignal,
} from '../src/analysis/albertSignals.js';
import type { AlbertSignal } from '../src/analysis/albertSignals.js';

// Helper: build a minimal valid input for computeAlbertSignal
// All bars at price 100, 220 bars history (enough for SMA200)
function buildInput(overrides: Partial<{
    nBars: number;
    lastClose: number;
    lastVolume: number;
    prevClose: number;
    prevOpen: number;
    currOpen: number;
    ema21Override?: number;
}> = {}): Parameters<typeof computeAlbertSignal>[0] {
    const n = overrides.nBars ?? 220;
    const closes = Array(n).fill(100);
    const highs  = Array(n).fill(101);
    const lows   = Array(n).fill(99);
    const opens  = Array(n).fill(100);
    const volumes = Array(n).fill(500_000);

    // Last two bars: prev (bearish) + curr (bullish engulfing)
    if (overrides.prevOpen !== undefined) opens[n - 2] = overrides.prevOpen;
    if (overrides.prevClose !== undefined) closes[n - 2] = overrides.prevClose;
    if (overrides.currOpen !== undefined) opens[n - 1] = overrides.currOpen;
    if (overrides.lastClose !== undefined) {
        closes[n - 1] = overrides.lastClose;
        highs[n - 1] = overrides.lastClose + 1;
    }
    if (overrides.lastVolume !== undefined) volumes[n - 1] = overrides.lastVolume;

    const bars = closes.map((c, i) => ({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        open: opens[i]!,
        high: highs[i]!,
        low: lows[i]!,
        close: c,
        volume: volumes[i]!,
    }));

    return { ticker: 'TEST', bars, closes, highs, lows, volumes, spyWeak: false, date: '11/04/2026' };
}

describe('computeAlbertSignal', () => {
    it('returns insufficientData when fewer than 60 bars', () => {
        const input = buildInput({ nBars: 50 });
        const signal = computeAlbertSignal(input);
        expect(signal.insufficientData).toBe(true);
        expect(signal.recommendation).toBe('HOLD');
        expect(signal.reason).toContain('לא מספיק נתונים');
    });

    it('returns REDUCE / SELL when close drops below EMA21', () => {
        // 220 bars at 100, last bar drops to 80 (well below EMA21 ~100)
        const input = buildInput({ lastClose: 80 });
        const signal = computeAlbertSignal(input);
        expect(signal.recommendation).toBe('REDUCE / SELL');
        expect(signal.status).toBe('חולשה');
    });

    it('returns BUY / ADD on breakout with volume spike and bullish engulfing', () => {
        const n = 220;
        // 218 bars at 100, then prev bearish (open=105, close=95), curr bullish breakout (open=93, close=125, vol=4M)
        const closes = [...Array(n - 2).fill(100), 95, 125];
        const highs  = [...Array(n - 2).fill(101), 106, 126];
        const lows   = [...Array(n - 2).fill(99),  93,  92];
        const opens  = [...Array(n - 2).fill(100), 105, 93];
        const volumes = [...Array(n - 1).fill(500_000), 4_000_000]; // 4x vol

        const bars = closes.map((c, i) => ({
            date: `2026-01-${String(i + 1).padStart(2, '0')}`,
            open: opens[i]!, high: highs[i]!, low: lows[i]!, close: c, volume: volumes[i]!,
        }));

        const signal = computeAlbertSignal({
            ticker: 'TEST', bars, closes, highs, lows, volumes, spyWeak: false, date: '11/04/2026',
        });
        expect(signal.recommendation).toBe('BUY / ADD');
        expect(signal.status).toBe('BREAKOUT חזק');
    });

    it('returns HOLD when no signal triggers', () => {
        // 220 bars at 100, normal volume (0.5x), inside bar — no signal
        const input = buildInput();
        const signal = computeAlbertSignal(input);
        expect(signal.recommendation).toBe('HOLD');
    });

    it('sets spyWeak on signal when SPY is weak', () => {
        const input = buildInput();
        input.spyWeak = true;
        const signal = computeAlbertSignal(input);
        expect(signal.spyWeak).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: FAIL — `computeAlbertSignal is not a function`.

- [ ] **Step 3: Add `computeAlbertSignal` to `src/analysis/albertSignals.ts`**

Add after `computeAVWAP`:

```typescript
// ─── Decision Engine ──────────────────────────────────────────────────────────

export interface AlbertInput {
    ticker: string;
    bars: Bar[];
    closes: number[];
    highs: number[];
    lows: number[];
    volumes: number[];
    spyWeak: boolean;
    date: string;
}

/**
 * Core decision engine. Evaluated in strict order: gate → SELL → BUY → HOLD.
 * First matching branch wins.
 */
export function computeAlbertSignal(input: AlbertInput): AlbertSignal {
    const { ticker, bars, closes, highs, lows, volumes, spyWeak, date } = input;
    const base = { ticker, date, spyWeak, marubozu: false, insufficientData: false };

    // ── 1. Insufficient Data Gate ──────────────────────────────────────────────
    if (closes.length < 60) {
        return { ...base, status: 'HOLD', recommendation: 'HOLD', reason: 'לא מספיק נתונים', insufficientData: true };
    }

    const curr = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;
    const currentClose = closes[closes.length - 1]!;

    const ema21   = calculateEMA(closes, 21);
    const sma50   = calculateSMA(closes, 50);
    const sma200  = calculateSMA(closes, 200);
    const volRatio = computeVolumeRatio20(volumes);
    const high25d  = computeHighNDays(closes, 25);
    const high20d  = computeHighNDays(closes, 20);
    const ath52w   = calculate52wHighAndConsolidation(closes)?.ath;
    const avwap    = computeAVWAP(closes, highs, lows, volumes);
    const candles  = detectCandlePatterns(prev, curr);

    const pullbackPct = high25d != null && high25d > 0
        ? ((currentClose - high25d) / high25d) * 100
        : undefined;

    // ── 2. REDUCE / SELL ──────────────────────────────────────────────────────
    const belowEMA21     = ema21 != null && currentClose < ema21;
    const belowSMA50     = sma50 != null && currentClose < sma50;
    const proxyDropNoBounce = pullbackPct != null && pullbackPct < -12 && curr.close < curr.open;

    if (belowEMA21 || belowSMA50 || proxyDropNoBounce) {
        const reasons: string[] = [];
        if (belowEMA21)       reasons.push('מתחת ל-EMA21');
        if (belowSMA50)       reasons.push('מתחת ל-50DMA');
        if (proxyDropNoBounce) reasons.push(`ירידה ${Math.abs(pullbackPct!).toFixed(1)}% ללא באונס`);
        return { ...base, status: 'חולשה', recommendation: 'REDUCE / SELL', reason: reasons.join(' + '), pullbackPct, marubozu: candles.marubozu };
    }

    // ── 3. BUY / ADD ──────────────────────────────────────────────────────────
    const hasPattern  = candles.insideCandle || candles.bullishEngulfing;
    const aboveEMA21  = ema21  != null && currentClose > ema21;
    const aboveSMA50  = sma50  != null && currentClose > sma50;
    const aboveSMA200 = sma200 != null && currentClose > sma200;
    const isBreakout  = (high20d != null && currentClose >= high20d) ||
                        (ath52w  != null && currentClose >= ath52w * 0.998);
    const isPullback  = pullbackPct != null && pullbackPct >= -15 && pullbackPct <= -8;
    const avwapOk     = avwap == null || currentClose > avwap;
    const volOk       = volRatio != null && volRatio >= 4.0;

    if (hasPattern && aboveEMA21 && aboveSMA50 && aboveSMA200 && (isBreakout || isPullback) && avwapOk && volOk) {
        const parts: string[] = [];
        if (candles.bullishEngulfing) parts.push(candles.marubozu ? 'אנגולפינג מרבוזו' : 'אנגולפינג');
        else                          parts.push(candles.marubozu ? 'Inside Candle מרבוזו' : 'Inside Candle');
        parts.push(`${volRatio!.toFixed(1)}x ווליום`);
        parts.push('מעל EMA21 + 50DMA + 200DMA');
        if (avwap != null) parts.push('AVWAP ATH');
        if (ath52w != null && currentClose >= ath52w * 0.998) parts.push('פריצה ל-ATH חדש');
        else if (isBreakout) parts.push('פריצה ל-High 20 יום');

        const status: StatusLabel = isPullback ? 'PULLBACK מדויק' : 'BREAKOUT חזק';
        return { ...base, status, recommendation: 'BUY / ADD', reason: parts.join(' + '), pullbackPct, marubozu: candles.marubozu };
    }

    // ── 4. HOLD ───────────────────────────────────────────────────────────────
    const status: StatusLabel = pullbackPct != null && pullbackPct >= -7 && pullbackPct <= 0
        ? 'CONSOLIDATION'
        : 'HOLD';
    return { ...base, status, recommendation: 'HOLD', reason: 'ממתין לסיגנל', pullbackPct, marubozu: candles.marubozu };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: PASS. If the breakout BUY test fails, check that SMA200 is defined (need ≥200 bars) and that EMA21 > 80 (the SELL threshold check).

- [ ] **Step 5: Commit**

```bash
git add src/analysis/albertSignals.ts tests/albertSignals.test.ts
git commit -m "feat: add computeAlbertSignal decision engine"
```

---

## Task 6: Hebrew Formatter — `formatHebrewAlert`

**Files:**
- Modify: `src/analysis/albertSignals.ts` (add `formatHebrewAlert`)
- Modify: `tests/albertSignals.test.ts` (add formatter tests)

- [ ] **Step 1: Write the failing tests**

Add to `tests/albertSignals.test.ts`:

```typescript
import {
    detectCandlePatterns,
    computeVolumeRatio20,
    computeHighNDays,
    computeAVWAP,
    computeAlbertSignal,
    formatHebrewAlert,
} from '../src/analysis/albertSignals.js';
import type { AlbertSignal } from '../src/analysis/albertSignals.js';

function makeSignal(overrides: Partial<AlbertSignal> = {}): AlbertSignal {
    return {
        ticker: 'NBIS',
        date: '11/04/2026',
        status: 'HOLD',
        recommendation: 'HOLD',
        reason: 'ממתין לסיגנל',
        marubozu: false,
        spyWeak: false,
        insufficientData: false,
        ...overrides,
    };
}

describe('formatHebrewAlert', () => {
    it('includes ticker and date in header', () => {
        const out = formatHebrewAlert(makeSignal());
        expect(out).toContain('$NBIS');
        expect(out).toContain('11/04/2026');
    });

    it('shows לא מספיק נתונים for insufficient data', () => {
        const out = formatHebrewAlert(makeSignal({ insufficientData: true, reason: 'לא מספיק נתונים' }));
        expect(out).toContain('לא מספיק נתונים');
    });

    it('shows SPY warning only on BUY/ADD + spyWeak', () => {
        const buySignal = makeSignal({ recommendation: 'BUY / ADD', status: 'BREAKOUT חזק', spyWeak: true, reason: 'test' });
        expect(formatHebrewAlert(buySignal)).toContain('⚠️ שוק');

        const holdSignal = makeSignal({ recommendation: 'HOLD', spyWeak: true });
        expect(formatHebrewAlert(holdSignal)).not.toContain('⚠️ שוק');
    });

    it('shows pullback line only on BUY/ADD with pullbackPct', () => {
        const signal = makeSignal({ recommendation: 'BUY / ADD', status: 'PULLBACK מדויק', reason: 'test', pullbackPct: -10.5 });
        const out = formatHebrewAlert(signal);
        expect(out).toContain('Pullback של 10.5%');
        expect(out).toContain('EMA21');
    });

    it('shows PAYtience on HOLD', () => {
        const out = formatHebrewAlert(makeSignal({ recommendation: 'HOLD' }));
        expect(out).toContain('PAYtience');
    });

    it('does not show PAYtience on BUY', () => {
        const out = formatHebrewAlert(makeSignal({ recommendation: 'BUY / ADD', status: 'BREAKOUT חזק', reason: 'test' }));
        expect(out).not.toContain('PAYtience');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest tests/albertSignals.test.ts --no-coverage
```

Expected: FAIL — `formatHebrewAlert is not a function`.

- [ ] **Step 3: Add `formatHebrewAlert` to `src/analysis/albertSignals.ts`**

Add at the bottom of the file:

```typescript
// ─── Hebrew Formatter ─────────────────────────────────────────────────────────

/**
 * Format an AlbertSignal as a Hebrew stdout alert block.
 */
export function formatHebrewAlert(signal: AlbertSignal): string {
    if (signal.insufficientData) {
        return [
            `📌 $${signal.ticker}   |   ${signal.date}`,
            '',
            'סטטוס: לא מספיק נתונים',
            'המלצה: HOLD',
        ].join('\n');
    }

    const lines: string[] = [
        `📌 $${signal.ticker}   |   ${signal.date}`,
        '',
        `סטטוס: ${signal.status}`,
        `המלצה: ${signal.recommendation}`,
    ];

    if (signal.spyWeak && signal.recommendation === 'BUY / ADD') {
        lines.push('⚠️ שוק: SPY מתחת ל-EMA21 — זהירות מוגברת');
    }

    lines.push('', `סיבה: ${signal.reason}`, '');

    if (signal.pullbackPct != null && signal.recommendation === 'BUY / ADD') {
        lines.push(`💡 Pullback של ${Math.abs(signal.pullbackPct).toFixed(1)}% — באונס מדויק על EMA21`);
    }
    if (signal.recommendation === 'HOLD') {
        lines.push('💡 PAYtience!');
    }

    return lines.join('\n');
}
```

- [ ] **Step 4: Run all tests**

```bash
npx jest --no-coverage
```

Expected: all tests PASS (technicalAnalysis + albertSignals).

- [ ] **Step 5: Commit**

```bash
git add src/analysis/albertSignals.ts tests/albertSignals.test.ts
git commit -m "feat: add formatHebrewAlert Hebrew output formatter"
```

---

## Task 7: Orchestrator — `scripts/albert-daily-alerts.ts`

**Files:**
- Create: `scripts/albert-daily-alerts.ts`

No unit tests for the orchestrator (it wraps network calls). Smoke-test manually.

- [ ] **Step 1: Create `scripts/albert-daily-alerts.ts`**

```typescript
#!/usr/bin/env npx tsx
/**
 * Albert Daily Alerts — EOD scanner
 * Prints a Hebrew BUY/ADD/HOLD/REDUCE/SELL alert per watchlist ticker.
 *
 * Usage:
 *   npx tsx scripts/albert-daily-alerts.ts
 *   npx tsx scripts/albert-daily-alerts.ts --date 2026-04-10
 */
import 'dotenv/config';
import pLimit from 'p-limit';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { computeAlbertSignal, formatHebrewAlert } from '../src/analysis/albertSignals.js';
import { calculateEMA } from '../src/utils/technicalAnalysis.js';
import logger from '../src/utils/logger.js';
import type { Bar, AlbertInput } from '../src/analysis/albertSignals.js';

// ─── Date resolution ──────────────────────────────────────────────────────────

function resolveAsOfDate(): string {
    const flagIdx = process.argv.indexOf('--date');
    if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
        return process.argv[flagIdx + 1]!;
    }
    return new Date().toISOString().slice(0, 10);
}

// ─── Yahoo raw fetch ──────────────────────────────────────────────────────────

interface RawBars {
    bars: Bar[];
    closes: number[];
    highs: number[];
    lows: number[];
    volumes: number[];
}

async function fetchRawBars(ticker: string, asOfDate: string): Promise<RawBars | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json',
            },
        });
        if (!res.ok) return null;

        const data = await res.json() as {
            chart?: {
                result?: Array<{
                    timestamp?: number[];
                    indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
                }>;
            };
        };

        const result = data?.chart?.result?.[0];
        if (!result?.timestamp?.length) return null;

        const ts = result.timestamp!;
        const quote = result.indicators?.quote?.[0];
        if (!quote) return null;

        const asOfEnd = new Date(asOfDate + 'T23:59:59Z').getTime() / 1000;
        const bars: Bar[] = [];

        for (let i = 0; i < ts.length; i++) {
            if (ts[i]! > asOfEnd) break;
            const c = quote.close?.[i];
            if (c == null || c <= 0) continue;
            bars.push({
                date: new Date(ts[i]! * 1000).toISOString().slice(0, 10),
                open:   quote.open?.[i]   ?? c,
                high:   quote.high?.[i]   ?? c,
                low:    quote.low?.[i]    ?? c,
                close:  c,
                volume: quote.volume?.[i] ?? 0,
            });
        }

        if (bars.length === 0) return null;
        return {
            bars,
            closes:  bars.map(b => b.close),
            highs:   bars.map(b => b.high),
            lows:    bars.map(b => b.low),
            volumes: bars.map(b => b.volume),
        };
    } catch {
        return null;
    }
}

// ─── SPY context ──────────────────────────────────────────────────────────────

async function computeSpyWeak(asOfDate: string): Promise<boolean> {
    const raw = await fetchRawBars('SPY', asOfDate);
    if (!raw || raw.closes.length < 22) return false;
    const ema21 = calculateEMA(raw.closes, 21);
    const lastClose = raw.closes[raw.closes.length - 1]!;
    const prevClose = raw.closes[raw.closes.length - 2] ?? lastClose;
    const priceChange = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;
    return (ema21 != null && lastClose < ema21) || priceChange < -1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const asOfDate = resolveAsOfDate();
    logger.info(`🔍 Albert Daily Alerts — ${asOfDate}`);

    await fetchAndCacheWatchlist();
    const tickers = loadWatchlist();
    logger.info(`📋 Watchlist: ${tickers.length} tickers`);

    const spyWeak = await computeSpyWeak(asOfDate);
    if (spyWeak) logger.warn('⚠️ SPY weak — market caution flag ON');

    const dateDisplay = asOfDate.split('-').reverse().join('/');
    const limit = pLimit(3);

    const tasks = tickers.map(ticker =>
        limit(async () => {
            const raw = await fetchRawBars(ticker, asOfDate);
            if (!raw) {
                logger.warn(`❌ ${ticker}: no data`);
                return null;
            }
            const input: AlbertInput = { ticker, ...raw, spyWeak, date: dateDisplay };
            return computeAlbertSignal(input);
        })
    );

    const signals = await Promise.all(tasks);
    const separator = '\n' + '─'.repeat(50) + '\n';

    console.log('\n' + '═'.repeat(50));
    console.log(`📊 Albert Daily Alerts — ${dateDisplay}`);
    console.log('═'.repeat(50) + '\n');

    for (const signal of signals) {
        if (!signal) continue;
        console.log(formatHebrewAlert(signal));
        console.log(separator);
    }
}

main().catch((err: unknown) => {
    logger.error('Fatal error:', (err as Error).message);
    process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If errors appear, fix them before continuing.

- [ ] **Step 3: Smoke test with a real date (requires GOOGLE_SHEET_ID in .env)**

```bash
npx tsx scripts/albert-daily-alerts.ts --date 2026-04-10
```

Expected: Hebrew alert blocks printed to stdout. Check that:
- At least one ticker shows a signal block with `📌 $TICKER`
- No runtime exceptions
- Tickers without data show the warning in logger (not a crash)

- [ ] **Step 4: Commit**

```bash
git add scripts/albert-daily-alerts.ts
git commit -m "feat: add albert-daily-alerts orchestrator script"
```

---

## Task 8: Wire npm Script + Final Validation

**Files:**
- Modify: `package.json` (add `albert-alerts`)

- [ ] **Step 1: Add npm script to `package.json`**

In the `"scripts"` block, add:

```json
"albert-alerts": "tsx scripts/albert-daily-alerts.ts"
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests PASS. Zero failures.

- [ ] **Step 3: Run linter**

```bash
npm run lint
```

Expected: no new lint errors. Fix any that appear.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: wire albert-alerts npm script"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] EMA21 — Task 1
- [x] Volume Ratio 20d — Task 3
- [x] Candle patterns (Inside, Engulfing, Marubozu) — Task 2
- [x] High 20d / High 25d — Task 3
- [x] 52-Week High — used via `calculate52wHighAndConsolidation` in Task 5
- [x] AVWAP from ATH — Task 4
- [x] Decision logic (gate → SELL → BUY → HOLD) — Task 5
- [x] SPY filter (spyWeak flag) — Task 7 (`computeSpyWeak`)
- [x] Hebrew output format — Task 6
- [x] Pullback % line in output — Task 6
- [x] PAYtience on HOLD — Task 6
- [x] `--date` CLI flag — Task 7
- [x] "לא מספיק נתונים" when < 60 bars — Task 5 + Task 6
- [x] p-limit concurrency (3) — Task 7
- [x] `npm run albert-alerts` — Task 8

**Type consistency check:**
- `Bar` defined Task 2, used in Tasks 5, 7 ✓
- `AlbertSignal` defined Task 2, used in Tasks 5, 6, 7 ✓
- `AlbertInput` defined Task 5, used in Task 7 ✓
- `computeAlbertSignal` signature consistent across Tasks 5, 7 ✓
- `calculateEMA` exported in Task 1, imported in Tasks 5 (via albertSignals) and 7 ✓
