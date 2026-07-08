/**
 * Recent-alert lookup for cross-day signal dedup.
 *
 * Walks results/lean-YYYY-MM-DD.json snapshots backwards from the scan date
 * (calendar days; trading-day gaps and missing artifacts are simply skipped)
 * and unions the tickers seen in the requested `detections` section.
 *
 * Date handling matches snapshotWriter exactly: both sides derive the
 * filename from a UTC YYYY-MM-DD string (scanDate comes from
 * getLastTradingDay), so midnight/timezone boundaries cannot desync them.
 *
 * Used to suppress repeat alerts: the 2026-07-08 precision study showed e.g.
 * repeat nearBreakouts return +0.89% med21 vs +1.70% for first alerts, at
 * 10x the alert volume.
 */
import fs from 'node:fs';
import path from 'node:path';
import logger from '../utils/logger.js';

export function loadRecentSignalTickers(
    resultsDir: string,
    scanDate: string,
    section: string,
    daysBack = 21
): Set<string> {
    const out = new Set<string>();
    const scanD = new Date(scanDate + 'T00:00:00Z');
    for (let back = 1; back <= daysBack; back++) {
        const d = new Date(scanD);
        d.setUTCDate(d.getUTCDate() - back);
        const file = path.join(resultsDir, `lean-${d.toISOString().slice(0, 10)}.json`);
        if (!fs.existsSync(file)) continue;
        try {
            const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                detections?: Record<string, Array<{ ticker: string }>>;
            };
            for (const rec of snap.detections?.[section] ?? []) out.add(rec.ticker);
        } catch (e) {
            logger.warn(`⚠️ signalHistory: failed to parse ${file}: ${(e as Error).message}`);
        }
    }
    return out;
}
