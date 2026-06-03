#!/usr/bin/env npx tsx
/**
 * ADR% Study (G1) — does Average Daily Range predict forward returns?
 * Qullamaggie's thesis: only stocks with enough daily range (ADR% > ~4%) can
 * produce the 20%+ moves the strategy targets; low-range names structurally can't.
 *
 * ADR% (Qullamaggie definition) = 100 × mean_{last 20d}( high_i / low_i − 1 )
 *
 * For each actionable historical flag (BUY/WATCH), compute ADR% at the signal
 * date and bucket forward returns. If high-ADR entries win more / move bigger,
 * ADR% becomes a TD-25 dial (and possibly a soft gate).
 *
 * Usage: npx tsx scripts/adr-study.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dirname, '..', 'results');

interface Flag {
    action: string;
    date: string;
    ticker: string;
    peak21d: number | null;
    forwardNow: number | null;
    isWin: boolean;
    outcome: string;
    championScore: number;
    momentumLevel: string;
    rvol: number;
    distributionDays: number;
}

const file = fs.readdirSync(RESULTS).filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop()!;
const data = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8')) as { flags: Flag[] };
const flags = data.flags.filter((f) => (f.action === 'BUY' || f.action === 'WATCH') && f.outcome !== 'no_data' && f.peak21d != null);
console.log(`📂 ${file} — ${flags.length} actionable flags\n`);

const tickers = [...new Set(flags.map((f) => f.ticker))];
console.log(`🔎 Fetching Yahoo OHLC for ${tickers.length} tickers...`);

interface Series { ts: number[]; high: number[]; low: number[] }
const cache = new Map<string, Series>();
const limit = pLimit(8);
let done = 0;
await Promise.all(
    tickers.map((t) =>
        limit(async () => {
            try {
                const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=2y`, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                });
                if (r.ok) {
                    const j = (await r.json()) as {
                        chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ high?: (number | null)[]; low?: (number | null)[] }> } }> };
                    };
                    const res = j?.chart?.result?.[0];
                    const ts = res?.timestamp ?? [];
                    const hi = res?.indicators?.quote?.[0]?.high ?? [];
                    const lo = res?.indicators?.quote?.[0]?.low ?? [];
                    const cts: number[] = [], chi: number[] = [], clo: number[] = [];
                    for (let i = 0; i < ts.length; i++) {
                        if (hi[i] != null && lo[i] != null && lo[i]! > 0) { cts.push(ts[i]!); chi.push(hi[i]!); clo.push(lo[i]!); }
                    }
                    if (cts.length > 40) cache.set(t, { ts: cts, high: chi, low: clo });
                }
            } catch { /* skip */ }
            done++;
            if (done % 40 === 0) process.stderr.write(`  ${done}/${tickers.length}\n`);
        })
    )
);
console.log(`  ✓ cached ${cache.size}/${tickers.length}\n`);

/** ADR% at index i = 100 × mean_{i-19..i}( high/low − 1 ). */
function adrAt(s: Series, i: number): number | null {
    if (i < 20) return null;
    let sum = 0;
    for (let k = i - 19; k <= i; k++) sum += s.high[k]! / s.low[k]! - 1;
    return (sum / 20) * 100;
}

interface Enriched extends Flag { adr: number | null }
const enriched: Enriched[] = flags.map((f) => {
    const s = cache.get(f.ticker);
    if (!s) return { ...f, adr: null };
    const t0 = new Date(f.date + 'T00:00:00Z').getTime() / 1000;
    let idx = -1;
    for (let i = 0; i < s.ts.length; i++) if (s.ts[i]! >= t0) { idx = i; break; }
    return { ...f, adr: idx >= 0 ? adrAt(s, idx) : null };
});

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
function stats(sub: Enriched[]) {
    if (!sub.length) return { n: 0, win: '0', peak: '0', now: '0' };
    const w = sub.filter((f) => f.isWin).length;
    return { n: sub.length, win: ((w / sub.length) * 100).toFixed(0), peak: (median(sub.map((f) => f.peak21d ?? 0)) * 100).toFixed(1), now: (median(sub.map((f) => f.forwardNow ?? 0)) * 100).toFixed(1) };
}
function row(label: string, sub: Enriched[]) {
    const s = stats(sub);
    if (!s.n) return;
    console.log(`${label.padEnd(24)} ${String(s.n).padStart(5)} ${(s.win + '%').padStart(6)} ${(s.peak + '%').padStart(8)} ${(s.now + '%').padStart(8)}`);
}

const wa = enriched.filter((f) => f.adr != null);
console.log(`📊 ADR% vs forward returns (n=${wa.length})`);
console.log(`${'ADR% bucket'.padEnd(24)} ${'n'.padStart(5)} ${'WIN%'.padStart(6)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(8)}`);
console.log('─'.repeat(56));
row('< 3%', wa.filter((f) => f.adr! < 3));
row('3–4%', wa.filter((f) => f.adr! >= 3 && f.adr! < 4));
row('4–6%', wa.filter((f) => f.adr! >= 4 && f.adr! < 6));
row('6–9%', wa.filter((f) => f.adr! >= 6 && f.adr! < 9));
row('≥ 9%', wa.filter((f) => f.adr! >= 9));
console.log('─'.repeat(56));
row('ALL', wa);

// Does ADR add to TD-25 A+/A? (full + rvol3-10 + score≥90 + dist≤2)
const grade = (f: Enriched) => {
    let d = 0;
    if (f.momentumLevel === 'full' || f.momentumLevel === 'recovery') d++;
    if (f.rvol >= 3 && f.rvol < 10) d++;
    if (f.championScore >= 90) d++;
    if ((f.distributionDays ?? 0) <= 2) d++;
    return d;
};
const top = wa.filter((f) => grade(f) >= 3); // A+/A
console.log(`\n📊 ADR within A+/A entries (does it sharpen the best tier? n=${top.length})`);
console.log('─'.repeat(56));
row('A+/A + ADR ≥ 5%', top.filter((f) => f.adr! >= 5));
row('A+/A + ADR < 5%', top.filter((f) => f.adr! < 5));

fs.writeFileSync(path.join(RESULTS, `adr-study-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: file, enriched }, null, 2));
console.log('\n✅ Study complete.');
