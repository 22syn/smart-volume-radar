# Architecture

## Services

| Service | File | Purpose |
|---------|------|---------|
| Market data | `marketData.ts` | Yahoo Finance (primary) + Twelve Data (fallback); p-limit |
| RVOL | `rvolCalculator.ts` | Filter MIN_RVOL, sort desc, slice TOP_N |
| News | `newsService.ts` | Finnhub headlines; Israeli names cache |
| Telegram | `telegramBot.ts` | Format daily report (sectors, signals); send |
| LLM | `llmSummary.ts` | Optional AI summary — OpenAI / Perplexity / Gemini |

## Concurrency

```ts
import pLimit from 'p-limit';
const marketLimit = pLimit(3);   // 3–5 tickers in parallel
const newsLimit   = pLimit(2);   // 2 news requests in parallel

await Promise.all(tickers.map(t => marketLimit(() => fetchStock(t))));
```

Never use `sleep()` for rate limiting.

## Error Handling

```ts
// Services: return null/[] on failure
async function fetchStock(ticker: string): Promise<StockData | null> {
  try { ... }
  catch (err) { logger.warn('fetchStock failed', { ticker, err }); return null; }
}

// main(): catch all, notify, exit
catch (err) {
  logger.error('Fatal', err);
  await sendTelegramMessage(formatErrorForTelegram(err));
  process.exit(1);
}
```

## Caches

- `tickerCache` — watchlist tickers, built by `fetchAndCacheWatchlist()`
- `sectorMap` — `Map<string, string>` for O(1) sector lookup, built after watchlist load
- `_israeliNamesCache` — lazy-init getter in `newsService.ts`

## Signal Storage & Weekly Evaluation

- Daily scan → `results/scan-YYYY-MM-DD.json` (gitignored)
- CI uploads as artifact (90-day retention)
- `npm run evaluate-setups` → `scripts/evaluate-setups.ts`:
  1. `gh run download` — last 7 days artifacts
  2. Fetch current prices
  3. Compute % change for 🎯 signals
  4. Send summary to Telegram

## Twelve Data Fallback

When Yahoo fails: provides volume, avgVolume, RVOL, priceChange, lastPrice, RSI, SMA21, 52w high.
Note: `monthsInConsolidation` not available from Twelve Data.
