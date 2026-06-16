#!/usr/bin/env npx tsx
/**
 * export-tv-cookies — one-time helper.
 * Reads TradingView session cookies from the local Playwright persistent
 * profile and prints them as base64-encoded JSON to stdout.
 *
 * Usage:
 *   npx tsx scripts/export-tv-cookies.ts
 *   # Copy the output, then:
 *   gh secret set TV_COOKIES --body "<paste output>" --repo KobiHaz/StockMarketBot
 */
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';

const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');

async function main() {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
    const cookies = await context.cookies('https://www.tradingview.com');
    await context.close();

    if (cookies.length === 0) {
        process.stderr.write('❌ No cookies found. Run `npm run tv-sync -- --login` first.\n');
        process.exit(1);
    }

    const b64 = Buffer.from(JSON.stringify(cookies)).toString('base64');
    process.stdout.write(b64 + '\n');
    process.stderr.write(`✓ Exported ${cookies.length} cookies. Paste into GitHub Secret "TV_COOKIES".\n`);
    process.stderr.write('  gh secret set TV_COOKIES --body "<paste>" --repo KobiHaz/StockMarketBot\n');
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
