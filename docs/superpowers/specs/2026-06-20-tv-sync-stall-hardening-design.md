# tv-sync stall hardening — Design (minimal structural)

**Date:** 2026-06-20
**Status:** Approved for planning (user chose "minimal structural").
**Context:** The 2026-06-02 incident was a ~16-minute page stall with no per-action
bound, so one hung action blocked the whole nightly. Roadmap Phase-2 item E.

## Goal

Close the "one stalled action hangs the entire run" class with the smallest,
lowest-risk change to the core nightly script (`scripts/sync-tv-watchlist.ts`).
The MCP's outer 35-min kill stays as the final backstop; this makes the script
itself fail-fast and recover per-list instead of hanging.

## Scope (minimal structural — 3 changes)

1. **Explicit timeouts.** Right after the `page` is created, set
   `page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)` and
   `page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)`, and pass an explicit
   `timeout: NAV_TIMEOUT_MS` to all three `page.goto(...)` calls. Every action and
   navigation becomes bounded and tunable instead of relying on hidden defaults.
2. **Per-list bounded retry.** In the 4-list sync loop, wrap each
   `syncWatchlist(page, target, name)` in `tryWithin(PER_LIST_TIMEOUT_MS, …)` with
   **one retry**. If both attempts return null (timeout OR error), log a clear
   skip line and **continue to the next list** — a single stalled/failed list no
   longer aborts the run. (This deliberately makes per-list failures non-fatal and
   logged, which is the hardening intent.)
3. **Scroll-loop deadline.** Bound the `readCurrentSymbols` scroll loop with a
   wall-clock deadline (`SCROLL_DEADLINE_MS`); if exceeded, stop scrolling, log it,
   and return what was collected so far — a stalled scroll can't compound.

Reuses the existing `tryWithin(timeout, op)` helper — no new infrastructure.

## Out of scope (chose minimal over thorough)
Per-symbol add/remove micro-timeouts, screenshot-navigation retry, per-action
retry on every Playwright call, exponential backoff. These add complexity and a
larger change surface for marginal gain; revisit only if a future stall is traced
to one of them.

## Constants (new, near the existing config block)
```
const NAV_TIMEOUT_MS = 45000;            // page.goto / navigation
const DEFAULT_ACTION_TIMEOUT_MS = 20000; // default per-action
const PER_LIST_TIMEOUT_MS = 3 * 60 * 1000; // cap per watchlist (×2 attempts)
const SCROLL_DEADLINE_MS = 30000;        // readCurrentSymbols scroll loop
```
All overridable via env vars in a follow-up if needed; hard-coded for v1.

## Behavior changes
- A watchlist that stalls or errors past `PER_LIST_TIMEOUT_MS` is retried once,
  then **skipped** (logged `⚠️ "<name>" timed out/failed twice — skipping`), and
  the run proceeds. Previously this aborted the whole run.
- `page.goto` that can't load within `NAV_TIMEOUT_MS` throws promptly (caught by
  the existing outer try/catch → error screenshot → exit 1) instead of relying on
  the implicit default.
- The watchlist read returns partial symbols if scrolling exceeds the deadline
  (logged), rather than looping until manually killed.

## Error handling
- The per-list `tryWithin` wrap collapses timeout and thrown errors to `null`;
  both trigger the retry then skip. The outer try/catch is unchanged for
  everything outside the per-list wrap (navigation, login check, state write).
- Single-list mode / granular / screenshot paths are unaffected (the per-list
  retry is only in the 4-list sync loop).

## Testing
- **Manual regression:** `npm run tv-sync -- --dry-run` completes normally with
  no behavior change to the per-list diffs (timeouts not hit under normal load).
- **Forced-timeout proof:** temporarily set `PER_LIST_TIMEOUT_MS` very low (e.g.
  via a quick local edit or env) and confirm a list is retried then skipped with
  the log line, and the run continues to the next list and exits 0.
- No unit tests (browser-bound); the change is structural control-flow verified by
  the two manual runs above.
