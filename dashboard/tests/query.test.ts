// dashboard/tests/query.test.ts
import {
  buildSignalsQuery,
  buildSummaryQuery,
  buildRecentDatesQuery,
  buildHistoryRowsQuery,
} from '../src/query.js';

describe('buildSignalsQuery', () => {
  it('defaults to latest day when no params', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/scan_date = \(SELECT MAX\(scan_date\) FROM lean_signals\)/);
    expect(q.params).toEqual([]);
  });
  it('selects the signals + signal_count columns', () => {
    const q = buildSignalsQuery({});
    expect(q.sql).toMatch(/signals,signal_count/);
  });
  it('filters by date range', () => {
    const q = buildSignalsQuery({ from: '2026-06-01', to: '2026-06-29' });
    expect(q.sql).toMatch(/scan_date BETWEEN \? AND \?/);
    expect(q.params).toEqual(['2026-06-01', '2026-06-29']);
  });
});

describe('buildRecentDatesQuery', () => {
  it('selects distinct scan_dates on/before day, DESC, with limit', () => {
    const q = buildRecentDatesQuery('2026-06-03', 12);
    expect(q.sql).toBe(
      'SELECT DISTINCT scan_date FROM lean_signals WHERE scan_date <= ? ORDER BY scan_date DESC LIMIT ?',
    );
    expect(q.params).toEqual(['2026-06-03', 12]);
  });
  it('defaults limit to 12', () => {
    const q = buildRecentDatesQuery('2026-06-03');
    expect(q.params).toEqual(['2026-06-03', 12]);
  });
});

describe('buildHistoryRowsQuery', () => {
  it('emits one placeholder per date and passes dates as params', () => {
    const q = buildHistoryRowsQuery(['2026-06-03', '2026-06-02', '2026-06-01']);
    expect(q.sql).toBe(
      'SELECT scan_date,ticker,signal,signals,score FROM lean_signals WHERE scan_date IN (?,?,?)',
    );
    expect(q.params).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
  });
  it('produces valid SQL and no params for an empty date list', () => {
    const q = buildHistoryRowsQuery([]);
    expect(q.sql).toMatch(/WHERE scan_date IN \(SELECT NULL WHERE 0\)/);
    expect(q.params).toEqual([]);
  });
});

describe('buildSummaryQuery', () => {
  it('groups counts by date', () => {
    const q = buildSummaryQuery({});
    expect(q.sql).toMatch(/GROUP BY scan_date/);
  });
});
