/**
 * Smart Volume Radar — Lean Radar TradingView watchlist writer.
 *
 * Emits a daily watchlist file covering the FULL Lean Radar opportunity set:
 *   - 🎓 Graduated (any primary signal) — empirically the strongest cohort
 *   - 📈 Real Consolidation Breakouts
 *   - 📈 Near-pivot (Silent Watchlist for breakouts)
 *   - 📉 Real Healthy Pullback — 73% hit, +7.7% median (best baseline)
 *   - 📉 Near-pullback (Silent Watchlist for pullbacks)
 *   - 🔥 Near-volume (Silent Watchlist for high-volume entries)
 *
 * Excluded: real High Volume (real and extreme). High-volume days have a
 * 50/50 distribution direction risk (UPWK-style climax sells); needs the
 * accumulation/distribution tag layer before being safely tradable.
 *
 * Three output files:
 *   1. tv-watchlist-{date}.txt   — one symbol per line, with category headers
 *   2. tv-watchlist-{date}.csv   — comma-separated single line, paste-ready
 *   3. tv-watchlist-latest.txt   — stable filename for browser automation
 *
 * Exchange prefixes (TradingView convention):
 *   .TA  → TASE:        (Tel Aviv Stock Exchange)
 *   .DE  → XETR:        (Deutsche Börse Xetra)
 *   .PA  → EURONEXT:    (Euronext Paris)
 *   .AS  → EURONEXT:    (Euronext Amsterdam)
 *   .SW  → SIX:         (Swiss Exchange)
 *   .L   → LSE:         (London Stock Exchange)
 *   .MI  → MIL:         (Borsa Italiana)
 *   .VI  → VIE:         (Vienna Stock Exchange)
 *   .TW  → TWSE:        (Taiwan)
 *   .KS  → KRX:         (Korea)
 *   .SA  → BMFBOVESPA:  (Brazil)
 *   .MC  → BME:         (Spain)
 *   plain (no dot)      → no prefix (TradingView resolves NASDAQ/NYSE)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LeanScanResult } from './format.js';

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

/** Map a SVR ticker (e.g. "NICE.TA", "RHM.DE", "NVDA") to TradingView format
 *  (e.g. "TASE:NICE", "XETR:RHM", "NVDA"). */
export function toTradingViewSymbol(svrTicker: string): string {
    for (const [suffix, prefix] of Object.entries(EXCHANGE_PREFIX)) {
        if (svrTicker.endsWith(suffix)) {
            const base = svrTicker.slice(0, -suffix.length);
            return `${prefix}:${base}`;
        }
    }
    // US stocks — no prefix needed, TradingView resolves automatically.
    return svrTicker;
}

type SignalKind =
    | 'graduated'
    | 'breakout'
    | 'nearBreakout'
    | 'pullback'
    | 'nearPullback'
    | 'nearVolume';

interface WatchlistEntry {
    svrTicker: string;
    tvSymbol: string;
    kind: SignalKind;
    detail: string;
}

const SECTION_META: Record<SignalKind, { emoji: string; title: string; rationale: string }> = {
    graduated:    { emoji: '🎓', title: 'Graduated',     rationale: 'was on watchlist yesterday, fired real today' },
    breakout:     { emoji: '📈', title: 'Real Breakouts',rationale: 'close > pivot today' },
    nearBreakout: { emoji: '📈', title: 'Near Pivot',    rationale: 'within 2% of base high (Stage 2, tight base)' },
    pullback:     { emoji: '📉', title: 'Real Pullbacks',rationale: '−15% to −25% from ATH, above SMA200 (73% hit, +7.7% median)' },
    nearPullback: { emoji: '📉', title: 'Near Pullback', rationale: '−12% to −15% from ATH (74% conversion)' },
    nearVolume:   { emoji: '🔥', title: 'Near Volume',   rationale: 'RVOL 2.5–3.0x — building toward 3x (+10.7% median)' },
};

const SECTION_ORDER: SignalKind[] = [
    'graduated',
    'breakout',
    'nearBreakout',
    'pullback',
    'nearPullback',
    'nearVolume',
];

