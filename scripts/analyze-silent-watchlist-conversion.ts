#!/usr/bin/env npx tsx
/**
 * Silent Watchlist → Real Signal — conversion analysis.
 *
 * Question: do stocks that appear in the Silent Watchlist (near-misses)
 * actually convert into REAL Lean signals soon after? And if they do,
 * was that conversion a profitable entry?
 *
 * For each watchlist stock × each trading day in window:
 *   1. Compute all 6 detectors (3 real + 3 near-miss)
 *   2. If stock is a near-miss today AND was NOT yesterday → that's a
 *      "fresh near appearance"
 *   3. Within next 30 trading days, find the FIRST real signal that fires
 *   4. Record: did it convert? to what type? after how many days?
 *
 * Also computes per conversion the price-change from near-day to today,
 * so we can see whether near-miss entries paid off.
 *
 * Outputs:
 *   outputs/silent-conversion/transitions.json — every (near→real) row
 *   outputs/silent-conversion/summary.json     — aggregated stats
 *   console: conversion-rate table + example transitions
 *
 * Usage: BACKTEST_MODE=1 npx tsx scripts/analyze-silent-watchlist-conversion.ts
 *        [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { parseYahooChartResult } from '../src/services/marketData.js';
import {
    detectConsolidationBreakout,
    detectConsolidationNearMiss,
    qualifiesAsHighVolume,
    qualifiesAsHealthyPullback,
    qualifiesAsVolumeNearMiss,
    qualifiesAsPullbackNearMiss,
} from '../src/lean/signals.js';

process.env.BACKTEST_MODE = '1';

// ─── CLI ────────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const FROM = arg('from', '2025-05-13');
const TO = arg('to', '2026-05-12');
const HORIZON = parseInt(arg('horizon', '30'), 10); // trading days to look forward
const OUTDIR = 'outputs/silent-conversion';
fs.mkdirSync(OUTDIR, { recursive: true });

// ─── Yahoo fetch + slice ────────────────────────────────────────────
interface RawChart {
    meta?: { regularMarketPrice?: number };
    timestamp?: number[];
    indicators?: {
        quote?: Array<{
            open?: (number | null)[]; close?: (number | null)[];
            high?: (number | null)[]; low?: (number | null)[]; volume?: (number | null)[];
        }>;
    };
}

async function fetchRawChart(ticker: string, retries = 1): Promise<RawChart | null> {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5y`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (!res.ok) {
            if (res.status === 404 && ticker.includes('.')) return fetchRawChart(ticker.replace(/\./g, '-'), 0);
            if (retries > 0) { await new Promise((r) => setTimeout(r, 400)); return fetchRawChart(ticker, retries - 1); }
            return null;
        }
        const data = (await res.json()) as { chart?: { result?: RawChart[] } };
        return data?.chart?.result?.[0] ?? null;
    } catch {
        if (retries > 0) { await new Promise((r) => setTimeout(r, 400)); return fetchRawChart(ticker, retries - 1); }
        return null;
    }
}

function sliceChart(raw: RawChart, asOfTs: number): RawChart | null {
    const ts = raw.timestamp ?? [];
    let lastIdx = -1;
    for (let i = 0; i < ts.length; i++) if (ts[i]! <= asOfTs) lastIdx = i;
    if (lastIdx < 0) return null;
    const sl = <T>(a: T[] | undefined): T[] => (a ? a.slice(0, lastIdx + 1) : []);
    const q = raw.indicators?.quote?.[0];
    return {
        meta: { ...(raw.meta ?? {}), regularMarketPrice: undefined },
        timestamp: sl(ts),
        indicators: { quote: [{ open: sl(q?.open), close: sl(q?.close), high: sl(q?.high), low: sl(q?.low), volume: sl(q?.volume) }] },
    };
}

function dateToTs(d: string): number { return new Date(d + 'T23:59:59Z').getTime() / 1000; }

function tradingDays(from: string, to: string): string[] {
    const out: string[] = [];
    const cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T23:59:59Z');
    while (cur <= end) {
        const d = cur.getUTCDay();
        if (d >= 1 && d <= 5) out.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

function ohlcFromChart(chart: RawChart): { closes: number[]; highs: number[]; lows: number[] } {
    const q = chart.indicators?.quote?.[0];
    const rc = q?.close ?? [];
    const rh = q?.high ?? [];
    const rl = q?.low ?? [];
    const closes: number[] = [], highs: number[] = [], lows: number[] = [];
    for (let i = 0; i < rc.length; i++) {
        const c = rc[i];
        if (c == null || c <= 0) continue;
        closes.push(c);
        highs.push(rh[i] ?? c);
        lows.push(rl[i] ?? c);
    }
    return { closes, highs, lows };
}

// ─── Per-ticker per-day signal computation ──────────────────────────
type SigName = 'breakout' | 'highVol' | 'pullback' | 'nearBreakout' | 'nearVol' | 'nearPullback';
interface DaySignal {
    date: string;
    real: SigName[];      // which REAL signals fired today
    near: SigName[];      // which NEAR signals fired today
    price: number;
    rvol: number;
    pctFromAth: number | null;
}

async function timelineForTicker(ticker: string, dates: string[]): Promise<DaySignal[]> {
    const chart = await fetchRawChart(ticker);
    if (!chart) return [];
    const out: DaySignal[] = [];
    for (const date of dates) {
        const sliced = sliceChart(chart, dateToTs(date));
        if (!sliced) continue;
        const stock = await parseYahooChartResult(
            sliced as Parameters<typeof parseYahooChartResult>[0],
            ticker,
            { skipTwelveData: true }
        );
        if (!stock) continue;
        const ohlc = ohlcFromChart(sliced);

        const real: SigName[] = [];
        const near: SigName[] = [];

        if (detectConsolidationBreakout(stock, ohlc.closes, ohlc.highs, ohlc.lows)) real.push('breakout');
        else if (detectConsolidationNearMiss(stock, ohlc.closes, ohlc.highs, ohlc.lows)) near.push('nearBreakout');

        if (qualifiesAsHighVolume(stock)) real.push('highVol');
        else if (qualifiesAsVolumeNearMiss(stock)) near.push('nearVol');

        if (qualifiesAsHealthyPullback(stock)) real.push('pullback');
        else if (qualifiesAsPullbackNearMiss(stock)) near.push('nearPullback');

        if (real.length + near.length === 0) continue;
        out.push({
            date,
            real,
            near,
            price: stock.lastPrice,
            rvol: stock.rvol,
            pctFromAth: stock.pctFromAth ?? null,
        });
    }
    return out;
}

// ─── Main ────────────────────────────────────────────────────────────
interface Transition {
    ticker: string;
    nearDate: string;
    nearType: SigName;        // nearBreakout / nearVol / nearPullback
    nearPrice: number;
    nearRvol: number;
    convertedTo: SigName | null;  // null = no conversion within horizon
    convertDate: string | null;
    daysToConvert: number | null;
    convertPrice: number | null;
    returnFromNearPct: number | null; // (priceLastInWindow - nearPrice) / nearPrice
}

interface RealEvent {
    ticker: string;
    date: string;
    type: SigName;            // breakout / highVol / pullback
    price: number;
    rvol: number;
    pctFromAth: number | null;
    returnToNowPct: number | null; // (priceLastInWindow - price) / price
    // 30-day forward stats
    return5td: number | null;
    return10td: number | null;
    return30td: number | null;
    maxDrawdown30td: number | null;
}

async function main() {
    await fetchAndCacheWatchlist();
    const tickers = [...new Set(loadWatchlist())];
    const dates = tradingDays(FROM, TO);
    console.error(`Window: ${FROM} → ${TO} (${dates.length} td)  |  Tickers: ${tickers.length}  |  Horizon: ${HORIZON}td`);

    const limit = pLimit(5);
    const allTimelines = new Map<string, DaySignal[]>();
    let done = 0;
    await Promise.all(tickers.map((t) => limit(async () => {
        const tl = await timelineForTicker(t, dates);
        allTimelines.set(t, tl);
        done++;
        if (done % 50 === 0) console.error(`  processed ${done}/${tickers.length}`);
    })));
    console.error(`Timelines built for ${allTimelines.size}/${tickers.length} tickers`);

    // ─── Build transitions + real-fresh events ───────────────────
    const transitions: Transition[] = [];
    const realEvents: RealEvent[] = [];
    const dateIdx = new Map<string, number>();
    dates.forEach((d, i) => dateIdx.set(d, i));

    for (const [ticker, tl] of allTimelines) {
        // Quick lookup
        const tlByDate = new Map<string, DaySignal>();
        tl.forEach((d) => tlByDate.set(d.date, d));

        const lastDayInWindow = tl.length > 0 ? tl[tl.length - 1]!.price : null;
        // Use the chart's actual last price as proxy for "current"
        const priceLast = lastDayInWindow;

        // Helper: forward stats from index i for `n` trading days
        const forwardStats = (i: number, n: number, startPrice: number): { ret: number | null; mdd: number | null } => {
            let lastPx: number | null = null;
            let minPx = startPrice;
            for (let j = 1; j <= n; j++) {
                if (i + j >= dates.length) break;
                const d = tlByDate.get(dates[i + j]!);
                if (!d) continue;
                lastPx = d.price;
                if (d.price < minPx) minPx = d.price;
            }
            return {
                ret: lastPx != null ? ((lastPx - startPrice) / startPrice) * 100 : null,
                mdd: minPx < startPrice ? ((minPx - startPrice) / startPrice) * 100 : 0,
            };
        };

        // Detect FRESH real-* appearances (NOT real yesterday, IS real today)
        const prevReal = new Set<SigName>();
        for (let i = 0; i < dates.length; i++) {
            const d = dates[i]!;
            const day = tlByDate.get(d);
            const todayReal = new Set<SigName>(day?.real ?? []);
            const fresh = [...todayReal].filter((s) => !prevReal.has(s));
            for (const realType of fresh) {
                const f5 = forwardStats(i, 5, day!.price);
                const f10 = forwardStats(i, 10, day!.price);
                const f30 = forwardStats(i, 30, day!.price);
                realEvents.push({
                    ticker, date: d, type: realType,
                    price: day!.price, rvol: day!.rvol, pctFromAth: day!.pctFromAth,
                    returnToNowPct: priceLast != null && day!.price > 0 ? ((priceLast - day!.price) / day!.price) * 100 : null,
                    return5td: f5.ret, return10td: f10.ret, return30td: f30.ret,
                    maxDrawdown30td: f30.mdd,
                });
            }
            prevReal.clear();
            todayReal.forEach((s) => prevReal.add(s));
        }

        // Detect FRESH near-* appearances (was not near yesterday, IS near today)
        const prevNear = new Set<SigName>();
        for (let i = 0; i < dates.length; i++) {
            const d = dates[i]!;
            const day = tlByDate.get(d);
            const todayNear = new Set<SigName>(day?.near ?? []);
            // Fresh appearance = in today's near set, NOT in yesterday's
            const fresh = [...todayNear].filter((s) => !prevNear.has(s));
            for (const nearType of fresh) {
                // Look ahead HORIZON days for first REAL signal
                let converted: { date: string; sig: SigName; price: number; days: number } | null = null;
                for (let j = 1; j <= HORIZON; j++) {
                    if (i + j >= dates.length) break;
                    const futD = dates[i + j]!;
                    const futDay = tlByDate.get(futD);
                    if (!futDay || futDay.real.length === 0) continue;
                    // Pick the "matched" real signal first if exists (e.g., nearBreakout → breakout)
                    const ideal = nearType === 'nearBreakout' ? 'breakout' : nearType === 'nearVol' ? 'highVol' : 'pullback';
                    const matchedReal = futDay.real.find((r) => r === ideal) ?? futDay.real[0]!;
                    converted = { date: futD, sig: matchedReal, price: futDay.price, days: j };
                    break;
                }

                transitions.push({
                    ticker,
                    nearDate: d,
                    nearType,
                    nearPrice: day!.price,
                    nearRvol: day!.rvol,
                    convertedTo: converted?.sig ?? null,
                    convertDate: converted?.date ?? null,
                    daysToConvert: converted?.days ?? null,
                    convertPrice: converted?.price ?? null,
                    returnFromNearPct: priceLast != null && day!.price > 0 ? ((priceLast - day!.price) / day!.price) * 100 : null,
                });
            }
            // Update prevNear for next iteration
            prevNear.clear();
            todayNear.forEach((s) => prevNear.add(s));
        }
    }

    console.error(`\nTotal fresh near-* events: ${transitions.length}`);
    fs.writeFileSync(path.join(OUTDIR, 'transitions.json'), JSON.stringify(transitions, null, 2));

    // ─── Stats by near-type ────────────────────────────────────────
    function stats(rows: Transition[]) {
        const n = rows.length;
        const converted = rows.filter((r) => r.convertedTo !== null);
        const within1 = rows.filter((r) => r.daysToConvert != null && r.daysToConvert <= 1).length;
        const within5 = rows.filter((r) => r.daysToConvert != null && r.daysToConvert <= 5).length;
        const within10 = rows.filter((r) => r.daysToConvert != null && r.daysToConvert <= 10).length;
        const matchedReal = rows.filter((r) =>
            r.convertedTo === (r.nearType === 'nearBreakout' ? 'breakout' : r.nearType === 'nearVol' ? 'highVol' : 'pullback')
        ).length;

        // Return stats among converted
        const rets = converted.map((r) => r.returnFromNearPct).filter((x): x is number => x != null).sort((a, b) => a - b);
        const stats = rets.length ? {
            median: rets[Math.floor(rets.length / 2)]!,
            mean: rets.reduce((a, b) => a + b, 0) / rets.length,
            hit: rets.filter((r) => r > 0).length / rets.length * 100,
        } : null;

        return { n, converted: converted.length, within1, within5, within10, matchedReal, returnStats: stats };
    }

    const byType: Record<string, ReturnType<typeof stats>> = {};
    for (const t of ['nearBreakout', 'nearVol', 'nearPullback'] as SigName[]) {
        byType[t] = stats(transitions.filter((r) => r.nearType === t));
    }

    console.error(`\n${'='.repeat(95)}`);
    console.error(`SILENT WATCHLIST → REAL SIGNAL CONVERSION (within ${HORIZON} trading days)`);
    console.error('='.repeat(95));
    console.error(`Type            n_events   conv_any   matched   ≤1td   ≤5td   ≤10td   median_ret_to_now   hit%`);
    for (const k of ['nearBreakout', 'nearVol', 'nearPullback']) {
        const s = byType[k]!;
        const r = s.returnStats;
        console.error(
            `  ${k.padEnd(14)} ${String(s.n).padStart(5)}  ${(s.converted / s.n * 100).toFixed(0).padStart(4)}%  `
            + `${(s.matchedReal / s.n * 100).toFixed(0).padStart(4)}%  `
            + `${(s.within1 / s.n * 100).toFixed(0).padStart(4)}%  `
            + `${(s.within5 / s.n * 100).toFixed(0).padStart(4)}%  `
            + `${(s.within10 / s.n * 100).toFixed(0).padStart(4)}%  `
            + `${r ? `${r.median.toFixed(1).padStart(7)}%  ${r.hit.toFixed(0)}%` : 'n/a'}`
        );
    }

    // ─── Examples — biggest "wins" per near-type ──────────────────
    for (const k of ['nearBreakout', 'nearVol', 'nearPullback'] as SigName[]) {
        const conv = transitions
            .filter((r) => r.nearType === k && r.convertedTo && r.returnFromNearPct != null)
            .sort((a, b) => (b.returnFromNearPct ?? 0) - (a.returnFromNearPct ?? 0))
            .slice(0, 10);
        console.error(`\nTop 10 ${k} → conversion winners:`);
        for (const r of conv) {
            console.error(
                `  ${r.ticker.padEnd(10)}  near ${r.nearDate}@$${r.nearPrice.toFixed(2)}  → `
                + `${r.convertedTo} ${r.convertDate} @$${r.convertPrice?.toFixed(2)} (+${r.daysToConvert}td)  `
                + `return-to-now: ${r.returnFromNearPct?.toFixed(0)}%`
            );
        }
    }

    // ─── REAL signal baseline ──────────────────────────────────────
    fs.writeFileSync(path.join(OUTDIR, 'real-events.json'), JSON.stringify(realEvents, null, 2));

    function realStats(rows: RealEvent[]) {
        const n = rows.length;
        if (!n) return null;
        const med = (key: 'returnToNowPct' | 'return5td' | 'return10td' | 'return30td' | 'maxDrawdown30td') => {
            const v = rows.map((r) => r[key]).filter((x): x is number => x != null).sort((a, b) => a - b);
            return v.length ? v[Math.floor(v.length / 2)]! : null;
        };
        const hit = (key: 'returnToNowPct' | 'return5td' | 'return10td' | 'return30td') => {
            const v = rows.map((r) => r[key]).filter((x): x is number => x != null);
            return v.length ? (v.filter((x) => x > 0).length / v.length) * 100 : null;
        };
        return {
            n,
            ret5td_med: med('return5td'), ret5td_hit: hit('return5td'),
            ret10td_med: med('return10td'), ret10td_hit: hit('return10td'),
            ret30td_med: med('return30td'), ret30td_hit: hit('return30td'),
            retToNow_med: med('returnToNowPct'), retToNow_hit: hit('returnToNowPct'),
            mdd30td_med: med('maxDrawdown30td'),
        };
    }

    const realByType: Record<string, ReturnType<typeof realStats>> = {};
    for (const t of ['breakout', 'highVol', 'pullback'] as SigName[]) {
        realByType[t] = realStats(realEvents.filter((r) => r.type === t));
    }

    console.error(`\n${'='.repeat(100)}`);
    console.error(`REAL SIGNAL BASELINE — fresh appearance per (ticker, signal-type)`);
    console.error('='.repeat(100));
    console.error(`Type        n    +5td_med   +5td_hit  +10td_med  +10td_hit  +30td_med  +30td_hit  toNow_med  toNow_hit  mdd30_med`);
    for (const k of ['breakout', 'highVol', 'pullback']) {
        const s = realByType[k];
        if (!s) continue;
        const fmt = (v: number | null) => v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : 'n/a';
        const pct = (v: number | null) => v != null ? `${v.toFixed(0)}%` : 'n/a';
        console.error(
            `  ${k.padEnd(10)} ${String(s.n).padStart(4)}  ${fmt(s.ret5td_med).padStart(8)}  ${pct(s.ret5td_hit).padStart(6)}  `
            + `${fmt(s.ret10td_med).padStart(8)}  ${pct(s.ret10td_hit).padStart(6)}  `
            + `${fmt(s.ret30td_med).padStart(8)}  ${pct(s.ret30td_hit).padStart(6)}  `
            + `${fmt(s.retToNow_med).padStart(8)}  ${pct(s.retToNow_hit).padStart(6)}  `
            + `${fmt(s.mdd30td_med).padStart(8)}`
        );
    }

    // Top winners per real type
    for (const k of ['breakout', 'highVol', 'pullback'] as SigName[]) {
        const top = realEvents
            .filter((r) => r.type === k && r.returnToNowPct != null)
            .sort((a, b) => (b.returnToNowPct ?? 0) - (a.returnToNowPct ?? 0))
            .slice(0, 10);
        console.error(`\nTop 10 ${k} (real) — return-to-now:`);
        for (const r of top) {
            console.error(
                `  ${r.ticker.padEnd(10)}  ${r.date} @ $${r.price.toFixed(2)}  RVOL ${r.rvol.toFixed(1)}x  `
                + `+5td: ${r.return5td?.toFixed(1) ?? 'n/a'}%  +30td: ${r.return30td?.toFixed(1) ?? 'n/a'}%  toNow: ${r.returnToNowPct?.toFixed(0)}%`
            );
        }
    }

    fs.writeFileSync(path.join(OUTDIR, 'summary.json'), JSON.stringify({
        window: { from: FROM, to: TO, horizon: HORIZON },
        nearByType: byType,
        realByType,
    }, null, 2));
    console.error(`\nWritten: ${OUTDIR}/transitions.json + real-events.json + summary.json`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
