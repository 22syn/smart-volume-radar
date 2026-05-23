#!/usr/bin/env npx tsx
/**
 * Precision analysis — for every flag the radar issued in the 63-td window,
 * fetch the forward returns and classify the outcome. Then pivot by every
 * dimension we have (action, sector, score band, momentum level, criteria
 * that fired) to see which indicators correlate with success vs failure.
 *
 * Input: results/radar-reconstructed-{date}.json (from reconstruct-radar.ts,
 *         must be the enriched schema with FlagRecord objects).
 *
 * Output: results/precision-analysis-{date}.json + stdout summary.
 *
 * Outcome buckets (per flag, measured over forward 21 trading days from D):
 *   • Strong success: peak21d ≥ +15%
 *   • Weak success:   peak21d in [+5%, +15%)
 *   • Neutral:        peak21d in [0%, +5%)
 *   • Failed:         peak21d < 0% (never went up)
 *   • Reversal:       peak21d ≥ +5% BUT forward return @ end-of-data ≤ −10%
 *                      (it popped then collapsed)
 *
 * Plus a binary "WIN" flag: peak21d ≥ +10% (the threshold the radar's
 * empirical study used for "hit").
 *
 * Usage:
 *   BACKTEST_MODE=1 npx tsx scripts/precision-analysis.ts
 *                   [--win-threshold 0.10] [--reversal-threshold -0.10]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';

process.env.BACKTEST_MODE = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const WIN_THRESHOLD = parseFloat(arg('win-threshold', '0.10'));
const REVERSAL_THRESHOLD = parseFloat(arg('reversal-threshold', '-0.10'));

interface FlagRecord {
    action: string;
    championScore: number;
    momentumLevel: string;
    rvol: number;
    barGain: number;
    sector: string;
    sectorMedianReturn63d: number | null;
    breakoutStage: string | null;
    pctFromAth: number | null;
    extensionPct: number | null;
    distributionDays: number;
    failedCriteria: string[];
    lastPrice: number;
}

interface ReconstructedOutput {
    generatedAt: string;
    flaggedByDate: Record<string, Record<string, FlagRecord>>;
}

interface FlagWithOutcome extends FlagRecord {
    date: string;
    ticker: string;
    forward5d: number | null;
    forward10d: number | null;
    forward21d: number | null;
    peak21d: number | null;
    forwardNow: number | null;
    outcome: 'strong_success' | 'weak_success' | 'neutral' | 'failed' | 'reversal' | 'no_data';
    isWin: boolean; // peak21d >= WIN_THRESHOLD
}

// ─── Yahoo fetch ──────────────────────────────────────────────────
async function fetchYahoo2y(ticker: string): Promise<{ ts: number[]; close: number[] } | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`;
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        });
        if (!r.ok) return null;
        const data = (await r.json()) as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> } };
        const res = data?.chart?.result?.[0];
        const ts = res?.timestamp ?? [];
        const closeRaw = res?.indicators?.quote?.[0]?.close ?? [];
        const tsOut: number[] = [];
        const closeOut: number[] = [];
        for (let i = 0; i < ts.length; i++) {
            const c = closeRaw[i];
            if (c != null && c > 0) { tsOut.push(ts[i]!); closeOut.push(c); }
        }
        return tsOut.length >= 50 ? { ts: tsOut, close: closeOut } : null;
    } catch {
        return null;
    }
}

function tsToDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Find the index in `ts` for the given ISO date (or nearest trading day ≤ date). */
function findIdxAtOrBefore(ts: number[], iso: string): number {
    const cutoff = new Date(iso + 'T23:59:59Z').getTime() / 1000;
    for (let i = ts.length - 1; i >= 0; i--) {
        if (ts[i]! <= cutoff) return i;
    }
    return -1;
}

