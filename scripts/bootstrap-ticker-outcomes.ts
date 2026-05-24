#!/usr/bin/env npx tsx
/**
 * Build TWO outcomes files from the precision-analysis output:
 *   1. results/ticker-outcomes.json — per-ticker stats for TD-21/23
 *   2. results/sector-outcomes.json — per-sector stats for TD-15 (dynamic)
 *
 * Consumed at scan time → drives:
 *   - TD-15 dynamic sector blacklist (sectorOutcomes.ts) — replaces the
 *     hardcoded PERSISTENT_LOSER_SECTORS constant. Sectors flip in/out as
 *     the data shifts.
 *   - TD-21 auto ticker blacklist (recentWinRate < 10% AND no medNow drift)
 *   - TD-23 hot streak (recentWinRate ≥ 80% AND ≥ 10 alerts)
 *
 * Run this:
 *   - Via scripts/refresh-stats.ts (one command that does reconstruct →
 *     precision → bootstrap, refresh ~6 min)
 *   - Weekly via GHA workflow (.github/workflows/weekly-stats-refresh.yml)
 *   - Manually when investigating a specific classification change
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');

const BLACKLIST_RATE = 0.10;   // < 10% win rate → eligible for blacklist
const BLACKLIST_MIN_N = 8;
const BLACKLIST_MAX_MEDIAN_PEAK = 0.05;  // medPeak21d < +5% AND...
const BLACKLIST_MAX_MEDIAN_NOW = 0;      // medForwardNow ≤ 0% (only truly losing/flat tickers — slow grinders like TSM +1.7%, ASML +7% survive)
const HOT_STREAK_RATE = 0.80;  // ≥ 80% win rate → hot streak
const HOT_STREAK_MIN_N = 10;
const TRAILING_N = 30;         // only count last N alerts per ticker

interface FlagWithOutcome {
    date: string;
    ticker: string;
    sector: string;
    isWin: boolean;
    outcome: string;
    peak21d: number | null;
    forwardNow: number | null;
}

// Sector-level criteria (TD-15 dynamic). Stricter than ticker-level because
// sectors aggregate many tickers — blacklisting a sector blocks ALL its names.
// TWO independent paths to blacklist:
//   Path A (noisy AND slightly losing): low win rate + small peaks + non-positive drift
//   Path B (heavy bleed): doesn't matter the win rate, sector is losing money fast
// Both require n ≥ 25 to avoid blacklisting niche sectors on small samples.
const SECTOR_BLACKLIST_MIN_N = 25;
const SECTOR_BLACKLIST_RATE = 0.20;
const SECTOR_BLACKLIST_MAX_MEDIAN_PEAK = 0.04;
const SECTOR_BLACKLIST_MAX_MEDIAN_NOW = 0;
const SECTOR_BLACKLIST_HEAVY_BLEED = -0.05;  // medNow ≤ -5% → blacklist regardless of win rate

function median(nums: number[]): number {
    const sorted = [...nums].sort((a, b) => a - b);
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
if (files.length === 0) {
    console.error('❌ No precision-analysis-*.json found. Run precision-analysis.ts first.');
    process.exit(1);
}
const latest = path.join(RESULTS_DIR, files[files.length - 1]!);
console.log(`📂 Source: ${path.basename(latest)}`);
const data = JSON.parse(fs.readFileSync(latest, 'utf8')) as { flags: FlagWithOutcome[] };

// Group by ticker, take most recent TRAILING_N alerts
const byTicker = new Map<string, FlagWithOutcome[]>();
for (const f of data.flags) {
    if (f.outcome === 'no_data') continue;
    const arr = byTicker.get(f.ticker) ?? [];
    arr.push(f);
    byTicker.set(f.ticker, arr);
}

const perTicker: Record<string, { recentWinRate: number; recentAlertsCounted: number; blacklisted: boolean; hotStreak: boolean }> = {};
let blacklistedCount = 0;
let hotStreakCount = 0;

for (const [ticker, arr] of byTicker) {
    arr.sort((a, b) => b.date.localeCompare(a.date)); // newest first
    const slice = arr.slice(0, TRAILING_N);
    const wins = slice.filter((x) => x.isWin).length;
    const rate = wins / slice.length;
    const medPeak = median(slice.map((x) => x.peak21d ?? 0));
    const medNow = median(slice.map((x) => x.forwardNow ?? 0));

    // Refined blacklist criteria (2026-05-23): low win-rate ALONE is not
    // enough — mega-caps and slow grinders (TSM/ASML/SUN/KO) have 0% win
    // by the +10% peak threshold but still gain money long-term (+7% now).
    // Require both: low single-event peaks AND no long-term drift.
    const blacklisted =
        rate < BLACKLIST_RATE &&
        slice.length >= BLACKLIST_MIN_N &&
        medPeak < BLACKLIST_MAX_MEDIAN_PEAK &&
        medNow <= BLACKLIST_MAX_MEDIAN_NOW;
    const hotStreak = rate >= HOT_STREAK_RATE && slice.length >= HOT_STREAK_MIN_N;
    if (blacklisted) blacklistedCount++;
    if (hotStreak) hotStreakCount++;
    perTicker[ticker] = {
        recentWinRate: rate,
        recentAlertsCounted: slice.length,
        blacklisted,
        hotStreak,
    };
}

const out = {
    generatedAt: new Date().toISOString(),
    config: {
        TRAILING_N, BLACKLIST_RATE, BLACKLIST_MIN_N,
        BLACKLIST_MAX_MEDIAN_PEAK, BLACKLIST_MAX_MEDIAN_NOW,
        HOT_STREAK_RATE, HOT_STREAK_MIN_N,
    },
    perTicker,
};
const outPath = path.join(RESULTS_DIR, 'ticker-outcomes.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`✓ Wrote ${outPath}`);
console.log(`   ${Object.keys(perTicker).length} tickers classified`);
console.log(`   ${blacklistedCount} blacklisted (TD-21)`);
console.log(`   ${hotStreakCount} hot streak (TD-23)`);

if (blacklistedCount > 0) {
    console.log('\nTop 15 blacklisted:');
    Object.entries(perTicker)
        .filter(([, v]) => v.blacklisted)
        .sort((a, b) => a[1].recentWinRate - b[1].recentWinRate)
        .slice(0, 15)
        .forEach(([t, v]) => console.log(`   ${t.padEnd(12)} ${v.recentAlertsCounted} alerts, ${(v.recentWinRate*100).toFixed(0)}% win`));
}
// ─── Sector outcomes (TD-15 dynamic blacklist source) ──────────────
console.log('\n📊 Computing per-sector outcomes...');
const bySector = new Map<string, FlagWithOutcome[]>();
for (const f of data.flags) {
    if (f.outcome === 'no_data' || !f.sector) continue;
    const arr = bySector.get(f.sector) ?? [];
    arr.push(f);
    bySector.set(f.sector, arr);
}

const perSector: Record<string, {
    alerts: number;
    winRate: number;
    medianPeak21d: number;
    medianForwardNow: number;
    blacklisted: boolean;
}> = {};
let sectorBlacklistedCount = 0;

for (const [sector, arr] of bySector) {
    const wins = arr.filter((x) => x.isWin).length;
    const rate = wins / arr.length;
    const medPeak = median(arr.map((x) => x.peak21d ?? 0));
    const medNow = median(arr.map((x) => x.forwardNow ?? 0));
    const pathA =
        rate < SECTOR_BLACKLIST_RATE &&
        medPeak < SECTOR_BLACKLIST_MAX_MEDIAN_PEAK &&
        medNow <= SECTOR_BLACKLIST_MAX_MEDIAN_NOW;
    const pathB = medNow <= SECTOR_BLACKLIST_HEAVY_BLEED;
    const blacklisted =
        arr.length >= SECTOR_BLACKLIST_MIN_N && (pathA || pathB);
    if (blacklisted) sectorBlacklistedCount++;
    perSector[sector] = {
        alerts: arr.length,
        winRate: rate,
        medianPeak21d: medPeak,
        medianForwardNow: medNow,
        blacklisted,
    };
}

const sectorOut = {
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(latest),
    config: {
        SECTOR_BLACKLIST_RATE,
        SECTOR_BLACKLIST_MIN_N,
        SECTOR_BLACKLIST_MAX_MEDIAN_PEAK,
        SECTOR_BLACKLIST_MAX_MEDIAN_NOW,
        SECTOR_BLACKLIST_HEAVY_BLEED,
    },
    perSector,
};
const sectorPath = path.join(RESULTS_DIR, 'sector-outcomes.json');
fs.writeFileSync(sectorPath, JSON.stringify(sectorOut, null, 2));

console.log(`✓ Wrote ${sectorPath}`);
console.log(`   ${Object.keys(perSector).length} sectors classified`);
console.log(`   ${sectorBlacklistedCount} blacklisted (TD-15 dynamic)`);

console.log('\nSector breakdown (sorted by win rate):');
console.log(`${'Sector'.padEnd(25)} ${'n'.padStart(5)} ${'WIN%'.padStart(5)} ${'medPeak'.padStart(8)} ${'medNow'.padStart(7)}  ${'STATUS'}`);
console.log('-'.repeat(75));
Object.entries(perSector)
    .sort((a, b) => b[1].winRate - a[1].winRate)
    .forEach(([s, v]) => {
        const status = v.blacklisted ? '🔴 BLACKLIST' : v.winRate >= 0.5 ? '✓ strong' : v.winRate >= 0.3 ? '· ok' : '⚠ weak';
        console.log(`${s.padEnd(25)} ${String(v.alerts).padStart(5)} ${(v.winRate*100).toFixed(0).padStart(4)}% ${(v.medianPeak21d*100).toFixed(1).padStart(7)}% ${(v.medianForwardNow*100).toFixed(1).padStart(6)}%  ${status}`);
    });

if (hotStreakCount > 0) {
    console.log('\nTop 10 hot streak:');
    Object.entries(perTicker)
        .filter(([, v]) => v.hotStreak)
        .sort((a, b) => b[1].recentWinRate - a[1].recentWinRate)
        .slice(0, 10)
        .forEach(([t, v]) => console.log(`   ${t.padEnd(12)} ${v.recentAlertsCounted} alerts, ${(v.recentWinRate*100).toFixed(0)}% win`));
}
