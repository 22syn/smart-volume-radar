/**
 * MonitorTracker — state-machine tests for the follow-up lifecycle.
 */
import {
    recordAlert,
    checkMonitorEntry,
    updateMonitorState,
    MONITOR_EXPIRY_TRADING_DAYS,
} from '../src/services/monitorTracker.js';
import type { MonitorState, StockData, MomentumResult } from '../src/types/index.js';

function fullMomentum(): MomentumResult {
    return {
        level: 'full',
        rvolThreshold: 2,
        failures: [],
        criteria: {
            rvolPass: true,
            stage2: true,
            lowRiskEntry: true,
            pivotBreakout: true,
            tightness: true,
            aboveGapAvwap: true,
            antsAccumulation: false,
            bigMoveToday: true,
        },
    };
}

function watchlistMomentum(): MomentumResult {
    return {
        level: 'close',
        rvolThreshold: 2,
        failures: ['lowRiskEntry'],
        criteria: {
            rvolPass: true,
            stage2: true,
            lowRiskEntry: false,
            pivotBreakout: true,
            tightness: true,
            aboveGapAvwap: true,
            antsAccumulation: false,
            bigMoveToday: false,
        },
    };
}

function noneMomentum(): MomentumResult {
    return {
        level: 'none',
        rvolThreshold: 2,
        failures: ['rvolPass', 'pivotBreakout'],
        criteria: {
            rvolPass: false,
            stage2: true,
            lowRiskEntry: true,
            pivotBreakout: false,
            tightness: true,
            aboveGapAvwap: true,
            antsAccumulation: false,
            bigMoveToday: false,
        },
    };
}

function stock(overrides: Partial<StockData> = {}): StockData {
    return {
        ticker: 'TEST',
        currentVolume: 1_000_000,
        avgVolume: 500_000,
        rvol: 2.0,
        priceChange: 1,
        lastPrice: 100,
        sma21: 95,
        sma50: 90,
        sma200: 80,
        sma200Slope: 'up',
        ath: 100,
        daysSinceAth: 20,
        consecutiveGreenDays: 5,
        gapDay: null,
        avwapFromGap: undefined,
        projectedRvol: 2.0,
        marketRegime: 'bull',
        momentum: watchlistMomentum(),
        ...overrides,
    };
}

function emptyState(): MonitorState {
    return { lastUpdated: '2026-01-01', entries: [] };
}

describe('recordAlert', () => {
    it('adds a NEW monitor entry on first alert', () => {
        const state = emptyState();
        const result = recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        expect(result.isNew).toBe(true);
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]!.status).toBe('monitoring');
        expect(state.entries[0]!.firstAlertLevel).toBe('close');
        expect(state.entries[0]!.events).toHaveLength(1);
    });

    it('does NOT duplicate an existing entry', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        const result = recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-05');
        expect(result.isNew).toBe(false);
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]!.events).toHaveLength(2); // appended re-alert event
    });

    it('throws on non-alerting stock', () => {
        const state = emptyState();
        expect(() => recordAlert(state, stock({ momentum: noneMomentum() }), '2026-01-01')).toThrow();
    });
});

describe('checkMonitorEntry — state transitions', () => {
    it('GRADUATES when today fires Full', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({ lastPrice: 110, momentum: fullMomentum() }),
            '2026-01-15'
        );
        expect(result.transitioned).toBe(true);
        expect(result.newStatus).toBe('graduated');
        expect(state.entries[0]!.status).toBe('graduated');
        expect(state.entries[0]!.resolvedPrice).toBe(110);
    });

    it('triggers MANUAL-ENTRY on pivot+RVOL+bigMove day', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        const watchlistWithBigMove = watchlistMomentum();
        watchlistWithBigMove.criteria.bigMoveToday = true;
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({
                lastPrice: 108,
                priceChange: 5,
                projectedRvol: 1.8,
                momentum: watchlistWithBigMove,
            }),
            '2026-01-10'
        );
        expect(result.transitioned).toBe(true);
        expect(result.newStatus).toBe('manual-entry');
    });

    it('does NOT manual-entry on a flat day (priceChange < 3%)', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({ priceChange: 1, momentum: watchlistMomentum() }),
            '2026-01-10'
        );
        expect(result.transitioned).toBe(false);
    });

    it('triggers SMA21-PULLBACK on quiet pullback to SMA21 with green close', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({
                lastPrice: 95.5, // 0.5% above SMA21=95
                priceChange: 0.8, // green
                projectedRvol: 0.7, // quiet
                momentum: noneMomentum(), // not actively alerting today
            }),
            '2026-01-12'
        );
        expect(result.transitioned).toBe(true);
        expect(result.newStatus).toBe('sma21-pullback');
    });

    it('does NOT trigger SMA21-PULLBACK with high RVOL (institutional selling risk)', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({
                lastPrice: 95.5,
                priceChange: 0.8,
                projectedRvol: 2.5, // elevated → maybe selling
                momentum: noneMomentum(),
            }),
            '2026-01-12'
        );
        expect(result.transitioned).toBe(false);
    });

    it('EXPIRES after 30 trading days with no resolution', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        // 6 calendar weeks = 30 trading days
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({ momentum: noneMomentum() }),
            '2026-02-13'
        );
        expect(result.transitioned).toBe(true);
        expect(result.newStatus).toBe('expired');
    });

    it('does not re-process already-resolved entries', () => {
        const state = emptyState();
        recordAlert(state, stock({ momentum: watchlistMomentum() }), '2026-01-01');
        state.entries[0]!.status = 'graduated';
        const result = checkMonitorEntry(
            state.entries[0]!,
            stock({ momentum: fullMomentum() }),
            '2026-01-15'
        );
        expect(result.transitioned).toBe(false);
        expect(state.entries[0]!.status).toBe('graduated');
    });
});

describe('updateMonitorState — orchestration', () => {
    it('graduates an existing monitor AND adds a brand-new alert in one pass', () => {
        const state = emptyState();
        // Pre-existing monitor on AAA
        recordAlert(state, stock({ ticker: 'AAA', momentum: watchlistMomentum() }), '2026-01-01');

        // Today: AAA fires Full (graduate), BBB fires fresh Watchlist (new entry)
        const stocksByTicker = new Map<string, StockData>([
            ['AAA', stock({ ticker: 'AAA', momentum: fullMomentum() })],
            ['BBB', stock({ ticker: 'BBB', momentum: watchlistMomentum() })],
        ]);
        const summary = updateMonitorState(state, stocksByTicker, '2026-01-15');

        expect(summary.transitions).toHaveLength(1);
        expect(summary.transitions[0]!.newStatus).toBe('graduated');
        expect(summary.newEntries).toHaveLength(1);
        expect(summary.newEntries[0]!.ticker).toBe('BBB');
        expect(summary.activeCount).toBe(1); // BBB still monitoring; AAA graduated
    });

    it('expiry constant is exposed and reasonable', () => {
        expect(MONITOR_EXPIRY_TRADING_DAYS).toBe(30);
    });
});
