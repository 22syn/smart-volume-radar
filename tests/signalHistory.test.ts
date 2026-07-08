import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecentSignalTickers } from '../src/lean/signalHistory';

function writeSnap(dir: string, date: string, sections: Record<string, string[]>) {
    const detections: Record<string, Array<{ ticker: string }>> = {};
    for (const [k, tickers] of Object.entries(sections)) {
        detections[k] = tickers.map((t) => ({ ticker: t }));
    }
    fs.writeFileSync(path.join(dir, `lean-${date}.json`), JSON.stringify({ scanner: 'lean-radar', detections }));
}

describe('loadRecentSignalTickers', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sighist-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('unions tickers from the requested section across the lookback window', () => {
        writeSnap(dir, '2026-07-07', { nearConsolidation: ['AAA', 'BBB'] });
        writeSnap(dir, '2026-06-20', { nearConsolidation: ['CCC'] });      // 18 days back — inside 21
        writeSnap(dir, '2026-06-10', { nearConsolidation: ['OLD'] });      // 28 days back — outside
        const s = loadRecentSignalTickers(dir, '2026-07-08', 'nearConsolidation', 21);
        expect(s).toEqual(new Set(['AAA', 'BBB', 'CCC']));
    });

    it('only reads the requested section', () => {
        writeSnap(dir, '2026-07-07', { nearConsolidation: ['AAA'], creep: ['ZZZ'] });
        expect(loadRecentSignalTickers(dir, '2026-07-08', 'creep', 21)).toEqual(new Set(['ZZZ']));
    });

    it('returns an empty set when no snapshots exist', () => {
        expect(loadRecentSignalTickers(dir, '2026-07-08', 'creep', 21)).toEqual(new Set());
    });

    it('skips corrupt files without throwing', () => {
        fs.writeFileSync(path.join(dir, 'lean-2026-07-07.json'), '{not json');
        writeSnap(dir, '2026-07-06', { nearConsolidation: ['AAA'] });
        expect(loadRecentSignalTickers(dir, '2026-07-08', 'nearConsolidation', 21)).toEqual(new Set(['AAA']));
    });

    it('lookback dates match snapshotWriter filenames across month boundaries (UTC)', () => {
        writeSnap(dir, '2026-06-30', { nearConsolidation: ['EOM'] });      // 2 days before Jul 2
        expect(loadRecentSignalTickers(dir, '2026-07-02', 'nearConsolidation', 5)).toEqual(new Set(['EOM']));
    });
});
