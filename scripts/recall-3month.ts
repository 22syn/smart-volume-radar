#!/usr/bin/env npx tsx
/**
 * 3-Month RECALL Analysis — "Did the radar flag the real breakouts?"
 *
 * RECALL direction (ground truth → radar coverage):
 *   1. For each watchlist ticker, pull ~120 trading days of Yahoo OHLCV.
 *   2. Detect "real breakout" events in the last ~63 trading days using
 *      a backward-looking, OHLCV-only rule (no peek at radar internals).
 *   3. Dedupe: if multiple breakout days fire in a 7-trading-day window,
 *      keep only the FIRST (a single momentum event, not a cluster count).
 *   4. For each breakout event, check: was this ticker flagged by the
 *      radar (present in scan-*.json `signals[]`) in the 5 trading days
 *      BEFORE the breakout day?
 *   5. Report:
 *        - Breakouts found
 *        - Hit rate (flagged ≤5 td before)
 *        - Miss list (the ones we didn't flag — sorted by move size)
 *        - Lead-time distribution
 *
 * Ground-truth "real breakout" rule (recommended by explorer-agent — Rule 1
 * — directly mirrors the radar's two strongest empirical predictors:
 * pivotBreakout + RVOL≥2):
 *   A trading day D qualifies as a breakout day if ALL hold:
 *     • close[D] >= max(close[D-HIGH_WINDOW .. D-1])  (new HIGH_WINDOW high)
 *     • close[D] >= close[D-1] * (1 + BAR_GAIN)       (≥+BAR_GAIN bar move)
 *     • volume[D] / mean(volume[D-63..D-1]) >= RVOL_THRESHOLD
 *
 * Default: HIGH_WINDOW=252 (52-week), BAR_GAIN=0.03 (+3% day), RVOL=2.0.
 * Override via CLI for sensitivity analysis.
 *
 * "Radar flagged" definition:
 *   Ticker appears in any scan-*.json signals[] entry on a date in
 *   [D - LEAD .. D] INCLUSIVE — the breakout day itself counts as a hit
 *   because Telegram firing ON the breakout day is a perfect signal (and
 *   matches the radar's design — it fires when criteria are MET, not
 *   before). This is permissive — counts ANY signal class (BUY/WATCH/
 *   CAUTION/NOTABLE/silent) because the question is "did I see this
 *   ticker in Telegram on or before the breakout", not "was the action
 *   label perfectly tuned".
 *
 * Usage:
 *   npm run recall-3month [-- --days 63] [--rvol 2.0] [--bar-gain 0.03]
 *                         [--high-window 252] [--limit-tickers 50]
 *                         [--lead 5]
 *
 *   --days N             How many trading days back to scan (default 63)
 *   --rvol X             RVOL threshold for breakout day (default 2.0)
 *   --bar-gain X         Single-day price gain threshold (default 0.03 = +3%)
 *   --high-window N      New-high lookback in trading days (default 252 = 52w)
 *   --lead N             Trading days before breakout to check radar (default 5)
 *   --limit-tickers N    Cap ticker count for fast iteration (default unlimited)
 *
 * Env:
 *   BACKTEST_MODE=1      bypass data-freshness guard
 *   GOOGLE_SHEET_ID      required to load watchlist
 *
 * Output:
 *   results/recall-3month-{date}.json — full report
 *   stdout — human-readable summary
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { fetchAndCacheWatchlist, loadWatchlist, getSectorForTicker } from '../src/config/index.js';

process.env.BACKTEST_MODE = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

// ─── CLI ───────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const DAYS = parseInt(arg('days', '63'), 10);
const RVOL_THRESHOLD = parseFloat(arg('rvol', '2.0'));
const BAR_GAIN = parseFloat(arg('bar-gain', '0.03'));
const HIGH_WINDOW = parseInt(arg('high-window', '252'), 10);
const LEAD = parseInt(arg('lead', '5'), 10);
const LIMIT_TICKERS = parseInt(arg('limit-tickers', '0'), 10);

console.log(`═══ 3-Month RECALL Analysis ═══`);
console.log(`Window: last ${DAYS} td · breakout: new ${HIGH_WINDOW}d high + ≥${(BAR_GAIN*100).toFixed(0)}% bar + RVOL ≥${RVOL_THRESHOLD}`);
console.log(`Radar lead window: ${LEAD} trading days before breakout`);
console.log('');

// ─── Yahoo fetch (raw OHLCV series) ────────────────────────────────
interface OhlcvSeries {
    timestamps: number[]; // unix seconds
    closes: number[];
    volumes: number[];
}

async function fetchYahooSeries(ticker: string): Promise<OhlcvSeries | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`;
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        });
        if (!r.ok) return null;
        const data = (await r.json()) as {
            chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }> } }> };
        };
        const result = data?.chart?.result?.[0];
        if (!result?.timestamp?.length) return null;
        const ts = result.timestamp;
        const quote = result.indicators?.quote?.[0];
        if (!quote?.close || !quote?.volume) return null;
        // Build aligned arrays, filtering out null/zero rows
        const out: OhlcvSeries = { timestamps: [], closes: [], volumes: [] };
        for (let i = 0; i < ts.length; i++) {
            const c = quote.close[i];
            const v = quote.volume[i];
            if (c == null || v == null || c <= 0) continue;
            out.timestamps.push(ts[i]!);
            out.closes.push(c);
            out.volumes.push(v);
        }
        return out.closes.length >= 50 ? out : null;
    } catch {
        return null;
    }
}

function tsToDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ─── Breakout detection ────────────────────────────────────────────
interface BreakoutEvent {
    ticker: string;
    sector: string;
    date: string;
    close: number;
    barGain: number; // close[D]/close[D-1] - 1
    rvol: number;
    newHighOver: number; // ratio close[D] / max(close[D-HIGH_WINDOW..D-1])
    /** % move from breakout day to end of series (forward return as of now). */
    forwardReturnNow: number;
    /** Max % move within 21 td after breakout (peak performance). */
    forwardPeak21d: number;
}

