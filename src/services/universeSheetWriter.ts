/**
 * Merge symbols into the radar universe Google Sheet (columns Symbol | Sector) via the
 * Sheets API. **Additive only** — appends symbols not already present, never deletes or
 * overwrites existing rows (the sheet is the curated, multi-sector source of truth). The
 * scan pipeline keeps reading this same sheet through its public CSV export.
 *
 * Auth: a service account, from GOOGLE_SHEETS_CREDENTIALS (path to JSON) or
 * GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON, e.g. a CI secret). The sheet must be shared
 * with the service-account email as Editor (and kept "anyone with link can view" so the
 * scan's CSV read keeps working).
 */
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';

export interface UniverseRow {
    symbol: string;
    sector: string;
}

export interface MergeResult {
    added: UniverseRow[];
    alreadyPresent: number;
}

interface ServiceAccount {
    client_email: string;
    private_key: string;
}

function loadCredentials(): ServiceAccount {
    const inline = process.env.GOOGLE_SHEETS_CREDENTIALS_JSON;
    if (inline && inline.trim()) {
        return JSON.parse(inline) as ServiceAccount;
    }
    const file = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!file) {
        throw new Error(
            'Set GOOGLE_SHEETS_CREDENTIALS (path to the service-account JSON) or ' +
                'GOOGLE_SHEETS_CREDENTIALS_JSON (raw JSON, for CI).',
        );
    }
    return JSON.parse(readFileSync(file, 'utf8')) as ServiceAccount;
}

async function client(): Promise<sheets_v4.Sheets> {
    const creds = loadCredentials();
    const auth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    await auth.authorize();
    return google.sheets({ version: 'v4', auth });
}

/** Pure: keep only rows whose symbol is not already in `existing` (case-insensitive). */
export function selectNewRows(existing: Set<string>, rows: UniverseRow[]): UniverseRow[] {
    return rows.filter((r) => !existing.has(r.symbol.toUpperCase()));
}

/** Build an uppercase symbol set from a sheet's column-A values (skips the header). */
export function existingSymbolSet(colA: string[][]): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < colA.length; i++) {
        const v = (colA[i]?.[0] ?? '').trim();
        if (!v) continue;
        if (i === 0 && v.toLowerCase() === 'symbol') continue; // header
        set.add(v.toUpperCase());
    }
    return set;
}

/**
 * Append only the symbols not already in the first tab. Never clears or deletes.
 * Returns which rows were added and how many were skipped as already present.
 */
export async function mergeUniverseSheet(sheetId: string, rows: UniverseRow[]): Promise<MergeResult> {
    const api = await client();
    const meta = await api.spreadsheets.get({ spreadsheetId: sheetId });
    const firstTab = meta.data.sheets?.[0]?.properties?.title;
    if (!firstTab) throw new Error('universe sheet: no tabs found');

    const existingRes = await api.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${firstTab}'!A:A`,
    });
    const colA = (existingRes.data.values ?? []) as string[][];
    const existing = existingSymbolSet(colA);
    const sheetEmpty = colA.length === 0;

    const added = selectNewRows(existing, rows);
    if (added.length === 0) {
        return { added: [], alreadyPresent: rows.length };
    }

    const values = added.map((r) => [r.symbol, r.sector]);
    if (sheetEmpty) values.unshift(['Symbol', 'Sector']); // seed header on a blank sheet

    await api.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: `'${firstTab}'!A:B`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
    });
    return { added, alreadyPresent: rows.length - added.length };
}
