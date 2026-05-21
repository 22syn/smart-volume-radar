#!/usr/bin/env npx tsx
/**
 * Debug helper — opens TradingView in the persistent Playwright profile,
 * navigates to chart, dumps all visible buttons + data-name attributes,
 * and saves a full screenshot. Used to find the right selectors for the
 * sync-tv-watchlist.ts script after TV's DOM changes.
 *
 * Usage: BACKTEST_MODE=1 npx tsx scripts/debug-tv-dom.ts
 */
import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PROFILE_DIR = path.join(os.homedir(), '.cache', 'svr-tv-sync', 'chromium-profile');
const OUT_DIR = path.join(os.homedir(), 'Library', 'Logs');

async function main() {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1600, height: 1000 },
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    console.error('opening chart…');
    await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000); // let SPA fully hydrate

    // Press Escape a few times to dismiss any modals
    for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    }

    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const before = path.join(OUT_DIR, `tv-debug-before-${ts}.png`);
    await page.screenshot({ path: before, fullPage: false });
    console.error(`📸 before: ${before}`);

    // Dump all data-name attributes
    const dataNames = await page.evaluate(() => {
        const els = document.querySelectorAll('[data-name]');
        const counts = new Map<string, number>();
        els.forEach((el) => {
            const n = el.getAttribute('data-name') || '';
            counts.set(n, (counts.get(n) || 0) + 1);
        });
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    });
    console.error(`\n=== ALL data-name (top 50) ===`);
    for (const [n, c] of dataNames.slice(0, 50)) {
        console.error(`  ${n.padEnd(50)} ×${c}`);
    }

    // Look for things relevant to watchlist/symbols
    const wlNames = dataNames.filter(([n]) =>
        /watch|symbol|add|list|search/i.test(n)
    );
    console.error(`\n=== watchlist/symbol-related data-name ===`);
    for (const [n, c] of wlNames) console.error(`  ${n.padEnd(50)} ×${c}`);

    // Dump visible button texts in the right panel
    const buttons = await page.evaluate(() => {
        const arr: Array<{ text: string; dataName: string; ariaLabel: string }> = [];
        document.querySelectorAll('button').forEach((b) => {
            const rect = b.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return;
            // Only right-side panel buttons (roughly x > 1200 in 1600 viewport)
            if (rect.left < 1100) return;
            const text = (b.textContent || '').trim().slice(0, 60);
            const dn = b.getAttribute('data-name') || '';
            const al = b.getAttribute('aria-label') || '';
            if (text || dn || al) arr.push({ text, dataName: dn, ariaLabel: al });
        });
        return arr;
    });
    console.error(`\n=== Right-panel buttons (visible) ===`);
    for (const b of buttons.slice(0, 30)) {
        console.error(`  text="${b.text}" data-name="${b.dataName}" aria-label="${b.ariaLabel}"`);
    }

    // Try clicking the watchlist dropdown and screenshot the menu
    try {
        await page.click('button[data-name="watchlists-button"]', { force: true });
        await page.waitForTimeout(800);
        const menuShot = path.join(OUT_DIR, `tv-debug-menu-${ts}.png`);
        await page.screenshot({ path: menuShot, fullPage: false });
        console.error(`📸 menu: ${menuShot}`);
        // Dump menu items
        const menuItems = await page.evaluate(() => {
            const arr: string[] = [];
            document.querySelectorAll('div[role="menu"] *, div[class*="menu"] *').forEach((el) => {
                const t = (el.textContent || '').trim();
                if (t && t.length < 60 && t.length > 1 && !arr.includes(t)) {
                    arr.push(t);
                }
            });
            return arr.slice(0, 30);
        });
        console.error(`\n=== Dropdown menu items ===`);
        for (const t of menuItems) console.error(`  "${t}"`);
    } catch (e) {
        console.error(`menu click failed: ${(e as Error).message}`);
    }

    console.error('\n⏳ browser stays open 60s for manual inspection...');
    await page.waitForTimeout(60_000);
    await ctx.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
