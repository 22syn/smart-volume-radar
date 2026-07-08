/**
 * Market Data service tests — mocked fetch
 */

// Mock p-limit to avoid ESM import issues in Jest
jest.mock('p-limit', () => () => (fn: () => Promise<unknown>) => fn());

// Mock config (avoids Twelve Data fetch; uses defaults for Yahoo path)
jest.mock('../src/config/index.js', () => ({
    config: {
        useFetchedIndicators: false,
        twelveDataApiKey: '',
        forceScan: false,
        debug: false,
        athThresholdPct: 20,
        athCloseThresholdPct: 25,
        consolidationMinMonths: 6,
        consolidationMaxMonths: 36,
        consolidationCloseMinMonths: 4,
        sma21TouchThresholdPct: 3,
        sma21CloseThresholdPct: 5,
        formatPrecision: { price: 2, pct: 2, base: 2, rvol: 2, rsi: 0 },
    },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

import { fetchAllStocks, normalizePriceUnitJumps } from '../src/services/marketData.js';
import logger from '../src/utils/logger.js';

function createYahooChartResponse(ticker: string): object {
    const volumes = Array(70).fill(1000000);
    const closes = Array(70).fill(100);
    closes[68] = 98;
    closes[69] = 102;
    return {
        chart: {
            result: [{
                meta: { regularMarketPrice: 102 },
                indicators: { quote: [{ volume: volumes, close: closes }] },
            }],
        },
    };
}

describe('fetchAllStocks', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('returns stocks from Yahoo Chart when API succeeds', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('AAPL')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['AAPL']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('AAPL');
        expect(stocks[0].rvol).toBeGreaterThan(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('returns failedTickers and logs warning when all sources return no data', async () => {
        const emptyYahoo = { chart: { result: [] } };
        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(emptyYahoo) });
        const warnSpy = jest.spyOn(logger, 'warn');

        const { stocks, failedTickers } = await fetchAllStocks(['BAD']);
        expect(stocks).toHaveLength(0);
        expect(failedTickers).toContain('BAD');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('No data from any source (Yahoo or Twelve Data)')
        );
        warnSpy.mockRestore();
    });

    it('handles multiple tickers', async () => {
        const emptyYahoo = { chart: { result: [] } };
        mockFetch
            .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(createYahooChartResponse('AAPL')) })
            .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(emptyYahoo) });

        const { stocks, failedTickers } = await fetchAllStocks(['AAPL', 'FAIL']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('AAPL');
        expect(failedTickers).toContain('FAIL');
    });

    it('supports indices with no volume data (rvol=0)', async () => {
        const indexResponse = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 4000 },
                    indicators: { quote: [{ volume: [], close: [3900, 4000] }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(indexResponse),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['^TNX']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('^TNX');
        expect(stocks[0].rvol).toBe(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('supports stocks with no volume data (rvol=0) instead of failing', async () => {
        const stockResponse = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 100 },
                    indicators: { quote: [{ volume: [], close: [98, 100] }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(stockResponse),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['COBE']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('COBE');
        expect(stocks[0].rvol).toBe(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('supports stocks with only one day of price data (priceChange=0)', async () => {
        const stockResponse = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 100 },
                    indicators: { quote: [{ volume: [1000], close: [100] }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(stockResponse),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['NEW']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('NEW');
        expect(stocks[0].priceChange).toBe(0);
        expect(failedTickers).toHaveLength(0);
    });

    it('falls back from dot to dash for Yahoo tickers (e.g. BRK.B -> BRK-B)', async () => {
        // First call for BRK.B returns 404
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
        });
        // Second call for BRK-B (fallback) returns success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('BRK-B')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BRK.B']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BRK-B'); // The data returned is for the fallback ticker
        expect(failedTickers).toHaveLength(0);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BRK.B'), expect.any(Object));
        expect(mockFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('BRK-B'), expect.any(Object));
    });

    it('falls back to CBOE when COBE fails (typo fallback)', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';
        // 1. Yahoo Chart COBE -> 404
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Twelve Data COBE -> 404
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. Yahoo Chart CBOE (typo fallback) -> success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(createYahooChartResponse('CBOE')),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['COBE']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('CBOE');
        expect(failedTickers).toHaveLength(0);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('CBOE'), expect.any(Object));

        delete process.env.TWELVE_DATA_API_KEY;
    });

    it('falls back from dot to dash for Twelve Data (e.g. BRK.B -> BRK-B)', async () => {
        process.env.TWELVE_DATA_API_KEY = 'test-key';

        // 1. Yahoo Chart BRK.B -> 404
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 2. Yahoo Chart BRK-B (dot-to-dash fallback) -> 404
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 3. Twelve Data BRK.B -> 404
        mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
        // 4. Twelve Data BRK-B (dot-to-dash fallback) -> success
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({
                status: 'ok',
                close: '100',
                volume: '1000',
                percent_change: '1',
            }),
        });
        // 5 & 6. Indicators (RSI, SMA)
        mockFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', values: [] }),
        });

        const { stocks, failedTickers } = await fetchAllStocks(['BRK.B']);
        expect(stocks).toHaveLength(1);
        expect(stocks[0].ticker).toBe('BRK-B');
        expect(failedTickers).toHaveLength(0);
        // At least 4 calls for the main logic, plus indicators
        expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(mockFetch).toHaveBeenNthCalledWith(1, expect.stringContaining('BRK.B'), expect.any(Object));
        // Twelve Data call for BRK.B is the 3rd fetch call in this sequence
        expect(mockFetch.mock.calls[2][0]).toContain('BRK.B');
        // Twelve Data fallback call for BRK-B is the 4th fetch call
        expect(mockFetch.mock.calls[3][0]).toContain('BRK-B');

        delete process.env.TWELVE_DATA_API_KEY;
    });
});

