/**
 * Criteria Importance Analysis — find which momentum criteria
 * actually predict forward returns from past Watchlist/Full alerts.
 *
 * Pipeline:
 *   1. Load monitor-list.json (every alert ever fired, with first-alert price)
 *   2. For each entry: refetch historical data as-of firstAlertDate, recompute
 *      the 8-criteria momentum snapshot at that exact moment
 *   3. Compute realized return (resolved → resolvedPrice; monitoring → today)
 *   4. Aggregate: lift per criterion (top quintile vs bottom quintile),
 *      winners/losers profile, sector skew, persistence vs return
 *   5. Save results/criteria-importance.csv for further drilling
 *
 * Run: npm run analyze-criteria-importance
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { fetchYahooChartAsOfDate, fetchMarketRegime } from '../src/services/marketData.js';
import { evaluateMomentumSetup } from '../src/utils/setup.js';
import { fetchAndCacheWatchlist, validateConfig } from '../src/config/index.js';
import type { MomentumCriteria, MomentumLevel } from '../src/types/index.js';
import logger from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface MonitorEvent {
    date: string;
    type: string;
    price?: number;
    rvol?: number;
    note?: string;
}
interface MonitorEntry {
    ticker: string;
    firstAlertDate: string;
    firstAlertLevel: 'full' | 'close' | 'recovery';
    firstAlertPrice: number;
    firstAlertRvol: number;
    lastChecked: string;
    status: 'monitoring' | 'graduated' | 'sma21-pullback' | 'manual-entry' | 'expired';
    sector?: string;
    events: MonitorEvent[];
    resolvedDate?: string;
    resolvedPrice?: number;
}

interface AnalyzedEntry {
    ticker: string;
    firstAlertDate: string;
    firstAlertLevel: string;
    sector: string;
    firstAlertPrice: number;
    endPrice: number;
    returnPct: number;
    reAlertCount: number;
    daysHeld: number;
    criteriaAtAlert: MomentumCriteria | null;
    snapshotLevel: MomentumLevel;
    status: string;
    /** Returns at fixed forward windows from firstAlertDate. null = window not yet complete. */
    forwardReturns: Record<number, number | null>;
}

/** Trading-day arithmetic: skip Sat/Sun. Returns ISO date `YYYY-MM-DD`. */
function addTradingDays(isoDate: string, n: number): string {
    const d = new Date(isoDate + 'T12:00:00Z');
    let added = 0;
    while (added < n) {
        d.setUTCDate(d.getUTCDate() + 1);
        const wd = d.getUTCDay();
        if (wd !== 0 && wd !== 6) added++;
    }
    return d.toISOString().slice(0, 10);
}

const FORWARD_WINDOWS = [3, 5, 10, 20, 40] as const;

const CRITERIA_KEYS: Array<keyof MomentumCriteria> = [
    'rvolPass',
    'stage2',
    'pivotBreakout',
    'aboveGapAvwap',
    'lowRiskEntry',
    'tightness',
    'antsAccumulation',
    'bigMoveToday',
];

function pad(s: string | number, n: number, right = false): string {
    const str = String(s);
    if (str.length >= n) return str;
    const p = ' '.repeat(n - str.length);
    return right ? str + p : p + str;
}

