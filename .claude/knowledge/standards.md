# Standards & Conventions

Node.js CLI — no React. Extends base-coding-standards.

## Naming

| Pattern | Prefix | Examples |
|---------|--------|---------|
| Network | `fetch` | `fetchAllStocks`, `fetchFromYahooChart` |
| Cache/file | `load` | `loadWatchlist` |
| Sync access | `get` | `getSectorForTicker`, `getIsraeliNames` |
| Calculation | `calculate` | `calculateSMA`, `calculateRSI` |
| Format | `format` | `formatDailyReport`, `formatRVOL` |
| Validate | `validate` | `validateTicker`, `validateConfig` |
| Booleans | `is`/`has`/`use`/`enable` | `isFullSetup`, `enableLlmSummary` |
| Constants | `SCREAMING_SNAKE` | `TICKER_REGEX`, `TELEGRAM_MAX_LENGTH` |
| Config keys | `camelCase` | `minRVOL`, `topN` |

## Data Rules

- Normalize at API boundary — Yahoo/Finnhub → typed interfaces in the fetching service
- `Array.isArray(x) ? x : [x]` — when API may return single item
- `Map` for O(1) keyed lookups; `Set` for dedup; `Record` for grouping
- Params: object when 4+ related; individual otherwise

## Logging

```ts
logger.info('...', { context });   // ✅
logger.warn('...', { ticker });    // ✅
logger.error('...', err);          // ✅
console.log('...');                // ❌ never
```

## Security

- `validateTicker(ticker)` before any URL construction
- `encodeURIComponent(ticker)` in all API URLs
- `escapeHtml()` before any string in Telegram HTML messages
- Never expose API keys in logs

## What NOT To Do

- ❌ `console.log` — use logger
- ❌ `sleep()` — use p-limit
- ❌ Inline setup criteria — use `isFullSetup`/`isCloseSetup` from `setup.ts`
- ❌ Skip `escapeHtml` in Telegram message building
- ❌ Commit `results/` folder