describe('normalizePriceUnitJumps', () => {
    function series(closes: number[]) {
        // highs/lows/opens seeded off closes so we can verify they rescale together.
        return {
            closes: [...closes],
            highs: closes.map((c) => c * 1.02),
            lows: closes.map((c) => c * 0.98),
            opens: closes.map((c) => c * 1.01),
        };
    }

    it('leaves a clean series untouched', () => {
        const s = series([100, 98, 102, 101, 99]);
        const before = JSON.parse(JSON.stringify(s));
        expect(normalizePriceUnitJumps(s)).toBe(0);
        expect(s).toEqual(before);
    });

    it('does not trigger on a large-but-legal daily move (2× gap)', () => {
        const s = series([15, 16, 32, 33]); // 2× gap, ratio 2 « 25
        const before = JSON.parse(JSON.stringify(s));
        expect(normalizePriceUnitJumps(s)).toBe(0);
        expect(s).toEqual(before);
    });

    it('repairs an upward shekel→agora (×100) switch, seamlessly', () => {
        // Older bars in shekels (~15), newer in agorot (~1850).
        const s = series([15, 16, 1850, 1900]);
        expect(normalizePriceUnitJumps(s)).toBe(1);
        // Earlier bars scaled up by the raw step ratio (1850/16) → seamless join.
        const factor = 1850 / 16;
        expect(s.closes[0]).toBeCloseTo(15 * factor, 6);
        expect(s.closes[1]).toBeCloseTo(16 * factor, 6);
        // Newer bars (canonical unit) untouched.
        expect(s.closes[2]).toBe(1850);
        expect(s.closes[3]).toBe(1900);
        // No residual gap across the switch day.
        expect(s.closes[2] / s.closes[1]).toBeCloseTo(1, 6);
    });

    it('repairs a downward agora→shekel switch', () => {
        const s = series([1850, 1900, 16, 15.5]);
        expect(normalizePriceUnitJumps(s)).toBe(1);
        const factor = 16 / 1900;
        expect(s.closes[0]).toBeCloseTo(1850 * factor, 6);
        expect(s.closes[1]).toBeCloseTo(1900 * factor, 6);
        expect(s.closes[2]).toBe(16);
        expect(s.closes[3]).toBe(15.5);
    });

    it('rescales highs/lows/opens with the same per-bar factor as closes', () => {
        const s = series([15, 16, 1850, 1900]);
        normalizePriceUnitJumps(s);
        // OHLC ratios preserved on every bar after rescale.
        for (let i = 0; i < s.closes.length; i++) {
            expect(s.highs[i] / s.closes[i]).toBeCloseTo(1.02, 6);
            expect(s.lows[i] / s.closes[i]).toBeCloseTo(0.98, 6);
            expect(s.opens[i] / s.closes[i]).toBeCloseTo(1.01, 6);
        }
    });

    it('returns 0 for series shorter than 2 bars', () => {
        expect(normalizePriceUnitJumps(series([100]))).toBe(0);
        expect(normalizePriceUnitJumps(series([]))).toBe(0);
    });
});

describe('parseYahooChartResult unit-jump integration', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('normalizes a TASE unit switch end-to-end and logs a warning', async () => {
        // 63 shekel bars (~15) then 7 agora bars (~1850): a ×~123 mid-series step.
        const closes = [
            ...Array(63).fill(15),
            ...Array(7).fill(1850),
        ];
        const volumes = Array(70).fill(1_000_000);
        const response = {
            chart: {
                result: [{
                    meta: { regularMarketPrice: 1850 },
                    indicators: { quote: [{ volume: volumes, close: closes }] },
                }],
            },
        };
        mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(response) });
        const warnSpy = jest.spyOn(logger, 'warn');

        const { stocks } = await fetchAllStocks(['NXSN.TA']);
        expect(stocks).toHaveLength(1);

        // ATH is close-based over the normalized series. Pre-fix it would be 1850
        // while the shekel bars (15) polluted SMA200; post-fix the whole series is
        // in agorot, so the 52w high sits at ~1845 (15 rescaled) ≈ 1850.
        expect(stocks[0].ath).toBeGreaterThan(1000);
        // Live price (agorot) sits right at the ATH, not 100× below it.
        expect(stocks[0].pctFromAth).toBeGreaterThan(-5);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('repaired 1 mid-series price-unit discontinuity')
        );
        warnSpy.mockRestore();
    });
});
