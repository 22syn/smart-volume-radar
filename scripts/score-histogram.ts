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

  // Score histogram
  const bins = [
    [100, 100], [90, 99], [80, 89], [70, 79], [60, 69],
    [50, 59], [40, 49], [30, 39], [20, 29], [0, 19]
  ];
  console.log(`\n📊 Score distribution (${stocks.length} stocks):\n`);
  console.log('Score range | Count | Action breakdown');
  console.log('─'.repeat(85));

  for (const [lo, hi] of bins) {
    const inBin = stocks.filter(s => (s.championScore ?? 0) >= lo && (s.championScore ?? 0) <= hi);
    if (inBin.length === 0) continue;
    const acts: Record<string, number> = {};
    for (const s of inBin) {
      const a = s.action ?? '?';
      acts[a] = (acts[a] ?? 0) + 1;
    }
    const breakdown = Object.entries(acts).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k}=${v}`).join(' | ');
    const label = lo === hi ? `${lo}` : `${lo}-${hi}`;
    console.log(`  ${label.padStart(7)}    | ${String(inBin.length).padStart(5)} | ${breakdown}`);
  }

  // Cumulative counts (≥ threshold)
  console.log(`\n📈 Cumulative count (≥ score threshold):\n`);
  for (const t of [50, 60, 65, 70, 75, 80, 85, 90, 95, 100]) {
    const count = stocks.filter(s => (s.championScore ?? 0) >= t).length;
    const cleanActions = stocks.filter(s =>
      (s.championScore ?? 0) >= t &&
      (s.action === 'BUY' || s.action === 'WATCH' || s.action === 'CAUTION_EXTENDED')
    ).length;
    const cleanWithRvol = stocks.filter(s =>
      (s.championScore ?? 0) >= t &&
      (s.action === 'BUY' || s.action === 'WATCH' || s.action === 'CAUTION_EXTENDED') &&
      (s.rvol ?? 0) >= 1.5
    ).length;
    console.log(`  score ≥ ${String(t).padStart(3)}  →  ${String(count).padStart(3)} stocks  |  ${cleanActions} clean actions  |  ${cleanWithRvol} clean + RVOL≥1.5`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