function detectBreakouts(ticker: string, series: OhlcvSeries): BreakoutEvent[] {
    const { closes, volumes, timestamps } = series;
    const N = closes.length;
    const events: BreakoutEvent[] = [];
    const minHistory = Math.max(HIGH_WINDOW, 63); // need 63d for RVOL avg
    const startIdx = Math.max(minHistory + 1, N - DAYS);
    let lastEventIdx = -1000;

    for (let i = startIdx; i < N; i++) {
        // Dedupe: 7-td cooldown between events on same ticker
        if (i - lastEventIdx < 7) continue;

        const close = closes[i]!;
        const prevClose = closes[i - 1]!;
        const barGain = close / prevClose - 1;
        if (barGain < BAR_GAIN) continue; // must be ≥ BAR_GAIN bar

        const windowMax = Math.max(...closes.slice(i - HIGH_WINDOW, i));
        const newHighOver = close / windowMax;
        if (newHighOver < 1.0) continue; // must be new HIGH_WINDOW high

        // RVOL: today / 63-day average
        const avgVol = volumes.slice(i - 63, i).reduce((s, v) => s + v, 0) / 63;
        const rvol = avgVol > 0 ? volumes[i]! / avgVol : 0;
        if (rvol < RVOL_THRESHOLD) continue;

        // Forward returns (informational only — not for hit-rate logic)
        const forwardReturnNow = closes[N - 1]! / close - 1;
        const peakEnd = Math.min(i + 21, N);
        const fwdSlice = closes.slice(i, peakEnd);
        const fwdPeak = fwdSlice.length ? Math.max(...fwdSlice) : close;
        const forwardPeak21d = fwdPeak / close - 1;

        events.push({
            ticker,
            sector: getSectorForTicker(ticker) || 'Unknown',
            date: tsToDate(timestamps[i]!),
            close,
            barGain,
            rvol,
            newHighOver,
            forwardReturnNow,
            forwardPeak21d,
        });
        lastEventIdx = i;
    }
    return events;
}

// ─── Scan history (radar flag lookup) ──────────────────────────────
interface ScanFile { date: string; tickers: Set<string>; }

