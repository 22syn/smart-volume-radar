> Consolidated 2026-06-02 - merged from the Cowork cabinet. This `.claude/` is the single source of truth. Agent/CI setup lives in `AGENTS.md` (repo root); coding standards in `docs/standards-for-ci.md`.

# Smart Volume Radar — Project Workspace

Stock volume monitoring bot. Identifies unusual trading (RVOL), enriches with news, sends formatted reports to Telegram. Before any task, read this file — it has everything you need inline.

**Stack:** Node.js ≥20, TypeScript 5.9, ESM, tsx
**APIs:** Yahoo Finance (primary), Twelve Data (fallback), Finnhub (news), Telegram Bot
**CI/CD:** GitHub Actions — daily scan + weekly performance evaluation
**Project path:** `~/Documents/Claude/Projects/smart-volume-radar-engine`

---

## How to Run

```sh
cd ~/Documents/Claude/Projects/smart-volume-radar-engine
npm install
npm run start           # daily scan
npm run evaluate-setups # weekly performance report
npm run test            # Jest
```

---

## Folder Map (project)

```
src/
  index.ts          → orchestration pipeline
  config/           → env vars, Google Sheet watchlist, validateConfig, sector map
  services/
    marketData.ts   → Yahoo + Twelve Data; p-limit concurrency
    rvolCalculator.ts
    newsService.ts  → Finnhub; Israeli names cache
    telegramBot.ts  → format + send
    llmSummary.ts   → optional AI summary
  utils/
    technicalAnalysis.ts → calculateSMA, calculateRSI, isNearSMA
    setup.ts        → isFullSetup, isCloseSetup  ← single source of truth
    formatters.ts   → formatRVOL, formatPriceChange
    logger.ts       → structured logging (NO console.log)
    errorHandler.ts → formatErrorForTelegram
    escapeHtml.ts   → safe Telegram HTML
    writeScanResults.ts
scripts/
  evaluate-setups.ts → download CI artifacts, fetch prices, report % change
results/              → scan-YYYY-MM-DD.json (gitignored)
```

---

## Data Pipeline

```
1. fetchAndCacheWatchlist()  → Google Sheet → ticker list + sector map
2. fetchAllStocks()          → Yahoo chart API (or Twelve Data fallback)
3. calculateRVOL()           → filter MIN_RVOL, sort, TOP_N
4. enrichWithNews()          → Finnhub headlines
5. sendDailyReport()         → format + Telegram
6. writeScanResults()        → results/scan-YYYY-MM-DD.json
```

---

## Setup Signals

**Full Setup 🎯** (all 4 must be true):
```
RVOL ≥ MIN_RVOL  AND  nearSMA21  AND  nearAth  AND  inConsolidationWindow
```

**Close Setup 👀** (close on each):
```
RVOL ≥ MIN_RVOL  AND  (nearSMA21 OR nearSMA21Close)
               AND  (nearAth OR nearAthClose)
               AND  (inConsolidationWindow OR inConsolidationClose)
```

Source of truth: `src/utils/setup.ts`. Never inline these criteria elsewhere.

---

## Required Config (env vars)

| Var | Required | Default |
|-----|----------|---------|
| `GOOGLE_SHEET_ID` | ✓ | — |
| `FINNHUB_API_KEY` | ✓ | — |
| `TELEGRAM_BOT_TOKEN` | ✓ | — |
| `TELEGRAM_CHAT_ID` | ✓ | — |
| `MIN_RVOL` | | 2.0 |
| `TOP_N` | | 15 |
| `ENABLE_LLM_SUMMARY` | | true |

---

## Calculation Quick Reference

- **RVOL:** `currentVolume / avg(last 63 days)` — today excluded
- **RSI:** 14-period Wilder's smoothing (matches TradingView)
- **SMA:** simple average of last N closes
- **52w High:** `max(closes[-252:])`
- **monthsInConsolidation:** trading days since last touch of 52w high ÷ 21

Full formulas: [calculations.md](knowledge/calculations.md)

---

## Core Rules

1. **No `console.log`** — `logger` only
2. **`p-limit` for concurrency** — never `sleep()`
3. **Normalize at API boundary** — Yahoo/Finnhub → typed interfaces in the fetching service
4. **Return `null`/`[]` on failure** — log with logger.warn/error
5. **Top-level catch in `main()`** — format, Telegram notify, `process.exit(1)`
6. **`setup.ts` is the single source of truth** — never inline setup criteria
7. **`escapeHtml()`** — always use before inserting strings into Telegram HTML messages
8. **`validateTicker()`** before any URL construction

---

## Reference Docs

- [calculations.md](knowledge/calculations.md) — exact formulas for RVOL, RSI, SMA, ATH, consolidation
- [architecture.md](knowledge/architecture.md) — services, concurrency, error handling patterns
- [standards.md](knowledge/standards.md) — naming conventions, coding rules
- [coding-patterns.md](knowledge/coding-patterns.md) — extracted project patterns (naming, data, error handling, state)
- [indicator-sources.md](knowledge/indicator-sources.md) — API comparison, fetch vs calculate, USE_FETCHED_INDICATORS config
- [message-guide.md](knowledge/message-guide.md) — full Telegram report format, emojis, all config variables

## Memory & Plans

- [memory.md](memory.md) — decisions, resolved issues, active context
