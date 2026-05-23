/**
 * Ticker stats — rolling per-ticker history derived from `results/scan-*.json`
 * snapshot files. Built once at the start of every scan and consumed by
 * `determineAction` (championScore.ts) + the Telegram formatter.
 *
 * Powers:
 *   - TD-19 "Double BUY" badge: was this ticker action=BUY on the most
 *     recent prior scan?
 *   - TD-20 ticker-fatigue filter: how many times has this ticker been
 *     flagged in the last 20 trading days?
 *   - TD-22 sector-override "in trend" detection: how many recent flags
 *     went to BUY or WATCH (proxy for "in an established uptrend")?
 *
 * Outputs also include a backward-looking "ticker outcomes" merge if
 * `results/ticker-outcomes.json` exists — produced by the offline
 * `scripts/bootstrap-ticker-outcomes.ts` script and surfacing fields like
 * `recentWinRate` for TD-21 (auto blacklist) + TD-23 (hot-streak badge).
 *
 * Design: the helper is OPTIONAL. If no scan history exists (fresh repo
 * or BACKTEST_MODE), it returns an empty Map and every downstream gate
 * falls back to its non-stats-aware behavior. This keeps the pipeline
 * safe to run anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TickerStats {
    /** Action label on the most recent prior scan (most recent date < today). */
    previousDayAction: string | null;
    /** Action label 2 scans ago (for chain detection). */
    twoDaysAgoAction: string | null;
    /** Total appearances in scan signals[] over the last 20 trading days. */
    alertCount20td: number;
    /** How many recent flags (last 10 td) were action=BUY or WATCH. */
    inTrendCount10td: number;
    /** Rolling win rate over last 30 alerts (if outcomes file exists). */
    recentWinRate: number | null;
    /** Total alerts counted toward `recentWinRate`. */
    recentAlertsCounted: number;
    /** True if this ticker is on the auto-blacklist (TD-21). */
    isBlacklisted: boolean;
    /** True if this ticker is on a current hot streak (TD-23). */
    isHotStreak: boolean;
}

const EMPTY_STATS: TickerStats = {
    previousDayAction: null,
    twoDaysAgoAction: null,
    alertCount20td: 0,
    inTrendCount10td: 0,
    recentWinRate: null,
    recentAlertsCounted: 0,
    isBlacklisted: false,
    isHotStreak: false,
};

interface ScanSignal { ticker?: string; action?: string; momentumLevel?: string; }
interface ScanFile { date: string; signals?: ScanSignal[]; }

/** Optional outcomes file produced by the offline bootstrapper. */
interface TickerOutcomesFile {
    generatedAt: string;
    perTicker: Record<string, {
        recentWinRate: number;
        recentAlertsCounted: number;
        blacklisted: boolean;
        hotStreak: boolean;
    }>;
}

/** Load up to `lookbackDays` of recent scan-*.json files, dedup by date. */
function loadRecentScans(resultsDir: string, lookbackDays: number, today: string): ScanFile[] {
    if (!fs.existsSync(resultsDir)) return [];
    const allFiles = fs.readdirSync(resultsDir)
        .filter((f) => /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
    const todayMs = new Date(today + 'T00:00:00Z').getTime();
    const cutoffMs = todayMs - lookbackDays * 86400000 - 14 * 86400000; // pad for weekends/holidays
    const out: ScanFile[] = [];
    for (const f of allFiles) {
        const d = f.slice(5, 15);
        if (new Date(d + 'T00:00:00Z').getTime() < cutoffMs) continue;
        // Skip today's scan if it's already been written (we want PRIOR history)
        if (d >= today) continue;
        try {
            const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')) as Partial<ScanFile>;
            if (Array.isArray(data.signals)) {
                out.push({ date: d, signals: data.signals });
            }
        } catch { /* skip malformed */ }
    }
    return out;
}

function loadOutcomes(resultsDir: string): TickerOutcomesFile | null {
    const p = path.join(resultsDir, 'ticker-outcomes.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) as TickerOutcomesFile; }
    catch { return null; }
}

/**
 * Build per-ticker rolling stats from recent scan history + optional
 * pre-computed outcomes file. Returns an empty Map on a fresh repo.
 *
 * `today` should be the scan date being computed (so we only look at
 * scans STRICTLY before it).
 */
export function buildTickerStats(resultsDir: string, today: string): Map<string, TickerStats> {
    const stats = new Map<string, TickerStats>();
    const scans = loadRecentScans(resultsDir, 20, today);
    if (scans.length === 0 && !loadOutcomes(resultsDir)) return stats;

    scans.sort((a, b) => a.date.localeCompare(b.date)); // chronological
    const latest = scans[scans.length - 1];
    const secondLatest = scans[scans.length - 2];
    const last10 = scans.slice(-10);

    // Build a per-(date, ticker) action map for last 2 days lookup
    const dayActionMap = new Map<string, Map<string, string>>();
    for (const s of scans) {
        const map = new Map<string, string>();
        for (const sig of s.signals ?? []) {
            if (sig.ticker) map.set(sig.ticker.toUpperCase(), sig.action ?? '');
        }
        dayActionMap.set(s.date, map);
    }

    // Collect every ticker that appears anywhere in the 20-td window
    const allTickers = new Set<string>();
    for (const s of scans) {
        for (const sig of s.signals ?? []) {
            if (sig.ticker) allTickers.add(sig.ticker.toUpperCase());
        }
    }

    for (const ticker of allTickers) {
        let alertCount20td = 0;
        let inTrendCount10td = 0;
        for (const s of scans) {
            if (s.signals?.some((sig) => sig.ticker?.toUpperCase() === ticker)) {
                alertCount20td++;
            }
        }
        for (const s of last10) {
            const sig = s.signals?.find((sg) => sg.ticker?.toUpperCase() === ticker);
            if (sig && (sig.action === 'BUY' || sig.action === 'WATCH')) {
                inTrendCount10td++;
            }
        }
        const previousDayAction = latest ? dayActionMap.get(latest.date)?.get(ticker) ?? null : null;
        const twoDaysAgoAction = secondLatest ? dayActionMap.get(secondLatest.date)?.get(ticker) ?? null : null;
        stats.set(ticker, {
            previousDayAction,
            twoDaysAgoAction,
            alertCount20td,
            inTrendCount10td,
            recentWinRate: null,
            recentAlertsCounted: 0,
            isBlacklisted: false,
            isHotStreak: false,
        });
    }

    // Merge in outcomes file (TD-21/23 data) if available
    const outcomes = loadOutcomes(resultsDir);
    if (outcomes?.perTicker) {
        for (const [ticker, o] of Object.entries(outcomes.perTicker)) {
            const t = ticker.toUpperCase();
            const existing = stats.get(t) ?? { ...EMPTY_STATS };
            stats.set(t, {
                ...existing,
                recentWinRate: o.recentWinRate,
                recentAlertsCounted: o.recentAlertsCounted,
                isBlacklisted: o.blacklisted,
                isHotStreak: o.hotStreak,
            });
        }
    }

    return stats;
}

/** Safe lookup: returns EMPTY_STATS for unknown tickers. */
export function getTickerStats(stats: Map<string, TickerStats> | undefined, ticker: string): TickerStats {
    if (!stats) return EMPTY_STATS;
    return stats.get(ticker.toUpperCase()) ?? EMPTY_STATS;
}
