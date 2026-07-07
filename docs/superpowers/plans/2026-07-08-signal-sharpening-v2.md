# Signal Sharpening v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 8-change signal-sharpening package (from the 2026-07-08 precision study, 145K trading-day event-study) in the Lean Radar on the `stable` branch.

**Architecture:** All detector logic stays pure in `src/lean/signals.ts` (single source of truth). Wiring/gating happens in `src/lean.ts`. Telegram rendering in `src/lean/format.ts`. Dashboard rows/score in `src/lean/dashboardRows.ts`. A new `src/lean/signalHistory.ts` reads recent `results/lean-*.json` snapshots for 21-day alert dedup (same file-walk pattern as `graduates.ts`).

**Tech Stack:** Node ≥20, TypeScript 5.9 ESM, Jest (`npx jest`), tsx. Branch `feat/signal-sharpening-v2` off `origin/stable`.

**Study evidence (why each change):** pullback depth −30..−25 is negative (−2.42% med21, win 45%); HV with mom63≥20 & pctATH≥−15 doubles raw HV (+3.37%/+10.98%, −84% alerts); RVOL≥8 = climax (+0.58% med21); nearBreakout as-is ≈ baseline (12.7 alerts/win), first-in-21d + mom63≥20 → +2.58%, win 64%; 39% of breakouts come from tickers with median daily move <0.8% (ETFs); CREEP-LIQ (s2 & mom63≥30 & pctATH≥−10 & rvol<1.5 & $10M dollar-vol) → +13.25% med63; pullback in weak tape (SPY<SMA50) → win 79%, +58% med63.

---

## Task 0: Branch + worktree setup

**Files:** none (git only)

- [ ] **Step 1: Create worktree on a fresh branch off origin/stable**

```bash
cd /Users/kobihazout/dev/smart-volume-radar-engine
git fetch origin stable
git worktree add .claude/worktrees/sharpen-v2 -b feat/signal-sharpening-v2 origin/stable
cd .claude/worktrees/sharpen-v2
npm ci
```

- [ ] **Step 2: Copy this plan into the branch and commit**

```bash
cp /Users/kobihazout/dev/smart-volume-radar-engine/.claude/worktrees/dash-stable/docs/superpowers/plans/2026-07-08-signal-sharpening-v2.md docs/superpowers/plans/
git add docs/superpowers/plans/2026-07-08-signal-sharpening-v2.md
git commit -m "docs: signal-sharpening v2 implementation plan"
```

- [ ] **Step 3: Baseline — verify the suite is green before touching anything**

Run: `npx jest 2>&1 | tail -4` → Expected: all suites pass.
Run: `npx tsc --noEmit` → Expected: exit 0.

**All file paths below are relative to `/Users/kobihazout/dev/smart-volume-radar-engine/.claude/worktrees/sharpen-v2/`.**

---

## Task 1: Pullback depth — cut the deep end (−30 → −25)

**Files:**
- Modify: `src/lean/signals.ts:36`
- Test: `tests/leanSignals.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `qualifiesAsHealthyPullback` describe block in `tests/leanSignals.test.ts` (use the existing `makeStock` helper defined at the top of that file):

```typescript
    it('rejects a deep pullback below -25% (study: -30..-25 zone is negative EV)', () => {
        const stock = makeStock({ pctFromAth: -27, lastPrice: 100, sma200: 90 });
        expect(qualifiesAsHealthyPullback(stock)).toBeNull();
    });

    it('accepts a pullback at exactly -25%', () => {
        const stock = makeStock({ pctFromAth: -25, lastPrice: 100, sma200: 90 });
        expect(qualifiesAsHealthyPullback(stock)).toEqual({ pctFromAth: -25 });
    });
```

Also search the file for any existing test that passes `pctFromAth` between −30 and −25 and expects a signal (the 2026-07-02 "deepened" behavior):

Run: `grep -n "\-2[6-9]\|\-30" tests/leanSignals.test.ts`

If such a test exists, update its expectation to `toBeNull()` and its title to say the deep zone is excluded.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest tests/leanSignals.test.ts -t "pullback" 2>&1 | tail -6`
Expected: FAIL — deep pullback (−27) currently returns a signal because `PULLBACK_MIN_PCT = -30`.

- [ ] **Step 3: Change the constant**

In `src/lean/signals.ts` line 36, replace:

```typescript
export const PULLBACK_MIN_PCT = -30; // deepened per 2026-07-02 signal-efficacy study
```

with:

```typescript
// 2026-07-08 precision study (145K day event-study): the -30..-25 zone is
// NEGATIVE (-2.42% med21, win 45%) even WITH survivorship bias in its favor.
// Gold zone is -20..-15 (+6.42% med21, win 65%). Reverts the 2026-07-02 deepening.
export const PULLBACK_MIN_PCT = -25;
```

- [ ] **Step 4: Run the suite**

