/**
 * Sector outcomes — runtime reader for `results/sector-outcomes.json`.
 *
 * Drives TD-15 (Persistent-Loser Sector Blacklist) DYNAMICALLY. Replaces the
 * earlier hardcoded `PERSISTENT_LOSER_SECTORS` constant: the list is now
 * auto-generated weekly by `scripts/bootstrap-ticker-outcomes.ts` from the
 * trailing 63-td precision data.
 *
 * Why this matters: sectors rotate. A sector that's a persistent loser today
 * (Banks 0% win) might recover next month — and conversely, a sector that's
 * crushing it now (Semis 54% win) could top out. A hardcoded list ages badly.
 * The dynamic list updates with every weekly refresh.
 *
 * Fallback: if the file doesn't exist (fresh repo, first run), falls back to
 * the conservative hardcoded list of well-known persistent losers. This keeps
 * the pipeline safe in all environments.
 */
import fs from 'node:fs';
import path from 'node:path';

interface SectorOutcomesFile {
    generatedAt: string;
    sourceFile?: string;
    config?: Record<string, number>;
    perSector: Record<string, {
        alerts: number;
        winRate: number;
        medianPeak21d: number;
        medianForwardNow: number;
        blacklisted: boolean;
    }>;
}

// Conservative fallback used when no sector-outcomes.json exists (e.g., fresh
// repo, never run bootstrap). Mirrors the earlier hardcoded constant in
// championScore.ts so behavior matches the 2026-05-23 launch baseline.
const FALLBACK_BLACKLIST = new Set<string>([
    'Banks', 'Telco', 'Defense', 'Finance',
    'real estate', 'residence', 'consumer basic', 'Aerospace & Defense',
]);

let cached: Set<string> | null = null;
let cachedMtimeMs = 0;

/**
 * Load the persistent-loser sector blacklist. Hot-reloads if the file mtime
 * changes (so the next scan picks up a fresh weekly refresh without restart).
 */
export function loadSectorBlacklist(resultsDir: string): Set<string> {
    const p = path.join(resultsDir, 'sector-outcomes.json');

    if (!fs.existsSync(p)) {
        cached = FALLBACK_BLACKLIST;
        return cached;
    }

    const stat = fs.statSync(p);
    if (cached && stat.mtimeMs === cachedMtimeMs) {
        return cached;
    }

    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8')) as SectorOutcomesFile;
        const set = new Set<string>();
        for (const [sector, s] of Object.entries(data.perSector ?? {})) {
            if (s.blacklisted) set.add(sector);
        }
        cached = set;
        cachedMtimeMs = stat.mtimeMs;
        return cached;
    } catch {
        // Malformed file — fall back to hardcoded list rather than block.
        cached = FALLBACK_BLACKLIST;
        return cached;
    }
}

/** Convenience predicate. */
export function isSectorBlacklisted(resultsDir: string, sector: string | undefined): boolean {
    if (!sector) return false;
    return loadSectorBlacklist(resultsDir).has(sector);
}
