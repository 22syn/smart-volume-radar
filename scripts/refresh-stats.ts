#!/usr/bin/env npx tsx
/**
 * Refresh ALL stats files in one command:
 *   1. reconstruct-radar.ts (63 td of historical Yahoo + production code)
 *   2. precision-analysis.ts (forward returns + outcome classification)
 *   3. bootstrap-ticker-outcomes.ts (ticker + sector outcomes files)
 *
 * Total time: ~6-8 min (mostly Yahoo fetch in step 1).
 *
 * Used by:
 *   - Weekly GHA workflow (.github/workflows/weekly-stats-refresh.yml)
 *   - Manual refresh after any significant code change
 *
 * Output files (all committed to repo):
 *   - results/ticker-outcomes.json — TD-21 blacklist + TD-23 hot streak
 *   - results/sector-outcomes.json — TD-15 dynamic sector blacklist
 *
 * Side effects:
 *   - Overwrites results/radar-reconstructed-{today}.json
 *   - Overwrites results/precision-analysis-{today}.json
 *
 * Usage:
 *   BACKTEST_MODE=1 npx tsx scripts/refresh-stats.ts [--days 63]
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const DAYS = arg('days', '63');

function run(label: string, cmd: string): void {
    console.log(`\n═══ ${label} ═══`);
    const t0 = Date.now();
    execSync(cmd, { stdio: 'inherit', cwd: PROJECT_ROOT, env: { ...process.env, BACKTEST_MODE: '1' } });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✓ ${label} done in ${dt}s`);
}

console.log(`🔄 Refreshing stats (${DAYS} trading days back)...`);

run(
    '1/3 Reconstruct radar',
    `npx tsx scripts/reconstruct-radar.ts --days ${DAYS}`
);

run(
    '2/3 Precision analysis',
    `npx tsx scripts/precision-analysis.ts`
);

run(
    '3/3 Bootstrap outcomes',
    `npx tsx scripts/bootstrap-ticker-outcomes.ts`
);

console.log('\n✅ All stats files refreshed. Commit + push:');
console.log('   git add results/ticker-outcomes.json results/sector-outcomes.json');
console.log('   git commit -m "refresh: stats outcomes (weekly)"');
console.log('   git push');
