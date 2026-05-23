/**
 * Smart Radar — TradingView watchlist writer (two-list model).
 *
 * Emits TWO watchlist files per scan, matching two TradingView watchlists:
 *
 *   1. "Smart Radar - BUY"   — highest-conviction action list (action=BUY)
 *      Files: tv-smart-buy-{date}.txt + tv-smart-buy-latest.txt
 *
 *   2. "Smart Radar - WATCH" — developing setups (action=WATCH)
 *      Files: tv-smart-watch-{date}.txt + tv-smart-watch-latest.txt
 *
 * CAUTION_* and PASS* are intentionally NOT pushed — those are diagnostic
 * Telegram blocks, not "open the chart now" candidates.
 *
 * Exchange prefix mapping mirrors Lean's writer (src/lean/tradingViewWatchlist.ts):
 *   .TA  → TASE:       .DE  → XETR:      .PA / .AS → EURONEXT:
 *   .SW  → SIX:        .L   → LSE:       .MI → MIL:
 *   .VI  → VIE:        .TW  → TWSE:      .KS → KRX:
 *   .SA  → BMFBOVESPA: .MC  → BME:       plain → no prefix.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StockData } from '../types/index.js';

const EXCHANGE_PREFIX: Record<string, string> = {
    '.TA': 'TASE',
    '.DE': 'XETR',
    '.PA': 'EURONEXT',
    '.AS': 'EURONEXT',
    '.SW': 'SIX',
    '.L': 'LSE',
    '.MI': 'MIL',
    '.VI': 'VIE',
    '.TW': 'TWSE',
    '.KS': 'KRX',
    '.SA': 'BMFBOVESPA',
    '.MC': 'BME',
};

/** Map a SVR ticker (e.g. "NICE.TA", "RHM.DE", "NVDA") to TradingView format. */
export function toTradingViewSymbol(svrTicker: string): string {
    for (const [suffix, prefix] of Object.entries(EXCHANGE_PREFIX)) {
        if (svrTicker.endsWith(suffix)) {
            const base = svrTicker.slice(0, -suffix.length);
            return `${prefix}:${base}`;
        }
    }
    return svrTicker;
}

export interface SmartListEntry {
    svrTicker: string;
    tvSymbol: string;
    action: 'BUY' | 'WATCH';
    score: number;
    detail: string;
}

function rankStocks(stocks: StockData[]): StockData[] {
    return [...stocks].sort((a, b) => {
        const sa = a.championScore ?? 0;
        const sb = b.championScore ?? 0;
        if (sb !== sa) return sb - sa;
        // tie-break: higher RVOL
        return (b.projectedRvol ?? b.rvol ?? 0) - (a.projectedRvol ?? a.rvol ?? 0);
    });
}

export function buildBuyList(stocks: StockData[]): SmartListEntry[] {
    const seen = new Set<string>();
    const out: SmartListEntry[] = [];
    for (const s of rankStocks(stocks)) {
        if (s.action !== 'BUY') continue;
        if (seen.has(s.ticker)) continue;
        out.push({
            svrTicker: s.ticker,
            tvSymbol: toTradingViewSymbol(s.ticker),
            action: 'BUY',
            score: s.championScore ?? 0,
            detail: `score ${s.championScore ?? 0}, RVOL ${(s.projectedRvol ?? s.rvol ?? 0).toFixed(2)}`,
        });
        seen.add(s.ticker);
    }
    return out;
}

export function buildWatchList(stocks: StockData[]): SmartListEntry[] {
    const seen = new Set<string>();
    const out: SmartListEntry[] = [];
    for (const s of rankStocks(stocks)) {
        if (s.action !== 'WATCH') continue;
        if (seen.has(s.ticker)) continue;
        out.push({
            svrTicker: s.ticker,
            tvSymbol: toTradingViewSymbol(s.ticker),
            action: 'WATCH',
            score: s.championScore ?? 0,
            detail: `score ${s.championScore ?? 0}, RVOL ${(s.projectedRvol ?? s.rvol ?? 0).toFixed(2)}`,
        });
        seen.add(s.ticker);
    }
    return out;
}

function writeListFile(
    dir: string,
    dateStamp: string,
    fileBaseName: string,
    title: string,
    sectionLabel: string,
    entries: SmartListEntry[]
): { dated: string; latest: string; count: number } {
    const lines: string[] = [];
    lines.push(`###${title} — ${dateStamp}`);
    lines.push(`###Generated: ${new Date().toISOString()}`);
    lines.push(`###Total: ${entries.length} symbols`);
    lines.push('');
    if (entries.length > 0) {
        lines.push(`###${sectionLabel}`);
        for (const e of entries) lines.push(e.tvSymbol);
    } else {
        lines.push('###(none today)');
    }
    const content = lines.join('\n') + '\n';
    const dated = path.join(dir, `${fileBaseName}-${dateStamp}.txt`);
    const latest = path.join(dir, `${fileBaseName}-latest.txt`);
    fs.writeFileSync(dated, content);
    fs.writeFileSync(latest, content);
    return { dated, latest, count: entries.length };
}

export interface SmartWatchlistWriteResult {
    buy: { dated: string; latest: string; count: number };
    watch: { dated: string; latest: string; count: number };
}

export function writeSmartTradingViewWatchlists(
    scanDate: string,
    stocks: StockData[],
    resultsDir: string
): SmartWatchlistWriteResult {
    const buy = buildBuyList(stocks);
    const watch = buildWatchList(stocks);

    const buyResult = writeListFile(
        resultsDir,
        scanDate,
        'tv-smart-buy',
        'Smart Radar — BUY (ACTION)',
        '🟢 BUY — at pivot, volume confirmed, score ≥ 70',
        buy
    );
    const watchResult = writeListFile(
        resultsDir,
        scanDate,
        'tv-smart-watch',
        'Smart Radar — WATCH (MONITOR)',
        '👀 WATCH — setup developing, not yet actionable',
        watch
    );

    return { buy: buyResult, watch: watchResult };
}
