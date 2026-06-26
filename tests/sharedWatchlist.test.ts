import { extractSymbols } from '../src/services/sharedWatchlist';

const FIXTURE =
    '<script>window.initData = {"name":"Semis",' +
    '"symbols":["###SEMI - CAP","NASDAQ:NVDA","NASDAQ:AMD","KRX:000660","NYSE:BRK.B"],' +
    '"x":1};</script>';

describe('extractSymbols', () => {
    it('returns the symbols and drops section headers', () => {
        expect(extractSymbols(FIXTURE)).toEqual([
            'NASDAQ:NVDA',
            'NASDAQ:AMD',
            'KRX:000660',
            'NYSE:BRK.B',
        ]);
    });

    it('throws when symbols are absent', () => {
        expect(() => extractSymbols('<html>nope</html>')).toThrow(/could not find symbols/i);
    });
});
