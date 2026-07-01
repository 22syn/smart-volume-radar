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
