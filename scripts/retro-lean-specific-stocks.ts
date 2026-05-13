#!/usr/bin/env npx tsx
/**
 * Lean Radar — retro test on specific tickers.
 *
 * For each ticker:
 *   1. Fetch 5y Yahoo chart
 *   2. Walk every trading day in the last 2 years
 *   3. At each day, slice chart + parse + run all 3 Lean detectors
 *   4. Record every firing (breakout / high-vol / pullback) with full context
 *   5. Independently find the "canonical breakout date" — first day price
 *      hit a new 52w high after at least 30 days of consolidation
 *   6. Compute: would Lean have caught it on time (= within ±5 trading
 *      days of the canonical date)?
 *
 * Output: outputs/retro-lean-tickers.json + console table.
 *
 * Usage:  BACKTEST_MODE=1 npx tsx scripts/retro-lean-specific-stocks.ts
 *         [--tickers INTC,AMKR,NBIS,WOLF]
 *         [--from 2024-05-13] [--to 2026-05-12]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
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

// ─── CLI ─────────────────────────────────────────────────────────────
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const TICKERS = arg('tickers', 'INTC,AMKR,NBIS,WOLF').split(',').map((s) => s.trim()).filter(Boolean);
const FROM = arg('from', '2024-05-13');
const TO = arg('to', '2026-05-12');
const OUTDIR = 'outputs/retro-lean';
fs.mkdirSync(OUTDIR, { recursive: true });

// ─── Yahoo fetch + slice (mirrors backtest-watchlist) ────────────────
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
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        });
        if (!res.ok) {
            if (retries > 0) {
                await new Promise((r) => setTimeout(r, 500));
                return fetchRawChart(ticker, retries - 1);
            }
            return null;
        }
        const data = (await res.json()) as { chart?: { result?: RawChart[] } };
        return data?.chart?.result?.[0] ?? null;
    } catch {
        if (retries > 0) {
            await new Promise((r) => setTimeout(r, 500));
            return fetchRawChart(ticker, retries - 1);
        }
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
        indicators: {
            quote: [
                {
                    open: sl(q?.open),
                    close: sl(q?.close),
                    high: sl(q?.high),
                    low: sl(q?.low),
                    volume: sl(q?.volume),
                },
            ],
        },
    };
}

function dateToTs(d: string): number {
    return new Date(d + 'T23:59:59Z').getTime() / 1000;
}

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

// ─── Canonical-breakout detector (objective, doesn't use Lean) ────────
/**
 * A canonical breakout day: price closed at a new 252-day high AFTER at
 * least 30 trading days of consolidation (i.e. no new high in the prior
 * 30 days). Returns sorted list of breakout dates.
 */
function findCanonicalBreakouts(chart: RawChart, from: string, to: string): Array<{ date: string; price: number; priorBaseDays: number }> {
    const ts = chart.timestamp ?? [];
    const closes = chart.indicators?.quote?.[0]?.close ?? [];
    if (!ts.length || !closes.length) return [];
    const fromTs = dateToTs(from);
    const toTs = dateToTs(to);

    const out: Array<{ date: string; price: number; priorBaseDays: number }> = [];
    for (let i = 252; i < ts.length; i++) {
        if (ts[i]! < fromTs || ts[i]! > toTs) continue;
        const c = closes[i];
        if (c == null) continue;
        // is this a new 252-day high?
        let prior = closes.slice(i - 252, i).filter((x): x is number => x != null);
        if (!prior.length) continue;
        const priorHigh = Math.max(...prior);
        if (c <= priorHigh) continue;

        // Find days since LAST new high (= consolidation length)
        let priorBaseDays = 0;
        for (let j = i - 1; j >= 252; j--) {
            const cj = closes[j];
            if (cj == null) continue;
            const prior2 = closes.slice(j - 252, j).filter((x): x is number => x != null);
            if (!prior2.length) continue;
            const ph2 = Math.max(...prior2);
            if (cj > ph2) break; // last new-high day
            priorBaseDays++;
        }
        if (priorBaseDays < 30) continue;
        out.push({
            date: new Date(ts[i]! * 1000).toISOString().slice(0, 10),
            price: c,
            priorBaseDays,
        });
    }
    return out;
}

