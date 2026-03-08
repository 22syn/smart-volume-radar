/**
 * writeScanResults utility tests
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildStoredScanResult,
    writeScanResults,
} from '../src/utils/writeScanResults.js';
import type { RVOLResult, StockData } from '../src/types/index.js';

const baseStock: StockData = {
    ticker: 'AAPL',
    currentVolume: 1_000_000,
    avgVolume: 500_000,
    rvol: 2,
    priceChange: 1.5,
    lastPrice: 100,
};

function toRVOLResult(s: StockData): RVOLResult {
    return { ...s, news: [], isVolumeWithoutPrice: false };
}

describe('buildStoredScanResult', () => {
    it('adds setupType "full" when stock has nearSMA21, nearAth, inConsolidationWindow', () => {
        const fullStock: StockData = {
            ...baseStock,
            nearSMA21: true,
            nearAth: true,
            inConsolidationWindow: true,
        };
        const result = buildStoredScanResult('2026-03-08', [toRVOLResult(fullStock)], []);
        expect(result.date).toBe('2026-03-08');
        expect(result.signals).toHaveLength(1);
        expect(result.signals[0].setupType).toBe('full');
        expect(result.signals[0].source).toBe('topSignals');
        expect(result.signals[0].ticker).toBe('AAPL');
        expect(result.signals[0].lastPrice).toBe(100);
        expect(result.signals[0].rvol).toBe(2);
    });

    it('adds setupType "close" when stock has nearSMA21Close, nearAthClose, inConsolidationClose', () => {
        const closeStock: StockData = {
            ...baseStock,
            ticker: 'MSFT',
            nearSMA21: false,
            nearAth: false,
            inConsolidationWindow: false,
            nearSMA21Close: true,
            nearAthClose: true,
            inConsolidationClose: true,
        };
        const result = buildStoredScanResult('2026-03-08', [], [closeStock]);
        expect(result.signals).toHaveLength(1);
        expect(result.signals[0].setupType).toBe('close');
        expect(result.signals[0].source).toBe('volumeWithoutPrice');
        expect(result.signals[0].ticker).toBe('MSFT');
    });

    it('adds setupType "none" when missing setup conditions', () => {
        const noneStock: StockData = {
            ...baseStock,
            ticker: 'GOOG',
            nearSMA21: false,
            nearAth: false,
            inConsolidationWindow: false,
        };
        const result = buildStoredScanResult('2026-03-08', [toRVOLResult(noneStock)], []);
        expect(result.signals).toHaveLength(1);
        expect(result.signals[0].setupType).toBe('none');
    });

    it('sets source "topSignals" for finalSignals and "volumeWithoutPrice" for volumeWithoutPrice', () => {
        const stock: StockData = { ...baseStock, ticker: 'A' };
        const silentStock: StockData = { ...baseStock, ticker: 'B' };
        const result = buildStoredScanResult('2026-03-08', [toRVOLResult(stock)], [silentStock]);
        expect(result.signals).toHaveLength(2);
        expect(result.signals[0].source).toBe('topSignals');
        expect(result.signals[0].ticker).toBe('A');
        expect(result.signals[1].source).toBe('volumeWithoutPrice');
        expect(result.signals[1].ticker).toBe('B');
    });
});

describe('writeScanResults', () => {
    it('creates file and JSON is valid', () => {
        const outDir = path.join(os.tmpdir(), `smart-volume-radar-test-${Date.now()}`);
        const stored = {
            date: '2026-03-08',
            signals: [
                { ticker: 'AAPL', lastPrice: 100, rvol: 2, setupType: 'full' as const, source: 'topSignals' as const },
            ],
        };
        writeScanResults(stored, outDir);
        const filePath = path.join(outDir, 'scan-2026-03-08.json');
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.date).toBe('2026-03-08');
        expect(parsed.signals).toHaveLength(1);
        expect(parsed.signals[0]).toEqual({
            ticker: 'AAPL',
            lastPrice: 100,
            rvol: 2,
            setupType: 'full',
            source: 'topSignals',
        });
        fs.rmSync(outDir, { recursive: true, force: true });
    });
});
