/**
 * Write the radar universe Google Sheet (columns Symbol | Sector) via the Sheets API.
 * The scan pipeline keeps reading this same sheet through its public CSV export.
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

/** Header + one row per symbol, ready for values.update. */
export function buildValues(rows: UniverseRow[]): string[][] {
    return [['Symbol', 'Sector'], ...rows.map((r) => [r.symbol, r.sector])];
}

/** Overwrite the first tab's Symbol|Sector columns with `rows`. */
export async function writeUniverseSheet(sheetId: string, rows: UniverseRow[]): Promise<void> {
    const api = await client();
    const meta = await api.spreadsheets.get({ spreadsheetId: sheetId });
    const firstTab = meta.data.sheets?.[0]?.properties?.title;
    if (!firstTab) throw new Error('universe sheet: no tabs found');
    await api.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `'${firstTab}'!A:B` });
    await api.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `'${firstTab}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: buildValues(rows) },
    });
}
