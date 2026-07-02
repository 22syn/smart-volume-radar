// dashboard/tests/enrich.test.ts
import { enrichRows } from '../src/enrich.js';

// dateSeq is scan_dates DESC (most recent first)
const D3 = '2026-06-03';
const D2 = '2026-06-02';
const D1 = '2026-06-01';
const dateSeq = [D3, D2, D1];

describe('enrichRows — streak', () => {
  it('counts consecutive days ending at the row date', () => {
    const history = [
      { scan_date: D1, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 60 },
      { scan_date: D2, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 62 },
      { scan_date: D3, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 64 },
    ];
    const rows = [{ scan_date: D3, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 64 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.streak).toBe(3);
  });

  it('resets on a gap (absent day breaks the streak)', () => {
    // AAA present D3 and D1 but absent D2 → streak ending at D3 is just 1
    const history = [
      { scan_date: D1, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 60 },
      { scan_date: D3, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 64 },
    ];
    const rows = [{ scan_date: D3, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 64 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.streak).toBe(1);
  });
});

describe('enrichRows — graduated_from', () => {
  it('sets prev primary signal when prev all-near and today real', () => {
    const history = [
      { scan_date: D2, ticker: 'BBB', signal: 'nearBreakout', signals: 'nearBreakout', score: 50 },
      { scan_date: D3, ticker: 'BBB', signal: 'breakout', signals: 'breakout', score: 55 },
    ];
    const rows = [{ scan_date: D3, ticker: 'BBB', signal: 'breakout', signals: 'breakout', score: 55 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.graduated_from).toBe('nearBreakout');
  });

  it('is null when prev day already had a real signal', () => {
    const history = [
      { scan_date: D2, ticker: 'BBB', signal: 'breakout', signals: 'breakout', score: 50 },
      { scan_date: D3, ticker: 'BBB', signal: 'breakout', signals: 'breakout', score: 55 },
    ];
    const rows = [{ scan_date: D3, ticker: 'BBB', signal: 'breakout', signals: 'breakout', score: 55 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.graduated_from).toBeNull();
  });

  it('is null when today has no real signal', () => {
    const history = [
      { scan_date: D2, ticker: 'BBB', signal: 'nearBreakout', signals: 'nearBreakout', score: 50 },
      { scan_date: D3, ticker: 'BBB', signal: 'nearHighVol', signals: 'nearHighVol', score: 52 },
    ];
    const rows = [{ scan_date: D3, ticker: 'BBB', signal: 'nearHighVol', signals: 'nearHighVol', score: 52 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.graduated_from).toBeNull();
  });
});

describe('enrichRows — score_delta', () => {
  it('is today minus prev day score', () => {
    const history = [
      { scan_date: D2, ticker: 'CCC', signal: 'breakout', signals: 'breakout', score: 40 },
      { scan_date: D3, ticker: 'CCC', signal: 'breakout', signals: 'breakout', score: 58 },
    ];
    const rows = [{ scan_date: D3, ticker: 'CCC', signal: 'breakout', signals: 'breakout', score: 58 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.score_delta).toBe(18);
  });

  it('is null when the ticker was absent the previous trading day', () => {
    const history = [
      { scan_date: D3, ticker: 'CCC', signal: 'breakout', signals: 'breakout', score: 58 },
    ];
    const rows = [{ scan_date: D3, ticker: 'CCC', signal: 'breakout', signals: 'breakout', score: 58 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.score_delta).toBeNull();
  });
});

describe('enrichRows — brand-new ticker', () => {
  it('streak 1, score_delta null, graduated_from null', () => {
    const history = [
      { scan_date: D3, ticker: 'NEW', signal: 'breakout', signals: 'breakout', score: 70 },
    ];
    const rows = [{ scan_date: D3, ticker: 'NEW', signal: 'breakout', signals: 'breakout', score: 70 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.streak).toBe(1);
    expect(out.score_delta).toBeNull();
    expect(out.graduated_from).toBeNull();
  });
});

describe('enrichRows — purity & multi-signal rank', () => {
  it('does not mutate input rows and returns new objects', () => {
    const rows = [{ scan_date: D3, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 64 }];
    const history = [{ scan_date: D3, ticker: 'AAA', signal: 'breakout', signals: 'breakout', score: 64 }];
    const out = enrichRows(rows, history, dateSeq);
    expect(out[0]).not.toBe(rows[0]);
    expect((rows[0] as Record<string, unknown>).streak).toBeUndefined();
  });

  it('rank uses any real signal within a comma-joined csv (graduation via highVolume)', () => {
    const history = [
      { scan_date: D2, ticker: 'MIX', signal: 'nearBreakout', signals: 'nearBreakout,nearHighVol', score: 50 },
      { scan_date: D3, ticker: 'MIX', signal: 'nearBreakout', signals: 'nearBreakout,highVolume', score: 55 },
    ];
    const rows = [{ scan_date: D3, ticker: 'MIX', signal: 'nearBreakout', signals: 'nearBreakout,highVolume', score: 55 }];
    const [out] = enrichRows(rows, history, dateSeq);
    expect(out.graduated_from).toBe('nearBreakout');
  });

  it('handles a row whose date is not in dateSeq (defensive: streak 0/1, deltas null)', () => {
    const rows = [{ scan_date: '2099-01-01', ticker: 'ZZZ', signal: 'breakout', signals: 'breakout', score: 10 }];
    const [out] = enrichRows(rows, [], dateSeq);
    expect(out.score_delta).toBeNull();
    expect(out.graduated_from).toBeNull();
    expect(out.streak).toBe(0);
  });
});
