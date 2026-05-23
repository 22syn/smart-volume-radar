#!/usr/bin/env npx tsx
/**
 * Reconstruct the radar's per-day output for every (ticker, day) in a window
 * up to 90 trading days back. Uses production code (parseYahooChartResult +
 * applyChampionScore) on as-of date slices of Yahoo data.
 *
 * Output: results/radar-reconstructed-{date}.json
 * Schema: {
 *   generatedAt, daysComputed, tickersComputed,
 *   flaggedByDate: { 'YYYY-MM-DD': { ticker: {action, championScore, ...}, ... } }
 * }
 *
 * Per-flag record includes: action, championScore, momentumLevel, rvol, barGain,
 * sector, sectorMedianReturn63d, breakoutStage, pctFromAth, failedCriteria,
 * extensionPct, distributionDays — enough for downstream precision analysis
 * without needing to re-compute.
 *
 * Only stocks with action != 'PASS' && action != 'PASS_TOO_LATE' are recorded
 * (i.e. anything that would have appeared in the daily Telegram report).
 *
 * Strategy:
 *   1. Fetch 2y Yahoo chart ONCE per ticker (cached).
 *   2. For each as-of date in window:
 *        a. Slice each ticker's Yahoo data to ≤ asOfDate.
 *        b. parseYahooChartResult({skipTwelveData: true}) → StockData
 *        c. Set sector + market regime (computed from SPY at that date).
 *        d. evaluateMomentumSetup + applyChampionScore.
 *        e. Record action if not PASS / PASS_TOO_LATE.
 *
 * Time: ~3-5 min for 369 tickers × 63 days (concurrency 8 on Yahoo fetch).
 *
 * Usage:
 *   BACKTEST_MODE=1 npx tsx scripts/reconstruct-radar.ts [--days 63]
 *                                                        [--limit-tickers 50]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import {
    fetchAndCacheWatchlist,
    loadWatchlist,
    getSectorForTicker,
} from '../src/config/index.js';
import { parseYahooChartResult } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { applyChampionScore } from '../src/utils/championScore.js';
import { applySectorRanks } from '../src/utils/sectorRank.js';
import type { StockData } from '../src/types/index.js';

process.env.BACKTEST_MODE = '1';

/** Per-flag record saved in flaggedByDate. Rich enough for precision analysis. */
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const DAYS = parseInt(arg('days', '63'), 10);
const LIMIT_TICKERS = parseInt(arg('limit-tickers', '0'), 10);

console.log(`═══ Radar Reconstruction (last ${DAYS} td) ═══`);

// ─── Yahoo fetch + cache ─────────────────────────────────────────
type YahooChartResult = {
    meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
    timestamp?: number[];
    indicators?: { quote?: Array<{ open?: (number | null)[]; close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; volume?: (number | null)[] }> };
};