// ─── Build OHLC arrays from sliced chart for the detectors ────────────
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

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    const dates = tradingDays(FROM, TO);
    console.error(`Window: ${FROM} → ${TO} (${dates.length} trading days)`);
    console.error(`Tickers: ${TICKERS.join(', ')}`);

    interface Firing {
        date: string;
        signal: 'breakout' | 'highVol' | 'pullback' | 'nearBreakout' | 'nearVol' | 'nearPullback';
        rvol: number;
        price: number;
        pctFromAth: number | undefined;
        detail: string;
    }
    interface TickerReport {
        ticker: string;
        priceFirst: number | null;
        priceLast: number | null;
        return: number | null;
        canonicalBreakouts: Array<{ date: string; price: number; priorBaseDays: number }>;
        firings: Firing[];
        firstFiring: Firing | null;
        // analysis
        leanCaughtCanonical: Array<{ canonical: string; canonicalPrice: number; lean: Firing | null; daysOffset: number | null }>;
    }
    const report: TickerReport[] = [];

    for (const ticker of TICKERS) {
        console.error(`\n=== ${ticker} ===`);
        const chart = await fetchRawChart(ticker);
        if (!chart) {
            console.error(`  ❌ no data`);
            continue;
        }

        const canonical = findCanonicalBreakouts(chart, FROM, TO);
        console.error(`  canonical breakouts in window: ${canonical.length}`);
        for (const c of canonical.slice(0, 10)) {
            console.error(`    ${c.date}  $${c.price.toFixed(2)}  (after ${c.priorBaseDays} consolidation days)`);
        }

        // First+last price in window
        const ts = chart.timestamp ?? [];
        const closes = chart.indicators?.quote?.[0]?.close ?? [];
        const fromTs = dateToTs(FROM), toTs = dateToTs(TO);
        let priceFirst: number | null = null, priceLast: number | null = null;
        for (let i = 0; i < ts.length; i++) {
            if (closes[i] == null) continue;
            if (ts[i]! >= fromTs && priceFirst == null) priceFirst = closes[i]!;
            if (ts[i]! <= toTs) priceLast = closes[i]!;
        }

        // Walk each day, run Lean detectors
        const firings: Firing[] = [];
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

            const c = detectConsolidationBreakout(stock, ohlc.closes, ohlc.highs, ohlc.lows);
            if (c) {
                firings.push({
                    date,
                    signal: 'breakout',
                    rvol: stock.rvol,
                    price: stock.lastPrice,
                    pctFromAth: stock.pctFromAth,
                    detail: `${c.window} base, ${c.baseRangePct.toFixed(1)}% range, pivot $${c.windowHigh.toFixed(2)}`,
                });
            } else {
                const nc = detectConsolidationNearMiss(stock, ohlc.closes, ohlc.highs, ohlc.lows);
                if (nc) {
                    firings.push({
                        date,
                        signal: 'nearBreakout',
                        rvol: stock.rvol,
                        price: stock.lastPrice,
                        pctFromAth: stock.pctFromAth,
                        detail: `${nc.window} base, ${nc.distanceToPivotPct.toFixed(1)}% below pivot $${nc.windowHigh.toFixed(2)}`,
                    });
                }
            }

            const v = qualifiesAsHighVolume(stock);
            if (v) {
                firings.push({
                    date,
                    signal: 'highVol',
                    rvol: stock.rvol,
                    price: stock.lastPrice,
                    pctFromAth: stock.pctFromAth,
                    detail: `${v.level === 'extreme' ? 'EXTREME' : 'high'} volume (${stock.rvol.toFixed(1)}x)`,
                });
            } else {
                const nv = qualifiesAsVolumeNearMiss(stock);
                if (nv) {
                    firings.push({
                        date,
                        signal: 'nearVol',
                        rvol: stock.rvol,
                        price: stock.lastPrice,
                        pctFromAth: stock.pctFromAth,
                        detail: `near 3x (${nv.rvol.toFixed(2)}x)`,
                    });
                }
            }

            const p = qualifiesAsHealthyPullback(stock);
            if (p) {
                firings.push({
                    date,
                    signal: 'pullback',
                    rvol: stock.rvol,
                    price: stock.lastPrice,
                    pctFromAth: stock.pctFromAth,
                    detail: `pullback ${p.pctFromAth.toFixed(1)}% from ATH`,
                });
            } else {
                const np = qualifiesAsPullbackNearMiss(stock);
                if (np) {
                    firings.push({
                        date,
                        signal: 'nearPullback',
                        rvol: stock.rvol,
                        price: stock.lastPrice,
                        pctFromAth: stock.pctFromAth,
                        detail: `near pullback band (${np.pctFromAth.toFixed(1)}% from ATH)`,
                    });
                }
            }
        }

        // First REAL firing (excluding near-miss)
        const firstReal = firings.find((f) => ['breakout', 'highVol', 'pullback'].includes(f.signal)) ?? null;
        console.error(`  Lean firings total: ${firings.length} (real: ${firings.filter((f) => ['breakout', 'highVol', 'pullback'].includes(f.signal)).length})`);
        console.error(`  first real firing: ${firstReal ? `${firstReal.date} (${firstReal.signal}: ${firstReal.detail})` : 'NEVER'}`);

        // Cross-reference: for each canonical breakout, find the nearest Lean firing within ±10 td
        const caught: TickerReport['leanCaughtCanonical'] = canonical.map((c) => {
            const cDate = c.date;
            const cTs = dateToTs(cDate);
            let nearest: Firing | null = null;
            let nearestDays = Infinity;
            for (const f of firings) {
                if (f.signal === 'nearBreakout' || f.signal === 'nearVol' || f.signal === 'nearPullback') continue;
                const days = Math.round((dateToTs(f.date) - cTs) / 86400);
                if (Math.abs(days) < Math.abs(nearestDays)) {
                    nearestDays = days;
                    nearest = f;
                }
            }
            return {
                canonical: c.date,
                canonicalPrice: c.price,
                lean: nearest && Math.abs(nearestDays) <= 14 ? nearest : null,
                daysOffset: nearest && Math.abs(nearestDays) <= 14 ? nearestDays : null,
            };
        });

        report.push({
            ticker,
            priceFirst,
            priceLast,
            return: priceFirst && priceLast ? ((priceLast - priceFirst) / priceFirst) * 100 : null,
            canonicalBreakouts: canonical,
            firings,
            firstFiring: firstReal,
            leanCaughtCanonical: caught,
        });
    }

    fs.writeFileSync(path.join(OUTDIR, 'retro-lean-tickers.json'), JSON.stringify(report, null, 2));

    // ─── Summary table ─────────────────────────────────────────────
    console.error(`\n${'='.repeat(80)}`);
    console.error(`CANONICAL BREAKOUT vs LEAN CATCH`);
    console.error('='.repeat(80));
    for (const t of report) {
        console.error(`\n${t.ticker} ($${t.priceFirst?.toFixed(2)} → $${t.priceLast?.toFixed(2)} = ${(t.return ?? 0).toFixed(0)}%)`);
        console.error(`  ${t.canonicalBreakouts.length} canonical breakouts, ${t.firings.filter((f) => ['breakout', 'highVol', 'pullback'].includes(f.signal)).length} Lean real firings`);
        for (const c of t.leanCaughtCanonical) {
            const status = !c.lean
                ? `❌ MISSED (no Lean firing within ±14td)`
                : c.daysOffset === 0
                    ? `✅ caught SAME DAY (${c.lean.signal})`
                    : c.daysOffset! < 0
                        ? `✅ caught ${Math.abs(c.daysOffset!)}td EARLY (${c.lean.signal} on ${c.lean.date})`
                        : `⏱ caught ${c.daysOffset}td LATE (${c.lean.signal} on ${c.lean.date})`;
            console.error(`  canonical ${c.canonical} @ $${c.canonicalPrice.toFixed(2)} → ${status}`);
        }
    }

    console.error(`\nWritten: ${OUTDIR}/retro-lean-tickers.json`);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
