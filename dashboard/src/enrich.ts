// dashboard/src/enrich.ts
// Pure cross-day enrichment computed from lean_signals history.

export interface HistoryRow {
  scan_date: string;
  ticker: string;
  signal: string;
  signals: string;
  score: number;
}

export interface EnrichedRow {
  streak: number;
  graduated_from: string | null;
  score_delta: number | null;
  [key: string]: unknown;
}

const REAL = ['breakout', 'highVolume', 'pullback'];

/** rank(signalsCsv): 1 if the csv contains any real signal, else 0. */
function rank(signalsCsv: unknown): 0 | 1 {
  const csv = typeof signalsCsv === 'string' ? signalsCsv : '';
  return REAL.some((r) => csv.includes(r)) ? 1 : 0;
}

type Presence = Record<string, Record<string, HistoryRow>>;

/**
 * Enrich each display row with cross-day derived fields.
 * @param rows       the day's rows to enrich (returned as new objects)
 * @param historyRows rows for the recent date window (scan_date,ticker,signal,signals,score)
 * @param dateSeq    scan_dates DESC (most recent first)
 */
export function enrichRows<T extends { scan_date: string; ticker: string; score: number; signals: string }>(
  rows: T[],
  historyRows: HistoryRow[],
  dateSeq: string[],
): (T & EnrichedRow)[] {
  // presence[date][ticker] = { signal, signals, score, ... }
  const presence: Presence = {};
  for (const h of historyRows) {
    (presence[h.scan_date] ??= {})[h.ticker] = h;
  }

  return rows.map((row) => {
    const D = row.scan_date;
    const T = row.ticker;
    const idx = dateSeq.indexOf(D);

    // streak: walk backwards (toward older dates = higher index) from idx.
    let streak = 0;
    if (idx !== -1) {
      for (let j = idx; j < dateSeq.length; j++) {
        if (presence[dateSeq[j]]?.[T]) streak++;
        else break;
      }
    }

    // previous trading day = the next-older date in the DESC sequence.
    const prevDate = idx !== -1 ? dateSeq[idx + 1] : undefined;
    const prev = prevDate ? presence[prevDate]?.[T] : undefined;

    const score_delta = prev ? row.score - prev.score : null;
    const graduated_from =
      prev && rank(prev.signals) === 0 && rank(row.signals) === 1 ? prev.signal : null;

    return { ...row, streak, graduated_from, score_delta };
  });
}
