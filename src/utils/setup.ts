/**
 * Smart Volume Radar - Setup Criteria
 * Single source of truth for Full Setup (🎯) and Close Setup (👀) identification.
 */

import type { StockData } from '../types/index.js';

/** Full setup: near SMA21, near ATH, in 6mo–3y consolidation window */
export function isFullSetup(s: StockData): boolean {
    return !!(s.nearSMA21 && s.nearAth && s.inConsolidationWindow);
}

/** Close setup: flexible — e.g. 4mo base, 17% from ATH — worth watching */
export function isCloseSetup(s: StockData): boolean {
    const smaOk = s.nearSMA21 || s.nearSMA21Close;
    const athOk = s.nearAth || s.nearAthClose;
    const baseOk = s.inConsolidationWindow || s.inConsolidationClose;
    return !!(smaOk && athOk && baseOk);
}
