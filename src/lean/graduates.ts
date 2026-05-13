/**
 * Smart Volume Radar — Lean Radar "Graduated" detector.
 *
 * Identifies stocks that were on yesterday's Silent Watchlist (any near-*)
 * and fired a REAL signal today. Per 2026-05-13 conversion analysis
 * (`scripts/analyze-silent-watchlist-conversion.ts`):
 *
 *   - 74% of nearPullback → some real signal within 30 td (54% matched)
 *   - 64% of nearVol      → some real signal within 30 td (40% matched)
 *   - 50% of nearBreakout → some real signal within 30 td (29% matched)
 *
 * Top winners in 2025-2026 (SNDK +1326%, MXL +484%, LITE +722%, AEHR +632%)
 * all came through the near→real path — often multiple times. Surfacing
 * this transition explicitly is the highest-leverage UX change for Lean.
 *
 * Snapshot-driven: looks for `results/lean-{prevTradingDay}.json` produced
 * by an earlier run. If no snapshot is available (e.g. ephemeral GH Actions
 * runner with no carryover), returns empty — degrades gracefully.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { LeanScanResult } from './format.js';
import type { StockData } from '../types/index.js';

interface YesterdayNear {
    nearConsolidation: Set<string>;
    nearVolume: Set<string>;
    nearPullback: Set<string>;
    snapshotDate: string;
}

/** Load yesterday's near-* tickers from the most recent lean snapshot
 *  that's STRICTLY OLDER than `scanDate`. Walks back up to `maxDaysBack`
 *  to skip weekends/holidays. */
function loadYesterdayNears(resultsDir: string, scanDate: string, maxDaysBack = 7): YesterdayNear | null {
    const scanD = new Date(scanDate + 'T00:00:00Z');
    for (let back = 1; back <= maxDaysBack; back++) {
        const d = new Date(scanD);
        d.setUTCDate(d.getUTCDate() - back);
        const dateStr = d.toISOString().slice(0, 10);
        const file = path.join(resultsDir, `lean-${dateStr}.json`);
        if (!fs.existsSync(file)) continue;
        try {
            const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                detections?: {
                    nearConsolidation?: Array<{ ticker: string }>;
                    nearVolume?: Array<{ ticker: string }>;
                    nearPullback?: Array<{ ticker: string }>;
                };
            };
            return {
                nearConsolidation: new Set(snap.detections?.nearConsolidation?.map((r) => r.ticker) ?? []),
                nearVolume: new Set(snap.detections?.nearVolume?.map((r) => r.ticker) ?? []),
                nearPullback: new Set(snap.detections?.nearPullback?.map((r) => r.ticker) ?? []),
                snapshotDate: dateStr,
            };
        } catch (e) {
            logger.warn(`⚠️ Failed to parse ${file}: ${(e as Error).message}`);
            continue;
        }
    }
    return null;
}

/**
 * Build the `graduated` array on a LeanScanResult.
 *
 * Mutates `result.graduated` in place (sets to empty array if no
 * yesterday snapshot or no transitions found).
 */
export function attachGraduated(
    result: LeanScanResult,
    scanDate: string,
    resultsDir: string
): void {
    const prev = loadYesterdayNears(resultsDir, scanDate);
    if (!prev) {
        logger.info(`🎓 No prior snapshot found in ${resultsDir} — Graduated section skipped`);
        result.graduated = [];
        return;
    }
    logger.info(
        `🎓 Loaded snapshot from ${prev.snapshotDate}: ` +
        `${prev.nearConsolidation.size} near-pivot, ${prev.nearVolume.size} near-vol, ${prev.nearPullback.size} near-pullback`
    );

    // Compute days on watchlist by walking back through snapshots while
    // the ticker remains in any near-* set. Caps at 5 to avoid excess I/O.
    function daysOnWatchlist(ticker: string): number {
        let days = 1;
        const scanD = new Date(scanDate + 'T00:00:00Z');
        for (let back = 1; back <= 5; back++) {
            const d = new Date(scanD);
            d.setUTCDate(d.getUTCDate() - back);
            const file = path.join(resultsDir, `lean-${d.toISOString().slice(0, 10)}.json`);
            if (!fs.existsSync(file)) continue;
            try {
                const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                    detections?: {
                        nearConsolidation?: Array<{ ticker: string }>;
                        nearVolume?: Array<{ ticker: string }>;
                        nearPullback?: Array<{ ticker: string }>;
                    };
                };
                const all = new Set<string>([
                    ...(snap.detections?.nearConsolidation?.map((r) => r.ticker) ?? []),
                    ...(snap.detections?.nearVolume?.map((r) => r.ticker) ?? []),
                    ...(snap.detections?.nearPullback?.map((r) => r.ticker) ?? []),
                ]);
                if (all.has(ticker)) days++;
                else break;
            } catch { /* ignore */ }
        }
        return days;
    }

    const graduated: NonNullable<LeanScanResult['graduated']> = [];
    const seen = new Set<string>();

    // Priority: breakout > pullback > volume (same ranking as the dedup logic).
    const consider = (
        stock: StockData,
        primary: 'breakout' | 'pullback' | 'highVol',
        primaryDetail: string
    ): void => {
        if (seen.has(stock.ticker)) return;
        const wasNear: Array<'nearBreakout' | 'nearVol' | 'nearPullback'> = [];
        if (prev.nearConsolidation.has(stock.ticker)) wasNear.push('nearBreakout');
        if (prev.nearVolume.has(stock.ticker)) wasNear.push('nearVol');
        if (prev.nearPullback.has(stock.ticker)) wasNear.push('nearPullback');
        if (wasNear.length === 0) return;
        graduated.push({
            stock,
            primary,
            primaryDetail,
            wasNear,
            daysOnWatchlist: daysOnWatchlist(stock.ticker),
        });
        seen.add(stock.ticker);
    };

    for (const { stock, signal } of result.consolidationBreakouts) {
        consider(stock, 'breakout', `📈 שובר בסיס ${signal.window} (טווח ${signal.baseRangePct.toFixed(1)}%)`);
    }
    for (const { stock, signal } of result.pullbacks) {
        consider(stock, 'pullback', `📉 Pullback בריא (${signal.pctFromAth.toFixed(1)}% מ-ATH)`);
    }
    for (const { stock, signal } of result.highVolume) {
        const tag = signal.level === 'extreme' ? '⚡ EXTREME volume' : '🔥 נפח גבוה';
        consider(stock, 'highVol', `${tag} (${stock.rvol.toFixed(1)}x)`);
    }

    result.graduated = graduated;
    if (graduated.length > 0) {
        logger.info(`🎓 ${graduated.length} graduated: ${graduated.map((g) => g.stock.ticker).join(', ')}`);
    }
}