async function fetchYahoo2y(ticker: string): Promise<YahooChartResult | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2y`;
    try {
        const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        });
        if (!r.ok) return null;
        const data = (await r.json()) as { chart?: { result?: unknown[] } };
        const result = data?.chart?.result?.[0] as YahooChartResult | undefined;
        return result?.timestamp?.length ? result : null;
    } catch {
        return null;
    }
}

/** Slice the Yahoo result to bars whose date <= asOfDate (UTC). Strips
 *  the regularMarketPrice so parseYahooChartResult uses the historical close. */
function sliceAsOf(result: YahooChartResult, asOfDate: string): YahooChartResult | null {
    const cutoff = new Date(asOfDate + 'T23:59:59Z').getTime() / 1000;
    const ts = result.timestamp ?? [];
    let lastIdx = -1;
    for (let i = ts.length - 1; i >= 0; i--) {
        if (ts[i]! <= cutoff) { lastIdx = i; break; }
    }
    if (lastIdx < 100) return null; // need at least 100 bars for SMA200/RVOL/etc.

    const q = result.indicators?.quote?.[0] ?? {};
    return {
        meta: { ...result.meta, regularMarketPrice: undefined },
        timestamp: ts.slice(0, lastIdx + 1),
        indicators: {
            quote: [{
                open: q.open?.slice(0, lastIdx + 1),
                close: q.close?.slice(0, lastIdx + 1),
                high: q.high?.slice(0, lastIdx + 1),
                low: q.low?.slice(0, lastIdx + 1),
                volume: q.volume?.slice(0, lastIdx + 1),
            }],
        },
    };
}

function tsToDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Extract trading-day dates from a Yahoo result (UTC). */
function tradingDates(result: YahooChartResult): string[] {
    return (result.timestamp ?? []).map(tsToDate);
}

async function main() {
    console.log('📋 Loading watchlist...');
    await fetchAndCacheWatchlist();
    let tickers = loadWatchlist();
    if (LIMIT_TICKERS > 0) tickers = tickers.slice(0, LIMIT_TICKERS);
    console.log(`   ${tickers.length} tickers\n`);

    // Always include SPY for market regime computation
    if (!tickers.includes('SPY')) tickers = ['SPY', ...tickers];

    // ─── Step 1: Fetch Yahoo 2y per ticker (concurrency 8) ────────
    console.log('🔎 Fetching Yahoo 2y (concurrency 8)...');
    const cache = new Map<string, YahooChartResult>();
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
                if (fetched % 50 === 0) {
                    process.stderr.write(`   ${fetched}/${tickers.length} fetched\n`);
                }
            })
        )
    );
    console.log(`   ✓ ${cache.size}/${tickers.length} cached (${failed} failed)\n`);

    // ─── Step 2: Build the list of as-of dates (trading days in window) ─
    const spy = cache.get('SPY');
    if (!spy) throw new Error('Could not fetch SPY for trading-day calendar / regime');
    const allDates = tradingDates(spy);
    const asOfDates = allDates.slice(-DAYS);
    console.log(`📅 Window: ${asOfDates[0]} → ${asOfDates[asOfDates.length - 1]} (${asOfDates.length} td)\n`);

    // ─── Step 3: For each date, compute action for every ticker ──
    console.log('⚙️  Computing per-day actions...');
    const flaggedByDate: Record<string, Record<string, FlagRecord>> = {};
    const actionDistByDate: Record<string, Record<string, number>> = {};

    // Pre-compute SPY closes for 63d return → regime
    const spyCloses = (spy.indicators?.quote?.[0]?.close ?? []) as (number | null)[];

    for (let di = 0; di < asOfDates.length; di++) {
        const asOf = asOfDates[di]!;
        // Market regime: SPY 63d return >= 0 → bull, else bear (matches fetchSpy63dReturn)
        const spyIdx = allDates.indexOf(asOf);
        const spyClose = spyIdx >= 0 ? spyCloses[spyIdx] : null;
        const spyClose63 = spyIdx >= 63 ? spyCloses[spyIdx - 63] : null;
        const spy63Return = (spyClose && spyClose63) ? spyClose / spyClose63 - 1 : 0;
        const regime: 'bull' | 'bear' = spy63Return >= 0 ? 'bull' : 'bear';

        // Build StockData for all tickers (in parallel — pure CPU)
        const stocks: StockData[] = [];
        await Promise.all(
            tickers.map((t) =>
                limit(async () => {
                    if (t === 'SPY') return;
                    const yahooResult = cache.get(t);
                    if (!yahooResult) return;
                    const sliced = sliceAsOf(yahooResult, asOf);
                    if (!sliced) return;
                    const stock = await parseYahooChartResult(sliced as never, t, { skipTwelveData: true });
                    if (!stock) return;
                    stock.sector = getSectorForTicker(t) ?? undefined;
                    stock.marketRegime = regime;
                    stocks.push(stock);
                })
            )
        );

        // Sector ranks (computes sectorMedianReturn63d on every stock)
        applySectorRanks(stocks);

        // Momentum + Champion Score per stock
        const dayFlagged: Record<string, FlagRecord> = {};
        const dayDist: Record<string, number> = {};
        for (const s of stocks) {
            s.momentum = evaluateMomentumSetup(s, { regime });
            applyChampionScore(s);
            const a = s.action ?? 'PASS';
            dayDist[a] = (dayDist[a] ?? 0) + 1;
            if (a !== 'PASS' && a !== 'PASS_TOO_LATE') {
                dayFlagged[s.ticker.toUpperCase()] = {
                    action: a,
                    championScore: s.championScore ?? 0,
                    momentumLevel: s.momentum?.level ?? 'none',
                    rvol: s.projectedRvol ?? s.rvol ?? 0,
                    barGain: s.priceChange ?? 0,
                    sector: s.sector ?? 'Unknown',
                    sectorMedianReturn63d: s.sectorMedianReturn63d ?? null,
                    breakoutStage: s.breakoutStage ?? null,
                    pctFromAth: s.pctFromAth ?? null,
                    extensionPct: s.tradePlan?.extensionPct ?? null,
                    distributionDays: s.distributionDays ?? 0,
                    failedCriteria: s.momentum?.failures ?? [],
                    lastPrice: s.lastPrice ?? 0,
                };
            }
        }
        flaggedByDate[asOf] = dayFlagged;
        actionDistByDate[asOf] = dayDist;

        if ((di + 1) % 10 === 0 || di === asOfDates.length - 1) {
            const total = Object.values(dayDist).reduce((s, n) => s + n, 0);
            const flagged = Object.keys(dayFlagged).length;
            process.stderr.write(
                `   ${di + 1}/${asOfDates.length}  ${asOf}  regime=${regime}  total=${total}  flagged=${flagged}  (BUY=${dayDist.BUY ?? 0} WATCH=${dayDist.WATCH ?? 0})\n`
            );
        }
    }

    // ─── Step 4: Write output ────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const out = {
        generatedAt: new Date().toISOString(),
        daysComputed: asOfDates.length,
        tickersFetched: cache.size,
        watchlistSize: tickers.length,
        windowStart: asOfDates[0],
        windowEnd: asOfDates[asOfDates.length - 1],
        flaggedByDate,
        actionDistByDate,
    };
    const outPath = path.join(RESULTS_DIR, `radar-reconstructed-${today}.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n📁 Saved: ${outPath}`);

    // Summary
    const grandTotal = Object.values(actionDistByDate).reduce((acc, d) => {
        for (const [k, v] of Object.entries(d)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
    }, {} as Record<string, number>);
    console.log(`\n📊 Action distribution across ${asOfDates.length} days × ${cache.size - 1} stocks:`);
    for (const [k, v] of Object.entries(grandTotal).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${k.padEnd(25)} ${v}`);
    }
}

main().catch((e) => {
    console.error('❌ Fatal:', e);
    process.exit(1);
});
