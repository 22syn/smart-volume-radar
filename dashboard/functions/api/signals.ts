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
