#!/usr/bin/env npx tsx
/**
 * RVOL-Acceleration Study — does volume EXPANDING into the entry beat volume
 * that's merely elevated-but-flat? Classic O'Neil/Minervini principle: the
 * breakout bar should show volume surging, not just above average.
 *
 * Method: for each historical BUY/WATCH flag, fetch Yahoo daily volume, compute
 *   - rvolToday   = vol[d] / avg(vol[d-63..d-1])
 *   - rvol3dAgo   = vol[d-3] / avg(vol[d-66..d-4])
 *   - accel       = rvolToday - rvol3dAgo   (>0 = expanding)
 *   - volTrend    = slope of last-3-day volume / avg
 * Then bucket forward returns by acceleration sign/magnitude.
 *
 * Usage: npx tsx scripts/rvol-acceleration-study.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dirname, '..', 'results');

interface Flag {
    action: string;
    rvol: number;
    date: string;
    ticker: string;
    forward21d: number | null;
    peak21d: number | null;
    forwardNow: number | null;
    isWin: boolean;
    outcome: string;
}

const file = fs.readdirSync(RESULTS).filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop()!;
const data = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8')) as { flags: Flag[] };
// Only actionable entries — the question is about ENTRY precision.
const flags = data.flags.filter(
    (f) => (f.action === 'BUY' || f.action === 'WATCH') && f.outcome !== 'no_data' && f.peak21d != null
);
console.log(`📂 ${file} — ${flags.length} actionable flags\n`);

const uniqueTickers = [...new Set(flags.map((f) => f.ticker))];
console.log(`🔎 Fetching Yahoo volume for ${uniqueTickers.length} tickers...`);

interface Series { ts: number[]; vol: number[] }
const cache = new Map<string, Series>();
const limit = pLimit(8);
let done = 0;
await Promise.all(
    uniqueTickers.map((t) =>
        limit(async () => {
            try {
                const r = await fetch(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=2y`,
                    { headers: { 'User-Agent': 'Mozilla/5.0' } }
                );
                if (r.ok) {
                    const j = (await r.json()) as {
                        chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ volume?: (number | null)[] }> } }> };
                    };
                    const res = j?.chart?.result?.[0];
                    const ts = res?.timestamp ?? [];
                    const vol = res?.indicators?.quote?.[0]?.volume ?? [];
                    const cts: number[] = [];
                    const cvol: number[] = [];
                    for (let i = 0; i < ts.length; i++) {
                        if (vol[i] != null && vol[i]! > 0) {
                            cts.push(ts[i]!);
                            cvol.push(vol[i]!);
                        }
                    }
                    if (cts.length > 70) cache.set(t, { ts: cts, vol: cvol });
                }
            } catch {
                /* skip */
            }
            done++;
            if (done % 40 === 0) process.stderr.write(`  ${done}/${uniqueTickers.length}\n`);
        })
    )
);
console.log(`  ✓ cached ${cache.size}/${uniqueTickers.length}\n`);

/** RVOL at index i = vol[i] / mean(vol[i-63..i-1]). */
function rvolAt(s: Series, i: number): number | null {
    if (i < 64) return null;
    let sum = 0;
    for (let k = i - 63; k < i; k++) sum += s.vol[k]!;
    const avg = sum / 63;
    return avg > 0 ? s.vol[i]! / avg : null;
}

// Annotate each flag with acceleration
interface Enriched extends Flag {
    accel: number | null;
}
const enriched: Enriched[] = [];
for (const f of flags) {
    const s = cache.get(f.ticker);
    if (!s) {
        enriched.push({ ...f, accel: null });
        continue;
    }
    const t0 = new Date(f.date + 'T00:00:00Z').getTime() / 1000;
    let idx = -1;
    for (let i = 0; i < s.ts.length; i++) {
        if (s.ts[i]! >= t0) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        enriched.push({ ...f, accel: null });
        continue;
    }
    const rNow = rvolAt(s, idx);
    const r3 = rvolAt(s, idx - 3);
    enriched.push({ ...f, accel: rNow != null && r3 != null ? rNow - r3 : null });
}

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
    if (!s.n) return;
    console.log(
        `${label.padEnd(28)} ${String(s.n).padStart(5)} ${(s.win + '%').padStart(6)} ${(s.peak + '%').padStart(8)} ${(s.now + '%').padStart(8)}`
    );
}

const withAccel = enriched.filter((f) => f.accel != null);
console.log(`📊 RVOL ACCELERATION vs forward returns (n=${withAccel.length} with vol data)`);
console.log(`${'Bucket'.padEnd(28)} ${'n'.padStart(5)} ${'WIN%'.padStart(6)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(8)}`);
console.log('─'.repeat(60));
row('Expanding (accel > 0)', withAccel.filter((f) => f.accel! > 0));
row('Flat/declining (accel ≤ 0)', withAccel.filter((f) => f.accel! <= 0));
console.log('─'.repeat(60));
row('Strong expand (accel ≥ +1)', withAccel.filter((f) => f.accel! >= 1));
row('Mild expand (0 to +1)', withAccel.filter((f) => f.accel! > 0 && f.accel! < 1));
row('Mild decline (-1 to 0)', withAccel.filter((f) => f.accel! > -1 && f.accel! <= 0));
row('Strong decline (≤ -1)', withAccel.filter((f) => f.accel! <= -1));

// Cross with RVOL level: does acceleration add signal ON TOP of high RVOL?
console.log(`\n📊 ACCELERATION within RVOL≥3 (does it add to the strongest dial?)`);
console.log(`${'Bucket'.padEnd(28)} ${'n'.padStart(5)} ${'WIN%'.padStart(6)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(8)}`);
console.log('─'.repeat(60));
const hi = withAccel.filter((f) => f.rvol >= 3);
row('RVOL≥3 + expanding', hi.filter((f) => f.accel! > 0));
row('RVOL≥3 + flat/declining', hi.filter((f) => f.accel! <= 0));

console.log('\n✅ Study complete.');
