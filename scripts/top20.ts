import { loadWatchlist, fetchAndCacheWatchlist, validateConfig, getSectorForTicker } from '../src/config/index.js';
import { fetchAllStocksAsOfDate, fetchMarketRegime, fetchSpy63dReturn } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { applyChampionScore } from '../src/utils/championScore.js';
import { applyRSPercentile } from '../src/utils/rsPercentile.js';
import { applySectorRanks } from '../src/utils/sectorRank.js';
import { getLastTradingDay } from '../src/utils/tradingDate.js';

async function main() {
  try { validateConfig(); } catch {}
  await fetchAndCacheWatchlist();
  const tickers = loadWatchlist();
  const scanDate = getLastTradingDay();
  const regime = await fetchMarketRegime(scanDate);
  const { stocks } = await fetchAllStocksAsOfDate(tickers, scanDate);
  for (const s of stocks) {
    s.sector = getSectorForTicker(s.ticker);
    s.marketRegime = regime;
    s.momentum = evaluateMomentumSetup(s, { regime });
    applyChampionScore(s);
  }
  const spy = await fetchSpy63dReturn(scanDate);
  applyRSPercentile(stocks, spy);
  applySectorRanks(stocks);
  for (const s of stocks) applyChampionScore(s);

  // Sort by Champion Score desc, tie-break by RVOL desc
  const sorted = [...stocks].sort((a, b) => {
    const scoreDiff = (b.championScore ?? 0) - (a.championScore ?? 0);
    if (Math.abs(scoreDiff) > 0.5) return scoreDiff;
    return (b.rvol ?? 0) - (a.rvol ?? 0);
  });

  const top = sorted.slice(0, 20);

  console.log(`\n📊 TOP 20 — sorted by Champion Score (regime: ${regime}, scan: ${scanDate})\n`);
  console.log(
    `Rank | Ticker      | Score | Action               | Stage         | RVOL  | Pos vs ATH | Sector`
  );
  console.log('─'.repeat(120));

  top.forEach((s, i) => {
    const ticker = s.ticker.padEnd(11);
    const score = (s.championScore ?? 0).toFixed(0).padStart(3);
    const action = (s.action ?? '?').padEnd(20);
    const stage = (s.breakoutStage ?? '?').padEnd(13);
    const rvol = (s.rvol ?? 0).toFixed(2).padStart(5);
    const ext = s.tradePlan?.extensionPct ?? 0;
    const dist = s.tradePlan?.distanceToEntryPct ?? 0;
    const posDesc = ext > 0 ? `+${ext.toFixed(1)}% past pivot` : `-${dist.toFixed(1)}% to pivot`;
    const sector = (s.sector ?? '?').slice(0, 25);
    const rank = String(i + 1).padStart(2);
    console.log(
      `  ${rank} | ${ticker} |   ${score} | ${action} | ${stage} | ${rvol}x | ${posDesc.padEnd(20)} | ${sector}`
    );
  });
}
main().catch(e => { console.error(e); process.exit(1); });