function fmtPct(n: number, decimals = 1): string {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(decimals)}%`;
}

function median(nums: number[]): number {
    if (nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function main(): Promise<void> {
    try {
        validateConfig();
    } catch {
        // continue
    }
    await fetchAndCacheWatchlist();

    const monitorPath = path.join(__dirname, '..', 'results', 'monitor-list.json');
    const data = JSON.parse(fs.readFileSync(monitorPath, 'utf-8')) as { entries: MonitorEntry[] };
    const entries = data.entries;
    logger.info(`Loaded ${entries.length} monitor entries`);

    // Pre-fetch market regime per unique alert date (much cheaper than per-entry).
    const uniqueDates = Array.from(new Set(entries.map((e) => e.firstAlertDate)));
    const regimeByDate = new Map<string, 'bull' | 'bear'>();
    logger.info(`Fetching market regime for ${uniqueDates.length} unique dates...`);
    const regimeLimit = pLimit(3);
    await Promise.all(
        uniqueDates.map((d) =>
            regimeLimit(async () => {
                try {
                    regimeByDate.set(d, await fetchMarketRegime(d));
                } catch {
                    regimeByDate.set(d, 'bull');
                }
            })
        )
    );

    // Today's date for current-price lookups on still-monitoring entries.
    const today = new Date().toISOString().slice(0, 10);

    const limit = pLimit(5);
    const analyzed: AnalyzedEntry[] = [];
    let processed = 0;
    let skipped = 0;

    await Promise.all(
        entries.map((e) =>
            limit(async () => {
                processed++;
                if (processed % 25 === 0) {
                    logger.info(`Processed ${processed}/${entries.length} (skipped ${skipped})...`);
                }
                try {
                    // 1. Snapshot at first-alert date (criteria recomputation)
                    const snap = await fetchYahooChartAsOfDate(e.ticker, e.firstAlertDate);
                    if (!snap) {
                        skipped++;
                        return;
                    }
                    const regime = regimeByDate.get(e.firstAlertDate) ?? 'bull';
                    snap.marketRegime = regime;
                    const momentum = evaluateMomentumSetup(snap, { regime });

                    // 2. End price: resolvedPrice if resolved, fresh fetch if still monitoring
                    let endPrice: number;
                    let endDate: string;
                    if (e.status !== 'monitoring' && e.resolvedPrice != null) {
                        endPrice = e.resolvedPrice;
                        endDate = e.resolvedDate ?? today;
                    } else {
                        const todayData = await fetchYahooChartAsOfDate(e.ticker, today);
                        if (!todayData) {
                            skipped++;
                            return;
                        }
                        endPrice = todayData.lastPrice;
                        endDate = today;
                    }

                    if (!Number.isFinite(endPrice) || endPrice <= 0 || e.firstAlertPrice <= 0) {
                        skipped++;
                        return;
                    }

                    const returnPct = ((endPrice - e.firstAlertPrice) / e.firstAlertPrice) * 100;
                    const reAlertCount = e.events.filter((ev) => ev.type.startsWith('re-alert')).length;
                    const daysHeld = Math.max(
                        0,
                        Math.round(
                            (Date.parse(endDate) - Date.parse(e.firstAlertDate)) / 86400_000
                        )
                    );

                    // Fetch forward prices at fixed trading-day windows.
                    const forwardReturns: Record<number, number | null> = {};
                    for (const w of FORWARD_WINDOWS) {
                        const target = addTradingDays(e.firstAlertDate, w);
                        if (target > today) {
                            forwardReturns[w] = null;
                            continue;
                        }
                        try {
                            const fwd = await fetchYahooChartAsOfDate(e.ticker, target);
                            if (fwd && fwd.lastPrice > 0) {
                                forwardReturns[w] = ((fwd.lastPrice - e.firstAlertPrice) / e.firstAlertPrice) * 100;
                            } else {
                                forwardReturns[w] = null;
                            }
                        } catch {
                            forwardReturns[w] = null;
                        }
                    }

                    analyzed.push({
                        ticker: e.ticker,
                        firstAlertDate: e.firstAlertDate,
                        firstAlertLevel: e.firstAlertLevel,
                        sector: e.sector ?? 'Unknown',
                        firstAlertPrice: e.firstAlertPrice,
                        endPrice,
                        returnPct,
                        reAlertCount,
                        daysHeld,
                        criteriaAtAlert: momentum.criteria,
                        snapshotLevel: momentum.level,
                        status: e.status,
                        forwardReturns,
                    });
                } catch (err) {
                    skipped++;
                    logger.warn(`Skip ${e.ticker} @ ${e.firstAlertDate}: ${(err as Error).message}`);
                }
            })
        )
    );

    logger.info(`\n✅ Analyzed ${analyzed.length}/${entries.length} (skipped ${skipped})\n`);

    if (analyzed.length === 0) {
        logger.error('No entries successfully analyzed. Aborting.');
        process.exit(1);
    }

    analyzed.sort((a, b) => b.returnPct - a.returnPct);

    const n = analyzed.length;
    const qSize = Math.max(5, Math.floor(n * 0.2));
    const top = analyzed.slice(0, qSize);
    const bottom = analyzed.slice(-qSize);

    // ─── A. Lift per criterion ─────────────────────────────────────
    console.log('\n═══ A. Criterion Lift Analysis ═══');
    console.log(`(Top/Bottom quintile = ${qSize} entries each, n=${n} total)\n`);
    console.log(
        `${pad('Criterion', 18, true)} | ${pad('All', 7)} | ${pad('Top 20%', 8)} | ${pad('Bot 20%', 8)} | ${pad('Lift', 7)} | Verdict`
    );
    console.log('─'.repeat(82));
    const pctTrue = (rows: AnalyzedEntry[], k: keyof MomentumCriteria): number =>
        rows.length === 0 ? 0 : rows.filter((r) => r.criteriaAtAlert?.[k]).length / rows.length;
    for (const k of CRITERIA_KEYS) {
        const all = pctTrue(analyzed, k);
        const t = pctTrue(top, k);
        const b = pctTrue(bottom, k);
        const lift = b > 0 ? t / b : t > 0 ? Infinity : 1;
        const verdict =
            lift >= 3
                ? '🔥 strong predictor'
                : lift >= 1.5
                  ? '✅ positive predictor'
                  : lift >= 0.85
                    ? '🤷 neutral'
                    : lift >= 0.5
                      ? '⚠️  anti-predictor'
                      : '🛑 strong anti-predictor';
        const liftStr = lift === Infinity ? '∞' : lift.toFixed(2) + 'x';
        console.log(
            `${pad(k, 18, true)} | ${pad((all * 100).toFixed(0) + '%', 7)} | ` +
                `${pad((t * 100).toFixed(0) + '%', 8)} | ${pad((b * 100).toFixed(0) + '%', 8)} | ` +
                `${pad(liftStr, 7)} | ${verdict}`
        );
    }

    // ─── B. Top winners ─────────────────────────────────────────────
    console.log('\n═══ B. Top 15 Winners ═══');
    for (const e of analyzed.slice(0, 15)) {
        const c = e.criteriaAtAlert!;
        const passing = CRITERIA_KEYS.filter((k) => c[k]).length;
        console.log(
            `  ${pad(e.ticker, 11, true)} | ${pad(fmtPct(e.returnPct), 8)} | ` +
                `lvl ${pad(e.firstAlertLevel, 8, true)} | re-alerts ${pad(e.reAlertCount, 2)} | ` +
                `criteria ${passing}/8 | ${e.status}`
        );
    }

    // ─── C. Top losers ──────────────────────────────────────────────
    console.log('\n═══ C. Bottom 15 Losers ═══');
    for (const e of analyzed.slice(-15).reverse()) {
        const c = e.criteriaAtAlert!;
        const passing = CRITERIA_KEYS.filter((k) => c[k]).length;
        console.log(
            `  ${pad(e.ticker, 11, true)} | ${pad(fmtPct(e.returnPct), 8)} | ` +
                `lvl ${pad(e.firstAlertLevel, 8, true)} | re-alerts ${pad(e.reAlertCount, 2)} | ` +
                `criteria ${passing}/8 | ${e.status}`
        );
    }

    // ─── D. Sector breakdown ─────────────────────────────────────────
    console.log('\n═══ D. Sector Breakdown (≥3 entries) ═══');
    const bySector = new Map<string, AnalyzedEntry[]>();
    for (const e of analyzed) {
        if (!bySector.has(e.sector)) bySector.set(e.sector, []);
        bySector.get(e.sector)!.push(e);
    }
    const sectorRows = Array.from(bySector.entries())
        .filter(([, rows]) => rows.length >= 3)
        .map(([sec, rows]) => ({
            sector: sec,
            n: rows.length,
            median: median(rows.map((r) => r.returnPct)),
            avg: rows.reduce((s, r) => s + r.returnPct, 0) / rows.length,
            winRate: rows.filter((r) => r.returnPct > 0).length / rows.length,
        }))
        .sort((a, b) => b.median - a.median);
    console.log(
        `${pad('Sector', 22, true)} | ${pad('n', 4)} | ${pad('Median', 9)} | ${pad('Avg', 9)} | Win%`
    );
    console.log('─'.repeat(70));
    for (const r of sectorRows) {
        console.log(
            `${pad(r.sector, 22, true)} | ${pad(r.n, 4)} | ${pad(fmtPct(r.median), 9)} | ${pad(
                fmtPct(r.avg),
                9
            )} | ${(r.winRate * 100).toFixed(0)}%`
        );
    }

    // ─── E. Persistence (re-alert count) vs return ───────────────────
    console.log('\n═══ E. Re-alert Count vs Return ═══');
    const buckets = new Map<string, AnalyzedEntry[]>();
    const bucketLabel = (k: number): string =>
        k === 0 ? '0 (single)' : k === 1 ? '1' : k === 2 ? '2' : k <= 4 ? '3-4' : '5+';
    for (const e of analyzed) {
        const lbl = bucketLabel(e.reAlertCount);
        if (!buckets.has(lbl)) buckets.set(lbl, []);
        buckets.get(lbl)!.push(e);
    }
    console.log(
        `${pad('Re-alerts', 12, true)} | ${pad('n', 5)} | ${pad('Median', 9)} | ${pad('Avg', 9)} | Win%`
    );
    console.log('─'.repeat(60));
    for (const lbl of ['0 (single)', '1', '2', '3-4', '5+']) {
        const rows = buckets.get(lbl);
        if (!rows || rows.length === 0) continue;
        const med = median(rows.map((r) => r.returnPct));
        const avg = rows.reduce((s, r) => s + r.returnPct, 0) / rows.length;
        const winRate = rows.filter((r) => r.returnPct > 0).length / rows.length;
        console.log(
            `${pad(lbl, 12, true)} | ${pad(rows.length, 5)} | ${pad(fmtPct(med), 9)} | ${pad(
                fmtPct(avg),
                9
            )} | ${(winRate * 100).toFixed(0)}%`
        );
    }

    // ─── F. Tier-vs-Outcome (the answer to "is Full really better?") ─
    console.log('\n═══ F. Initial Alert Tier vs Outcome ═══');
    const byTier = new Map<string, AnalyzedEntry[]>();
    for (const e of analyzed) {
        if (!byTier.has(e.firstAlertLevel)) byTier.set(e.firstAlertLevel, []);
        byTier.get(e.firstAlertLevel)!.push(e);
    }
    console.log(
        `${pad('Initial tier', 14, true)} | ${pad('n', 4)} | ${pad('Median', 9)} | ${pad('Avg', 9)} | Win%`
    );
    console.log('─'.repeat(60));
    for (const tier of ['full', 'recovery', 'close']) {
        const rows = byTier.get(tier);
        if (!rows || rows.length === 0) continue;
        const med = median(rows.map((r) => r.returnPct));
        const avg = rows.reduce((s, r) => s + r.returnPct, 0) / rows.length;
        const winRate = rows.filter((r) => r.returnPct > 0).length / rows.length;
        console.log(
            `${pad(tier, 14, true)} | ${pad(rows.length, 4)} | ${pad(fmtPct(med), 9)} | ${pad(
                fmtPct(avg),
                9
            )} | ${(winRate * 100).toFixed(0)}%`
        );
    }

    // ─── F2. Time-normalized lift per forward window ─────────────────
    console.log('\n═══ F2. Lift per Forward Window (time-normalized) ═══');
    function liftForReturns(rows: AnalyzedEntry[], getRet: (e: AnalyzedEntry) => number | null, label: string): void {
        const valid = rows.filter((e) => {
            const r = getRet(e);
            return r != null && Number.isFinite(r);
        });
        if (valid.length < 20) {
            console.log(`\n  ${label}: only ${valid.length} entries — skipped (need ≥20)`);
            return;
        }
        const sorted = [...valid].sort((a, b) => (getRet(b)! - getRet(a)!));
        const qSize = Math.max(5, Math.floor(sorted.length * 0.2));
        const t = sorted.slice(0, qSize);
        const b = sorted.slice(-qSize);
        const med = median(valid.map((e) => getRet(e)!));
        const winRate = valid.filter((e) => getRet(e)! > 0).length / valid.length;
        console.log(
            `\n  ${label} (n=${valid.length} complete | median ${fmtPct(med)} | win ${(winRate * 100).toFixed(0)}%):`
        );
        console.log(`    ${pad('Criterion', 18, true)} | ${pad('Top%', 6)} | ${pad('Bot%', 6)} | ${pad('Lift', 7)} | Verdict`);
        for (const k of CRITERIA_KEYS) {
            const tp = t.filter((e) => e.criteriaAtAlert?.[k]).length / t.length;
            const bp = b.filter((e) => e.criteriaAtAlert?.[k]).length / b.length;
            const lift = bp > 0 ? tp / bp : tp > 0 ? Infinity : 1;
            const verdict =
                lift >= 2 ? '✅' : lift >= 1.3 ? '+' : lift >= 0.85 ? '·' : lift >= 0.5 ? '⚠️' : '🛑';
            const liftStr = lift === Infinity ? '∞' : lift.toFixed(2) + 'x';
            console.log(
                `    ${pad(k, 18, true)} | ${pad((tp * 100).toFixed(0) + '%', 6)} | ${pad((bp * 100).toFixed(0) + '%', 6)} | ${pad(liftStr, 7)} | ${verdict}`
            );
        }
    }
    for (const w of FORWARD_WINDOWS) {
        liftForReturns(analyzed, (e) => e.forwardReturns[w] ?? null, `+${w}td`);
    }

    // ─── F3. Train/Test split — chronological, validate ret_10td ─────
    console.log('\n═══ F3. Train/Test Validation (chronological split, ret_10td) ═══');
    const withRet10 = analyzed.filter((e) => e.forwardReturns[10] != null);
    withRet10.sort((a, b) => a.firstAlertDate.localeCompare(b.firstAlertDate));
    const half = Math.floor(withRet10.length / 2);
    const train = withRet10.slice(0, half);
    const test = withRet10.slice(half);
    if (train.length < 20 || test.length < 20) {
        console.log(`  Insufficient data: train=${train.length}, test=${test.length}. Skipping validation.`);
    } else {
        const trainDates = `${train[0]!.firstAlertDate} → ${train[train.length - 1]!.firstAlertDate}`;
        const testDates = `${test[0]!.firstAlertDate} → ${test[test.length - 1]!.firstAlertDate}`;
        console.log(`\n  Train (n=${train.length}): ${trainDates}`);
        console.log(`  Test  (n=${test.length}): ${testDates}\n`);
        console.log(
            `  ${pad('Criterion', 18, true)} | ${pad('Train Lift', 11)} | ${pad('Test Lift', 11)} | Stable?`
        );
        console.log('  ' + '─'.repeat(60));

        const liftOf = (rows: AnalyzedEntry[], k: keyof MomentumCriteria): number => {
            const sorted = [...rows].sort((a, b) => (b.forwardReturns[10]! - a.forwardReturns[10]!));
            const qSize = Math.max(5, Math.floor(sorted.length * 0.2));
            const t = sorted.slice(0, qSize);
            const b = sorted.slice(-qSize);
            const tp = t.filter((e) => e.criteriaAtAlert?.[k]).length / t.length;
            const bp = b.filter((e) => e.criteriaAtAlert?.[k]).length / b.length;
            return bp > 0 ? tp / bp : tp > 0 ? Infinity : 1;
        };
        for (const k of CRITERIA_KEYS) {
            const trainLift = liftOf(train, k);
            const testLift = liftOf(test, k);
            const trainStr = trainLift === Infinity ? '∞' : trainLift.toFixed(2) + 'x';
            const testStr = testLift === Infinity ? '∞' : testLift.toFixed(2) + 'x';
            // Stable if both same side of 1.0 (both predictive or both anti-predictive)
            const sameSide =
                (trainLift >= 1.2 && testLift >= 1.2) ||
                (trainLift <= 0.83 && testLift <= 0.83) ||
                (trainLift > 0.83 && trainLift < 1.2 && testLift > 0.83 && testLift < 1.2);
            const stable = sameSide ? '✓ stable' : '✗ flips';
            console.log(`  ${pad(k, 18, true)} | ${pad(trainStr, 11)} | ${pad(testStr, 11)} | ${stable}`);
        }
    }

    // ─── G. Outcome status breakdown ─────────────────────────────────
    console.log('\n═══ G. Status (resolution) breakdown ═══');
    const byStatus = new Map<string, AnalyzedEntry[]>();
    for (const e of analyzed) {
        if (!byStatus.has(e.status)) byStatus.set(e.status, []);
        byStatus.get(e.status)!.push(e);
    }
    for (const [st, rows] of byStatus) {
        const med = median(rows.map((r) => r.returnPct));
        const avg = rows.reduce((s, r) => s + r.returnPct, 0) / rows.length;
        console.log(
            `  ${pad(st, 18, true)} n=${pad(rows.length, 3)} | median ${pad(fmtPct(med), 8)} | avg ${pad(
                fmtPct(avg),
                8
            )}`
        );
    }

    // ─── CSV export ─────────────────────────────────────────────────
    const csvPath = path.join(__dirname, '..', 'results', 'criteria-importance.csv');
    const headers = [
        'ticker',
        'firstAlertDate',
        'firstAlertLevel',
        'sector',
        'firstAlertPrice',
        'endPrice',
        'returnPct',
        'reAlertCount',
        'daysHeld',
        'snapshotLevel',
        'status',
        ...CRITERIA_KEYS,
        ...FORWARD_WINDOWS.map((w) => `ret_${w}td`),
    ];
    const csvLines = [headers.join(',')];
    for (const e of analyzed) {
        const row = [
            e.ticker,
            e.firstAlertDate,
            e.firstAlertLevel,
            e.sector,
            e.firstAlertPrice.toFixed(4),
            e.endPrice.toFixed(4),
            e.returnPct.toFixed(2),
            e.reAlertCount,
            e.daysHeld,
            e.snapshotLevel,
            e.status,
            ...CRITERIA_KEYS.map((k) => (e.criteriaAtAlert?.[k] ? '1' : '0')),
            ...FORWARD_WINDOWS.map((w) => {
                const r = e.forwardReturns[w];
                return r == null ? '' : r.toFixed(2);
            }),
        ];
        csvLines.push(row.join(','));
    }
    fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');
    console.log(`\n📁 Saved CSV: ${csvPath}`);
}

main().catch((err) => {
    logger.error('Fatal:', err);
    process.exit(1);
});
