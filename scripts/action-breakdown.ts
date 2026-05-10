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
  for (const s of stocks) applyChampionScore(s);  // re-apply with sector

  const dist: Record<string, number> = {};
  const sample: Record<string, string[]> = {};
  for (const s of stocks) {
    const a = s.action ?? 'UNDEFINED';
    dist[a] = (dist[a] ?? 0) + 1;
    if (!sample[a]) sample[a] = [];
    if (sample[a].length < 5) {
      sample[a].push(`${s.ticker} score=${s.championScore} stage=${s.breakoutStage ?? '?'} rvol=${(s.rvol??0).toFixed(2)} ext=${s.tradePlan?.extensionPct?.toFixed(1) ?? '?'}%`);
    }
  }
  console.log(`\nTotal scanned: ${stocks.length}`);
  console.log(`Regime: ${regime}\n`);
  console.log('Action distribution:');
  for (const [a, n] of Object.entries(dist).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${a.padEnd(20)} ${String(n).padStart(4)}`);
  }
  console.log('\nFirst 5 examples per action:');
  for (const a of Object.keys(dist).sort()) {
    console.log(`\n[${a}]`);
    for (const ex of sample[a]) console.log(`  ${ex}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
