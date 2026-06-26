#!/usr/bin/env npx tsx
/**
 * Smart Volume Radar — populate the universe sheet from a friend's shared TradingView
 * watchlists (one watchlist per sector). Runs in CI before the daily scan, or manually
 * via `npm run sync-friend-watchlists`. No browser/login — reads public share pages.
 *
 * Env: GOOGLE_SHEET_ID (target), and one of GOOGLE_SHEETS_CREDENTIALS /
 * GOOGLE_SHEETS_CREDENTIALS_JSON (service account). Sources: watchlist-sources.json.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../src/utils/logger.js';
import { fetchSharedWatchlist } from '../src/services/sharedWatchlist.js';
import { tvToYahoo } from '../src/services/symbolMap.js';
import { writeUniverseSheet, type UniverseRow } from '../src/services/universeSheetWriter.js';

interface Source {
    sector: string;
    shareUrl: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadSources(): Source[] {
    const file = path.join(PROJECT_ROOT, 'watchlist-sources.json');
    let raw: string;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        throw new Error(`Cannot read ${file}. Copy watchlist-sources.example.json and fill it in.`);
    }
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('watchlist-sources.json must be a JSON array');
    return data.map((row, i) => {
        const r = row as Record<string, unknown>;
        if (typeof r.sector !== 'string' || !r.sector.trim()) {
            throw new Error(`watchlist-sources[${i}]: "sector" must be a non-empty string`);
        }
        if (typeof r.shareUrl !== 'string' || !r.shareUrl.trim()) {
            throw new Error(`watchlist-sources[${i}]: "shareUrl" must be a non-empty string`);
        }
        return { sector: r.sector.trim(), shareUrl: r.shareUrl.trim() };
    });
}

async function main(): Promise<void> {
    const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
    if (!sheetId) throw new Error('GOOGLE_SHEET_ID is required (target universe sheet).');

    const sources = loadSources();
    const seen = new Set<string>();
    const rows: UniverseRow[] = [];
    const skipped: string[] = [];
    let failures = 0;

    for (const s of sources) {
        try {
            const tvSymbols = await fetchSharedWatchlist(s.shareUrl);
            if (tvSymbols.length === 0) {
                logger.warn(`${s.sector}: read 0 symbols — skipping this source (suspected fetch/parse miss)`);
                failures++;
                continue;
            }
            let added = 0;
            for (const tv of tvSymbols) {
                const yahoo = tvToYahoo(tv);
                if (!yahoo) {
                    skipped.push(`${tv} (${s.sector})`);
                    continue;
                }
                const key = yahoo.toUpperCase();
                if (seen.has(key)) continue; // first sector wins, mirrors loadWatchlist dedup
                seen.add(key);
                rows.push({ symbol: yahoo, sector: s.sector });
                added++;
            }
            logger.info(`${s.sector}: ${added} symbols (${tvSymbols.length} read)`);
        } catch (e) {
            logger.error(`${s.sector}: ${(e as Error).message}`);
            failures++;
        }
    }

    if (skipped.length > 0) {
        logger.warn(`Skipped ${skipped.length} unmapped symbols: ${skipped.join(', ')}`);
    }
    if (rows.length === 0) {
        throw new Error('No symbols resolved from any source — refusing to overwrite the universe sheet.');
    }

    await writeUniverseSheet(sheetId, rows);
    logger.info(
        `Universe sheet updated: ${rows.length} symbols across ${sources.length - failures}/${sources.length} sources.`,
    );
    if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
    logger.error(`fatal: ${(e as Error).message}`);
    process.exit(1);
});
