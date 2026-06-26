/**
 * Read a friend's shared/public TradingView watchlist over plain HTTP (no login).
 * The share page (https://www.tradingview.com/watchlists/<id>/) embeds the symbols in
 * `window.initData` as `"symbols":[ "NASDAQ:NVDA", ... ]`. No browser required.
 */

/** Parse the `symbols` array out of a shared-watchlist page's HTML. */
export function extractSymbols(html: string): string[] {
    const key = html.indexOf('"symbols":[');
    if (key === -1) {
        throw new Error(
            'shared watchlist: could not find symbols in the page (layout changed, or the list is no longer public)',
        );
    }
    const start = html.indexOf('[', key);
    let depth = 0;
    let end = -1;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (c === '[') depth++;
        else if (c === ']') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1) throw new Error('shared watchlist: malformed symbols array');
    const arr = JSON.parse(html.slice(start, end + 1)) as unknown[];
    // Keep EXCHANGE:SYMBOL rows; drop section headers ("###...") and non-strings.
    return arr.filter(
        (s): s is string => typeof s === 'string' && s.includes(':') && !s.startsWith('###'),
    );
}

/** Fetch a shared watchlist URL and return its TradingView symbols. */
export async function fetchSharedWatchlist(url: string): Promise<string[]> {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
        throw new Error(
            `shared watchlist fetch HTTP ${res.status} — check the link is shared/public: ${url}`,
        );
    }
    return extractSymbols(await res.text());
}
