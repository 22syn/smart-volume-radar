#!/usr/bin/env npx tsx
/**
 * Entry-Precision Study — slices the precision-analysis flag dataset every way
 * that matters for tightening BUY/WATCH entries. Pure analysis, no side effects.
 *
 * Answers:
 *   1. Win rate + median peak by action / stage / momentum level
 *   2. extensionPct buckets → is the 0-5% "BUY zone" actually the sweet spot?
 *   3. RVOL buckets → does higher RVOL = better forward return? (RVOL-accel thesis)
 *   4. championScore bands → where's the real cutoff?
 *   5. distributionDays → does distribution pressure hurt?
 *   6. "Precise entry" combo: BUY + extension<3% + rvol≥3 vs everything else
 *   7. POET coverage — did the radar ever flag it?
 *
 * Usage: npx tsx scripts/entry-precision-study.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(__dirname, '..', 'results');

interface Flag {
    action: string;
    championScore: number;
    momentumLevel: string;
    rvol: number;
    barGain: number;
    sector: string;
    breakoutStage: string;
    extensionPct: number;
    distributionDays: number;
    lastPrice: number;
    date: string;
    ticker: string;
    forward21d: number | null;
    peak21d: number | null;
    forwardNow: number | null;
    isWin: boolean;
    outcome: string;
}

const file = fs.readdirSync(RESULTS).filter((f) => /^precision-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop()!;
const data = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8')) as { flags: Flag[] };
const flags = data.flags.filter((f) => f.outcome !== 'no_data' && f.peak21d != null);

console.log(`📂 ${file} — ${data.flags.length} flags, ${flags.length} with outcomes\n`);

function median(xs: number[]): number {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
}
function stats(subset: Flag[]) {
    const n = subset.length;
    if (!n) return { n: 0, winRate: 0, medPeak: 0, medFwd21: 0, medNow: 0 };
    const wins = subset.filter((f) => f.isWin).length;
    return {
        n,
        winRate: wins / n,
        medPeak: median(subset.map((f) => f.peak21d ?? 0)),
        medFwd21: median(subset.map((f) => f.forward21d ?? 0)),
        medNow: median(subset.map((f) => f.forwardNow ?? 0)),
    };
}
function table(title: string, groups: Array<[string, Flag[]]>) {
    console.log(`\n══ ${title} ══`);
    console.log(`${'Bucket'.padEnd(26)} ${'n'.padStart(5)} ${'WIN%'.padStart(6)} ${'medPeak'.padStart(8)} ${'medFwd21'.padStart(9)} ${'medNow'.padStart(8)}`);
    console.log('─'.repeat(70));
    for (const [label, subset] of groups) {
        const s = stats(subset);
        if (s.n === 0) continue;
        console.log(
            `${label.padEnd(26)} ${String(s.n).padStart(5)} ${(s.winRate * 100).toFixed(0).padStart(5)}% ` +
            `${(s.medPeak * 100).toFixed(1).padStart(7)}% ${(s.medFwd21 * 100).toFixed(1).padStart(8)}% ${(s.medNow * 100).toFixed(1).padStart(7)}%`
        );
    }
}

// 1. By action
const actions = [...new Set(flags.map((f) => f.action))];
table('1. By ACTION', actions.map((a) => [a, flags.filter((f) => f.action === a)]));

// 2. By breakout stage
const stages = [...new Set(flags.map((f) => f.breakoutStage))];
table('2. By BREAKOUT STAGE', stages.map((s) => [s, flags.filter((f) => f.breakoutStage === s)]));

// 3. By momentum level
const levels = [...new Set(flags.map((f) => f.momentumLevel))];
table('3. By MOMENTUM LEVEL', levels.map((l) => [l, flags.filter((f) => f.momentumLevel === l)]));

// 4. extensionPct buckets
table('4. By EXTENSION-PCT (pivot proximity)', [
    ['0–2% (at pivot)', flags.filter((f) => f.extensionPct >= 0 && f.extensionPct < 2)],
    ['2–5%', flags.filter((f) => f.extensionPct >= 2 && f.extensionPct < 5)],
    ['5–10% (CAUTION)', flags.filter((f) => f.extensionPct >= 5 && f.extensionPct < 10)],
    ['>10% (TOO_LATE)', flags.filter((f) => f.extensionPct >= 10)],
]);

// 5. RVOL buckets
table('5. By RVOL (volume conviction)', [
    ['<2', flags.filter((f) => f.rvol < 2)],
    ['2–3', flags.filter((f) => f.rvol >= 2 && f.rvol < 3)],
    ['3–5', flags.filter((f) => f.rvol >= 3 && f.rvol < 5)],
    ['5–10', flags.filter((f) => f.rvol >= 5 && f.rvol < 10)],
    ['≥10', flags.filter((f) => f.rvol >= 10)],
]);

// 6. championScore bands
table('6. By CHAMPION SCORE band', [
    ['<60', flags.filter((f) => f.championScore < 60)],
    ['60–69', flags.filter((f) => f.championScore >= 60 && f.championScore < 70)],
    ['70–79', flags.filter((f) => f.championScore >= 70 && f.championScore < 80)],
    ['80–89', flags.filter((f) => f.championScore >= 80 && f.championScore < 90)],
    ['≥90', flags.filter((f) => f.championScore >= 90)],
]);

// 7. distribution days
table('7. By DISTRIBUTION DAYS', [
    ['0–2', flags.filter((f) => f.distributionDays <= 2)],
    ['3–5', flags.filter((f) => f.distributionDays >= 3 && f.distributionDays <= 5)],
    ['6+', flags.filter((f) => f.distributionDays >= 6)],
]);

// 8. The "precise entry" combo hypothesis
const buyish = flags.filter((f) => f.action === 'BUY');
table('8. PRECISE-ENTRY COMBO (within BUY only)', [
    ['BUY all', buyish],
    ['BUY + ext<3%', buyish.filter((f) => f.extensionPct < 3)],
    ['BUY + rvol≥3', buyish.filter((f) => f.rvol >= 3)],
    ['BUY + ext<3% + rvol≥3', buyish.filter((f) => f.extensionPct < 3 && f.rvol >= 3)],
    ['BUY + ext<3% + rvol≥3 + score≥80', buyish.filter((f) => f.extensionPct < 3 && f.rvol >= 3 && f.championScore >= 80)],
]);

// 9. Graduation proxy: full vs close, and "Breaking Out" stage specifically
table('9. GRADUATION proxy (level=full, stage=Breaking Out)', [
    ['level=full', flags.filter((f) => f.momentumLevel === 'full')],
    ['full + Breaking Out', flags.filter((f) => f.momentumLevel === 'full' && f.breakoutStage === 'Breaking Out')],
    ['full + Fresh', flags.filter((f) => f.momentumLevel === 'full' && f.breakoutStage === 'Fresh')],
    ['close (not yet full)', flags.filter((f) => f.momentumLevel === 'close')],
]);

// 10. POET coverage
const poet = data.flags.filter((f) => f.ticker === 'POET');
console.log(`\n══ 10. POET coverage ══`);
if (poet.length === 0) {
    console.log('  ❌ POET NEVER appeared in any flag — it was never in the watchlist or never produced a signal.');
} else {
    console.log(`  POET appeared ${poet.length} times:`);
    for (const f of poet.slice(0, 10)) {
        console.log(`    ${f.date} | ${f.action} | stage=${f.breakoutStage} | lvl=${f.momentumLevel} | rvol=${f.rvol?.toFixed(1)} | score=${f.championScore} | peak21d=${f.peak21d != null ? (f.peak21d*100).toFixed(0)+'%' : 'n/a'}`);
    }
}

console.log('\n✅ Study complete.');
