#!/usr/bin/env npx tsx
/**
 * 60-day Coverage + Criterion Analysis.
 *
 * What this answers:
 *  1. MISSED MOVERS — tickers in the watchlist that rallied >X% in the 60d window
 *     but never received a Normal-radar alert. Tells us where the radar is blind.
 *  2. CRITERION LIFT — for every alert in window, evaluate the 8 momentum criteria
 *     AT THE ALERT DATE, then bucket by criterion=True/False and compute median
 *     return-to-today. Replicates analyze-criteria-importance but on a focused
 *     60-day cohort.
 *  3. ENTRY SIMULATION — for each alert: hypothetical entry, what 4 different
 *     stop strategies would have done, hold-to-now P&L.
 *
 * Fetches each ticker's 5y Yahoo chart ONCE (same pattern as backtest-watchlist).
 *
 * Writes:
 *   outputs/backtest-60d/coverage.json     — every ticker, 60d return, alerts
 *   outputs/backtest-60d/criteria-60d.json — per-criterion lift stats
 *   outputs/backtest-60d/entries.json      — per-alert entry simulation
 *
 * Usage:  BACKTEST_MODE=1 npx tsx scripts/analyze-60d-coverage.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { parseYahooChartResult } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { calculateSMA } from '../src/utils/technicalAnalysis.js';
import type { MomentumLevel, MomentumCriteria } from '../src/types/index.js';

process.env.BACKTEST_MODE = '1';

// CLI: --from YYYY-MM-DD --to YYYY-MM-DD --out <dir>
function arg(name: string, fallback: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}
const FROM = arg('from', '2026-02-12');
const TO = arg('to', '2026-05-08');
const OUTDIR = arg('out', 'outputs/backtest-60d');
fs.mkdirSync(OUTDIR, { recursive: true });
console.error(`Window: ${FROM} → ${TO}, output: ${OUTDIR}`);

// ─── Yahoo fetch (mirrors backtest-watchlist.ts) ─────────────────────
interface RawChart {
    meta?: { regularMarketPrice?: number };
    timestamp?: number[];
    indicators?: {
        quote?: Array<{
            open?: (number | null)[];
            close?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            volume?: (number | null)[];
        }>;
    };
}

async function fetchRawChart(ticker: string, retries = 1): Promise<RawChart | null> {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;
        const res = await fetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            if (res.status === 404 && ticker.includes('.')) {
                const fb = ticker.replace(/\./g, '-');
                return fetchRawChart(fb, 0);
            }
            if (retries > 0) {
                await new Promise((r) => setTimeout(r, 400));
                return fetchRawChart(ticker, retries - 1);
            }
            return null;
        }
        const data = (await res.json()) as { chart?: { result?: RawChart[] } };
        return data?.chart?.result?.[0] ?? null;
    } catch {
        if (retries > 0) {
            await new Promise((r) => setTimeout(r, 400));
            return fetchRawChart(ticker, retries - 1);
        }
        return null;
    }
}

function sliceChart(raw: RawChart, asOfTimestamp: number): RawChart | null {
    const ts = raw.timestamp ?? [];
    let lastIdx = -1;
    for (let i = 0; i < ts.length; i++) {
        if (ts[i]! <= asOfTimestamp) lastIdx = i;
    }
    if (lastIdx < 0) return null;
    const sliceArr = <T>(arr: T[] | undefined): T[] => (arr ? arr.slice(0, lastIdx + 1) : []);
    const quote = raw.indicators?.quote?.[0];
    return {
        meta: { ...(raw.meta ?? {}) },
        timestamp: sliceArr(ts),
        indicators: {
            quote: [
                {
                    open: sliceArr(quote?.open),
                    close: sliceArr(quote?.close),
                    high: sliceArr(quote?.high),
                    low: sliceArr(quote?.low),
                    volume: sliceArr(quote?.volume),
                },
            ],
        },
    };
}

function tradingDays(from: string, to: string): string[] {
    const out: string[] = [];
    const cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T23:59:59Z');
    while (cur <= end) {
        const day = cur.getUTCDay();
        if (day >= 1 && day <= 5) out.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

function dateToTs(date: string): number {
    return new Date(date + 'T23:59:59Z').getTime() / 1000;
}

// ─── Per-date regime ──────────────────────────────────────────────────
function precomputeRegime(spy: RawChart, dates: string[]): Map<string, 'bull' | 'bear'> {
    const out = new Map<string, 'bull' | 'bear'>();
    const rawCloses = spy.indicators?.quote?.[0]?.close ?? [];
    const ts = spy.timestamp ?? [];
    const closes: number[] = [];
    const indexAt: number[] = [];
    for (let i = 0; i < rawCloses.length; i++) {
        const c = rawCloses[i];
        if (c != null && c > 0) {
            closes.push(c);
            indexAt.push(ts[i]!);
        }
    }
    for (const date of dates) {
        const cutoff = dateToTs(date);
        let lastIdx = -1;
        for (let j = 0; j < indexAt.length; j++) {
            if (indexAt[j]! <= cutoff) lastIdx = j;
            else break;
        }
        if (lastIdx < 100) { out.set(date, 'bull'); continue; }
        const upto = closes.slice(0, lastIdx + 1);
        const sma200 = calculateSMA(upto, 200);
        out.set(date, sma200 != null && upto[upto.length - 1]! < sma200 ? 'bear' : 'bull');
    }
    return out;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    await fetchAndCacheWatchlist();
    const watchlist = loadWatchlist();
    const tickers = [...new Set(watchlist)];
    console.error(`Watchlist: ${tickers.length} tickers`);

    const allDates = tradingDays(FROM, TO);
    console.error(`Trading days in window: ${allDates.length}`);

    // SPY first for regime
    const spy = await fetchRawChart('SPY');
    if (!spy) { console.error('No SPY data'); process.exit(1); }
    const regimeByDate = precomputeRegime(spy, allDates);
    console.error(`Regime map built for ${regimeByDate.size} dates`);
    const bullDays = [...regimeByDate.values()].filter((r) => r === 'bull').length;
    console.error(`Bull days: ${bullDays} / ${regimeByDate.size}, Bear: ${regimeByDate.size - bullDays}`);

    // Fetch all charts concurrently
    const limit = pLimit(5);
    const charts = new Map<string, RawChart>();
    let done = 0;
    await Promise.all(
        tickers.map((t) =>
            limit(async () => {
                const c = await fetchRawChart(t);
                if (c) charts.set(t, c);
                done++;
                if (done % 50 === 0) console.error(`fetched ${done}/${tickers.length}`);
            })
        )
    );
    console.error(`Charts fetched: ${charts.size}/${tickers.length}`);

    // For each ticker, compute (60d return) + (every alert in window with criteria)
    interface Alert {
        ticker: string;
        date: string;
        level: MomentumLevel;
        price: number;
        rvol: number;
        regime: 'bull' | 'bear';
        criteria: MomentumCriteria;
        returnToToday: number;
        // stop sim
        actual: number;
        stop8: number;
        stop15: number;
        sma21Stop: number;
    }
    interface TickerOut {
        ticker: string;
        priceStart: number | null;   // close at first day of window
        priceEnd: number | null;     // close at last day of window
        return60d: number | null;
        alerts: Alert[];
        anyAlert: boolean;
        firstAlertDate: string | null;
        firstAlertLevel: MomentumLevel | null;
    }

    const fromTs = dateToTs(FROM);
    const toTs = dateToTs(TO);
    const tickerResults: TickerOut[] = [];

    for (const ticker of tickers) {
        const chart = charts.get(ticker);
        if (!chart) continue;
        const ts = chart.timestamp ?? [];
        const q = chart.indicators?.quote?.[0];
        const closes = q?.close ?? [];
        if (!ts.length || !closes.length) continue;

        // Find first close at/after FROM, last close at/before TO
        let startIdx = -1, endIdx = -1;
        for (let i = 0; i < ts.length; i++) {
            if (closes[i] == null) continue;
            if (ts[i]! >= fromTs && startIdx < 0) startIdx = i;
            if (ts[i]! <= toTs) endIdx = i;
        }
        const priceStart = startIdx >= 0 ? closes[startIdx] ?? null : null;
        const priceEnd = endIdx >= 0 ? closes[endIdx] ?? null : null;
        const return60d = priceStart && priceEnd ? ((priceEnd - priceStart) / priceStart) * 100 : null;

        // Evaluate momentum at each trading day in window
        const alerts: Alert[] = [];
        const seenLevels = new Set<MomentumLevel>();
        for (const date of allDates) {
            const cutoff = dateToTs(date);
            const sliced = sliceChart(chart, cutoff);
            if (!sliced) continue;
            const parsed = await parseYahooChartResult(
                sliced as Parameters<typeof parseYahooChartResult>[0],
                ticker,
                { skipTwelveData: true }
            );
            if (!parsed) continue;
            const regime = regimeByDate.get(date) ?? 'bull';
            parsed.marketRegime = regime;
            const mom = evaluateMomentumSetup(parsed, { regime });
            if (mom.level === 'none') continue;
            // Only record FIRST appearance per level to keep cohort consistent
            if (seenLevels.has(mom.level)) continue;
            seenLevels.add(mom.level);

            // Compute return from this alert to TO
            // Use the chart's close at the alert date directly (parsed.lastPrice
            // can be inflated by meta.regularMarketPrice; we strip it but guard anyway).
            let alertClose = parsed.lastPrice;
            // Override with the actual close at the alert date from the FULL chart
            // (avoids any meta drift): find the last ts ≤ cutoff with non-null close.
            for (let i = ts.length - 1; i >= 0; i--) {
                if (ts[i]! <= cutoff && closes[i] != null) { alertClose = closes[i]!; break; }
            }
            const finalClose = priceEnd ?? alertClose;
            const ret = ((finalClose - alertClose) / alertClose) * 100;

            // Stop sims (post-alert path)
            const postCloses: number[] = [];
            const postDates: string[] = [];
            for (let i = 0; i < ts.length; i++) {
                if (ts[i]! > cutoff && ts[i]! <= toTs && closes[i] != null) {
                    postCloses.push(closes[i]!);
                    postDates.push(new Date(ts[i]! * 1000).toISOString().slice(0, 10));
                }
            }
            const stop8Price = alertClose * 0.92;
            const stop15Price = alertClose * 0.85;
            let stop8Result = ret, stop15Result = ret, sma21Result = ret;
            for (let i = 0; i < postCloses.length; i++) {
                const px = postCloses[i]!;
                if (stop8Result === ret && px <= stop8Price) stop8Result = -8;
                if (stop15Result === ret && px <= stop15Price) stop15Result = -15;
                // SMA21 stop computed below
            }
            // SMA21 stop: at each post-alert day, compute SMA21 over the closes
            // up to that day; if close < SMA21, exit.
            const allClosesArr = closes.filter((c): c is number => c != null);
            let runIdx = -1;
            for (let i = 0; i < ts.length; i++) {
                if (closes[i] == null) continue;
                if (ts[i]! > cutoff) { runIdx = i; break; }
            }
            if (runIdx >= 0) {
                for (let i = runIdx; i < ts.length && ts[i]! <= toTs; i++) {
                    const c = closes[i];
                    if (c == null) continue;
                    // Slice closes up to i
                    const upto = closes.slice(0, i + 1).filter((x): x is number => x != null);
                    const sma21 = calculateSMA(upto, 21);
                    if (sma21 != null && c < sma21) {
                        sma21Result = ((c - alertClose) / alertClose) * 100;
                        break;
                    }
                }
            }

            alerts.push({
                ticker,
                date,
                level: mom.level,
                price: alertClose,
                rvol: parsed.rvol,
                regime,
                criteria: mom.criteria,
                returnToToday: ret,
                actual: ret,
                stop8: stop8Result,
                stop15: stop15Result,
                sma21Stop: sma21Result,
            });
        }

        const firstAlert = alerts.length ? alerts.sort((a, b) => a.date.localeCompare(b.date))[0] : null;
        tickerResults.push({
            ticker,
            priceStart,
            priceEnd,
            return60d,
            alerts,
            anyAlert: alerts.length > 0,
            firstAlertDate: firstAlert?.date ?? null,
            firstAlertLevel: firstAlert?.level ?? null,
        });
    }

    // ─── Coverage analysis ─────────────────────────────────────────
    const withReturn = tickerResults.filter((r) => r.return60d != null);
    withReturn.sort((a, b) => (b.return60d ?? 0) - (a.return60d ?? 0));

    const missed20 = withReturn.filter((r) => (r.return60d ?? 0) >= 20 && !r.anyAlert);
    const missed50 = withReturn.filter((r) => (r.return60d ?? 0) >= 50 && !r.anyAlert);
    const captured20 = withReturn.filter((r) => (r.return60d ?? 0) >= 20 && r.anyAlert);

    console.error(`\n=========== COVERAGE ===========`);
    console.error(`tickers w/ 60d return: ${withReturn.length}`);
    console.error(`movers ≥+20%: ${withReturn.filter((r) => (r.return60d ?? 0) >= 20).length} `
        + `(captured ${captured20.length}, missed ${missed20.length})`);
    console.error(`movers ≥+50%: ${withReturn.filter((r) => (r.return60d ?? 0) >= 50).length} `
        + `(captured ${withReturn.filter((r) => (r.return60d ?? 0) >= 50 && r.anyAlert).length}, missed ${missed50.length})`);
    console.error(`\nTOP MISSED MOVERS (≥+20%, no alert in window):`);
    for (const r of missed20.slice(0, 20)) {
        console.error(`  ${(r.return60d ?? 0).toFixed(1).padStart(7)}%  ${r.ticker}`);
    }

    // ─── Criterion lift ────────────────────────────────────────────
    const allAlerts = tickerResults.flatMap((r) => r.alerts);
    const critKeys: (keyof MomentumCriteria)[] = [
        'rvolPass', 'stage2', 'lowRiskEntry', 'pivotBreakout',
        'tightness', 'aboveGapAvwap', 'antsAccumulation', 'bigMoveToday',
    ];
    interface Lift { n: number; medianReturn: number; meanReturn: number; hit: number; }
    function statsOf(rows: Alert[]): Lift {
        if (!rows.length) return { n: 0, medianReturn: 0, meanReturn: 0, hit: 0 };
        const rs = rows.map((r) => r.returnToToday).sort((a, b) => a - b);
        const n = rs.length;
        return {
            n,
            medianReturn: rs[Math.floor(n / 2)]!,
            meanReturn: rs.reduce((a, b) => a + b, 0) / n,
            hit: (rs.filter((x) => x > 0).length / n) * 100,
        };
    }
    const liftByCrit: Record<string, { whenTrue: Lift; whenFalse: Lift; liftMedian: number }> = {};
    for (const k of critKeys) {
        const t = statsOf(allAlerts.filter((a) => a.criteria[k]));
        const f = statsOf(allAlerts.filter((a) => !a.criteria[k]));
        const lift = f.medianReturn !== 0 ? t.medianReturn - f.medianReturn : t.medianReturn;
        liftByCrit[k] = { whenTrue: t, whenFalse: f, liftMedian: lift };
    }

    console.error(`\n=========== CRITERION LIFT (n=${allAlerts.length} alerts) ===========`);
    console.error(`Criterion         True n    True med   False n   False med   Δmedian   Read`);
    const ordered = critKeys
        .map((k) => ({ k, ...liftByCrit[k]! }))
        .sort((a, b) => b.liftMedian - a.liftMedian);
    for (const row of ordered) {
        const t = row.whenTrue, f = row.whenFalse;
        const verdict =
            row.liftMedian > 3 ? '✅ predictive'
                : row.liftMedian < -3 ? '⚠️ anti-predict'
                    : '🤷 neutral';
        console.error(
            `  ${row.k.padEnd(17)} ${String(t.n).padStart(4)}  ${t.medianReturn.toFixed(1).padStart(7)}%  `
            + `${String(f.n).padStart(4)}  ${f.medianReturn.toFixed(1).padStart(7)}%  `
            + `${row.liftMedian >= 0 ? '+' : ''}${row.liftMedian.toFixed(1).padStart(6)}%  ${verdict}`
        );
    }

    // ─── Entry simulation per alert ────────────────────────────────
    function statsBy<T extends string>(group: (a: Alert) => T, key: 'actual' | 'stop8' | 'stop15' | 'sma21Stop') {
        const buckets = new Map<T, number[]>();
        for (const a of allAlerts) {
            const k = group(a);
            const arr = buckets.get(k) ?? [];
            arr.push(a[key]);
            buckets.set(k, arr);
        }
        const out: Record<string, { n: number; mean: number; median: number; hit: number }> = {};
        for (const [k, rs] of buckets) {
            const sorted = [...rs].sort((a, b) => a - b);
            out[String(k)] = {
                n: rs.length,
                mean: rs.reduce((a, b) => a + b, 0) / rs.length,
                median: sorted[Math.floor(sorted.length / 2)]!,
                hit: (rs.filter((r) => r > 0).length / rs.length) * 100,
            };
        }
        return out;
    }

    console.error(`\n=========== ENTRY/STOP SIMULATION (n=${allAlerts.length}) ===========`);
    console.error(`Per-alert: enter at close on alert day, hold to ${TO}. Stops triggered at intra-window levels.`);
    const stopRowsByTier = (key: 'actual' | 'stop8' | 'stop15' | 'sma21Stop') => statsBy((a) => a.level, key);
    for (const key of ['actual', 'stop8', 'stop15', 'sma21Stop'] as const) {
        console.error(`\n  Strategy: ${key}`);
        const s = stopRowsByTier(key);
        for (const tier of ['full', 'recovery', 'close'] as const) {
            const row = s[tier];
            if (!row) continue;
            console.error(`    ${tier.padEnd(10)} n=${String(row.n).padStart(4)}  `
                + `mean=${row.mean.toFixed(1).padStart(6)}%  median=${row.median.toFixed(1).padStart(6)}%  hit=${row.hit.toFixed(0)}%`);
        }
    }

    // ─── Save artifacts ────────────────────────────────────────────
    fs.writeFileSync(
        path.join(OUTDIR, 'coverage.json'),
        JSON.stringify({
            from: FROM, to: TO,
            tickers: tickerResults.map((r) => ({
                ticker: r.ticker,
                priceStart: r.priceStart, priceEnd: r.priceEnd, return60d: r.return60d,
                anyAlert: r.anyAlert,
                firstAlertDate: r.firstAlertDate, firstAlertLevel: r.firstAlertLevel,
                alertCount: r.alerts.length,
            })),
            missedMovers: { plus20: missed20.length, plus50: missed50.length },
        }, null, 2)
    );
    fs.writeFileSync(path.join(OUTDIR, 'criteria-60d.json'), JSON.stringify(liftByCrit, null, 2));
    fs.writeFileSync(path.join(OUTDIR, 'entries.json'), JSON.stringify(allAlerts, null, 2));
    console.error(`\nWritten: ${OUTDIR}/coverage.json, criteria-60d.json, entries.json`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