Run: `npx jest tests/leanSignals.test.ts 2>&1 | tail -4` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lean/signals.ts tests/leanSignals.test.ts
git commit -m "feat(lean): cut pullback deep end to -25% (study: -30..-25 is negative EV)"
```

---

## Task 2: Climax guard — RVOL ≥ 8 is a warning, not strength

**Files:**
- Modify: `src/lean/signals.ts` (HighVolumeSignal + qualifiesAsHighVolume, lines 55-57 and 207-212)
- Modify: `src/lean/dashboardRows.ts:53-64` (scoreRow)
- Test: `tests/leanSignals.test.ts`, `tests/dashboardRows.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/leanSignals.test.ts`, in the `qualifiesAsHighVolume` describe:

```typescript
    it('flags climax=true when RVOL >= 8 (study: rvol>=8 med21 is +0.58%, noise)', () => {
        expect(qualifiesAsHighVolume(makeStock({ rvol: 9 }))).toEqual({ level: 'extreme', climax: true });
    });

    it('does not flag climax below 8', () => {
        expect(qualifiesAsHighVolume(makeStock({ rvol: 6 }))).toEqual({ level: 'extreme', climax: false });
        expect(qualifiesAsHighVolume(makeStock({ rvol: 3.5 }))).toEqual({ level: 'high', climax: false });
    });
