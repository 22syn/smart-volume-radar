#!/usr/bin/env npx tsx
/**
 * Replay March 11 scan using PRODUCTION code only.
 * - fetchYahooChartAsOfDate: same parseYahooChartResult as production (including volume bug)
 * - calculateRVOL: same filtering/sorting as production
 *
 * Run: npx tsx scripts/replay-march11-production.ts [YYYY-MM-DD]
 * Default: 2026-03-11
 */
import 'dotenv/config';
import { fetchAndCacheWatchlist, loadWatchlist } from '../src/config/index.js';
import { fetchYahooChartAsOfDate } from '../src/services/marketData.js';
import { calculateRVOL } from '../src/services/rvolCalculator.js';
import { config } from '../src/config/index.js';
import pLimit from 'p-limit';

const AS_OF_DATE = process.argv[2] || '2026-03-11';
const limit = pLimit(3);

const FALLBACK_TICKERS = [
    'DIFI.TA', 'USO', 'UCO', 'ENLT', 'LISN.SW', 'FIBI.TA', 'ECP.TA', 'TTE',
    'PTNR.TA', 'HBR.L', 'ITH.L', 'DSCT.TA', 'GNRS.TA', 'IGV', 'DELG.TA', 'SCOP.TA',
    'NBIS',
];

async function getTickers(): Promise<string[]> {
    if (!process.env.GOOGLE_SHEET_ID?.trim()) {
        return [...FALLBACK_TICKERS];
    }
    try {
        await fetchAndCacheWatchlist();
        const tickers = loadWatchlist();
        return tickers.includes('NBIS') ? tickers : [...tickers, 'NBIS'];
    } catch {
        return [...FALLBACK_TICKERS];
    }
}

async function main(): Promise<void> {
    console.log(`\n📊 Replay using PRODUCTION code (marketData + rvolCalculator) — as of ${AS_OF_DATE}\n`);

    const tickers = await getTickers();
    console.log(`📋 Tickers: ${tickers.length}\n`);

    const results = await Promise.all(
        tickers.map((t) => limit(() => fetchYahooChartAsOfDate(t, AS_OF_DATE)))
    );

    const stocks = results.filter((s): s is NonNullable<typeof s> => s != null);
    const failed = tickers.filter((_, i) => results[i] == null);

    console.log(`✅ Fetched: ${stocks.length}/${tickers.length} | Failed: ${failed.join(', ') || 'none'}\n`);

    const { topSignals, debug } = calculateRVOL(stocks, {
        minRVOL: config.minRVOL,
        topN: config.topN,
        priceChangeThreshold: config.priceChangeThreshold,
    });

    console.log('Green ranking (production logic):');
    console.log('| #  | Ticker    | RVOL  | Δ%      |');
    console.log('|----|-----------|-------|---------|');
    debug.greenSortedFull.forEach((e, i) => {
        const ch = (e.priceChange >= 0 ? '+' : '') + e.priceChange.toFixed(1) + '%';
        const mark = e.ticker === 'NBIS' ? ' ←' : '';
        console.log(`| ${(i + 1).toString().padStart(2)} | ${e.ticker.padEnd(9)} | ${e.rvol.toFixed(2).padStart(5)} | ${ch.padStart(7)} |${mark}`);
    });

    const nbIdx = debug.greenSortedFull.findIndex((e) => e.ticker === 'NBIS');
    const rank16 = debug.greenSortedFull[config.topN];
    console.log(`\nNBIS: rank ${nbIdx >= 0 ? nbIdx + 1 : 'N/A (not in green)'} of ${debug.greenCount} green | TOP_N=${config.topN}`);
    if (rank16) {
        console.log(`Rank 16 (cut): ${rank16.ticker} — RVOL ${rank16.rvol.toFixed(2)}`);
    }
}

main().catch(console.error);
