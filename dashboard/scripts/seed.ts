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
