/**
 * Time-weighted intraday RVOL helpers (Momentum Edition).
 * Standalone file — does not use jest.mock(), so it loads cleanly under ESM.
 */
import {
    projectedRvol,
    marketSessionMinutesElapsed,
    NYSE_SESSION_MINUTES,
} from '../src/services/rvolCalculator.js';

describe('projectedRvol', () => {
    it('30 minutes in, vol 1M, avg 10M → ~1.30', () => {
        // projected = 1M / (30/390) = 13M; rvol = 13M / 10M = 1.30
        const r = projectedRvol(1_000_000, 10_000_000, 30);
        expect(r).toBeCloseTo(1.3, 2);
    });

    it('after the close (390 min) equals raw RVOL', () => {
        const raw = 5_000_000 / 10_000_000;
        const proj = projectedRvol(5_000_000, 10_000_000, 390);
        expect(proj).toBeCloseTo(raw, 5);
    });

    it('clamps minutesElapsed ≥ 1 to avoid divide-by-zero', () => {
        const r = projectedRvol(1_000_000, 10_000_000, 0);
        expect(r).toBeGreaterThan(0);
        expect(Number.isFinite(r)).toBe(true);
    });

    it('returns 0 when avg volume is non-positive', () => {
        expect(projectedRvol(1_000_000, 0, 100)).toBe(0);
    });
});

describe('marketSessionMinutesElapsed', () => {
    it('returns full session length on a Saturday', () => {
        const sat = new Date('2025-01-04T18:00:00Z'); // Sat
        expect(marketSessionMinutesElapsed(sat)).toBe(NYSE_SESSION_MINUTES);
    });

    it('returns full session before NY market open (08:00 ET)', () => {
        // 08:00 ET Mon → treated as overnight (full session)
        const preOpen = new Date('2025-01-06T13:00:00Z');
        expect(marketSessionMinutesElapsed(preOpen)).toBe(NYSE_SESSION_MINUTES);
    });
});
