#!/usr/bin/env npx tsx
/**
 * Earnings-Proximity Study — do entries with an imminent earnings report
 * underperform (gap risk), and is a post-earnings entry better (O'Neil's
 * Power Earnings Gap) than a pre-earnings one?
 *
 * Method: for each actionable historical flag (BUY/WATCH), fetch the ticker's
 * Finnhub earnings calendar, find the earnings date NEAREST the signal, and
 * bucket forward returns by:
 *   - daysToEarnings  (next report AFTER signal)  → pre-earnings gap risk
 *   - daysSinceEarnings (last report BEFORE signal) → post-earnings drift / PEG
 *
 * Usage: FINNHUB from .env. npx tsx scripts/earnings-proximity-study.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dirname, '..', 'results');
const KEY = process.env.FINNHUB_API_KEY!;
if (!KEY) throw new Error('FINNHUB_API_KEY missing');

interface Flag {
    action: string;
    date: string;
    ticker: string;
    peak21d: number | null;
    forwardNow: number | null;
    isWin: boolean;
    outcome: string;
}

const file = fs.readdirSync(RESULTS).filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop()!;
const data = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8')) as { flags: Flag[] };
const flags = data.flags.filter((f) => (f.action === 'BUY' || f.action === 'WATCH') && f.outcome !== 'no_data' && f.peak21d != null);
console.log(`📂 ${file} — ${flags.length} actionable flags\n`);

const tickers = [...new Set(flags.map((f) => f.ticker))];
console.log(`🔎 Fetching Finnhub earnings calendar for ${tickers.length} tickers...`);

// earnings report dates per ticker (sorted asc)
const earningsDates = new Map<string, string[]>();
const limit = pLimit(4); // gentle on the 60/min free tier
let done = 0;
await Promise.all(
    tickers.map((t) =>
        limit(async () => {
            try {
                const r = await fetch(
                    `https://finnhub.io/api/v1/calendar/earnings?from=2025-08-01&to=2026-08-01&symbol=${encodeURIComponent(t)}&token=${KEY}`
                );
                if (r.ok) {
                    const j = (await r.json()) as { earningsCalendar?: Array<{ date: string }> };
                    const dates = (j.earningsCalendar ?? []).map((e) => e.date).sort();
                    if (dates.length) earningsDates.set(t, dates);
                }
            } catch {
                /* skip */
            }
            done++;
            if (done % 30 === 0) process.stderr.write(`  ${done}/${tickers.length}\n`);
            await new Promise((res) => setTimeout(res, 60)); // ~16/s ceiling safety
        })
    )
);
console.log(`  ✓ earnings data for ${earningsDates.size}/${tickers.length} tickers\n`);

function daysBetween(a: string, b: string): number {
    return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

interface Enriched extends Flag {
    daysToEarnings: number | null; // next report on/after signal
    daysSinceEarnings: number | null; // last report before signal
}
const enriched: Enriched[] = flags.map((f) => {
    const ds = earningsDates.get(f.ticker);
    if (!ds) return { ...f, daysToEarnings: null, daysSinceEarnings: null };
    let next: number | null = null;
    let prev: number | null = null;
    for (const d of ds) {
        const delta = daysBetween(f.date, d);
        if (delta >= 0 && (next == null || delta < next)) next = delta;
        if (delta < 0 && (prev == null || -delta < prev)) prev = -delta;
    }
    return { ...f, daysToEarnings: next, daysSinceEarnings: prev };
});

const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
};
function stats(sub: Enriched[]) {
    if (!sub.length) return { n: 0, win: '0', peak: '0', now: '0' };
    const w = sub.filter((f) => f.isWin).length;
    return {
        n: sub.length,
        win: ((w / sub.length) * 100).toFixed(0),
        peak: (median(sub.map((f) => f.peak21d ?? 0)) * 100).toFixed(1),
        now: (median(sub.map((f) => f.forwardNow ?? 0)) * 100).toFixed(1),
    };
}
function row(label: string, sub: Enriched[]) {
    const s = stats(sub);
    console.log(`${label.padEnd(30)} ${String(s.n).padStart(5)} ${(s.win + '%').padStart(6)} ${(s.peak + '%').padStart(8)} ${(s.now + '%').padStart(8)}`);
}

const withData = enriched.filter((f) => f.daysToEarnings != null || f.daysSinceEarnings != null);
console.log(`📊 PRE-EARNINGS gap risk — forward returns by days-TO next report (n=${withData.length})`);
console.log(`${'Bucket'.padEnd(30)} ${'n'.padStart(5)} ${'WIN%'.padStart(6)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(8)}`);
console.log('─'.repeat(62));
row('earnings in 0–3 days', enriched.filter((f) => f.daysToEarnings != null && f.daysToEarnings <= 3));
row('earnings in 4–7 days', enriched.filter((f) => f.daysToEarnings != null && f.daysToEarnings >= 4 && f.daysToEarnings <= 7));
row('earnings in 8–21 days', enriched.filter((f) => f.daysToEarnings != null && f.daysToEarnings >= 8 && f.daysToEarnings <= 21));
row('earnings >21 days away', enriched.filter((f) => f.daysToEarnings != null && f.daysToEarnings > 21));

console.log(`\n📊 POST-EARNINGS drift (PEG) — forward returns by days-SINCE last report`);
console.log(`${'Bucket'.padEnd(30)} ${'n'.padStart(5)} ${'WIN%'.padStart(6)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(8)}`);
console.log('─'.repeat(62));
row('within 3 days after report', enriched.filter((f) => f.daysSinceEarnings != null && f.daysSinceEarnings <= 3));
row('4–10 days after', enriched.filter((f) => f.daysSinceEarnings != null && f.daysSinceEarnings >= 4 && f.daysSinceEarnings <= 10));
row('11–30 days after', enriched.filter((f) => f.daysSinceEarnings != null && f.daysSinceEarnings >= 11 && f.daysSinceEarnings <= 30));
row('>30 days after (mid-cycle)', enriched.filter((f) => f.daysSinceEarnings != null && f.daysSinceEarnings > 30));

console.log(`\n📊 BASELINE (all actionable)`);
console.log('─'.repeat(62));
row('all', enriched);

// Save
fs.writeFileSync(
    path.join(RESULTS, `earnings-proximity-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: file, tickersWithData: earningsDates.size, enriched }, null, 2)
);
console.log('\n✅ Study complete.');