function loadScanHistory(): Map<string, Set<string>> {
    const byDate = new Map<string, Set<string>>();

    // Preferred source: reconstructed radar output (full action map per ticker per day).
    // Produced by `npm run reconstruct-radar` — runs current production logic on
    // historical Yahoo data so the recall test reflects what the radar would
    // catch TODAY, not what was historically logged (the production logic and
    // file schemas have changed over the 3-month window).
    const reconstructedFiles = fs
        .readdirSync(RESULTS_DIR)
        .filter((f) => /^radar-reconstructed-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
    if (reconstructedFiles.length > 0) {
        const latest = reconstructedFiles[reconstructedFiles.length - 1]!;
        console.log(`   ↳ using reconstructed radar: ${latest}`);
        const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, latest), 'utf8')) as {
            flaggedByDate: Record<string, Record<string, string>>;
        };
        for (const [date, flagged] of Object.entries(data.flaggedByDate)) {
            const set = new Set<string>(Object.keys(flagged).map((t) => t.toUpperCase()));
            byDate.set(date, set);
        }
        return byDate;
    }

    // Fallback: legacy scan-*.json files (only useful for the last ~14 days
    // since the older files use a debug schema without signals[]).
    const files = fs.readdirSync(RESULTS_DIR).filter((f) => /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const f of files) {
        const date = f.slice(5, 15);
        try {
            const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
            const signals = (data.signals ?? data.topSignals ?? []) as Array<{ ticker?: string }>;
            const set = new Set<string>(signals.map((s) => (s.ticker ?? '').toUpperCase()).filter(Boolean));
            byDate.set(date, set);
        } catch { /* skip malformed */ }
    }
    return byDate;
}

/** Was `ticker` flagged in any scan in the window [eventDate - LEAD .. eventDate] INCLUSIVE?
 *  Same-day flagging is a HIT — Telegram firing on the breakout day is a successful
 *  alert (no "before" requirement). */
