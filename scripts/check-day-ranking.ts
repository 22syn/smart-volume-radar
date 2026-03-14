#!/usr/bin/env npx tsx
/**
 * Simulate Green-path ranking for a given date using historical Yahoo data.
 * Use for investigation: was ticker X #16 (cut by TOP_N)?
 *
 * Run: npx tsx scripts/check-day-ranking.ts [YYYY-MM-DD]
 * Default: 2026-03-11
 *
 * Tickers: from watchlist (if GOOGLE_SHEET_ID set) or fallback list.
 * NBIS always included for March 11 investigation.
 */
import 'dotenv/config';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import pLimit from 'p-limit';

const TARGET_DATE = process.argv[2] || '2026-03-11';
const LOOKBACK = 63;
const TOP_N = 15;
const limit = pLimit(3);

/** Fallback when watchlist unavailable (no sheet or fetch fails) */
const FALLBACK_TICKERS = [
    'DIFI.TA', 'USO', 'UCO', 'ENLT', 'LISN.SW', 'FIBI.TA', 'ECP.TA', 'TTE',
    'PTNR.TA', 'HBR.L', 'ITH.L', 'DSCT.TA', 'GNRS.TA', 'IGV', 'DELG.TA', 'SCOP.TA',
    'NBIS',
];

async function getTickersToCheck(): Promise<string[]> {
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        console.log('📋 Using fallback ticker list (GOOGLE_SHEET_ID not set)\n');
        return [...FALLBACK_TICKERS];
    }
    try {
        await fetchAndCacheWatchlist();
        const tickers = loadWatchlist();
        const withNbis = tickers.includes('NBIS') ? tickers : [...tickers, 'NBIS'];
        console.log(`📋 Loaded ${withNbis.length} tickers from watchlist (+ NBIS if missing)\n`);
        return withNbis;
    } catch (e) {
        console.warn('⚠️ Watchlist fetch failed, using fallback:', (e as Error).message);
        console.log('📋 Using fallback ticker list\n');
        return [...FALLBACK_TICKERS];
    }
}

async function fetchYahooChart(
    ticker: string
): Promise<{ timestamps: number[]; closes: number[]; volumes: number[] } | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const result = (json?.chart as Record<string, unknown>)?.result as Record<string, unknown>[] | undefined;
    const r0 = result?.[0] as Record<string, unknown> | undefined;
    const timestamps = (r0?.timestamp as number[]) ?? [];
    const quoteArr = (r0?.indicators as Record<string, unknown>)?.quote as Record<string, unknown>[] | undefined;
    const quote = quoteArr?.[0] as Record<string, unknown> | undefined;
    const rawCloses = (quote?.close as (number | null)[]) ?? [];
    const rawVols = (quote?.volume as (number | null)[]) ?? [];

    const closes: number[] = [];
    const volumes: number[] = [];
    const tsOut: number[] = [];
    for (let i = 0; i < timestamps.length; i++) {
        const c = rawCloses[i];
        if (c != null && c > 0) {
            closes.push(c);
            volumes.push(rawVols[i] != null && rawVols[i]! > 0 ? rawVols[i]! : 0);
            tsOut.push(timestamps[i]);
        }
    }
    return { timestamps: tsOut, closes, volumes };
}

function dateFromTs(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
    const tickers = await getTickersToCheck();
    console.log(`\n📊 דירוג Green (RVOL + Δ%≥2%) — ${TARGET_DATE}\n`);

    type Row = { ticker: string; close: number; rvol: number; priceChange: number; green: boolean };

    const results = await Promise.all(
        tickers.map((ticker) =>
            limit(async (): Promise<Row> => {
                const data = await fetchYahooChart(ticker);
                if (!data) return { ticker, close: 0, rvol: 0, priceChange: 0, green: false };

                const { timestamps, closes, volumes } = data;
                const dayRows: Array<{ date: string; close: number; volume: number }> = [];
                for (let i = 0; i < timestamps.length; i++) {
                    if (closes[i] > 0) {
                        dayRows.push({
                            date: dateFromTs(timestamps[i]),
                            close: closes[i],
                            volume: volumes[i] ?? 0,
                        });
                    }
                }

                const idx = dayRows.findIndex((r) => r.date === TARGET_DATE);
                if (idx < 0) return { ticker, close: 0, rvol: 0, priceChange: 0, green: false };

                const close = dayRows[idx].close;
                const volume = dayRows[idx].volume;
                const prevClose = idx >= 1 ? dayRows[idx - 1].close : close;
                const priceChange = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0;

                const volHistory = dayRows
                    .slice(Math.max(0, idx - LOOKBACK), idx)
                    .map((r) => r.volume)
                    .filter((v) => v > 0);
                const avgVol = volHistory.length > 0 ? volHistory.reduce((a, b) => a + b, 0) / volHistory.length : 0;
                const rvol = avgVol > 0 ? volume / avgVol : 0;
                const green = rvol >= 2 && Math.abs(priceChange) >= 2;
                return { ticker, close, rvol, priceChange, green };
            })
        )
    );

    const rows = results;

    // Sort: green first, then by RVOL desc (same as rvolCalculator)
    rows.sort((a, b) => {
        if (a.green !== b.green) return a.green ? -1 : 1;
        return b.rvol - a.rvol;
    });

    console.log('| #  | Ticker    | RVOL  | Δ%      | Green |');
    console.log('|----|-----------|-------|---------|-------|');
    rows.forEach((r, i) => {
        const mark = r.ticker === 'NBIS' ? ' ←' : '';
        const ch = (r.priceChange >= 0 ? '+' : '') + r.priceChange.toFixed(1) + '%';
        console.log(`| ${(i + 1).toString().padStart(2)} | ${r.ticker.padEnd(9)} | ${r.rvol.toFixed(2).padStart(5)} | ${ch.padStart(7)} | ${r.green ? '✅' : '❌'}    |${mark}`);
    });

    const nbIdx = rows.findIndex((r) => r.ticker === 'NBIS');
    const greenCount = rows.filter((r) => r.green).length;
    const greenRows = rows.filter((r) => r.green);
    const rank16 = greenRows[TOP_N]; // First one cut by TOP_N=15
    console.log(`\nNBIS: מקום ${nbIdx >= 0 ? nbIdx + 1 : '?'} מתוך ${rows.length} | Green: ${greenCount} | TOP_N=${TOP_N}`);
    if (rank16) {
        console.log(`\nמקום 16 (חתוך): ${rank16.ticker} — RVOL ${rank16.rvol.toFixed(2)} | Δ% ${rank16.priceChange >= 0 ? '+' : ''}${rank16.priceChange.toFixed(1)}%`);
    }
}

main().catch(console.error);
