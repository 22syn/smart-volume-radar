# svr-tv-sync MCP — Roadmap (next phases)

**Date:** 2026-06-19
**Status:** Backlog for discussion — nothing here is committed work yet.
**Shipped to date (main):** v1 `tv_sync` (thin wrapper + outer timeout) · v2 granular
`tv_read_watchlist`/`tv_add_symbols`/`tv_remove_symbols` + `file`/`pruneAfterDays`
· v3 `tv_screenshot` (chart-only, returns image inline) · single-list file-resolution fix.

Each item below gets its own brainstorm → spec → plan → build cycle when picked.

---

## Candidate work items

| # | Item | What it adds | Value | Effort | Depends on / risk |
|---|------|--------------|-------|--------|-------------------|
| A | **Multi-timeframe screenshot** | One call returns e.g. daily + weekly (+ optionally 4H) as several images | High — fast multi-TF read in one shot | Low–Med | Loop existing `runScreenshot`; MCP returns multiple image blocks |
| B | **Save screenshots to a folder** | Optional param to keep PNGs (e.g. `~/Library/Logs/tv-shots/`) instead of auto-deleting | Low–Med — only if you want to browse/share them | Low | Skip the unlink + path param |
| C | **Session-health / re-login tool** | `tv_session_status` that reports logged-in/expired; clear guidance to run `--login` | Med — avoids silent auth-expiry failures | Med | Re-login itself is interactive (can't be headless) |
| D | **Visual deep-dive tool** | One tool that returns the chart image **+** the radar's current technical state (+ optional news) for a ticker | **Highest** — fuses the chart you see with the radar data + my analysis | Med–High | Reuses `radar-deep-dive` skill data + `tv_screenshot`; defines a combined result |
| E | **Deep retry hardening in tv-sync** | Per-action timeout/retry inside `sync-tv-watchlist.ts` (today only a wrapper-level timeout exists) | Med — real fix for the 2026-06-02 stall class | Med–High | Touches the core script; needs careful testing |
| F | **CI-mode in the MCP** | Let the MCP run against the GHA cookie-injected path | Low — nightly already runs in GHA; MCP is local on-demand | Med | Mostly redundant; deprioritized |
| G | **Sector-rank integration** | Add 150-sector ranking as info-only (not a filter) | Med — better context | Low–Med | **Blocked**: waiting on you to provide the ranking source |

---

## Recommended sequence

### Phase 1 — Visual analysis power (build on what we just shipped)
- **A. Multi-timeframe screenshot** — quick win, directly extends `tv_screenshot`.
- **D. Visual deep-dive tool** — the headline: "deep dive on TICKER" returns the
  chart + radar technical state + (optional) news, and I analyze it together.
  This is where the screenshot feature pays off most.

### Phase 2 — Reliability
- **C. Session-health tool** — catch expired logins early instead of failing mid-run.
- **E. Deep retry hardening** — properly close out the original stall-incident class.

### Phase 3 — Nice-to-have / blocked
- **B. Save-to-folder** — trivial, do it if/when you want persisted images.
- **G. Sector-rank** — unblock by providing the source, then info-only add.
- **F. CI-mode** — likely drop unless a concrete need appears.

---

## Open decisions (need your input)
1. **Phase-1 priority:** start with the quick win (A) or go straight for the high-value combo (D)?
2. **D's scope:** chart + radar state only, or also pull live news/fundamentals (Finnhub) into the same result?
3. **Sector-rank (G):** where does the 150-sector ranking come from? (still pending)

---

*Pick an item and I'll run it through the normal cycle (brainstorm → spec → plan → build → verify), same as v1–v3.*