```

`tests/dashboardRows.test.ts` — add (mirror the existing scoreRow test style in that file; build the same `ScoreInput`-shaped object the existing tests use):

```typescript
    it('penalizes climax RVOL >= 8 by 15 points', () => {
        const base = {
            scanDate: '2026-07-08', ticker: 'X', region: 'US', sector: 'Semis',
            signal: 'highVolume' as const, signals: ['highVolume' as const], signalCount: 1,
            rvol: 5, athPct: -5, dayPct: 1, stage2: 1 as const, distPivot: null, price: 10,
        };
        const normal = scoreRow(base);
        const climax = scoreRow({ ...base, rvol: 9 });
        // rvol contribution is capped at 6*5=30 for both; the only delta is the -15 climax penalty.
        expect(normal - climax).toBe(15);
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/leanSignals.test.ts tests/dashboardRows.test.ts 2>&1 | tail -6`
Expected: FAIL — `climax` property missing; score delta is 0.

- [ ] **Step 3: Implement**

`src/lean/signals.ts` — after line 35 (`EXTREME_VOLUME_RVOL`), add:

```typescript
// 2026-07-08 study: RVOL>=8 events return +0.58% med21 (vs +1.81% for all HV) —
// climaxes and news spikes. Flagged as a WARNING, never counted as strength.
export const CLIMAX_RVOL = 8;
```

Change the interface (lines 55-57):

```typescript
export interface HighVolumeSignal {
    level: 'high' | 'extreme';
    /** RVOL >= CLIMAX_RVOL — exhaustion/news spike; warn, don't upgrade. */
    climax: boolean;
}
```

Change `qualifiesAsHighVolume` (lines 207-212):

```typescript
export function qualifiesAsHighVolume(stock: StockData): HighVolumeSignal | null {
    const rvol = stock.rvol ?? 0;
    const climax = rvol >= CLIMAX_RVOL;
    if (rvol >= EXTREME_VOLUME_RVOL) return { level: 'extreme', climax };
    if (rvol >= HIGH_VOLUME_RVOL) return { level: 'high', climax };
    return null;
}
```

`src/lean/dashboardRows.ts` — in `scoreRow` (after the existing climax-day penalty at line 60):

```typescript
  if ((r.rvol || 0) >= 8) s -= 15; // 2026-07-08 study: rvol>=8 = climax, +0.58% med21
```

`src/lean/format.ts` — locate the high-volume line renderer (search: `grep -n "extreme" src/lean/format.ts`). Where the `extreme` badge is rendered, append a climax warning when `signal.climax` is true:

```typescript
const climaxTag = signal.climax ? ' ⚠️ קליימקס' : '';
```

and append `${climaxTag}` to that line's output string.

- [ ] **Step 4: Run the full suite (format tests included)**

Run: `npx jest 2>&1 | tail -4` → Expected: PASS. If `leanFormat.test.ts` breaks because HighVolumeSignal literals now need `climax`, add `climax: false` to those fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/lean/signals.ts src/lean/format.ts src/lean/dashboardRows.ts tests/
git commit -m "feat(lean): flag RVOL>=8 as climax warning + score penalty"
```

---

## Task 3: HV-LEADER — A-tier high-volume (mom63 ≥ 20 & pctATH ≥ −15)

**Files:**
- Modify: `src/lean/signals.ts` (constants + helper), `src/lean.ts:157-163` (wiring), `src/lean/format.ts` (badge + sort)
- Test: `tests/leanSignals.test.ts`

**Design:** `leader` is set in `lean.ts` (needs the closes series for momentum63), not inside `qualifiesAsHighVolume`. Telegram-level priority only — no D1 schema change (YAGNI; the dashboard already shows rvol/athPct).

- [ ] **Step 1: Write the failing test**

`tests/leanSignals.test.ts`:

```typescript
import { isHvLeader } from '../src/lean/signals';

describe('isHvLeader', () => {
    // 64 closes climbing 0.5%/day => mom63 ≈ +37%
    const risingCloses = Array.from({ length: 70 }, (_, i) => 100 * Math.pow(1.005, i));
    const flatCloses = Array.from({ length: 70 }, () => 100);

    it('true when Stage2 + mom63>=20 + within -15% of ATH', () => {
        const stock = makeStock({ pctFromAth: -8 });
        expect(isHvLeader(stock, risingCloses)).toBe(true);
    });
    it('false when momentum is flat', () => {
        const stock = makeStock({ pctFromAth: -8 });
        expect(isHvLeader(stock, flatCloses)).toBe(false);
    });
    it('false when too far from ATH', () => {
        const stock = makeStock({ pctFromAth: -22 });
        expect(isHvLeader(stock, risingCloses)).toBe(false);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/leanSignals.test.ts -t "isHvLeader" 2>&1 | tail -4`
Expected: FAIL — `isHvLeader` is not exported.

- [ ] **Step 3: Implement**

`src/lean/signals.ts` — after the leader-gate block (line 110), add:

```typescript
// ─── HV-LEADER A-tier (2026-07-08 study) ─────────────────────────────
// HV + mom63>=20 + within -15% of ATH: +3.37%/+10.98% med21/63 (vs +1.81%/+6.18%
// raw HV), win 61.5%, best ATR expectancy in the system (+0.47 ATR).
export const HV_LEADER_MOM63_MIN = 20;
export const HV_LEADER_MAX_FROM_ATH = -15;

/** A-tier high-volume: Stage-2 leader near highs. Needs the closes series. */
export function isHvLeader(stock: StockData, closes: number[]): boolean {
    if (!isStage2(stock)) return false;
    if ((stock.pctFromAth ?? -Infinity) < HV_LEADER_MAX_FROM_ATH) return false;
    const m = momentum63(closes);
    return m != null && m >= HV_LEADER_MOM63_MIN;
}
```

Add `leader` to the interface (now with climax from Task 2):

```typescript
export interface HighVolumeSignal {
    level: 'high' | 'extreme';
    climax: boolean;
    /** A-tier: Stage2 + mom63>=20 + within -15% of ATH. Set by lean.ts (needs closes). */
    leader?: boolean;
}
```

`src/lean.ts` — the HV wiring at lines 157-163 becomes (add `isHvLeader` to the import block at lines 25-31):

```typescript
            const vol = qualifiesAsHighVolume(stock);
            if (vol) {
                vol.leader = ohlc ? isHvLeader(stock, ohlc.closes) : false;
                result.highVolume.push({ stock, signal: vol });
            } else {
                const nearV = qualifiesAsVolumeNearMiss(stock);
                if (nearV) result.nearVolume.push({ stock, signal: nearV });
            }
```

`src/lean.ts` — the HV sort (line ~175 `result.highVolume.sort(...)`) becomes leaders-first:

```typescript
        result.highVolume.sort((a, b) =>
            (Number(b.signal.leader ?? false) - Number(a.signal.leader ?? false)) ||
            ((b.stock.rvol ?? 0) - (a.stock.rvol ?? 0)));
```

`src/lean/format.ts` — in the HV line renderer (same spot as Task 2's climax tag):

```typescript
const leaderTag = signal.leader ? ' 🥇 מוביל' : '';
```

appended to the line before the climax tag.

- [ ] **Step 4: Run the suite**

Run: `npx jest 2>&1 | tail -4` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lean/signals.ts src/lean.ts src/lean/format.ts tests/leanSignals.test.ts
git commit -m "feat(lean): HV-LEADER A-tier badge + leaders-first sort"
```

---

## Task 4: Signal history helper (21-day dedup infrastructure)

**Files:**
- Create: `src/lean/signalHistory.ts`
- Test: `tests/signalHistory.test.ts` (create)

**Design:** Walks `results/lean-YYYY-MM-DD.json` snapshots backwards from the scan date (calendar days), unions the tickers seen in a given `detections` section. Mirrors `loadYesterdayNears` in `src/lean/graduates.ts:36` (same file naming, same `detections` shape — see `LeanSnapshot` in `src/utils/snapshotWriter.ts:51`). Missing files are skipped silently (CI artifact history accumulates but may have gaps).

- [ ] **Step 1: Write the failing test**

Create `tests/signalHistory.test.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecentSignalTickers } from '../src/lean/signalHistory';

function writeSnap(dir: string, date: string, sections: Record<string, string[]>) {
    const detections: Record<string, Array<{ ticker: string }>> = {};
    for (const [k, tickers] of Object.entries(sections)) {
        detections[k] = tickers.map((t) => ({ ticker: t }));
    }
    fs.writeFileSync(path.join(dir, `lean-${date}.json`), JSON.stringify({ scanner: 'lean-radar', detections }));
}

describe('loadRecentSignalTickers', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sighist-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('unions tickers from the requested section across the lookback window', () => {
        writeSnap(dir, '2026-07-07', { nearConsolidation: ['AAA', 'BBB'] });
        writeSnap(dir, '2026-06-20', { nearConsolidation: ['CCC'] });      // 18 days back — inside 21
        writeSnap(dir, '2026-06-10', { nearConsolidation: ['OLD'] });      // 28 days back — outside
        const s = loadRecentSignalTickers(dir, '2026-07-08', 'nearConsolidation', 21);
        expect(s).toEqual(new Set(['AAA', 'BBB', 'CCC']));
    });

    it('returns an empty set when no snapshots exist', () => {
        expect(loadRecentSignalTickers(dir, '2026-07-08', 'creep', 21)).toEqual(new Set());
    });

    it('skips corrupt files without throwing', () => {
        fs.writeFileSync(path.join(dir, 'lean-2026-07-07.json'), '{not json');
        writeSnap(dir, '2026-07-06', { nearConsolidation: ['AAA'] });
        expect(loadRecentSignalTickers(dir, '2026-07-08', 'nearConsolidation', 21)).toEqual(new Set(['AAA']));
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/signalHistory.test.ts 2>&1 | tail -4`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/lean/signalHistory.ts`:

```typescript
/**
 * Recent-alert lookup for cross-day signal dedup.
 *
 * Walks results/lean-YYYY-MM-DD.json snapshots backwards from the scan date
 * (calendar days; trading-day gaps and missing artifacts are simply skipped)
 * and unions the tickers seen in the requested `detections` section.
 *
 * Used to suppress repeat alerts: the 2026-07-08 precision study showed e.g.
 * repeat nearBreakouts return +0.89% med21 vs +1.70% for first alerts, at
 * 10x the alert volume.
 */
import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

export function loadRecentSignalTickers(
    resultsDir: string,
    scanDate: string,
    section: string,
    daysBack = 21
): Set<string> {
    const out = new Set<string>();
    const scanD = new Date(scanDate + 'T00:00:00Z');
    for (let back = 1; back <= daysBack; back++) {
        const d = new Date(scanD);
        d.setUTCDate(d.getUTCDate() - back);
        const file = path.join(resultsDir, `lean-${d.toISOString().slice(0, 10)}.json`);
        if (!fs.existsSync(file)) continue;
        try {
            const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                detections?: Record<string, Array<{ ticker: string }>>;
            };
            for (const rec of snap.detections?.[section] ?? []) out.add(rec.ticker);
        } catch (e) {
            logger.warn(`⚠️ signalHistory: failed to parse ${file}: ${(e as Error).message}`);
        }
    }
    return out;
}
```

- [ ] **Step 4: Run the test**

Run: `npx jest tests/signalHistory.test.ts 2>&1 | tail -4` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lean/signalHistory.ts tests/signalHistory.test.ts
git commit -m "feat(lean): signalHistory helper for 21-day alert dedup"
```

---

## Task 5: nearBreakout — momentum gate + first-in-21d only

**Files:**
- Modify: `src/lean.ts:149-156` (nearC wiring; the detector itself stays unchanged)
- Test: none new at unit level (detector unchanged); wiring verified in Task 9's DRY_RUN

**Design:** The study: nearBreakout as-is = 6,837 alerts/yr, +0.94% med21 (≈baseline). First-in-21d + mom63≥20 → 206 alerts, +2.58%, win 64%. Both gates applied at the wiring level so the pure detector (and its tests) stay intact.

- [ ] **Step 1: Load history + apply gates in lean.ts**

In `src/lean.ts`, before the `for (const stock of stocks)` loop (right after the `result` object is initialized at ~line 146), add (imports: `momentum63` added to the signals import block; `loadRecentSignalTickers` from `./lean/signalHistory.js`):

```typescript
        // Cross-day dedup sets (2026-07-08 study: repeat near-breakouts are noise).
        const resultsDir = path.join(__moduleDir, '..', 'results');
        const recentNearBO = loadRecentSignalTickers(resultsDir, scanDate, 'nearConsolidation', 21);
```

Then change the nearC wiring (lines 153-155):

```typescript
                } else {
                    // Study gates: only FIRST alert in 21d AND 63d momentum >= 20%
                    // (repeat/no-momentum near-breakouts: +0.89% med21 ≈ noise).
                    const m = momentum63(ohlc.closes);
                    const nearC =
                        m != null && m >= LEADER_MOM63_MIN && !recentNearBO.has(stock.ticker)
                            ? detectConsolidationNearMiss(stock, ohlc.closes, ohlc.highs, ohlc.lows)
                            : null;
                    if (nearC) result.nearConsolidation.push({ stock, signal: nearC });
                }
```

(`LEADER_MOM63_MIN` is already exported from signals.ts:94; add it to the import block.)

- [ ] **Step 2: Typecheck + suite**

Run: `npx tsc --noEmit && npx jest 2>&1 | tail -4` → Expected: clean + PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lean.ts
git commit -m "feat(lean): gate nearBreakout to first-in-21d + mom63>=20 (-97% noise in study)"
```

---

## Task 6: Breakout ADR floor — stop pointing the tier at ETFs

**Files:**
- Modify: `src/lean/signals.ts` (new helper + constant), `src/lean.ts` (gate)
- Test: `tests/leanSignals.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/leanSignals.test.ts`:

```typescript
import { adr20Pct, BREAKOUT_MIN_ADR_PCT } from '../src/lean/signals';

describe('adr20Pct', () => {
    it('computes the mean daily range % over the last 20 bars', () => {
        // 25 bars, every bar high=102, low=98, close=100 → range 4%
        const closes = Array(25).fill(100);
        const highs = Array(25).fill(102);
        const lows = Array(25).fill(98);
        expect(adr20Pct(highs, lows, closes)).toBeCloseTo(4.0, 5);
    });
    it('returns null with fewer than 20 bars', () => {
        expect(adr20Pct([1, 2], [1, 2], [1, 2])).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/leanSignals.test.ts -t "adr20Pct" 2>&1 | tail -4`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

`src/lean/signals.ts` — after the CONSOLIDATION_WINDOWS block:

```typescript
// 2026-07-08 study: 39% of confirmed breakouts came from tickers whose median
// daily move is <0.8% (ETFs, utilities) — and the tier underperforms baseline
// at 63d (+3.12% vs +4.50%). The tightness windows structurally select
// low-volatility instruments; an ADR floor re-aims the tier at stocks that move.
export const BREAKOUT_MIN_ADR_PCT = 2.0;

/** Mean daily range % over the last 20 bars: avg((high−low)/close × 100). */
export function adr20Pct(highs: number[], lows: number[], closes: number[]): number | null {
    const n = closes.length;
    if (n < 20) return null;
    let sum = 0;
    let cnt = 0;
    for (let i = n - 20; i < n; i++) {
        const h = highs[i];
        const l = lows[i];
        const c = closes[i];
        if (h == null || l == null || c == null || c <= 0) continue;
        sum += ((h - l) / c) * 100;
        cnt++;
    }
    return cnt > 0 ? sum / cnt : null;
}
```

`src/lean.ts` — in the consolidation wiring (inside `if (ohlc)`, before calling `detectConsolidationBreakout`):

```typescript
                // ADR floor: skip the consolidation family for instruments that
                // don't move (ETF creep — 39% of study breakouts, below-baseline returns).
                const adr = adr20Pct(ohlc.highs, ohlc.lows, ohlc.closes);
                if (adr != null && adr < BREAKOUT_MIN_ADR_PCT) {
                    // no breakout / nearBreakout for slow movers
                } else {
                    const consolidation = detectConsolidationBreakout(stock, ohlc.closes, ohlc.highs, ohlc.lows);
                    ...existing breakout/nearC logic from Task 5 moves inside this else...
                }
```

(Concretely: wrap the existing breakout+nearC block from Task 5 in the `else`. Add `adr20Pct, BREAKOUT_MIN_ADR_PCT` to the signals import block.)

- [ ] **Step 4: Run the suite**

Run: `npx tsc --noEmit && npx jest 2>&1 | tail -4` → Expected: clean + PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lean/signals.ts src/lean.ts tests/leanSignals.test.ts
git commit -m "feat(lean): ADR>=2% floor on the consolidation tier (de-ETF the breakouts)"
```

---

## Task 7: CREEP-LIQ tier — catch the quiet monsters

**Files:**
- Modify: `src/lean/signals.ts` (detector), `src/lean/format.ts:34-48` (LeanScanResult + section), `src/lean.ts` (wiring), `src/utils/snapshotWriter.ts:51-60` (snapshot section), `src/lean/dashboardRows.ts:20-44` (SignalKind + BASE + mapping)
- Test: `tests/leanSignals.test.ts`, `tests/dashboardRows.test.ts`

**Design:** New signal for stocks grinding at highs with NO volume anomaly — the profile of 58% of the year's explosive moves (median RVOL 0.84 at launch: MXL +331%, INTC, MU, SIMO, IREN). Study card (with the $10M liquidity floor): n=883, +2.97%/+13.25% med21/63, win 59.1%. Position signal — 63d horizon.

- [ ] **Step 1: Write the failing detector tests**

`tests/leanSignals.test.ts`:

```typescript
import { qualifiesAsCreep, approxUsdFactor } from '../src/lean/signals';

describe('qualifiesAsCreep', () => {
    const risingCloses = Array.from({ length: 70 }, (_, i) => 100 * Math.pow(1.006, i)); // mom63 ≈ +46%

    it('fires for a quiet Stage-2 leader near highs with liquidity', () => {
        const stock = makeStock({
            rvol: 0.9, pctFromAth: -4, lastPrice: 100, avgVolume: 500_000, // $50M/day
        });
        const sig = qualifiesAsCreep(stock, risingCloses);
        expect(sig).not.toBeNull();
        expect(sig!.mom63).toBeGreaterThanOrEqual(30);
    });

    it('rejects when volume is already elevated (rvol >= 1.5 — HV territory)', () => {
        const stock = makeStock({ rvol: 2.0, pctFromAth: -4, avgVolume: 500_000 });
        expect(qualifiesAsCreep(stock, risingCloses)).toBeNull();
    });

    it('rejects illiquid names (avg dollar volume < $10M)', () => {
        const stock = makeStock({ rvol: 0.9, pctFromAth: -4, lastPrice: 5, avgVolume: 100_000 }); // $0.5M
        expect(qualifiesAsCreep(stock, risingCloses)).toBeNull();
    });

    it('rejects when too far from the high (pctFromAth < -10)', () => {
        const stock = makeStock({ rvol: 0.9, pctFromAth: -14, avgVolume: 500_000 });
        expect(qualifiesAsCreep(stock, risingCloses)).toBeNull();
    });
});

describe('approxUsdFactor', () => {
    it('converts TASE agorot and LSE pence to ~USD', () => {
        expect(approxUsdFactor('HGG.TA')).toBeCloseTo(0.0027, 4);
        expect(approxUsdFactor('BA.L')).toBeCloseTo(0.0127, 4);
        expect(approxUsdFactor('NVDA')).toBe(1);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/leanSignals.test.ts -t "Creep" 2>&1 | tail -4` → Expected: FAIL.

- [ ] **Step 3: Implement the detector**

`src/lean/signals.ts` — append at the end of the file:

```typescript
// ─── 4. CREEP tier (2026-07-08 study) ────────────────────────────────
// 58% of explosive moves (+25% in 21d) launched with NO alert — median RVOL
// 0.84 at launch, many AT a fresh 52w high (MXL +331%, INTC, MU, SIMO, IREN).
// This tier catches the quiet grind: Stage-2 leader near highs, volume still
// asleep, liquid enough to trade. Study card (with $10M floor): n=883,
// +2.97%/+13.25% med21/63, win 59.1%. POSITION signal — 63-day horizon.
export const CREEP_MOM63_MIN = 30;
export const CREEP_MAX_FROM_ATH = -10;
export const CREEP_MAX_RVOL = 1.5;
export const CREEP_MIN_DOLLAR_VOLUME_USD = 10_000_000;

export interface CreepSignal {
    mom63: number;
    pctFromAth: number;
    avgDollarVolumeUsd: number;
}

/** Rough per-suffix price→USD factor for the liquidity floor (subunit currencies included). */
export function approxUsdFactor(ticker: string): number {
    const t = ticker.toUpperCase();
    if (t.endsWith('.TA')) return 0.0027;   // agorot → USD (₪/100 × ~0.27)
    if (t.endsWith('.L')) return 0.0127;    // pence → USD
    if (t.endsWith('.TW')) return 0.031;
    if (t.endsWith('.KS')) return 0.00072;
    if (t.endsWith('.T')) return 0.0067;
    if (t.endsWith('.SA')) return 0.18;
    if (t.endsWith('.TO') || t.endsWith('.V')) return 0.73;
    if (t.endsWith('.DE') || t.endsWith('.MI') || t.endsWith('.PA') || t.endsWith('.AS') || t.endsWith('.MC')) return 1.08;
    if (t.endsWith('.HK')) return 0.128;
    return 1; // USD default
}

export function qualifiesAsCreep(stock: StockData, closes: number[]): CreepSignal | null {
    if (!isStage2(stock)) return null;
    const pct = stock.pctFromAth;
    if (pct == null || pct < CREEP_MAX_FROM_ATH) return null;
    if ((stock.rvol ?? 0) >= CREEP_MAX_RVOL) return null;
    const m = momentum63(closes);
    if (m == null || m < CREEP_MOM63_MIN) return null;
    const dollarVol = (stock.avgVolume ?? 0) * (stock.lastPrice ?? 0) * approxUsdFactor(stock.ticker);
    if (dollarVol < CREEP_MIN_DOLLAR_VOLUME_USD) return null;
    return { mom63: m, pctFromAth: pct, avgDollarVolumeUsd: dollarVol };
}
```

Run: `npx jest tests/leanSignals.test.ts -t "Creep" 2>&1 | tail -4` → Expected: PASS.

Commit: `git add -A && git commit -m "feat(lean): CREEP detector (quiet Stage-2 leader near highs, liquid)"`

- [ ] **Step 4: Wire the pipeline end-to-end**

1. `src/lean/format.ts` LeanScanResult (line 34): add after `pullbacks`:

```typescript
    creep: Array<{ stock: StockData; signal: CreepSignal }>;
```

(import `CreepSignal` from `./signals.js`; make it non-optional and fix the two initializers.)

2. `src/lean.ts`: initialize `creep: []` in the `result` object; in the detector loop after the pullback block:

```typescript
            if (ohlc) {
                const cr = !recentCreep.has(stock.ticker) ? qualifiesAsCreep(stock, ohlc.closes) : null;
                if (cr) result.creep.push({ stock, signal: cr });
            }
```

and next to the `recentNearBO` load add:

```typescript
        const recentCreep = loadRecentSignalTickers(resultsDir, scanDate, 'creep', 21);
```

plus a sort with the other sorts:

```typescript
        result.creep.sort((a, b) => b.signal.mom63 - a.signal.mom63);
```

3. `src/utils/snapshotWriter.ts` — add to `LeanSnapshot['detections']` (line 52-59):

```typescript
        creep: Array<{ ticker: string; mom63: number; pctFromAth: number }>;
```

and populate it where the other sections are serialized (find with `grep -n "nearPullback" src/utils/snapshotWriter.ts`), mapping `result.creep`:

```typescript
        creep: result.creep.map((r) => ({
            ticker: r.stock.ticker, mom63: r.signal.mom63, pctFromAth: r.signal.pctFromAth,
        })),
```

(If the lean snapshot call site passes sections individually, mirror the exact pattern used for `pullbacks`.)

4. `src/lean/format.ts` — render a new section between pullbacks and breakouts (mirror the pullback section builder exactly; look at how `pullbacks` renders):

Section header: `🐢 <b>זחילה שקטה</b> — מוביל על שיא, נפח רדום (אופק 63 יום)`
Per-stock line suffix: `↳ mom63 +${signal.mom63.toFixed(0)}% · ${signal.pctFromAth.toFixed(1)}% מהשיא`
Also update the order legend at format.ts:158 to `🎓 graduated → 📉 pullback → 🐢 creep → 📈 breakout → 🔥 volume`.

5. `src/lean/dashboardRows.ts`:

```typescript
export type SignalKind =
  | 'breakout' | 'highVolume' | 'pullback' | 'creep'
  | 'nearBreakout' | 'nearHighVol' | 'nearPullback';

const BASE: Record<SignalKind, number> = {
  pullback: 50, creep: 42, nearPullback: 38, highVolume: 30,
  nearHighVol: 18, breakout: 12, nearBreakout: 8,
};
```

and in `rowsFromLeanResult`, add `creep` to the section→kind mapping next to the existing ones (find with `grep -n "pullbacks" src/lean/dashboardRows.ts`).

6. `dashboard/public/index.html` — add `<option value="creep">🐢 Creep</option>` to the `#f-signal` select (line ~123).

- [ ] **Step 5: Add pipeline tests + run everything**

`tests/dashboardRows.test.ts` — extend whichever test builds a LeanScanResult fixture with a `creep: []` field (required now), and add:

```typescript
    it('maps creep detections to rows with BASE 42', () => {
        // extend the existing rowsFromLeanResult fixture with one creep entry and
        // assert the produced row has signal 'creep' and score >= 42.
    });
```

(Write it concretely against the existing fixture style in that file — the fixture shape is already established there.)

Run: `npx tsc --noEmit && npx jest 2>&1 | tail -4` → Expected: clean + PASS (fix any fixture that now needs `creep: []`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(lean): CREEP-LIQ tier end-to-end (detector, report section, snapshot, dashboard rows)"
```

---

## Task 8: SPY regime — flag the tape, boost pullbacks in weak markets

**Files:**
- Modify: `src/lean.ts` (fetch SPY + regime), `src/lean/format.ts` (header line), `src/lean/dashboardRows.ts` (score boost)
- Test: `tests/dashboardRows.test.ts`

**Design:** Study: pullback during SPY<SMA50 → win 79%, +17.4%/+58.0% med21/63 (single correction episode — hence a boost/tag, not a filter). Breakout in weak tape: +0.25% (another reason the ADR floor matters).

- [ ] **Step 1: Compute the regime in lean.ts**

After the OHLC fetch loop (~line 135), add (import `calculateSMA` from `../utils/technicalAnalysis.js` — check the exact relative path used elsewhere in lean.ts):

```typescript
        // Market regime: SPY vs SMA50/200. Study: pullbacks in weak tape (SPY<SMA50)
        // were the strongest setup measured (win 79%, +58% med63) — boost, don't filter.
        let regime: { spyAboveSma50: boolean; spyAboveSma200: boolean } | undefined;
        try {
            const spy = await fetchOHLCSeries('SPY');
            if (spy && spy.closes.length >= 200) {
                const last = spy.closes[spy.closes.length - 1]!;
                const sma50 = calculateSMA(spy.closes, 50);
                const sma200 = calculateSMA(spy.closes, 200);
                if (sma50 != null && sma200 != null) {
                    regime = { spyAboveSma50: last > sma50, spyAboveSma200: last > sma200 };
                }
            }
        } catch { /* regime is optional — scan proceeds without it */ }
        if (regime) result.regime = regime;
```

Add to `LeanScanResult` in format.ts:

```typescript
    /** SPY tape context (optional — absent if the SPY fetch failed). */
    regime?: { spyAboveSma50: boolean; spyAboveSma200: boolean };
```

(Note: `result` is initialized before this snippet in current code order — place the regime computation after `result` is created, or store in a local and attach. Either way `result.regime` must be set before `formatLeanReport` and `writeDashboardRows` are called.)

- [ ] **Step 2: Header line in format.ts**

In `formatLeanReport`, right after the title/date header (before the order legend at line ~158):

```typescript
    if (result.regime) {
        const r = result.regime;
        const tape = r.spyAboveSma50
            ? '🌡️ שוק: SPY מעל SMA50 — מצב רגיל'
            : '🌡️ <b>שוק חלש</b>: SPY מתחת SMA50 — 📉 פולבקים של מובילים = הסטאפ החזק ביותר (win 79% במחקר)';
        parts.push(tape + '\n');
    }
```

(Adapt `parts.push` to however the function accumulates lines — check its local variable name.)

- [ ] **Step 3: Score boost in dashboardRows**

`scoreRow` gets a new optional context param (keep backwards-compatible):

```typescript
export function scoreRow(r: ScoreInput, ctx?: { weakTape?: boolean }): number {
  ...
  if (ctx?.weakTape && r.signals.includes('pullback')) s += 15; // regime study: win 79% in weak tape
  return Math.round(s);
}
```

Thread `ctx` through both `scoreRow` call sites (lines ~84 and ~145): `scoreRow(r, { weakTape: regime ? !regime.spyAboveSma50 : false })` — `rowsFromLeanResult` reads `result.regime`.

Test in `tests/dashboardRows.test.ts`:

```typescript
    it('boosts pullback rows by 15 in weak tape', () => {
        const base = { /* same ScoreInput shape as the climax test, signal/signals: pullback */ };
        expect(scoreRow(base, { weakTape: true }) - scoreRow(base)).toBe(15);
    });
```

- [ ] **Step 4: Run everything + commit**

Run: `npx tsc --noEmit && npx jest 2>&1 | tail -4` → Expected: clean + PASS.

```bash
git add -A && git commit -m "feat(lean): SPY regime header + weak-tape pullback boost"
```

---

## Task 9: Pullback stop hint (formatter only)

**Files:**
- Modify: `src/lean/format.ts` (pullback section line)
- Test: `tests/leanFormat.test.ts`

- [ ] **Step 1: Failing test** — in `tests/leanFormat.test.ts`, find the test that renders a pullback and assert the output contains the stop hint:

```typescript
    it('pullback lines include the study stop hint', () => {
        // reuse the existing formatLeanReport fixture that includes a pullback
        expect(out).toContain('🛑 סטופ −10..−12% / SMA50');
    });
```

- [ ] **Step 2: Implement** — in the pullback section renderer in format.ts, append to the section header (once, not per stock):

```typescript
    '   <i>🛑 סטופ −10..−12% / SMA50 · אופק 63 יום (הבור החציוני −8.6% — סטופ −5% נזרק ברעש)</i>'
```

- [ ] **Step 3: Run + commit**

Run: `npx jest tests/leanFormat.test.ts 2>&1 | tail -4` → Expected: PASS.

```bash
git add src/lean/format.ts tests/leanFormat.test.ts
git commit -m "feat(lean): pullback stop-calibration hint in report"
```

---

## Task 10: Full verification + PR

**Files:** none new

- [ ] **Step 1: Full suite + typecheck (root AND dashboard)**

```bash
npx tsc --noEmit && npx jest 2>&1 | tail -5
cd dashboard && npx tsc --noEmit && npx jest 2>&1 | tail -5 && cd ..
```

Expected: everything green.

- [ ] **Step 2: DRY_RUN smoke test (no Telegram send)**

```bash
DRY_RUN=1 npm run start:lean 2>&1 | tail -40
```

Expected: scan completes; log shows the new gates working (fewer nearBreakouts, a creep section, regime line in the printed report). Requires `GOOGLE_SHEET_ID`/`FINNHUB_API_KEY` env — if unavailable locally, note it and rely on CI.

- [ ] **Step 3: Push + PR to stable**

```bash
git push -u origin feat/signal-sharpening-v2
gh pr create --base stable --title "Signal sharpening v2: pullback zone, HV-LEADER, climax guard, nearBO dedup, ADR floor, CREEP tier, regime" --body "Implements the 8-change package from the 2026-07-08 precision study (145K-day event-study, see docs/superpowers/plans/2026-07-08-signal-sharpening-v2.md). Each change carries its measured before/after in code comments.

VALIDATION REQUIRED BEFORE MERGE: run the radar-criteria-tester agent on this branch (60-90d real scan data) to confirm predicted lift out-of-sample."
```

- [ ] **Step 4: Post-PR — run radar-criteria-tester validation**

Dispatch the `radar-criteria-tester` agent on the branch to produce the before/after lift analysis on real scan history. Attach its verdict to the PR before merging.

---

## Self-Review (completed)

- **Spec coverage:** change 1 → Task 1 · change 2 (HV-LEADER) → Task 3 · change 3 (climax) → Task 2 · change 4 (nearBO dedup) → Tasks 4-5 · change 5 (ADR floor) → Task 6 · change 6 (CREEP-LIQ) → Task 7 · change 7 (stop hint) → Task 9 · change 8 (regime boost) → Task 8. ✓
- **Type consistency:** `HighVolumeSignal.climax` (Task 2) is required — Task 3 fixtures include it; `LeanScanResult.creep` non-optional — Task 7 step 5 fixes fixtures; `scoreRow(r, ctx?)` stays backwards-compatible. ✓
- **Known soft spots (flagged, not placeholders):** format.ts render-site line numbers aren't pinned (file wasn't fully read) — each formatter step includes the exact grep to locate the site and the exact string to add; snapshotWriter creep serialization mirrors the documented `pullbacks` pattern with concrete code. Engineer should follow the greps.
