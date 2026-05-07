/**
 * RS Percentile tests
 */
import { applyRSPercentile, computeRSPercentiles } from '../src/utils/rsPercentile';
import type { StockData } from '../src/types';

const mk = (ticker: string, return63d: number | undefined): StockData => ({
    ticker,
    currentVolume: 1,
    avgVolume: 1,
    rvol: 1,
    priceChange: 0,
    lastPrice: 100,
    return63d,
});

describe('computeRSPercentiles', () => {
    it('top alpha gets 100, bottom gets 0', () => {
        const stocks = [
            mk('A', 5),
            mk('B', 10),
            mk('C', 15),
            mk('D', 20),
            mk('E', 25),
        ];
        const r = computeRSPercentiles(stocks, 0);
        expect(r[0]).toBe(0);   // A worst
        expect(r[4]).toBe(100); // E best
        expect(r[2]).toBe(50);  // C middle
    });

    it('uses SPY-relative alpha (subtracts SPY return)', () => {
        // Without SPY relative: A=10 best, C=5 worst.
        // With SPY=15: alpha A=-5, B=0, C=-10. Now C is worst, A is middle.
        const stocks = [mk('A', 10), mk('B', 15), mk('C', 5)];
        const r = computeRSPercentiles(stocks, 15);
        expect(r[2]).toBe(0);   // C: alpha -10
        expect(r[1]).toBe(100); // B: alpha 0
        expect(r[0]).toBe(50);  // A: alpha -5
    });

    it('handles ties by averaging positions', () => {
        const stocks = [mk('A', 10), mk('B', 10), mk('C', 20)];
        const r = computeRSPercentiles(stocks, 0);
        // A and B tied at 0/1 positions, avg pos = 0.5, pct = 0.5/2 * 100 = 25
        expect(r[0]).toBe(25);
        expect(r[1]).toBe(25);
        // C at position 2, pct = 2/2 * 100 = 100
        expect(r[2]).toBe(100);
    });

    it('falls back to raw return63d when SPY return is null', () => {
        const stocks = [mk('A', -5), mk('B', 5), mk('C', 10)];
        const r = computeRSPercentiles(stocks, null);
        expect(r[0]).toBe(0);
        expect(r[2]).toBe(100);
    });

    it('skips stocks with missing return63d', () => {
        const stocks = [mk('A', 10), mk('B', undefined), mk('C', 20)];
        const r = computeRSPercentiles(stocks, 0);
        expect(r[0]).toBe(0);
        expect(r[1]).toBeUndefined();
        expect(r[2]).toBe(100);
    });

    it('single stock gets 50 (no peers to compare)', () => {
        const stocks = [mk('A', 10)];
        const r = computeRSPercentiles(stocks, 0);
        expect(r[0]).toBe(50);
    });

    it('empty array returns empty array', () => {
        expect(computeRSPercentiles([], 0)).toEqual([]);
    });
});

describe('applyRSPercentile (mutating)', () => {
    it('mutates rsPercentile on each stock', () => {
        const stocks = [mk('A', 5), mk('B', 25), mk('C', 15)];
        applyRSPercentile(stocks, 0);
        expect(stocks[0]!.rsPercentile).toBe(0);
        expect(stocks[1]!.rsPercentile).toBe(100);
        expect(stocks[2]!.rsPercentile).toBe(50);
    });

    it('leaves stocks with missing return63d untouched', () => {
        const stocks = [mk('A', 10), mk('B', undefined), mk('C', 20)];
        applyRSPercentile(stocks, 0);
        expect(stocks[0]!.rsPercentile).toBe(0);   // worst alpha
        expect(stocks[1]!.rsPercentile).toBeUndefined();
        expect(stocks[2]!.rsPercentile).toBe(100); // best alpha
    });
});
