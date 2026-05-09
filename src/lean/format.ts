/**
 * Smart Volume Radar — Lean Radar Telegram formatter (stable branch).
 *
 * One line per stock. Header `🪶 LEAN RADAR` distinguishes from main Radar.
 * Sections (only rendered when non-empty):
 *   📈 Consolidation Breakout
 *   🔥 High Volume (3x+)
 *   📉 Healthy Pullback
 *   👁️ Silently Watching (near-misses)
 */
import type { StockData } from '../types/index.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import type {
    ConsolidationSignal,
    HighVolumeSignal,
    PullbackSignal,
    ConsolidationNearMiss,
    VolumeNearMiss,
    PullbackNearMiss,
} from './signals.js';

export interface LeanScanResult {
    consolidationBreakouts: Array<{ stock: StockData; signal: ConsolidationSignal }>;
    highVolume: Array<{ stock: StockData; signal: HighVolumeSignal }>;
    pullbacks: Array<{ stock: StockData; signal: PullbackSignal }>;
    nearConsolidation: Array<{ stock: StockData; signal: ConsolidationNearMiss }>;
    nearVolume: Array<{ stock: StockData; signal: VolumeNearMiss }>;
    nearPullback: Array<{ stock: StockData; signal: PullbackNearMiss }>;
}

function tickerLink(stock: StockData): string {
    const isIsraeli = stock.ticker.endsWith('.TA');
    const tvTicker = stock.ticker.replace('.TA', '');
    const encTv = encodeURIComponent(isIsraeli ? 'TASE-' + tvTicker : tvTicker);
    return `<a href="https://www.tradingview.com/symbols/${encTv}">${escapeHtml(stock.ticker)}</a>`;
}

function fmtPrice(p: number | undefined): string {
    if (p == null) return '?';
    return p < 10 ? p.toFixed(3) : p < 100 ? p.toFixed(2) : p.toFixed(1);
}

function fmtRvol(r: number | undefined): string {
    if (r == null) return '?';
    return `${r.toFixed(1)}x`;
}

function fmtPct(p: number | undefined): string {
    if (p == null) return '?';
    const sign = p >= 0 ? '+' : '';
    return `${sign}${p.toFixed(1)}%`;
}

/** Top-level format function. */
export function formatLeanReport(date: string, result: LeanScanResult): string {
    const parts: string[] = [];

    // Header
    parts.push(
        `🪶 <b>LEAN RADAR</b>\n` +
            `📅 <code>${date}</code>\n` +
            `<i>3 signals: 📈 breakout · 🔥 RVOL 3x+ · 📉 -15% pullback</i>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━`
    );

    const totalReal =
        result.consolidationBreakouts.length +
        result.highVolume.length +
        result.pullbacks.length;
    const totalNear =
        result.nearConsolidation.length +
        result.nearVolume.length +
        result.nearPullback.length;

    if (totalReal === 0 && totalNear === 0) {
        parts.push(`\n📭 <i>אין איתותים היום — לא breakouts, לא RVOL גבוה, לא pullbacks תקינים.</i>`);
        return parts.join('\n');
    }

    // 1. Consolidation Breakouts
    if (result.consolidationBreakouts.length > 0) {
        parts.push(
            `\n📈 <b>פריצת קונסולידציה</b>  ·  ${result.consolidationBreakouts.length}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`
        );
        for (const { stock, signal } of result.consolidationBreakouts) {
            const sectorTag = stock.sector ? ` <i>(${escapeHtml(stock.sector)})</i>` : '';
            parts.push(
                `${tickerLink(stock)}${sectorTag} — שובר בסיס ${signal.window} ` +
                    `(טווח ${signal.baseRangePct.toFixed(1)}%)  ·  RVOL ${fmtRvol(stock.rvol)}  ·  ` +
                    `${fmtPct(stock.priceChange)}  ·  $${fmtPrice(stock.lastPrice)}`
            );
        }
    }

    // 2. High Volume
    if (result.highVolume.length > 0) {
        parts.push(
            `\n🔥 <b>נפח גבוה — 3x+</b>  ·  ${result.highVolume.length}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`
        );
        for (const { stock, signal } of result.highVolume) {
            const tag = signal.level === 'extreme' ? '⚡ EXTREME' : '🔥';
            const sectorTag = stock.sector ? ` <i>(${escapeHtml(stock.sector)})</i>` : '';
            parts.push(
                `${tag} ${tickerLink(stock)}${sectorTag} — RVOL ${fmtRvol(stock.rvol)}  ·  ` +
                    `${fmtPct(stock.priceChange)}  ·  $${fmtPrice(stock.lastPrice)}`
            );
        }
    }

    // 3. Healthy Pullback
    if (result.pullbacks.length > 0) {
        parts.push(
            `\n📉 <b>Pullback תקין (15-25% מ-52w high)</b>  ·  ${result.pullbacks.length}\n` +
                `━━━━━━━━━━━━━━━━━━━━━━`
        );
        for (const { stock, signal } of result.pullbacks) {
            const sectorTag = stock.sector ? ` <i>(${escapeHtml(stock.sector)})</i>` : '';
            parts.push(
                `${tickerLink(stock)}${sectorTag} — ${fmtPct(signal.pctFromAth)} מ-ATH ` +
                    `($${fmtPrice(stock.ath)})  ·  RVOL ${fmtRvol(stock.rvol)}  ·  ` +
                    `$${fmtPrice(stock.lastPrice)}`
            );
        }
    }

    // 4. Silent Watchlist (near-misses)
    if (totalNear > 0) {
        parts.push(`\n👁️ <b>Silently Watching</b>  ·  ${totalNear}\n━━━━━━━━━━━━━━━━━━━━━━`);

        if (result.nearConsolidation.length > 0) {
            parts.push(`<b>📈 קרובים לפריצה:</b>`);
            for (const { stock, signal } of result.nearConsolidation) {
                parts.push(
                    `  ${tickerLink(stock)} — בסיס ${signal.window}, ` +
                        `${signal.distanceToPivotPct.toFixed(1)}% מתחת לפיבוט ` +
                        `($${fmtPrice(signal.windowHigh)})  ·  RVOL ${fmtRvol(stock.rvol)}`
                );
            }
        }
        if (result.nearVolume.length > 0) {
            parts.push(`<b>🔥 כמעט 3x:</b>`);
            for (const { stock, signal } of result.nearVolume) {
                parts.push(
                    `  ${tickerLink(stock)} — RVOL ${fmtRvol(signal.rvol)}  ·  ${fmtPct(stock.priceChange)}`
                );
            }
        }
        if (result.nearPullback.length > 0) {
            parts.push(`<b>📉 קרובים לאזור pullback:</b>`);
            for (const { stock, signal } of result.nearPullback) {
                parts.push(
                    `  ${tickerLink(stock)} — ${fmtPct(signal.pctFromAth)} מ-ATH (כמעט שם)`
                );
            }
        }
    }

    return parts.join('\n');
}