function radarFlagged(ticker: string, eventDate: string, scans: Map<string, Set<string>>): { flagged: boolean; flaggedDates: string[]; sameDayHit: boolean } {
    const t = ticker.toUpperCase();
    const eventDay = new Date(eventDate + 'T00:00:00Z');
    const flaggedDates: string[] = [];
    let sameDayHit = false;

    // Day 0 (breakout day) + up to LEAD+4 calendar days back (covers ~LEAD trading days
    // even after weekends/holidays).
    for (let d = 0; d <= LEAD + 4; d++) {
        const check = new Date(eventDay);
        check.setUTCDate(check.getUTCDate() - d);
        const iso = check.toISOString().slice(0, 10);
        const set = scans.get(iso);
        if (set?.has(t)) {
            flaggedDates.push(iso);
            if (d === 0) sameDayHit = true;
        }
        if (flaggedDates.length >= LEAD + 1) break;
    }
    return { flagged: flaggedDates.length > 0, flaggedDates, sameDayHit };
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
    console.log('📋 Loading watchlist...');
    await fetchAndCacheWatchlist();
    let tickers = loadWatchlist();
    if (LIMIT_TICKERS > 0) tickers = tickers.slice(0, LIMIT_TICKERS);
    console.log(`   ${tickers.length} tickers\n`);

    console.log('📂 Loading scan history...');
    const scans = loadScanHistory();
    const scanDates = [...scans.keys()].sort();
    console.log(`   ${scans.size} scan files (${scanDates[0]} → ${scanDates[scanDates.length - 1]})\n`);

    console.log(`🔎 Fetching Yahoo OHLCV (concurrency 8)...`);
    const limit = pLimit(8);
    let fetched = 0;
    let fetchFailed = 0;
    const allEvents: BreakoutEvent[] = [];

    await Promise.all(
        tickers.map((t) =>
            limit(async () => {
                const series = await fetchYahooSeries(t);
                fetched++;
                if (!series) { fetchFailed++; return; }
                const events = detectBreakouts(t, series);
                allEvents.push(...events);
                if (fetched % 25 === 0) {
                    process.stderr.write(`   ${fetched}/${tickers.length} fetched, ${allEvents.length} breakouts so far\n`);
                }
            })
        )
    );

    console.log(`\n📊 Results:`);
    console.log(`   Tickers fetched: ${fetched - fetchFailed}/${tickers.length} (${fetchFailed} failed)`);
    console.log(`   Breakout events detected: ${allEvents.length}`);

    // Cross-reference with scan history
    const hits: BreakoutEvent[] = [];
    const sameDayHits: BreakoutEvent[] = [];
    const aheadHits: BreakoutEvent[] = [];
    const misses: BreakoutEvent[] = [];
    const leadByDays: number[] = [];

    for (const ev of allEvents) {
        const { flagged, flaggedDates, sameDayHit } = radarFlagged(ev.ticker, ev.date, scans);
        if (flagged) {
            hits.push(ev);
            if (sameDayHit) sameDayHits.push(ev);
            // Lead time = days between event and EARLIEST flag
            const firstFlag = flaggedDates.sort()[0]!;
            const lead = Math.round((new Date(ev.date + 'T00:00:00Z').getTime() - new Date(firstFlag + 'T00:00:00Z').getTime()) / 86400000);
            leadByDays.push(lead);
            if (lead > 0) aheadHits.push(ev);
        } else {
            misses.push(ev);
        }
    }

    const hitRate = allEvents.length > 0 ? hits.length / allEvents.length : 0;

    console.log(`\n   HITS (flagged ≤${LEAD} td before OR same day): ${hits.length} (${(hitRate * 100).toFixed(1)}%)`);
    console.log(`     ↳ same-day hits:      ${sameDayHits.length} (radar fired on the breakout day)`);
    console.log(`     ↳ advance-warning:    ${aheadHits.length} (radar fired 1-${LEAD} td before)`);
    console.log(`   MISSES (no flag at all): ${misses.length}`);

    if (leadByDays.length > 0) {
        leadByDays.sort((a, b) => a - b);
        const median = leadByDays[Math.floor(leadByDays.length / 2)];
        const mean = leadByDays.reduce((s, n) => s + n, 0) / leadByDays.length;
        console.log(`   Lead-time on hits: median ${median} cal days, mean ${mean.toFixed(1)}`);
    }

    // Per-sector hit rate
    console.log('\n📈 Hit rate by sector:');
    const bySector = new Map<string, { hits: number; total: number }>();
    for (const ev of allEvents) {
        const cur = bySector.get(ev.sector) ?? { hits: 0, total: 0 };
        cur.total++;
        bySector.set(ev.sector, cur);
    }
    for (const ev of hits) {
        const cur = bySector.get(ev.sector)!;
        cur.hits++;
    }
    const sectorRows = [...bySector.entries()]
        .filter(([, v]) => v.total >= 2)
        .sort((a, b) => b[1].total - a[1].total);
    for (const [sector, v] of sectorRows.slice(0, 15)) {
        const rate = (v.hits / v.total * 100).toFixed(0);
        console.log(`   ${sector.padEnd(30)} ${v.hits}/${v.total}  (${rate}%)`);
    }

    // Top misses by forward peak
    misses.sort((a, b) => b.forwardPeak21d - a.forwardPeak21d);
    console.log(`\n❌ Top 20 MISSES (sorted by 21d forward peak after breakout day):`);
    for (const ev of misses.slice(0, 20)) {
        console.log(
            `   ${ev.date}  ${ev.ticker.padEnd(10)} +${(ev.barGain * 100).toFixed(1)}% bar  RVOL ${ev.rvol.toFixed(2)}  peak21d +${(ev.forwardPeak21d * 100).toFixed(1)}%  ${ev.sector}`
        );
    }

    // Top hits by forward peak (good ones we caught)
    hits.sort((a, b) => b.forwardPeak21d - a.forwardPeak21d);
    console.log(`\n✅ Top 10 HITS (best forward performance we caught):`);
    for (const ev of hits.slice(0, 10)) {
        console.log(
            `   ${ev.date}  ${ev.ticker.padEnd(10)} +${(ev.barGain * 100).toFixed(1)}% bar  RVOL ${ev.rvol.toFixed(2)}  peak21d +${(ev.forwardPeak21d * 100).toFixed(1)}%  ${ev.sector}`
        );
    }

    // Write full JSON for further analysis
    const today = new Date().toISOString().slice(0, 10);
    const out = {
        generatedAt: new Date().toISOString(),
        config: { DAYS, RVOL_THRESHOLD, BAR_GAIN, HIGH_WINDOW, LEAD, LIMIT_TICKERS },
        watchlistSize: tickers.length,
        fetched: fetched - fetchFailed,
        fetchFailed,
        scanFilesUsed: scans.size,
        scanDateRange: { start: scanDates[0], end: scanDates[scanDates.length - 1] },
        totalBreakouts: allEvents.length,
        hits: hits.length,
        misses: misses.length,
        hitRate,
        events: allEvents.map((ev) => ({
            ...ev,
            flagged: hits.includes(ev),
        })),
    };
    const outPath = path.join(RESULTS_DIR, `recall-3month-${today}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n📁 Full report saved: ${outPath}`);
}

main().catch((e) => {
    console.error('❌ Fatal:', e);
    process.exit(1);
});
