/**
 * One-off: regenerate the Telegram daily report locally and print it as plain text
 * (HTML stripped). Does NOT send to Telegram. Used to review what the scheduled
 * run produces without spamming the chat.
 */
import { loadWatchlist, fetchAndCacheWatchlist, getSectorForTicker, validateConfig } from '../src/config/index.js';
import { fetchAllStocksAsOfDate, fetchMarketRegime } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
// enrichWithNews removed 2026-05-22 with news feature cleanup.
import { formatDailyReport } from '../src/services/telegramBot.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';
import type { RVOLResult } from '../src/types/index.js';

async function main(): Promise<void> {
    try {
        validateConfig();
    } catch {
        // continue
    }
    await fetchAndCacheWatchlist();
    const tickers = loadWatchlist();
    const scanDate = getLastTradingDay();
    const regime = await fetchMarketRegime(scanDate);
    const { stocks } = await fetchAllStocksAsOfDate(tickers, scanDate);
    for (const s of stocks) {
        s.marketRegime = regime;
        s.momentum = evaluateMomentumSetup(s, { regime });
    }
    const momentumStocks = stocks.filter(
        (s) => s.momentum?.level === 'full' || s.momentum?.level === 'close' || s.momentum?.level === 'recovery'
    );
    const tierRank = (lvl: 'full' | 'close' | 'recovery' | 'none' | undefined): number =>
        lvl === 'full' ? 0 : lvl === 'recovery' ? 1 : lvl === 'close' ? 2 : 3;
    momentumStocks.sort((a, b) => {
        const t = tierRank(a.momentum?.level) - tierRank(b.momentum?.level);
        return t !== 0 ? t : (b.rvol ?? 0) - (a.rvol ?? 0);
    });
    const finalSignals: RVOLResult[] = momentumStocks.map((s) => ({
        ...s,
        sector: getSectorForTicker(s.ticker),
        isVolumeWithoutPrice: false,
    }));
    const report = formatDailyReport(scanDate, finalSignals, []);
    // Strip HTML for terminal readability
    const plain = report.replace(/<a [^>]*>([^<]*)<\/a>/g, '$1').replace(/<[^>]+>/g, '');
    console.log('━━━━━ TELEGRAM REPORT (plain text) ━━━━━');
    console.log(plain);
    console.log('━━━━━ END ━━━━━');
    console.log(`\n[${finalSignals.length} momentum signals on ${scanDate}]`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
