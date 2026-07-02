// dashboard/functions/api/signals.ts
import {
  buildSignalsQuery,
  buildRecentDatesQuery,
  buildHistoryRowsQuery,
} from '../../src/query.js';
import { enrichRows, type HistoryRow } from '../../src/enrich.js';

interface Env { DB: D1Database; }

interface DayRow { scan_date: string; ticker: string; score: number; signals: string; [k: string]: unknown; }

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const q = buildSignalsQuery({ from, to });
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<DayRow>();
  const dayRows = (results ?? []) as DayRow[];

  if (dayRows.length === 0) return Response.json([]);

  try {
    // The dashboard's displayed rows are a single day; enrich against that day.
    const targetDate = dayRows.reduce((m, r) => (r.scan_date > m ? r.scan_date : m), dayRows[0].scan_date);

    const dq = buildRecentDatesQuery(targetDate, 12);
    const dates = await env.DB.prepare(dq.sql).bind(...dq.params).all<{ scan_date: string }>();
    const dateSeq = (dates.results ?? []).map((d) => d.scan_date);

    const hq = buildHistoryRowsQuery(dateSeq);
    const hist = await env.DB.prepare(hq.sql).bind(...hq.params).all<HistoryRow>();
    const historyRows = (hist.results ?? []) as HistoryRow[];

    return Response.json(enrichRows(dayRows, historyRows, dateSeq));
  } catch {
    // Resilient fallback: return un-enriched day rows if enrichment fails.
    return Response.json(dayRows);
  }
};
