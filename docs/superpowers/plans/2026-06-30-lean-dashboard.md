# Lean Radar Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private Cloudflare-hosted dashboard that shows every Lean Radar signal (sortable/filterable/searchable, with a quality score, daily summary, distribution chart, and click-to-deep-dive), fed daily from GitHub Actions into Cloudflare D1.

**Architecture:** Row-building + scoring live in the radar repo (`src/lean/dashboardRows.ts`), shared by the live lean run and the backfill seed; both emit a flat `results/dashboard-{date}.json` (`Row[]`, already scored). A standalone `dashboard/` package ingests that JSON into D1 (REST API, idempotent) and serves a Cloudflare Pages app (Functions API + static RTL front-end) gated by Cloudflare Access.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers — repo convention), Jest (repo's `jest.config.cjs`), Cloudflare Pages + Functions, Cloudflare D1, Chart.js (CDN), vanilla JS front-end, wrangler.

---

## File Structure

Radar repo (shared logic — `stable` branch, runs in GHA):
- Create `src/lean/dashboardRows.ts` — `Row` type, `scoreRow()`, `rowsFromLeanResult()`, `rowsFromReconstructed()`, `writeDashboardRows()`.
- Modify `src/lean.ts` — call `writeDashboardRows(scanDate, result)` after the report is built.
- Modify `scripts/reconstruct-lean.ts` — also emit per-day `dashboard-{date}.json` for the seed.
- Create `tests/dashboardRows.test.ts` — score + mapping tests.

Dashboard package (`dashboard/`, Cloudflare Pages project):
- Create `dashboard/wrangler.toml` — Pages config + D1 binding.
- Create `dashboard/schema.sql` — `lean_signals` table + indexes.
- Create `dashboard/src/ingestD1.ts` — build `INSERT OR REPLACE` batches, POST to D1 REST API.
- Create `dashboard/src/query.ts` — pure `buildSignalsQuery()` / `buildSummaryQuery()`.
- Create `dashboard/scripts/seed.ts` — loop `dashboard-{date}.json` files → ingest.
- Create `dashboard/functions/api/signals.ts` — `onRequestGet`, wires `env.DB` → `buildSignalsQuery`.
- Create `dashboard/functions/api/summary.ts` — `onRequestGet`, daily aggregate.
- Create `dashboard/public/index.html` — RTL shell.
- Create `dashboard/public/app.js` — fetch + render table/cards/chart/deep-dive.
- Create `dashboard/public/styles.css` — RTL styling.
- Create `dashboard/tests/ingestD1.test.ts`, `dashboard/tests/query.test.ts`.
- Create `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/jest.config.cjs`.

GHA + access:
- Modify `.github/workflows/daily-scan-lean.yml` — add D1 ingest step + thin Telegram pointer.
- Create `dashboard/README.md` — Cloudflare Access setup runbook + secrets list.

---

## Shared contract (used across tasks)

```typescript
// src/lean/dashboardRows.ts
export type SignalKind =
  | 'breakout' | 'highVolume' | 'pullback'
  | 'nearBreakout' | 'nearHighVol' | 'nearPullback';

export interface Row {
  scanDate: string;     // 'YYYY-MM-DD'
  ticker: string;
  region: 'US' | 'TASE' | 'Foreign';
  sector: string;
  signal: SignalKind;
  rvol: number;
  athPct: number | null;
  dayPct: number;
  stage2: 0 | 1;
  distPivot: number | null;
  score: number;
  price: number;
}
```

---

## Phase 1 — Shared row-building + scoring (radar repo)

### Task 1: Region + ETF helpers

**Files:**
- Create: `src/lean/dashboardRows.ts`
- Test: `tests/dashboardRows.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dashboardRows.test.ts
import { regionOf, isETFSector } from '../src/lean/dashboardRows.js';

describe('regionOf', () => {
  it('classifies US, TASE, Foreign', () => {
    expect(regionOf('AAPL')).toBe('US');
    expect(regionOf('TEVA.TA')).toBe('TASE');
    expect(regionOf('ASML.AS')).toBe('Foreign');
    expect(regionOf('6531.TW')).toBe('Foreign');
  });
});

describe('isETFSector', () => {
  it('detects ETF sectors', () => {
    expect(isETFSector('ETF - US')).toBe(true);
    expect(isETFSector('Semiconductor')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/dashboardRows.test.ts -t regionOf`
Expected: FAIL — module not found / `regionOf is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lean/dashboardRows.ts
const FOREIGN_SUFFIXES = [
  '.TW', '.KS', '.T', '.MI', '.PA', '.L', '.AS', '.SW', '.VI',
  '.SA', '.BK', '.HK', '.DE', '.CO', '.ST', '.HE', '.OL', '.MC', '.BR', '.TO',
];

export function regionOf(ticker: string): 'US' | 'TASE' | 'Foreign' {
  if (ticker.endsWith('.TA')) return 'TASE';
  if (FOREIGN_SUFFIXES.some((s) => ticker.endsWith(s))) return 'Foreign';
  return 'US';
}

export function isETFSector(sector: string | undefined | null): boolean {
  return /ETF/i.test(sector ?? '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/dashboardRows.test.ts -t regionOf`
Expected: PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add src/lean/dashboardRows.ts tests/dashboardRows.test.ts
git commit -m "feat(dashboard): region + ETF helpers for dashboard rows"
```

### Task 2: scoreRow()

**Files:**
- Modify: `src/lean/dashboardRows.ts`
- Test: `tests/dashboardRows.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// add to tests/dashboardRows.test.ts
import { scoreRow } from '../src/lean/dashboardRows.js';

const base = {
  scanDate: '2026-06-29', ticker: 'X', region: 'US' as const, sector: 'Semis',
  rvol: 0, athPct: -20, dayPct: 1, stage2: 0 as 0 | 1, distPivot: null, price: 100,
};

describe('scoreRow', () => {
  it('rewards Stage2 + volume for a healthy pullback', () => {
    const s = scoreRow({ ...base, signal: 'pullback', rvol: 4, stage2: 1 });
    // 40 base + min(4,6)*5=20 + stage2 20 = 80
    expect(s).toBe(80);
  });
  it('penalizes a high-volume down-day (climax) and deep ATH', () => {
    // RENK-like: highVolume, RVOL 6+, dayPct<0, athPct -52, not stage2
    const s = scoreRow({ ...base, signal: 'highVolume', rvol: 12, dayPct: -2, athPct: -52, stage2: 0 });
    // 35 + min(12,6)*5=30 + 0 - 25 (climax) - 20 (deep ATH) = 20
    expect(s).toBe(20);
  });
  it('adds proximity bonus for a near-breakout at the pivot', () => {
    const s = scoreRow({ ...base, signal: 'nearBreakout', rvol: 0, stage2: 1, distPivot: 0 });
    // 25 + 0 + 20 + max(0,10-0*4)=10 = 55
    expect(s).toBe(55);
  });
  it('de-prioritizes ETFs', () => {
    const s = scoreRow({ ...base, signal: 'pullback', rvol: 0, sector: 'ETF - US' });
    // 40 + 0 + 0 - 12 = 28
    expect(s).toBe(28);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/dashboardRows.test.ts -t scoreRow`
Expected: FAIL — `scoreRow is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to src/lean/dashboardRows.ts
const BASE: Record<SignalKind, number> = {
  breakout: 50, pullback: 40, highVolume: 35,
  nearBreakout: 25, nearHighVol: 15, nearPullback: 10,
};

type ScoreInput = Omit<Row, 'score'>;

export function scoreRow(r: ScoreInput): number {
  let s = BASE[r.signal];
  s += Math.min(r.rvol || 0, 6) * 5;
  if (r.stage2) s += 20;
  if (r.distPivot != null) s += Math.max(0, 10 - r.distPivot * 4);
  if (r.signal === 'highVolume' && (r.dayPct || 0) < 0) s -= 25;
  if (r.athPct != null && r.athPct < -30) s -= 20;
  if (isETFSector(r.sector)) s -= 12;
  return Math.round(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/dashboardRows.test.ts -t scoreRow`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lean/dashboardRows.ts tests/dashboardRows.test.ts
git commit -m "feat(dashboard): confluence scoreRow with climax + ETF penalties"
```

### Task 3: rowsFromLeanResult()

**Files:**
- Modify: `src/lean/dashboardRows.ts`
- Test: `tests/dashboardRows.test.ts`

Note the `LeanScanResult` shape (from `src/lean.ts`): arrays `consolidationBreakouts`, `highVolume`, `pullbacks`, `nearConsolidation`, `nearVolume`, `nearPullback`, each element `{ stock: StockData, signal }`. `nearConsolidation` signal has `distanceToPivotPct`; a breakout's pivot distance is 0.

- [ ] **Step 1: Write the failing test**

```typescript
// add to tests/dashboardRows.test.ts
import { rowsFromLeanResult } from '../src/lean/dashboardRows.js';

function stub(ticker: string, over: any = {}) {
  return { ticker, sector: 'Semis', rvol: 2, pctFromAth: -20, priceChange: 1,
           lastPrice: 100, sma50: 110, sma200: 90, ...over };
}

describe('rowsFromLeanResult', () => {
  it('maps each category to a Row with the right signal + dist_pivot', () => {
    const result: any = {
      consolidationBreakouts: [{ stock: stub('MNST', { lastPrice: 120, sma50: 100, sma200: 90 }), signal: { window: '1M', windowHigh: 119 } }],
      highVolume: [{ stock: stub('CTRA'), signal: { level: 'extreme' } }],
      pullbacks: [{ stock: stub('ARM'), signal: { pctFromAth: -22 } }],
      nearConsolidation: [{ stock: stub('REG'), signal: { window: '1M', windowHigh: 81, distanceToPivotPct: 0.6 } }],
      nearVolume: [{ stock: stub('FOO'), signal: { rvol: 2.7 } }],
      nearPullback: [{ stock: stub('BAR'), signal: { pctFromAth: -13 } }],
    };
    const rows = rowsFromLeanResult('2026-06-29', result);
    const by = Object.fromEntries(rows.map((r) => [r.ticker, r]));
    expect(by.MNST.signal).toBe('breakout');
    expect(by.MNST.distPivot).toBe(0);
    expect(by.MNST.stage2).toBe(1);            // 120>100>90
    expect(by.CTRA.signal).toBe('highVolume');
    expect(by.REG.signal).toBe('nearBreakout');
    expect(by.REG.distPivot).toBe(0.6);
    expect(by.FOO.signal).toBe('nearHighVol');
    expect(by.BAR.signal).toBe('nearPullback');
    expect(by.ARM.scanDate).toBe('2026-06-29');
    expect(typeof by.ARM.score).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/dashboardRows.test.ts -t rowsFromLeanResult`
Expected: FAIL — `rowsFromLeanResult is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to src/lean/dashboardRows.ts
import type { StockData } from '../types/index.js';

function isStage2(s: StockData): 0 | 1 {
  return s.lastPrice != null && s.sma50 != null && s.sma200 != null &&
    s.lastPrice > s.sma50 && s.sma50 > s.sma200 ? 1 : 0;
}

function buildRow(
  scanDate: string, stock: StockData, signal: SignalKind, distPivot: number | null,
): Row {
  const r: Omit<Row, 'score'> = {
    scanDate, ticker: stock.ticker.toUpperCase(), region: regionOf(stock.ticker),
    sector: stock.sector ?? 'Unknown', signal,
    rvol: stock.rvol ?? 0, athPct: stock.pctFromAth ?? null,
    dayPct: stock.priceChange ?? 0, stage2: isStage2(stock),
    distPivot, price: stock.lastPrice ?? 0,
  };
  return { ...r, score: scoreRow(r) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowsFromLeanResult(scanDate: string, result: any): Row[] {
  const rows: Row[] = [];
  for (const e of result.consolidationBreakouts) rows.push(buildRow(scanDate, e.stock, 'breakout', 0));
  for (const e of result.highVolume) rows.push(buildRow(scanDate, e.stock, 'highVolume', null));
  for (const e of result.pullbacks) rows.push(buildRow(scanDate, e.stock, 'pullback', null));
  for (const e of result.nearConsolidation) rows.push(buildRow(scanDate, e.stock, 'nearBreakout', e.signal.distanceToPivotPct));
  for (const e of result.nearVolume) rows.push(buildRow(scanDate, e.stock, 'nearHighVol', null));
  for (const e of result.nearPullback) rows.push(buildRow(scanDate, e.stock, 'nearPullback', null));
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/dashboardRows.test.ts -t rowsFromLeanResult`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lean/dashboardRows.ts tests/dashboardRows.test.ts
git commit -m "feat(dashboard): rowsFromLeanResult mapper"
```

### Task 4: rowsFromReconstructed() + writeDashboardRows()

**Files:**
- Modify: `src/lean/dashboardRows.ts`
- Test: `tests/dashboardRows.test.ts`

The reconstructed JSON (`scripts/reconstruct-lean.ts`) stores `signalsByDate[date][ticker] = { sector, rvol, barGain, pctFromAth, lastPrice, isStage2, primary, distanceToPivotPct }` where `primary` is already one of the six `SignalKind` values.

- [ ] **Step 1: Write the failing test**

```typescript
// add to tests/dashboardRows.test.ts
import { rowsFromReconstructed } from '../src/lean/dashboardRows.js';

describe('rowsFromReconstructed', () => {
  it('flattens signalsByDate into scored Rows', () => {
    const recon = {
      signalsByDate: {
        '2026-06-29': {
          ARM: { sector: 'Semis', rvol: 3.6, barGain: 2.8, pctFromAth: -22,
                 lastPrice: 343, isStage2: true, primary: 'pullback', distanceToPivotPct: null },
        },
      },
    };
    const rows = rowsFromReconstructed(recon);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe('ARM');
    expect(rows[0].signal).toBe('pullback');
    expect(rows[0].stage2).toBe(1);
    expect(rows[0].dayPct).toBe(2.8);
    expect(typeof rows[0].score).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/dashboardRows.test.ts -t rowsFromReconstructed`
Expected: FAIL — `rowsFromReconstructed is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// add to src/lean/dashboardRows.ts
import fs from 'node:fs';
import path from 'node:path';

interface ReconRecord {
  sector: string; rvol: number; barGain: number; pctFromAth: number | null;
  lastPrice: number; isStage2: boolean; primary: SignalKind; distanceToPivotPct: number | null;
}

export function rowsFromReconstructed(recon: {
  signalsByDate: Record<string, Record<string, ReconRecord>>;
}): Row[] {
  const rows: Row[] = [];
  for (const [scanDate, day] of Object.entries(recon.signalsByDate)) {
    for (const [ticker, rec] of Object.entries(day)) {
      const r: Omit<Row, 'score'> = {
        scanDate, ticker: ticker.toUpperCase(), region: regionOf(ticker),
        sector: rec.sector ?? 'Unknown', signal: rec.primary,
        rvol: rec.rvol ?? 0, athPct: rec.pctFromAth, dayPct: rec.barGain ?? 0,
        stage2: rec.isStage2 ? 1 : 0, distPivot: rec.distanceToPivotPct, price: rec.lastPrice ?? 0,
      };
      rows.push({ ...r, score: scoreRow(r) });
    }
  }
  return rows;
}

/** Write results/dashboard-{date}.json (Row[]) next to the lean snapshot. */
export function writeDashboardRows(scanDate: string, result: unknown, resultsDir: string): string {
  const rows = rowsFromLeanResult(scanDate, result as never);
  const file = path.join(resultsDir, `dashboard-${scanDate}.json`);
  fs.writeFileSync(file, JSON.stringify(rows));
  return file;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/dashboardRows.test.ts`
Expected: PASS (entire file).

- [ ] **Step 5: Commit**

```bash
git add src/lean/dashboardRows.ts tests/dashboardRows.test.ts
git commit -m "feat(dashboard): reconstructed mapper + writeDashboardRows emitter"
```

### Task 5: Wire emitter into the lean run + reconstruction

**Files:**
- Modify: `src/lean.ts` (after `formatLeanReport`, before the Telegram send block at ~line 192)
- Modify: `scripts/reconstruct-lean.ts` (after it writes its reconstructed JSON)

- [ ] **Step 1: Add the emitter call to `src/lean.ts`**

Find (near line 189-192):
```typescript
        const message = formatLeanReport(scanDate, result);
```
Insert immediately BEFORE that line:
```typescript
        // Emit flat dashboard rows for D1 ingestion (independent of Telegram).
        try {
            const dashFile = writeDashboardRows(scanDate, result, path.join(__moduleDir, '..', 'results'));
            logger.info(`📊 Dashboard rows → ${dashFile}`);
        } catch (e) {
            logger.warn(`⚠️ dashboard rows emit failed: ${(e as Error).message}`);
        }
```
Add the import at the top of `src/lean.ts` (with the other `./lean/...` imports):
```typescript
import { writeDashboardRows } from './lean/dashboardRows.js';
```

- [ ] **Step 2: Add per-day emit to `scripts/reconstruct-lean.ts`**

After the block that writes `lean-reconstructed-${today}.json` (near `fs.writeFileSync(outPath, ...)`), add:
```typescript
    // Also emit per-day flat dashboard rows for the D1 seed.
    const { rowsFromReconstructed } = await import('../src/lean/dashboardRows.js');
    const allRows = rowsFromReconstructed(out as never);
    const byDate = new Map<string, unknown[]>();
    for (const row of allRows) {
        const arr = byDate.get(row.scanDate) ?? [];
        arr.push(row);
        byDate.set(row.scanDate, arr);
    }
    for (const [d, rows] of byDate) {
        fs.writeFileSync(path.join(RESULTS_DIR, `dashboard-${d}.json`), JSON.stringify(rows));
    }
    console.log(`📊 Emitted ${byDate.size} dashboard-{date}.json files for seed`);
```

- [ ] **Step 3: Verify lean run emits the file (DRY_RUN, no Telegram)**

Run: `FORCE_SCAN=true DRY_RUN=1 npm run start:lean`
Expected: log line `📊 Dashboard rows → .../results/dashboard-<date>.json`; the file exists and is a JSON array of row objects with a numeric `score`.

- [ ] **Step 4: Verify reconstruction emits seed files**

Run: `BACKTEST_MODE=1 npx tsx scripts/reconstruct-lean.ts --days 20`
Expected: `📊 Emitted 20 dashboard-{date}.json files for seed`; `results/dashboard-2026-*.json` files exist.

- [ ] **Step 5: Commit**

```bash
git add src/lean.ts scripts/reconstruct-lean.ts
git commit -m "feat(dashboard): emit dashboard-{date}.json from lean run and reconstruction"
```

---

## Phase 2 — Dashboard package scaffold + D1

### Task 6: Scaffold `dashboard/` package

**Files:**
- Create: `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/jest.config.cjs`, `dashboard/.gitignore`

- [ ] **Step 1: Create `dashboard/package.json`**

```json
{
  "name": "lean-dashboard",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "jest",
    "seed": "tsx scripts/seed.ts",
    "dev": "wrangler pages dev public --d1 DB",
    "deploy": "wrangler pages deploy public"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "wrangler": "^3.60.0"
  }
}
```

- [ ] **Step 2: Create `dashboard/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"]
  }
}
```

- [ ] **Step 3: Create `dashboard/jest.config.cjs`**

```javascript
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
```

- [ ] **Step 4: Create `dashboard/.gitignore`**

```
node_modules/
.wrangler/
dist/
```

- [ ] **Step 5: Install and commit**

Run: `cd dashboard && npm install`
Expected: installs without error.
```bash
git add dashboard/package.json dashboard/tsconfig.json dashboard/jest.config.cjs dashboard/.gitignore dashboard/package-lock.json
git commit -m "chore(dashboard): scaffold Cloudflare Pages package"
```

### Task 7: D1 schema + wrangler config

**Files:**
- Create: `dashboard/schema.sql`, `dashboard/wrangler.toml`

- [ ] **Step 1: Create `dashboard/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS lean_signals (
  scan_date   TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  region      TEXT,
  sector      TEXT,
  signal      TEXT NOT NULL,
  rvol        REAL,
  ath_pct     REAL,
  day_pct     REAL,
  stage2      INTEGER,
  dist_pivot  REAL,
  score       INTEGER,
  price       REAL,
  PRIMARY KEY (scan_date, ticker)
);
CREATE INDEX IF NOT EXISTS idx_lean_date  ON lean_signals(scan_date);
CREATE INDEX IF NOT EXISTS idx_lean_score ON lean_signals(score);
```

- [ ] **Step 2: Create the D1 database**

Run: `cd dashboard && npx wrangler d1 create lean-radar`
Expected: prints a `database_id`. Copy it for the next step.

- [ ] **Step 3: Create `dashboard/wrangler.toml`** (paste the real `database_id`)

```toml
name = "lean-dashboard"
pages_build_output_dir = "public"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "DB"
database_name = "lean-radar"
database_id = "PASTE_DATABASE_ID_HERE"
```

- [ ] **Step 4: Apply the schema (remote)**

Run: `cd dashboard && npx wrangler d1 execute lean-radar --remote --file schema.sql`
Expected: `Executed 3 commands` (table + 2 indexes), no error.

- [ ] **Step 5: Commit**

```bash
git add dashboard/schema.sql dashboard/wrangler.toml
git commit -m "feat(dashboard): D1 schema + wrangler config"
```

### Task 8: D1 ingest client (REST API, idempotent batches)

**Files:**
- Create: `dashboard/src/ingestD1.ts`
- Test: `dashboard/tests/ingestD1.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/ingestD1.test.ts
import { buildUpsertBatches } from '../src/ingestD1.js';

const row = {
  scanDate: '2026-06-29', ticker: 'ARM', region: 'US', sector: 'Semis',
  signal: 'pullback', rvol: 3.6, athPct: -22, dayPct: 2.8, stage2: 1,
  distPivot: null, score: 78, price: 343,
};

describe('buildUpsertBatches', () => {
  it('produces INSERT OR REPLACE with 12 params per row', () => {
    const batches = buildUpsertBatches([row as never], 100);
    expect(batches).toHaveLength(1);
    expect(batches[0].sql).toMatch(/INSERT OR REPLACE INTO lean_signals/);
    expect(batches[0].params).toHaveLength(12);
    expect(batches[0].params[1]).toBe('ARM');
  });
  it('splits into multiple batches by size', () => {
    const rows = Array.from({ length: 250 }, () => row);
    const batches = buildUpsertBatches(rows as never, 100);
    expect(batches).toHaveLength(3); // 100 + 100 + 50
    expect(batches[2].params).toHaveLength(50 * 12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx jest tests/ingestD1.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/src/ingestD1.ts
export interface Row {
  scanDate: string; ticker: string; region: string; sector: string; signal: string;
  rvol: number; athPct: number | null; dayPct: number; stage2: number;
  distPivot: number | null; score: number; price: number;
}
export interface Batch { sql: string; params: unknown[]; }

const COLS = '(scan_date,ticker,region,sector,signal,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price)';

export function buildUpsertBatches(rows: Row[], batchSize = 100): Batch[] {
  const batches: Batch[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params: unknown[] = [];
    for (const r of slice) {
      params.push(r.scanDate, r.ticker, r.region, r.sector, r.signal, r.rvol,
        r.athPct, r.dayPct, r.stage2, r.distPivot, r.score, r.price);
    }
    batches.push({ sql: `INSERT OR REPLACE INTO lean_signals ${COLS} VALUES ${placeholders}`, params });
  }
  return batches;
}

export interface D1Config { accountId: string; databaseId: string; apiToken: string; }

export async function ingestRows(rows: Row[], cfg: D1Config): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  for (const batch of buildUpsertBatches(rows)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: batch.sql, params: batch.params }),
    });
    if (!res.ok) throw new Error(`D1 ingest failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { success: boolean; errors?: unknown };
    if (!body.success) throw new Error(`D1 error: ${JSON.stringify(body.errors)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx jest tests/ingestD1.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ingestD1.ts dashboard/tests/ingestD1.test.ts
git commit -m "feat(dashboard): D1 ingest client with idempotent batches"
```

### Task 9: Seed script + initial backfill

**Files:**
- Create: `dashboard/scripts/seed.ts`

- [ ] **Step 1: Write the seed script**

```typescript
// dashboard/scripts/seed.ts
import fs from 'node:fs';
import path from 'node:path';
import { ingestRows, type Row } from '../src/ingestD1.js';

const RESULTS = process.argv[2] ?? path.resolve('../results');
const cfg = {
  accountId: process.env.CF_ACCOUNT_ID!,
  databaseId: process.env.D1_DATABASE_ID!,
  apiToken: process.env.CF_API_TOKEN!,
};
if (!cfg.accountId || !cfg.databaseId || !cfg.apiToken) {
  console.error('Set CF_ACCOUNT_ID, D1_DATABASE_ID, CF_API_TOKEN'); process.exit(2);
}

const files = fs.readdirSync(RESULTS).filter((f) => /^dashboard-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
let total = 0;
for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8')) as Row[];
  await ingestRows(rows, cfg);
  total += rows.length;
  console.log(`✓ ${f}: ${rows.length} rows`);
}
console.log(`Seeded ${total} rows from ${files.length} days`);
```

- [ ] **Step 2: Generate seed files (if not present from Task 5)**

Run: `cd .. && BACKTEST_MODE=1 npx tsx scripts/reconstruct-lean.ts --days 20`
Expected: `results/dashboard-2026-*.json` files exist (20).

- [ ] **Step 3: Run the seed against remote D1**

Run: `cd dashboard && CF_ACCOUNT_ID=... D1_DATABASE_ID=... CF_API_TOKEN=... npx tsx scripts/seed.ts ../results`
Expected: `✓` line per day; `Seeded ~2800 rows from 20 days`.

- [ ] **Step 4: Verify rows landed**

Run: `cd dashboard && npx wrangler d1 execute lean-radar --remote --command "SELECT scan_date, COUNT(*) FROM lean_signals GROUP BY scan_date ORDER BY scan_date"`
Expected: 20 dated rows with counts ~100-190 each.

- [ ] **Step 5: Commit**

```bash
git add dashboard/scripts/seed.ts
git commit -m "feat(dashboard): D1 seed script + 20-day backfill"
```

---

## Phase 3 — API (Pages Functions)

### Task 10: Query builder (pure)

**Files:**
- Create: `dashboard/src/query.ts`
- Test: `dashboard/tests/query.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/tests/query.test.ts
import { buildSignalsQuery, buildSummaryQuery } from '../src/query.js';

describe('buildSignalsQuery', () => {
  it('defaults to latest day when no params', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/scan_date = \(SELECT MAX\(scan_date\) FROM lean_signals\)/);
    expect(q.params).toEqual([]);
  });
  it('filters by date range', () => {
    const q = buildSignalsQuery({ from: '2026-06-01', to: '2026-06-29' });
    expect(q.sql).toMatch(/scan_date BETWEEN \? AND \?/);
    expect(q.params).toEqual(['2026-06-01', '2026-06-29']);
  });
});

describe('buildSummaryQuery', () => {
  it('groups counts by date', () => {
    const q = buildSummaryQuery({});
    expect(q.sql).toMatch(/GROUP BY scan_date/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx jest tests/query.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/src/query.ts
export interface Query { sql: string; params: unknown[]; }
export interface SignalParams { from?: string; to?: string; }

const SELECT = 'SELECT scan_date,ticker,region,sector,signal,rvol,ath_pct,day_pct,stage2,dist_pivot,score,price FROM lean_signals';

export function buildSignalsQuery(p: SignalParams): Query {
  if (p.from && p.to) {
    return { sql: `${SELECT} WHERE scan_date BETWEEN ? AND ? ORDER BY scan_date DESC, score DESC`, params: [p.from, p.to] };
  }
  return { sql: `${SELECT} WHERE scan_date = (SELECT MAX(scan_date) FROM lean_signals) ORDER BY score DESC`, params: [] };
}

export function buildSummaryQuery(_p: SignalParams): Query {
  return {
    sql: `SELECT scan_date,
      COUNT(*) AS total,
      SUM(signal='breakout') AS breakout,
      SUM(signal='highVolume') AS high_volume,
      SUM(signal='pullback') AS pullback,
      SUM(signal LIKE 'near%') AS near_all,
      SUM(score>=70) AS score70,
      SUM(score>=65) AS score65
      FROM lean_signals GROUP BY scan_date ORDER BY scan_date DESC`,
    params: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx jest tests/query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/query.ts dashboard/tests/query.test.ts
git commit -m "feat(dashboard): pure D1 query builders"
```

### Task 11: `/api/signals` and `/api/summary` Pages Functions

**Files:**
- Create: `dashboard/functions/api/signals.ts`, `dashboard/functions/api/summary.ts`

- [ ] **Step 1: Write `functions/api/signals.ts`**

```typescript
// dashboard/functions/api/signals.ts
import { buildSignalsQuery } from '../../src/query.js';

interface Env { DB: D1Database; }

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const q = buildSignalsQuery({ from, to });
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all();
  return Response.json(results);
};
```

- [ ] **Step 2: Write `functions/api/summary.ts`**

```typescript
// dashboard/functions/api/summary.ts
import { buildSummaryQuery } from '../../src/query.js';

interface Env { DB: D1Database; }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const q = buildSummaryQuery({});
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all();
  return Response.json(results);
};
```

- [ ] **Step 3: Run locally against remote D1 and curl**

Run (terminal A): `cd dashboard && npx wrangler pages dev public --d1 DB=lean-radar --remote`
Run (terminal B): `curl -s 'http://localhost:8788/api/signals' | head -c 400`
Expected: a JSON array of the latest day's rows (objects with `ticker`, `score`, etc.).
Run (terminal B): `curl -s 'http://localhost:8788/api/summary' | head -c 400`
Expected: a JSON array of per-day aggregate objects.

- [ ] **Step 4: Stop the dev server** (Ctrl-C in terminal A).

- [ ] **Step 5: Commit**

```bash
git add dashboard/functions/api/signals.ts dashboard/functions/api/summary.ts
git commit -m "feat(dashboard): /api/signals and /api/summary Pages Functions"
```

---

## Phase 4 — Front-end (RTL, 4 views)

### Task 12: HTML shell + styles

**Files:**
- Create: `dashboard/public/index.html`, `dashboard/public/styles.css`

- [ ] **Step 1: Create `dashboard/public/index.html`**

```html
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🪶 Lean Radar Dashboard</title>
  <link rel="stylesheet" href="styles.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
</head>
<body>
  <header>
    <h1>🪶 Lean Radar</h1>
    <div id="day-picker"></div>
  </header>
  <section id="cards"></section>
  <section id="chart-wrap"><canvas id="dist-chart" height="90"></canvas></section>
  <section id="controls">
    <input id="search" placeholder="חיפוש טיקר…">
    <select id="f-region"><option value="">כל האזורים</option><option>US</option><option>TASE</option><option>Foreign</option></select>
    <select id="f-signal"><option value="">כל הסיגנלים</option><option>breakout</option><option>highVolume</option><option>pullback</option><option>nearBreakout</option><option>nearHighVol</option><option>nearPullback</option></select>
    <label><input type="checkbox" id="f-stage2"> Stage2 בלבד</label>
  </section>
  <table id="grid"><thead></thead><tbody></tbody></table>
  <aside id="deepdive" hidden></aside>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `dashboard/public/styles.css`**

```css
:root{--ink:#1a1a1a;--line:#e2e2e2;--head:#1F3864;--accent:#0b6;}
*{box-sizing:border-box}
body{direction:rtl;font-family:Arial,"Arial Hebrew",sans-serif;color:var(--ink);margin:0;padding:16px;background:#fafafa}
header{display:flex;justify-content:space-between;align-items:center}
#cards{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px;text-align:center;min-width:90px}
.card .big{font-size:1.5rem;font-weight:700;display:block}
.card small{color:#666}
#controls{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
#controls input,#controls select{padding:6px 8px;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;background:#fff;font-size:.9rem}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:center;cursor:default}
th{background:var(--head);color:#fff;cursor:pointer;position:sticky;top:0}
tbody tr{cursor:pointer}
tbody tr:hover{background:#eef}
#deepdive{position:fixed;inset-inline-end:0;top:0;height:100%;width:320px;background:#fff;border-inline-start:2px solid var(--head);padding:18px;overflow:auto;box-shadow:-4px 0 12px rgba(0,0,0,.08)}
#chart-wrap{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;margin:10px 0}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/public/index.html dashboard/public/styles.css
git commit -m "feat(dashboard): RTL HTML shell + styles"
```

### Task 13: app.js — fetch, table (sort/filter/search), cards, chart, deep-dive

**Files:**
- Create: `dashboard/public/app.js`

- [ ] **Step 1: Create `dashboard/public/app.js`**

```javascript
const COLS = [
  ['ticker','טיקר'],['region','אזור'],['sector','סקטור'],['signal','סיגנל'],
  ['rvol','RVOL'],['ath_pct','ATH%'],['day_pct','יום%'],['stage2','S2'],
  ['dist_pivot','לפיבוט%'],['score','Score'],['price','מחיר'],
];
let rows = [], sortKey = 'score', sortDir = -1;

const $ = (s) => document.querySelector(s);
const num = (v) => (v == null ? '' : (typeof v === 'number' ? v : v));

async function load() {
  rows = await (await fetch('/api/signals')).json();
  const summary = await (await fetch('/api/summary')).json();
  renderCards(summary[0]);
  renderChart(rows);
  renderHead();
  renderBody();
}

function renderCards(s) {
  if (!s) return;
  const cards = [
    ['Total', s.total], ['📈 Breakout', s.breakout], ['🔥 HighVol', s.high_volume],
    ['📉 Pullback', s.pullback], ['⏳ Near', s.near_all], ['Score≥70', s.score70],
  ];
  $('#cards').innerHTML = cards.map(([l, v]) => `<div class="card"><span class="big">${v ?? 0}</span><small>${l}</small></div>`).join('');
  $('#day-picker').textContent = `📅 ${s.scan_date}`;
}

function renderChart(data) {
  const buckets = [0, 40, 55, 70, 85, 200];
  const labels = ['<40','40-55','55-70','70-85','85+'];
  const counts = labels.map(() => 0);
  for (const r of data) {
    for (let i = 0; i < buckets.length - 1; i++) {
      if (r.score >= buckets[i] && r.score < buckets[i + 1]) { counts[i]++; break; }
    }
  }
  if (window._chart) window._chart.destroy();
  window._chart = new Chart($('#dist-chart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'התפלגות Score', data: counts, backgroundColor: '#1F3864' }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}

function renderHead() {
  $('#grid thead').innerHTML = '<tr>' + COLS.map(([k, label]) =>
    `<th data-k="${k}">${label}${sortKey === k ? (sortDir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('') + '</tr>';
  $('#grid thead').querySelectorAll('th').forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; }
    renderHead(); renderBody();
  });
}

function visibleRows() {
  const q = $('#search').value.trim().toUpperCase();
  const reg = $('#f-region').value, sig = $('#f-signal').value, s2 = $('#f-stage2').checked;
  return rows.filter((r) =>
    (!q || r.ticker.includes(q)) && (!reg || r.region === reg) &&
    (!sig || r.signal === sig) && (!s2 || r.stage2 === 1))
    .sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x == null) return 1; if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
    });
}

function scoreColor(s) { return s >= 85 ? '#63BE7B' : s >= 70 ? '#A9D08E' : s >= 55 ? '#FFEB84' : '#F8C9C9'; }

function renderBody() {
  $('#grid tbody').innerHTML = visibleRows().map((r) => '<tr>' + COLS.map(([k]) => {
    let v = r[k];
    if (k === 'stage2') v = v ? '✓' : '';
    else if (k === 'rvol') v = v != null ? v.toFixed(1) + 'x' : '';
    else if (k === 'ath_pct' || k === 'day_pct' || k === 'dist_pivot') v = v != null ? v.toFixed(1) + '%' : '';
    const style = k === 'score' ? ` style="background:${scoreColor(r.score)}"` : '';
    return `<td${style}>${v ?? ''}</td>`;
  }).join('') + '</tr>').join('');
  $('#grid tbody').querySelectorAll('tr').forEach((tr, i) => tr.onclick = () => deepDive(visibleRows()[i]));
}

function deepDive(r) {
  const tv = `https://www.tradingview.com/symbols/${r.ticker.replace('.', '-')}/`;
  $('#deepdive').hidden = false;
  $('#deepdive').innerHTML = `
    <button onclick="document.getElementById('deepdive').hidden=true">✕</button>
    <h2>${r.ticker}</h2>
    <p>${r.sector} · ${r.region}</p>
    <ul>
      <li>סיגנל: ${r.signal}</li><li>Score: <b>${r.score}</b></li>
      <li>RVOL: ${r.rvol?.toFixed(1)}x</li><li>ATH: ${r.ath_pct?.toFixed(1)}%</li>
      <li>יום: ${r.day_pct?.toFixed(1)}%</li><li>Stage2: ${r.stage2 ? '✓' : '✗'}</li>
      <li>מחיר: ${r.price}</li>
    </ul>
    <a href="${tv}" target="_blank">פתח ב-TradingView ↗</a>`;
}

['#search', '#f-region', '#f-signal', '#f-stage2'].forEach((s) =>
  $(s).addEventListener('input', renderBody));
load();
```

- [ ] **Step 2: Verify end-to-end locally**

Run (terminal A): `cd dashboard && npx wrangler pages dev public --d1 DB=lean-radar --remote`
Open `http://localhost:8788` in a browser.
Expected: cards show the latest day's counts; chart renders; table lists rows sorted by Score desc; sorting a column header reorders; typing in search filters; clicking a row opens the deep-dive panel with a working TradingView link.

- [ ] **Step 3: Stop the dev server.**

- [ ] **Step 4: Commit**

```bash
git add dashboard/public/app.js
git commit -m "feat(dashboard): app.js — table/cards/chart/deep-dive"
```

---

## Phase 5 — Deploy, automation, access

### Task 14: Deploy to Cloudflare Pages + Cloudflare Access

**Files:**
- Create: `dashboard/README.md`

- [ ] **Step 1: Deploy**

Run: `cd dashboard && npx wrangler pages deploy public --project-name lean-dashboard`
Expected: prints a `*.pages.dev` URL. Open it — note that without the D1 binding bound to the Pages *project* it will 500 on `/api/*`.

- [ ] **Step 2: Bind D1 to the Pages project**

In the Cloudflare dashboard → Workers & Pages → `lean-dashboard` → Settings → Functions → D1 bindings: add binding `DB` → database `lean-radar` (Production). Redeploy if prompted.
Verify: open `https://lean-dashboard.pages.dev/api/summary` — returns JSON.

- [ ] **Step 3: Enable Cloudflare Access**

In Cloudflare Zero Trust → Access → Applications → Add → Self-hosted: domain = `lean-dashboard.pages.dev`. Policy: Allow, emails = `kobi@leadslords.com` (+ friend's email). Save.
Verify: opening the URL in a private window prompts for email OTP.

- [ ] **Step 4: Write `dashboard/README.md`**

```markdown
# Lean Radar Dashboard

Cloudflare Pages app over D1 (`lean-radar`). Data from the Lean Radar daily scan.

## Secrets (GitHub Actions)
- `CF_API_TOKEN` — Cloudflare token, permission: Account › D1 › Edit
- `CF_ACCOUNT_ID` — Cloudflare account id
- `D1_DATABASE_ID` — `lean-radar` database id (from `wrangler d1 create`)

## Schema:  `wrangler d1 execute lean-radar --remote --file schema.sql`
## Seed:    `npx tsx scripts/seed.ts ../results`
## Deploy:  `wrangler pages deploy public --project-name lean-dashboard`
## Access:  Cloudflare Zero Trust → Access → email allowlist (Kobi + friend).
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/README.md
git commit -m "docs(dashboard): deploy + Cloudflare Access runbook"
```

### Task 15: Daily D1 ingest step in GHA + thin Telegram pointer

**Files:**
- Modify: `.github/workflows/daily-scan-lean.yml`

- [ ] **Step 1: Add the ingest step** after the `Run Lean Radar` step:

```yaml
      - name: Ingest dashboard rows to D1
        if: success()
        env:
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}
        run: |
          cd dashboard && npm ci
          npx tsx scripts/seed.ts ../results
```
(The seed script ingests every `dashboard-{date}.json` in `results/`; on the live runner only the current day's file is present, so it ingests just today — idempotent via `INSERT OR REPLACE`.)

- [ ] **Step 2: Add the thin Telegram pointer** after the ingest step:

```yaml
      - name: Telegram dashboard pointer
        if: success()
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          DATE=$(ls results/dashboard-*.json | sort | tail -1 | sed 's/.*dashboard-//;s/.json//')
          HI=$(node -e "const r=require('./results/dashboard-'+process.argv[1]+'.json');console.log(r.filter(x=>x.score>=70).length)" "$DATE")
          TOT=$(node -e "const r=require('./results/dashboard-'+process.argv[1]+'.json');console.log(r.length)" "$DATE")
          curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
            --data-urlencode "text=🪶 Lean ${DATE}: ${HI} בשכנוע גבוה · ${TOT} סיגנלים → https://lean-dashboard.pages.dev"
```

- [ ] **Step 3: Validate the workflow YAML**

Run: `npx --yes yaml-lint .github/workflows/daily-scan-lean.yml` (or `python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/daily-scan-lean.yml'))"`)
Expected: parses with no error.

- [ ] **Step 4: Trigger a manual run to verify end-to-end**

Run: `gh workflow run daily-scan-lean.yml --ref stable`
Then: `gh run watch`
Expected: green run; D1 has today's rows (`wrangler d1 execute lean-radar --remote --command "SELECT MAX(scan_date), COUNT(*) FROM lean_signals WHERE scan_date=(SELECT MAX(scan_date) FROM lean_signals)"`); Telegram pointer message received.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/daily-scan-lean.yml
git commit -m "feat(dashboard): daily D1 ingest + thin Telegram pointer"
```

---

## Self-Review notes (resolved)

- **Spec coverage:** D1 schema (Task 7) · ingestion REST+idempotent (Task 8) · seed/backfill (Task 9) · 4 views table/cards/chart/deep-dive (Tasks 12-13) · Cloudflare Access (Task 14) · daily GHA ingest + thin Telegram pointer (Task 15) · scoring documented (Task 2) · RTL (Task 12). All spec sections mapped.
- **Type consistency:** `Row` field names (`scanDate/athPct/dayPct/distPivot`) are consistent across `dashboardRows.ts`, `ingestD1.ts`; D1 columns use snake_case (`ath_pct` …) consistently in `schema.sql`, `buildUpsertBatches`, `query.ts`, and `app.js` (which reads the snake_case API rows). `buildSignalsQuery`/`buildSummaryQuery` names match between `query.ts` and the Pages Functions.
- **No placeholders:** every code step is complete; the only intentional manual values are the real `database_id` (Task 7) and Cloudflare dashboard UI steps (Task 14), which cannot be scripted.
```
