# tv_screenshot — Design (chart screenshots back to Claude)

**Date:** 2026-06-18
**Status:** Approved for planning
**Author:** Kobi + Claude
**Builds on:** v2 (`2026-06-18-svr-tv-sync-mcp-v2-design.md`).

## Goal

A new MCP tool, `tv_screenshot`, that opens TradingView at a given symbol on the
user's saved chart layout (with their indicators), captures a screenshot, and
returns it to Claude as an **image** so Claude can see and analyze the chart.

## Architecture (same philosophy as v1/v2)

Script owns Playwright; MCP shells out. One new script mode (`--screenshot`) and
one new MCP tool (`tv_screenshot`). Reuses the existing browser setup, logged-in
persistent profile, navigation, and `page.screenshot()` (already at line 982).

```
tv_screenshot({ symbol, interval? })                       (MCP tool)
   ▼  buildScreenshotArgs -> ['--screenshot', SYM, ('--interval', '1W')?]
npm run tv-sync -- --screenshot "NVDA" [--interval "1W"]
   ▼  script: navigate to /chart/?symbol=<sym>[&interval=<code>] (saved layout) →
            wait for render → dismissPopups → page.screenshot to a temp PNG →
            print {"mode":"screenshot","symbol":...,"interval":...,"path":"/tmp/..png"}
   ▼  MCP: read the PNG file → return MCP image content (base64) + a text caption
   ▼  Claude receives the actual image and analyzes it
```

## Why URL params (symbol + interval)

TradingView indicators/studies live at the **layout** level, independent of the
active symbol. Navigating to `https://www.tradingview.com/chart/?symbol=<SYM>`
loads the user's default saved layout (indicators intact) at that symbol.
`&interval=<code>` sets the timeframe on the same layout. This is deterministic
and avoids driving TradingView's finicky symbol-search / interval UI by keyboard.

If empirical testing shows the URL drops the saved indicators, the fallback is:
load `/chart/`, then set the symbol via the symbol-search box (type + Enter).
This is flagged as a build-time verification point, not expected to be needed.

## Why a temp file (not base64 over stdout)

A screenshot is ~0.5–1 MB; base64'd it exceeds the MCP's 1 MB stdout buffer cap
(`MAX_BUFFER`) and would truncate. So the script writes the PNG to a temp file and
prints only the path (JSON, like the other granular modes); the MCP reads that
file and returns it as image content.

## Script changes (`scripts/sync-tv-watchlist.ts`)

New CLI parsing (after the v2 granular consts):
```
const SCREENSHOT_SYMBOL = arg('screenshot', '');
const SCREENSHOT_INTERVAL = arg('interval', '');
const SCREENSHOT_MODE = !!SCREENSHOT_SYMBOL;
```
`SCREENSHOT_MODE` is added to the `GRANULAR_MODE` early-branch family in `main()`
(handled after the login check, before the sync `tasks`), reached the same way.

A `tvInterval(raw)` mapper converts friendly forms to TradingView interval codes
(`1D`/`D`/`daily`→`D`, `1W`/`W`→`W`, `M`→`M`, `1H`/`60`→`60`, `4H`/`240`→`240`,
`30`/`15`/`5`/`1`→as-is); unknown values pass through unchanged. `1M` is left
unmapped (ambiguous: monthly is `M`, 1-minute is `1`) and documented.

A `runScreenshot(page)` handler:
1. Build URL: `/chart/?symbol=<encodeURIComponent(symbol)>` + (`&interval=<code>` if given).
2. `page.goto(url, {waitUntil:'domcontentloaded'})`, wait for render (~6 s), `dismissPopups(page)`.
3. `const out = path.join(os.tmpdir(), 'svr-tv-shot-<safeSymbol>-<ts>.png')`.
4. `await page.screenshot({ path: out, fullPage: false })`.
5. `console.log(JSON.stringify({ mode:'screenshot', symbol, interval: interval||null, path: out }))`.
6. return 0.

`log()` stays on stderr; the JSON result is the only stdout line.

## MCP changes (`mcp-tv-sync`)

- `src/buildArgs.js`: add `buildScreenshotArgs({symbol, interval})` →
  `['--screenshot', symbol]` + (`['--interval', interval]` if interval set).
  Throws if `symbol` is missing/empty (trimmed). Pure.
- `src/tools.js`: add the `tv_screenshot` tool definition (symbol required string,
  interval optional string). Generalize `TOOL_SPECS` from `{build, granular:bool}`
  to `{build, kind:'sync'|'granular'|'image'}`; existing tools become `kind:'sync'`
  (tv_sync) / `kind:'granular'` (read/add/remove); `tv_screenshot` is `kind:'image'`.
- `index.js`: dispatch on `spec.kind`. For `image`: run, parse the JSON line for
  `path`, read the PNG as base64, return
  `content: [{type:'image', data:<base64>, mimeType:'image/png'}, {type:'text', text:<caption>}]`.
  isError when exitCode≠0, timeout, missing/invalid `path`, unreadable file, or
  `parsed.error` present.

## Tool surface (addition)
| Tool | Params | Returns |
|------|--------|---------|
| `tv_screenshot` | `symbol` (string, required), `interval` (string, optional) | image (PNG) + text caption (symbol, interval, path) |

## Error handling
- Empty `symbol` → arg-builder throws → isError before spawn.
- Unresolvable symbol → TradingView renders an "invalid symbol" chart; the
  screenshot still returns so the problem is visible. (No special detection in v1
  of this tool.)
- Missing/unreadable PNG or timeout → isError with the stderr tail.

## Testing
- **Unit:** `buildScreenshotArgs` — symbol→`--screenshot SYM`; interval appended
  when set, omitted when absent; empty symbol throws.
- **Integration (manual):** `tv_screenshot({symbol:"NVDA"})` → Claude confirms it
  receives a readable NVDA chart image showing the user's indicators; a second
  call with `interval:"1W"` shows the weekly timeframe.

## Out of scope (future)
Multiple-timeframe batch screenshots, element-cropped captures, drawing/annotation,
symbol-validity detection, CI mode.
