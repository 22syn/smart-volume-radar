// dashboard/functions/api/summary.ts
import { buildSummaryQuery } from '../../src/query.js';

interface Env { DB: D1Database; }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const q = buildSummaryQuery({});
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all();
  return Response.json(results);
};
