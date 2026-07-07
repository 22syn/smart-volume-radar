import { selectNewRows, existingSymbolSet } from '../src/services/universeSheetWriter';

describe('existingSymbolSet', () => {
    it('builds an uppercase set and skips the header row', () => {
        const set = existingSymbolSet([['Symbol', 'Sector'], ['nvda', 'Semis'], ['amd', 'Semis']]);
        expect(set.has('NVDA')).toBe(true);
        expect(set.has('AMD')).toBe(true);
        expect(set.has('SYMBOL')).toBe(false);
        expect(set.size).toBe(2);
    });

    it('handles an empty sheet', () => {
        expect(existingSymbolSet([]).size).toBe(0);
    });
});

describe('selectNewRows', () => {
    it('keeps only rows whose symbol is not already present (case-insensitive)', () => {
        const existing = new Set(['NVDA', 'AMD']);
        const rows = [
            { symbol: 'NVDA', sector: 'Semis' },
            { symbol: 'INTC', sector: 'Semis' },
            { symbol: 'amd', sector: 'Semis' },
        ];
        expect(selectNewRows(existing, rows)).toEqual([{ symbol: 'INTC', sector: 'Semis' }]);
    });

    it('returns all rows when nothing exists yet', () => {
        const rows = [{ symbol: 'NVDA', sector: 'Semis' }];
        expect(selectNewRows(new Set(), rows)).toEqual(rows);
    });
});