export function buildLeanWatchlist(result: LeanScanResult): WatchlistEntry[] {
    const seen = new Set<string>();
    const entries: WatchlistEntry[] = [];

    const pushIfNew = (
        ticker: string,
        kind: SignalKind,
        detail: string
    ): void => {
        if (seen.has(ticker)) return;
        entries.push({
            svrTicker: ticker,
            tvSymbol: toTradingViewSymbol(ticker),
            kind,
            detail,
        });
        seen.add(ticker);
    };

    // 1. Graduated — ANY primary type (breakout, pullback, volume — all welcome)
    for (const g of result.graduated ?? []) {
        pushIfNew(g.stock.ticker, 'graduated', g.primaryDetail);
    }

    // 2. Real Consolidation Breakouts — explicit close > pivot today
    for (const r of result.consolidationBreakouts) {
        pushIfNew(
            r.stock.ticker,
            'breakout',
            `${r.signal.window} base ${r.signal.baseRangePct.toFixed(1)}%, pivot $${r.signal.windowHigh.toFixed(2)}`
        );
    }

    // 3. Near-pivot — within 2% below pivot (50% convert within 30td)
    for (const r of result.nearConsolidation) {
        pushIfNew(
            r.stock.ticker,
            'nearBreakout',
            `${r.signal.window} base, ${r.signal.distanceToPivotPct.toFixed(2)}% below pivot $${r.signal.windowHigh.toFixed(2)}`
        );
    }

    // 4. Real Pullback — −15% to −25% from ATH, above SMA200 (best baseline)
    for (const r of result.pullbacks) {
        pushIfNew(
            r.stock.ticker,
            'pullback',
            `${r.signal.pctFromAth.toFixed(1)}% from ATH $${r.stock.ath?.toFixed(2) ?? '?'} (above SMA200)`
        );
    }

    // 5. Near-pullback — −12% to −15% (74% conversion rate — strongest)
    for (const r of result.nearPullback) {
        pushIfNew(
            r.stock.ticker,
            'nearPullback',
            `${r.signal.pctFromAth.toFixed(1)}% from ATH (approaching pullback band)`
        );
    }

    // 6. Near-volume — RVOL 2.5–3.0x (highest median return: +10.7%)
    for (const r of result.nearVolume) {
        pushIfNew(
            r.stock.ticker,
            'nearVolume',
            `RVOL ${r.signal.rvol.toFixed(1)}x — approaching 3x threshold`
        );
    }

    return entries;
}

/** Back-compat alias — old code may import this. Now returns ALL Lean
 *  entries, not just breakout-track. The "breakout" name is historical. */
export const buildBreakoutWatchlist = buildLeanWatchlist;

export function writeTradingViewWatchlist(
    scanDate: string,
    result: LeanScanResult,
    resultsDir: string
): { txtPath: string; csvPath: string; latestPath: string; count: number } {
    const entries = buildLeanWatchlist(result);
    const dateStamp = scanDate;

    const byKind = (k: SignalKind) => entries.filter((e) => e.kind === k);

    // .txt — one symbol per line, grouped by section
    const txtLines: string[] = [];
    txtLines.push(`###Lean Radar — ${dateStamp}`);
    txtLines.push(`###Generated: ${new Date().toISOString()}`);
    txtLines.push(`###Total: ${entries.length} unique symbols across 6 categories`);
    txtLines.push('');

    let sectionsPrinted = 0;
    for (const kind of SECTION_ORDER) {
        const items = byKind(kind);
        if (items.length === 0) continue;
        const meta = SECTION_META[kind];
        txtLines.push(`###${meta.emoji} ${meta.title} (${items.length}) — ${meta.rationale}`);
        for (const e of items) txtLines.push(e.tvSymbol);
        txtLines.push('');
        sectionsPrinted++;
    }
    if (sectionsPrinted === 0) {
        txtLines.push('###(no signals today)');
    }

    const txtPath = path.join(resultsDir, `tv-watchlist-${dateStamp}.txt`);
    const latestPath = path.join(resultsDir, 'tv-watchlist-latest.txt');
    const txtContent = txtLines.join('\n') + '\n';
    fs.writeFileSync(txtPath, txtContent);
    fs.writeFileSync(latestPath, txtContent);

    // .csv — comma-separated single line, paste-ready into TradingView
    const csvPath = path.join(resultsDir, `tv-watchlist-${dateStamp}.csv`);
    const csvLine = entries.map((e) => e.tvSymbol).join(',');
    fs.writeFileSync(csvPath, csvLine + '\n');

    return { txtPath, csvPath, latestPath, count: entries.length };
}