function classifyOutcome(peak21d: number | null, forwardNow: number | null): FlagWithOutcome['outcome'] {
    if (peak21d == null || forwardNow == null) return 'no_data';
    if (peak21d >= 0.15) {
        // Even strong peak: if it then collapsed (forward now ≤ reversal), call it reversal
        if (forwardNow <= REVERSAL_THRESHOLD) return 'reversal';
        return 'strong_success';
    }
    if (peak21d >= 0.05) {
        if (forwardNow <= REVERSAL_THRESHOLD) return 'reversal';
        return 'weak_success';
    }
    if (peak21d >= 0) return 'neutral';
    return 'failed';
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
    // Load latest reconstructed file
    const files = fs.readdirSync(RESULTS_DIR)
        .filter((f) => /^radar-reconstructed-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
    if (files.length === 0) {
        console.error('❌ No radar-reconstructed-*.json found. Run reconstruct-radar.ts first.');
        process.exit(1);
    }
    const reconPath = path.join(RESULTS_DIR, files[files.length - 1]!);
    console.log(`📂 Loading: ${path.basename(reconPath)}`);
    const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8')) as ReconstructedOutput;

    // Flatten flags into a single list
    const allFlags: Array<FlagRecord & { date: string; ticker: string }> = [];
    for (const [date, byTicker] of Object.entries(recon.flaggedByDate)) {
        for (const [ticker, rec] of Object.entries(byTicker)) {
            allFlags.push({ ...rec, date, ticker });
        }
    }
    console.log(`   ${allFlags.length} total flags across ${Object.keys(recon.flaggedByDate).length} days`);

    // Unique tickers to fetch
    const tickers = [...new Set(allFlags.map((f) => f.ticker))];
    console.log(`   ${tickers.length} unique tickers to fetch forward returns for`);

    // Fetch Yahoo per ticker
    console.log('\n🔎 Fetching Yahoo 2y per ticker (concurrency 8)...');
    const cache = new Map<string, { ts: number[]; close: number[] }>();
    const limit = pLimit(8);
    let fetched = 0;
    let failed = 0;
    await Promise.all(
        tickers.map((t) =>
            limit(async () => {
                const r = await fetchYahoo2y(t);
                fetched++;
                if (r) cache.set(t, r);
                else failed++;
                if (fetched % 50 === 0) process.stderr.write(`   ${fetched}/${tickers.length}\n`);
            })
        )
    );
    console.log(`   ✓ ${cache.size}/${tickers.length} cached (${failed} failed)\n`);

    // For each flag: compute forward returns + outcome
    console.log('⚙️  Computing forward returns + outcomes...');
    const flagsWithOutcome: FlagWithOutcome[] = [];
    for (const f of allFlags) {
        const series = cache.get(f.ticker);
        if (!series) {
            flagsWithOutcome.push({ ...f, forward5d: null, forward10d: null, forward21d: null, peak21d: null, forwardNow: null, outcome: 'no_data', isWin: false });
            continue;
        }
        const idx = findIdxAtOrBefore(series.ts, f.date);
        if (idx < 0) {
            flagsWithOutcome.push({ ...f, forward5d: null, forward10d: null, forward21d: null, peak21d: null, forwardNow: null, outcome: 'no_data', isWin: false });
            continue;
        }
        const entry = series.close[idx]!;
        const fwd = (n: number) => idx + n < series.close.length ? series.close[idx + n]! / entry - 1 : null;
        const forward5d = fwd(5);
        const forward10d = fwd(10);
        const forward21d = fwd(21);
        const peakSlice = series.close.slice(idx + 1, Math.min(idx + 22, series.close.length));
        const peak21d = peakSlice.length > 0 ? Math.max(...peakSlice) / entry - 1 : null;
        const forwardNow = series.close[series.close.length - 1]! / entry - 1;
        const outcome = classifyOutcome(peak21d, forwardNow);
        const isWin = peak21d != null && peak21d >= WIN_THRESHOLD;
        flagsWithOutcome.push({ ...f, forward5d, forward10d, forward21d, peak21d, forwardNow, outcome, isWin });
    }

    // ─── Pivots ────────────────────────────────────────────────────
    const print = (label: string, rows: Array<{ key: string; n: number; winRate: number; medPeak: number; medNow: number }>) => {
        console.log(`\n${label}`);
        console.log(`   ${'key'.padEnd(28)} ${'n'.padStart(5)}  ${'WIN%'.padStart(6)}  ${'medPeak21d'.padStart(11)}  ${'medNow'.padStart(7)}`);
        for (const r of rows) {
            console.log(`   ${r.key.padEnd(28)} ${String(r.n).padStart(5)}  ${(r.winRate * 100).toFixed(0).padStart(5)}%  ${(r.medPeak * 100).toFixed(1).padStart(10)}%  ${(r.medNow * 100).toFixed(1).padStart(6)}%`);
        }
    };

    function pivot(getKey: (f: FlagWithOutcome) => string) {
        const groups = new Map<string, FlagWithOutcome[]>();
        for (const f of flagsWithOutcome) {
            if (f.outcome === 'no_data') continue;
            const k = getKey(f);
            const arr = groups.get(k) ?? [];
            arr.push(f);
            groups.set(k, arr);
        }
        const rows = [...groups.entries()]
            .filter(([, arr]) => arr.length >= 3)
            .map(([key, arr]) => {
                const wins = arr.filter((x) => x.isWin).length;
                const peaks = arr.map((x) => x.peak21d!).sort((a, b) => a - b);
                const nows = arr.map((x) => x.forwardNow!).sort((a, b) => a - b);
                return {
                    key,
                    n: arr.length,
                    winRate: wins / arr.length,
                    medPeak: peaks[Math.floor(peaks.length / 2)] ?? 0,
                    medNow: nows[Math.floor(nows.length / 2)] ?? 0,
                };
            })
            .sort((a, b) => b.n - a.n);
        return rows;
    }

    console.log('\n═══ PRECISION ANALYSIS ═══');
    console.log(`\nTotal flags with outcome data: ${flagsWithOutcome.filter((f) => f.outcome !== 'no_data').length}`);
    console.log(`Total flags WITHOUT forward data: ${flagsWithOutcome.filter((f) => f.outcome === 'no_data').length}`);

    // Outcome distribution
    const outcomeCounts = new Map<string, number>();
    for (const f of flagsWithOutcome) {
        outcomeCounts.set(f.outcome, (outcomeCounts.get(f.outcome) ?? 0) + 1);
    }
    const totalWithData = flagsWithOutcome.filter((f) => f.outcome !== 'no_data').length;
    console.log(`\n=== Outcome distribution ===`);
    for (const k of ['strong_success', 'weak_success', 'neutral', 'failed', 'reversal'] as const) {
        const n = outcomeCounts.get(k) ?? 0;
        console.log(`   ${k.padEnd(20)} ${String(n).padStart(5)}  (${(n / totalWithData * 100).toFixed(1)}%)`);
    }

    print('=== By Action Label ===', pivot((f) => f.action));
    print('=== By Momentum Level ===', pivot((f) => f.momentumLevel));
    print('=== By Sector ===', pivot((f) => f.sector));
    print('=== By Breakout Stage ===', pivot((f) => f.breakoutStage ?? '(none)'));

    // Score bands
    print('=== By Champion Score band ===', pivot((f) => {
        const s = f.championScore;
        if (s >= 90) return '90-100';
        if (s >= 80) return '80-89';
        if (s >= 70) return '70-79';
        if (s >= 60) return '60-69';
        if (s >= 50) return '50-59';
        if (s >= 40) return '40-49';
        return '<40';
    }));

    // RVOL bands
    print('=== By RVOL band ===', pivot((f) => {
        const r = f.rvol;
        if (r >= 5) return '≥5.0';
        if (r >= 3) return '3.0-5.0';
        if (r >= 2) return '2.0-3.0';
        if (r >= 1.5) return '1.5-2.0';
        if (r >= 1.0) return '1.0-1.5';
        return '<1.0';
    }));

    // Sector median
    print('=== By Sector Median 63d band ===', pivot((f) => {
        const m = f.sectorMedianReturn63d;
        if (m == null) return '(unknown)';
        if (m >= 30) return '≥30%';
        if (m >= 20) return '20-30%';
        if (m >= 10) return '10-20%';
        if (m >= 0) return '0-10%';
        return '<0% (gate active)';
    }));

    // Action × sector matrix for the failure-rich cells
    console.log('\n=== Worst-performing buckets (n≥5, WIN%<40%) ===');
    const worst = pivot((f) => `${f.action} / ${f.sector}`).filter((r) => r.n >= 5 && r.winRate < 0.4).sort((a, b) => a.winRate - b.winRate);
    for (const r of worst.slice(0, 20)) {
        console.log(`   ${r.key.padEnd(45)} n=${r.n} win=${(r.winRate * 100).toFixed(0)}%  peak=${(r.medPeak * 100).toFixed(1)}%  now=${(r.medNow * 100).toFixed(1)}%`);
    }

    console.log('\n=== Best-performing buckets (n≥5, WIN%≥60%) ===');
    const best = pivot((f) => `${f.action} / ${f.sector}`).filter((r) => r.n >= 5 && r.winRate >= 0.6).sort((a, b) => b.winRate - a.winRate);
    for (const r of best.slice(0, 20)) {
        console.log(`   ${r.key.padEnd(45)} n=${r.n} win=${(r.winRate * 100).toFixed(0)}%  peak=${(r.medPeak * 100).toFixed(1)}%  now=${(r.medNow * 100).toFixed(1)}%`);
    }

    // Top 15 outright failures (loudest alerts that went nowhere)
    const failures = flagsWithOutcome
        .filter((f) => f.outcome === 'failed' || f.outcome === 'reversal')
        .sort((a, b) => b.championScore - a.championScore || b.rvol - a.rvol);
    console.log('\n=== Top 20 outright FAILURES (by championScore, then RVOL) ===');
    console.log(`   ${'Date'.padEnd(11)} ${'Ticker'.padEnd(10)} ${'Action'.padEnd(22)} ${'Score'.padStart(5)} ${'RVOL'.padStart(5)} ${'Stage'.padEnd(14)} ${'Bar%'.padStart(6)} ${'Peak21d'.padStart(8)} ${'Now'.padStart(7)} ${'SecMed'.padStart(7)} Sector`);
    for (const f of failures.slice(0, 20)) {
        console.log(`   ${f.date.padEnd(11)} ${f.ticker.padEnd(10)} ${f.action.padEnd(22)} ${String(f.championScore).padStart(5)} ${f.rvol.toFixed(2).padStart(5)} ${(f.breakoutStage ?? '?').padEnd(14)} ${(f.barGain * 100).toFixed(1).padStart(5)}% ${(f.peak21d! * 100).toFixed(1).padStart(7)}% ${(f.forwardNow! * 100).toFixed(1).padStart(6)}% ${f.sectorMedianReturn63d != null ? (f.sectorMedianReturn63d * 100).toFixed(1).padStart(6) + '%' : '   n/a'} ${f.sector}`);
    }

    // Write full report
    const today = new Date().toISOString().slice(0, 10);
    const outPath = path.join(RESULTS_DIR, `precision-analysis-${today}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        config: { WIN_THRESHOLD, REVERSAL_THRESHOLD },
        totalFlags: allFlags.length,
        flagsWithOutcome: flagsWithOutcome.filter((f) => f.outcome !== 'no_data').length,
        outcomeDistribution: Object.fromEntries(outcomeCounts),
        flags: flagsWithOutcome,
    }, null, 2));
    console.log(`\n📁 Full report saved: ${outPath}`);
}

main().catch((e) => { console.error('❌ Fatal:', e); process.exit(1); });
