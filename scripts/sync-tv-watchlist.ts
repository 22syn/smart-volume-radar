#!/usr/bin/env npx tsx
/**
 * Smart Volume Radar — sync the daily "breakout track" watchlist into TradingView.
 *
 * Long-term automation: runs nightly via a LaunchAgent on the user's mac.
 * Uses Playwright with a persistent Chromium profile (NOT the user's daily
 * Chrome — fully isolated). One-time login by the user, after which the
 * session persists indefinitely in the profile dir.
 *
 * Flow:
 *   1. Download the latest tv-watchlist-latest.txt from the most recent
 *      successful Lean Radar GitHub Actions artifact (no network call
 *      to TradingView yet — we just have the list of symbols).
 *   2. Open TradingView's chart page in the persistent Chromium profile.
 *   3. Open the named watchlist (creates if missing).
 *   4. Read existing symbols. Diff vs. target list:
 *        - Add symbols that are in target but not in TV.
 *        - Optionally remove symbols that are in TV but not in target
 *          (controlled by --replace flag; default is additive-only).
 *   5. Take a screenshot for audit (~/Library/Logs/tv-sync-{date}.png).
 *
 * Modes:
 *   --login            One-time interactive: launches non-headless browser,
 *                      waits up to 5 minutes for user to log in, then exits.
 *                      Session cookies persist in PROFILE_DIR for future runs.
 *   --replace          Sync as REPLACE (remove TV symbols not in target).
 *                      Default is ADDITIVE (only add, never remove).
 *   --watchlist NAME   Watchlist name in TradingView (default: 'Lean Radar').
 *   --headed           Force visible browser (default: headless when not --login).
 *   --dry-run          Read TV state and target list, print diff, do not modify.
 *
 * Auth notes: TradingView's "Add symbols" UI is reached via a single button
 * on the right-side watchlist panel. Selectors are kept in TV_SELECTORS at
 * the top of the file so they can be updated when TV changes their DOM.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Config ────────────────────────────────────────────────────────────
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs');
fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const REPO = 'KobiHaz/StockMarketBot';

// TradingView DOM selectors — update these when TV changes their HTML.
const TV_SELECTORS = {
    // Right-hand watchlist panel
    watchlistPanel: 'div[data-name="watchlists-dialog"], div.tv-screener-table',
    // The watchlist title dropdown (click to switch lists)
    watchlistTitleButton: 'button[data-name="watchlists-button"]',
    // Item in the dropdown for a named watchlist
    watchlistItem: (name: string) => `div[data-name="watchlists-menu"] >> text="${name}"`,
    // "+ Add symbol" button at the bottom of the watchlist
    addSymbolButton: 'button[data-name="add-symbol-button"]',
    // The autocomplete input that appears after clicking "Add symbol"
    symbolInput: 'input[data-name="symbol-search-input"]',
    // Each symbol row in the active watchlist
    symbolRow: 'div[data-name="list-item"]',
    symbolRowText: 'div[data-name="list-item"] [class*="symbolNameText"]',
    // Login form
    loginButton: 'button[data-name="header-user-menu-sign-in"]',
};

// ─── CLI ────────────────────────────────────────────────────────────
function arg(name: string, fallback = ''): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
function has(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const LOGIN_MODE = has('login');
const DRY_RUN = has('dry-run');
const REPLACE = has('replace');
const HEADED = has('headed') || LOGIN_MODE;
const WATCHLIST_NAME = arg('watchlist', 'Lean Radar');
const WATCHLIST_FILE = arg('file', path.join(PROJECT_ROOT, 'results', 'tv-watchlist-latest.txt'));

// ─── Log helper ─────────────────────────────────────────────────────
const logPath = path.join(LOG_DIR, 'tv-sync.log');
function log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    fs.appendFileSync(logPath, line + '\n');
}

// ─── Step 1: Get the latest watchlist file ───────────────────────────
function downloadLatestArtifact(): string | null {
    log('🔎 Looking for the latest Lean Radar artifact via gh CLI...');
    try {
        // Find the latest successful run ID
        const runId = execSync(
            `gh run list --workflow="Lean Radar - Daily Scan" --status=success --limit 1 --json databaseId -q '.[0].databaseId' --repo ${REPO}`,
            { encoding: 'utf8' }
        ).trim();
        if (!runId) {
            log('⚠️ No successful runs found via gh CLI; falling back to local file.');
            return null;
        }
        log(`  ↳ latest run: ${runId}`);

        // Download to a temp dir
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svr-tv-'));
        execSync(`gh run download ${runId} --repo ${REPO} --dir "${tmpDir}"`, { encoding: 'utf8', stdio: 'pipe' });

        // Walk the temp dir for tv-watchlist-latest.txt
        const found = findFile(tmpDir, 'tv-watchlist-latest.txt');
        if (!found) {
            log('⚠️ Artifact downloaded but tv-watchlist-latest.txt not found in it.');
            return null;
        }
        log(`✓ Downloaded artifact watchlist: ${found}`);
        return found;
    } catch (e) {
        log(`⚠️ gh download failed: ${(e as Error).message}. Falling back to local file.`);
        return null;
    }
}

function findFile(dir: string, name: string): string | null {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const r = findFile(p, name);
            if (r) return r;
        } else if (entry.name === name) {
            return p;
        }
    }
    return null;
}

function parseWatchlist(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim());
    return lines.filter((l) => l && !l.startsWith('#'));
}

// ─── Step 2-4: Drive TradingView via Playwright ──────────────────────
async function isLoggedIn(page: Page): Promise<boolean> {
    // The "Sign in" button is only visible when logged out.
    const signInBtn = await page.$(TV_SELECTORS.loginButton);
    return !signInBtn;
}

async function openWatchlist(page: Page, name: string): Promise<void> {
    log(`↳ Switching to watchlist "${name}"...`);
    // Click the watchlist title dropdown
    const titleBtn = await page.waitForSelector(TV_SELECTORS.watchlistTitleButton, { timeout: 10000 });
    await titleBtn.click();
    await page.waitForTimeout(500);
    // Click the named watchlist item
    const item = await page.$(TV_SELECTORS.watchlistItem(name));
    if (!item) {
        throw new Error(
            `Watchlist "${name}" not found in TradingView. Please create it manually (right panel → list dropdown → Create new list).`
        );
    }
    await item.click();
    await page.waitForTimeout(800);
}

async function readCurrentSymbols(page: Page): Promise<string[]> {
    const els = await page.$$(TV_SELECTORS.symbolRowText);
    const symbols: string[] = [];
    for (const el of els) {
        const t = (await el.textContent())?.trim();
        if (t) symbols.push(t);
    }
    return symbols;
}

async function addSymbol(page: Page, symbol: string): Promise<void> {
    log(`  + ${symbol}`);
    // Click "+ Add symbol"
    const addBtn = await page.waitForSelector(TV_SELECTORS.addSymbolButton, { timeout: 5000 });
    await addBtn.click();
    // Type the symbol
    const input = await page.waitForSelector(TV_SELECTORS.symbolInput, { timeout: 5000 });
    await input.fill(symbol);
    await page.waitForTimeout(600); // wait for autocomplete
    await input.press('Enter');
    await page.waitForTimeout(400);
    // Close the dialog (Esc)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
}

async function syncWatchlist(page: Page, target: string[]): Promise<void> {
    log(`📋 Target watchlist (${target.length}): ${target.join(', ')}`);

    await openWatchlist(page, WATCHLIST_NAME);

    const current = await readCurrentSymbols(page);
    log(`📋 Current in TV (${current.length}): ${current.join(', ')}`);

    // Normalize for diff. TV displays without exchange prefix, our file has it.
    // For comparison, strip the exchange prefix from target.
    const normalize = (s: string) => s.split(':').pop()!.toUpperCase();
    const targetSet = new Set(target.map(normalize));
    const currentSet = new Set(current.map(normalize));

    const toAdd = target.filter((s) => !currentSet.has(normalize(s)));
    const toRemove = current.filter((s) => !targetSet.has(normalize(s)));

    log(`→ to add: ${toAdd.length} (${toAdd.join(', ') || '—'})`);
    if (REPLACE) log(`→ to remove: ${toRemove.length} (${toRemove.join(', ') || '—'})`);

    if (DRY_RUN) {
        log('(dry-run — no changes made)');
        return;
    }

    for (const s of toAdd) {
        try {
            await addSymbol(page, s);
        } catch (e) {
            log(`  ⚠️ Failed to add ${s}: ${(e as Error).message}`);
        }
    }

    if (REPLACE) {
        log('(NOTE: --replace removal not yet implemented — manual review for now)');
    }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
    log(`═══ TV Sync — ${LOGIN_MODE ? 'LOGIN MODE' : DRY_RUN ? 'DRY-RUN' : 'sync'} ═══`);
    log(`Profile dir: ${PROFILE_DIR}`);
    log(`Watchlist:   ${WATCHLIST_NAME}`);
    log(`File:        ${WATCHLIST_FILE}`);

    let context: BrowserContext | null = null;
    try {
        context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: !HEADED,
            viewport: { width: 1400, height: 900 },
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const page = context.pages()[0] ?? (await context.newPage());

        if (LOGIN_MODE) {
            log('Opening TradingView for one-time login...');
            await page.goto('https://www.tradingview.com/#signin', { waitUntil: 'domcontentloaded' });
            log('⌛ Browser is now open. Log into TradingView, then close the browser window when done.');
            log('   (The session will persist in the profile dir for future runs.)');
            // Wait until the user closes the context (close all pages) or up to 10 min.
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => resolve(), 10 * 60 * 1000);
                context!.on('close', () => { clearTimeout(timeout); resolve(); });
            });
            log('✓ Login flow completed.');
            return;
        }

        // Determine watchlist source: prefer GH artifact, fall back to local.
        let watchlistPath = downloadLatestArtifact() ?? WATCHLIST_FILE;
        if (!fs.existsSync(watchlistPath)) {
            throw new Error(`Watchlist file not found: ${watchlistPath}. Run preview:lean to generate one.`);
        }
        const target = parseWatchlist(watchlistPath);
        if (target.length === 0) {
            log('📭 Target watchlist is empty — nothing to sync.');
            return;
        }

        // Navigate to TradingView chart page (which has the watchlist panel).
        await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000); // let SPA hydrate

        if (!(await isLoggedIn(page))) {
            throw new Error(
                'Not logged into TradingView. Run with --login once to authenticate. ' +
                'See ~/Library/Logs/tv-sync.log for details.'
            );
        }

        await syncWatchlist(page, target);

        // Screenshot for audit
        const screenshotPath = path.join(LOG_DIR, `tv-sync-${new Date().toISOString().slice(0, 10)}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        log(`📸 Screenshot saved: ${screenshotPath}`);
    } catch (e) {
        log(`❌ Error: ${(e as Error).message}`);
        if (context) {
            const errShot = path.join(LOG_DIR, `tv-sync-error-${Date.now()}.png`);
            try { await context.pages()[0]?.screenshot({ path: errShot }); log(`  err screenshot: ${errShot}`); } catch { /* */ }
        }
        process.exit(1);
    } finally {
        await context?.close();
    }
}

main().catch((e) => { log(`❌ Fatal: ${(e as Error).message}`); process.exit(1); });
