# svr-tv-sync MCP v2 — Design (granular tools + flag exposure)

**Date:** 2026-06-18
**Status:** Approved for planning
**Author:** Kobi + Claude
**Builds on:** v1 (`2026-06-18-svr-tv-sync-mcp-design.md`) — the thin `tv_sync` wrapper.

## Goal

Add fine-grained, on-demand TradingView operations to the MCP so the user can
read / add / remove individual symbols without running a full sync, and expose
the two remaining useful flags. Keep v1's architecture: **the script owns
Playwright; the MCP shells out.** No selectors or browser logic duplicated in
the MCP (selectors are the fragile surface — they stay in one place).

## Scope

In scope:
1. Three new MCP tools: `tv_read_watchlist`, `tv_add_symbols`, `tv_remove_symbols`.
2. Extend `tv_sync` with `file` → `--file` and `pruneAfterDays` → `--prune-after-days`
   (both flags already exist in the script; this is pure MCP forwarding).
3. "stderr fix": granular operations return their result as structured JSON on
   **stdout** (verbose `log()` diagnostics stay on stderr, which is the correct
   convention). The MCP parses stdout for the granular tools.

Out of scope (future): CI-mode in the MCP, `--login` exposure (interactive),
streaming progress, extracting a shared `tvBrowser` library (see Alternatives),
dry-run on add/remove (the user calls them with explicit symbols).

## Architecture

Chosen approach **A — add CLI modes to the script**:
- The script gains three modes handled in `main()` immediately after the
  browser/page is set up (before the sync logic), each reusing the existing
  proven functions and emitting one JSON object to stdout, then exiting:
  - `--read "NAME"`   → `openWatchlist(page, NAME, false)` + `readCurrentSymbols(page)`
  - `--add "NAME" --symbols "A,B,C"`    → `openWatchlist(page, NAME, true)` + `addSymbolsBulk(page, syms)`
  - `--remove "NAME" --symbols "A,B,C"` → `openWatchlist(page, NAME, false)` + `removeSymbol(page, s)` loop
- The MCP gains three thin tools that shell out to those modes and parse the JSON.

Rejected alternatives:
- **B — MCP runs its own Playwright:** duplicates the fragile selectors + browser
  setup in two places. Rejected.
- **C — extract a shared `tvBrowser` library** imported by both the sync script
  and an MCP CLI: cleanest long-term boundaries, but a risky refactor of a
  working ~960-line script for no v2-functional gain. Deferred; revisit if the
  script keeps growing.

```
tv_read_watchlist / tv_add_symbols / tv_remove_symbols  (MCP tools)
   │  build args -> argv[]
   ▼
npm run tv-sync -- --read|--add|--remove "NAME" [--symbols "..."]   (cwd = repo)
   ▼
sync-tv-watchlist.ts main(): browser setup → granular branch → JSON to stdout → exit
   (reuses openWatchlist / readCurrentSymbols / addSymbolsBulk / removeSymbol)
```

## Script changes (`scripts/sync-tv-watchlist.ts`)

New CLI parsing (uses existing `arg()` which reads `--name value`):
```
const READ_LIST   = arg('read', '');
const ADD_LIST    = arg('add', '');
const REMOVE_LIST = arg('remove', '');
const SYMBOLS_CSV = arg('symbols', '');
const GRANULAR_MODE = !!(READ_LIST || ADD_LIST || REMOVE_LIST);
```
`--file` (`WATCHLIST_FILE_OVERRIDE`, line 81) and `--prune-after-days`
(`PRUNE_AFTER_DAYS`, line 83) already exist — no change needed beyond confirming
`PRUNE_AFTER_DAYS` is consumed by the staleness logic.

In `main()`, after `const page = context.pages()[0] ?? await context.newPage();`
and before the `LOGIN_MODE` / sync logic, add a granular branch that:
- parses `SYMBOLS_CSV` into a trimmed, upper-cased, comma-split list;
- runs the matching operation reusing the existing functions;
- prints exactly one JSON object via `console.log(JSON.stringify(result))`;
- closes the browser and `return`s (does not fall through to sync).

JSON output shapes (stdout):
- read:   `{ "mode":"read",   "watchlist":NAME, "symbols":[...] }`
- add:    `{ "mode":"add",    "watchlist":NAME, "added":[...], "failed":[...] }`
- remove: `{ "mode":"remove", "watchlist":NAME, "removed":[...], "notFound":[...] }`

If the list is missing on read/remove: emit `{ "mode":..., "watchlist":NAME,
"error":"watchlist not found" }` and exit non-zero.

`log()` stays on stderr (unchanged).

## MCP changes (`mcp-tv-sync`)

New pure arg-builders in `src/buildArgs.js` (unit-tested alongside the existing
`buildArgs`):
- `buildReadArgs({watchlist})` → `['--read', NAME]`
- `buildAddArgs({watchlist, symbols})` → `['--add', NAME, '--symbols', 'A,B,C']`
- `buildRemoveArgs({watchlist, symbols})` → `['--remove', NAME, '--symbols', 'A,B,C']`
- extend `buildArgs` to append `--file PATH` (when `file` set) and
  `--prune-after-days N` (when `pruneAfterDays` set).
All validate `watchlist` against `WATCHLISTS`; add/remove require a non-empty
`symbols` array (throw otherwise).

Tool wiring split out of `index.js` into `src/tools.js` (index grows 1→4 tools):
- `src/tools.js` exports the four tool definitions (name, description,
  inputSchema) and a `handleTool(name, args, runner)` dispatcher.
- `index.js` keeps server bootstrap, the `runTvSync` child-process/timeout glue
  (now returning parsed stdout for granular tools), and StdioServerTransport.

Tool surface:
| Tool | Params | Returns |
|------|--------|---------|
| `tv_sync` (extended) | dryRun, replace, headed, watchlist, **file**, **pruneAfterDays** | exit/summary (as v1) |
| `tv_read_watchlist` | watchlist (enum, required) | symbols[] (parsed from stdout JSON) |
| `tv_add_symbols` | watchlist (enum, required), symbols (string[], required, non-empty) | added[], failed[] |
| `tv_remove_symbols` | watchlist (enum, required), symbols (string[], required, non-empty) | removed[], notFound[] |

## Error handling
- Invalid `watchlist` → rejected by the enum in each tool's inputSchema before spawn.
- Empty `symbols` for add/remove → arg-builder throws → tool returns isError.
- Watchlist not found (read/remove) → script exits non-zero with `error` JSON;
  MCP surfaces it as isError with the message.
- Symbol not present on remove → reported in `notFound` (soft, not an error).
- Outer timeout (`TV_SYNC_TIMEOUT_MS`) still wraps every call.
- Granular stdout must be valid JSON; if parsing fails, the tool returns the raw
  stdout/stderr tail as an error so failures are visible (no silent success).

## Testing
- **Unit:** all four arg-builders — every param combination, watchlist validation,
  empty-symbols rejection, file/pruneAfterDays appended correctly.
- **Integration (manual):** `tv_read_watchlist("Lean Radar - Near")` matches the
  symbols a dry-run sync reports; a round-trip — `tv_add_symbols` a throwaway
  ticker, `tv_read_watchlist` shows it, `tv_remove_symbols` removes it,
  `tv_read_watchlist` confirms it's gone.

## Registration
No change — the existing user-scoped registration already launches `index.js`;
the new tools appear automatically after a reload.
