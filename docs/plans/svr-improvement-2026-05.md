# Plan: Smart Volume Radar — 6-Phase Improvement

## Context
The Smart Radar is sending 155 alerts/day with only 1 actionable (Telegram spam).
The `llmSummary` is dead in production (Gemini key missing). The radar lacks
agentic deep-dives and a way to validate criteria changes before deploy.
This plan fixes those + introduces 2 reusable Claude assets (skill + subagent)
and a quality pass over the whole codebase.

**Branch:** `main` (Smart Radar). Lean Radar lives on `stable` and is already healthy.

---

## Tasks

### Phase 0: Cleanup & cabinet sync — *house-keeping, no code change*
- [ ] **0.1** Move `outputs/2026-05-*.md` from project → `~/cabinet/outputs/` (per global CLAUDE.md rule).
  - Files: 2026-05-10 normal radar quant review, 2026-05-10 lean radar quant review,
    2026-05-11 60d deep analysis, 2026-05-11 window comparison, 2026-05-22 anthropic research.
  - **Verify:** `ls ~/cabinet/outputs/ | grep smart-volume-radar` shows new files.
- [ ] **0.2** Update `~/cabinet/knowledge/reference/smart-volume-radar-architecture.md`
  with: 2-radar split (Smart on main, Lean on stable), TV watchlist split,
  Graduated detector, LaunchAgent flow.
  - **Verify:** doc mentions "Lean Radar" + "tv-breakouts-latest.txt" + "Graduated detector".
- [ ] **0.3** Create `~/cabinet/knowledge/reference/smart-volume-radar-criteria-empirical.md`
  with the 60d/1y findings: lowRiskEntry −25.6%, pivotBreakout +20.4%, Graduated +24.3%.
  - **Verify:** numbers match `outputs/2026-05-11-60d-deep-analysis.md`.
- [ ] **0.4** Create `~/cabinet/projects/smart-volume-radar/decisions-log.md` —
  start with entries for split TV watchlists (5/22) and llmSummary identified dead (5/22).
  - **Verify:** file exists, 2 entries with date + rationale + impact.
- [ ] **0.5** `git -C ~/cabinet commit -am "update: SVR architecture + criteria + decisions"` + push.
  - **Verify:** `git log` shows commit, push succeeded.

### Phase 1: Smart Radar spam fix — *the headline win, est. 30 min*
- [ ] **1.1** Cap `formatNotableSection` at top-5 per sub-section (distribution + no-vol).
  - File: `src/services/telegramBot.ts:543`.
  - **Verify:** unit test or quick `npm run preview-report` shows ≤10 lines in NOTABLE.
- [ ] **1.2** Skip stocks in NOTABLE when `championScore < 60` (low-quality filter).
  - File: `src/services/telegramBot.ts:543`.
  - **Verify:** preview-report shows distribution items only with score ≥60.
- [ ] **1.3** Skip NOTABLE entirely when `sectorMedianReturn63d < 0` (sector-wide noise).
  - File: `src/services/telegramBot.ts:543`.
  - **Verify:** preview-report on a day with weak A&D sector — A&D items absent.
- [ ] **1.4** Add 🎓 **Graduated** section to top of Telegram (Close→Full event).
  - File: `src/services/telegramBot.ts:formatGraduationSection` (already exists at line 717 — just verify it's wired).
  - **Verify:** when a real graduation happens, section appears at top.
- [ ] **1.5** Use **`anthropic-skills:code-review-checklist`** on the diff before commit.
  - **Verify:** review notes saved to `outputs/2026-05-22-spam-fix-review.md`,
    no critical findings unresolved.
- [ ] **1.6** Commit + push + trigger GHA run for verification.
  - **Verify:** the night's Telegram shows ≤20 lines total instead of 155.

### Phase 2: llmSummary — kill the dead code, optionally build aiCommentary
- [ ] **2.1** Delete `src/services/llmSummary.ts` exports that are unused
  (`getReportSummary`, `getPerStockAnalyses`, `buildPrompt`).
  Keep `classifyTickersWithGroq` only (it's a utility, not dead).
  - **Verify:** `grep -rn "getReportSummary\|getPerStockAnalyses" src/` returns nothing.
- [ ] **2.2** Delete `src/agents/llmClient.ts` + `src/agents/types.ts` (newer abstraction, never used).
  - **Verify:** `grep -rn "from.*agents/llmClient" src/` returns nothing.
- [ ] **2.3** Remove `enableLlmSummary`, `LLM_PROVIDER`, `LLM_*` from `src/config/index.ts`
  except for the bits `classifyTickersWithGroq` still needs (Groq key).
  - **Verify:** `tsc --noEmit` passes.
- [ ] **2.4** Remove `ENABLE_LLM_SUMMARY` + `LLM_PROVIDER` + `GEMINI_API_KEY`
  from `.github/workflows/daily-scan.yml`.
  - **Verify:** GHA run completes without LLM warnings.
- [ ] **2.5** Use **`code-simplifier:code-simplifier`** subagent on the LLM cleanup.
  - **Verify:** subagent returns diff with no broken imports, no dead types.
- [ ] **2.6** **Decision point**: build `aiCommentary.ts` (Claude API + prompt caching)
  for graduation-only commentary? Defer to a follow-up unless explicitly chosen now.

### Phase 3: Custom skill `radar:deep-dive` — *per-stock thesis on demand, est. 2-3h*
- [ ] **3.1** Create `~/.claude/skills/radar-deep-dive/SKILL.md` with YAML frontmatter
  (description, when-to-use triggers). Skill file structure per Anthropic Skills docs.
  - **Verify:** Claude auto-invokes skill on prompt "deep dive on MNST".
- [ ] **3.2** Define tool interface inside the skill: `getStock(ticker)`,
  `getNews(ticker)`, `getEarnings(ticker)`, `getSector(ticker)`, `getMonitorHistory(ticker)`.
  - **Verify:** skill can invoke each without error.
- [ ] **3.3** Wire to existing radar fetchers (newsService, finnhubFundamentals, monitorTracker).
  - **Verify:** `getNews("AAPL")` returns Finnhub headlines.
- [ ] **3.4** Output template: 1-page thesis with bull case / bear case / current setup / recent news.
  - **Verify:** test on 3 tickers — output is consistent format, under 200 words.
- [ ] **3.5** Use **`anthropic-skills:clean-code`** for skill instructions readability.
  - **Verify:** SKILL.md scans clean — no jargon, each section purpose-stated.

### Phase 4: Subagent `radar-criteria-tester` — *validate before deploy, est. 3-4h*
- [ ] **4.1** Create `.claude/agents/radar-criteria-tester.md` with focused system prompt:
  "Given a proposed criterion change, run the lift analysis on 60-90 days of scan history
  and return side-by-side comparison + recommendation."
  - **Verify:** subagent file parses, shows in `Agent` tool's options.
- [ ] **4.2** Wire read-only access to `results/scan-*.json` + execute permission for
  `scripts/analyze-criteria-importance.ts`.
  - **Verify:** subagent can read scan files + spawn the analysis script.
- [ ] **4.3** Output format: lift before/after, hit-rate before/after, sector breakdown,
  risk warnings (e.g., "tested only in bull regime").
  - **Verify:** test on a known change (drop lowRiskEntry) — output matches our manual finding.
- [ ] **4.4** Use **`anthropic-skills:tdd-workflow`** patterns for the subagent's test cases.
  - **Verify:** subagent ships with 3 canonical test scenarios documented in its prompt.

### Phase 5: Quality pass — *codebase health, est. 2-3h*
- [ ] **5.1** Run **`anthropic-skills:code-review-checklist`** on `src/index.ts`,
  `src/services/marketData.ts`, `src/utils/setup.ts`, `src/utils/championScore.ts`.
  - **Verify:** findings written to `outputs/2026-05-22-svr-quality-review.md`.
- [ ] **5.2** Run **`code-simplifier:code-simplifier`** subagent on the same 4 files
  to remove duplication + dead code.
  - **Verify:** simplifier returns diff. PR-ready, no behavior change.
- [ ] **5.3** Run **`anthropic-skills:lint-and-validate`** project-wide.
  - **Verify:** `npx tsc --noEmit && npm run lint` exit 0.
- [ ] **5.4** Use **`engineering:tech-debt`** skill to identify + prioritize remaining issues.
  - **Verify:** prioritized list in `outputs/2026-05-22-svr-tech-debt-backlog.md`.
- [ ] **5.5** Use **`anthropic-skills:performance-profiling`** on the scan pipeline.
  - Question to answer: is the 1-minute scan time mostly Yahoo I/O or computation?
  - **Verify:** profile breakdown saved to outputs.

### Phase X: Verification (always last)
- [ ] **X.1** Full `tsc --noEmit && npm run lint && npm run test` passes on main.
- [ ] **X.2** GHA Smart Radar run completes successfully with new spam-fixed output.
- [ ] **X.3** Telegram message of the night ≤25 total lines (vs 155 today).
- [ ] **X.4** All cabinet docs committed + pushed.
- [ ] **X.5** Final `outputs/2026-05-22-svr-improvement-summary.md` with before/after metrics.

---

## Skill / Agent Cheat Sheet (used in this plan)

| Asset | When | Used in |
|---|---|---|
| `anthropic-skills:plan-writing` | Now (this doc) | This file |
| `anthropic-skills:code-review-checklist` | Pre-commit reviews | Phase 1.5, 5.1 |
| `anthropic-skills:clean-code` | Naming/structure | Phase 3.5 |
| `anthropic-skills:lint-and-validate` | After each phase | Phase 5.3, all Phase X |
| `anthropic-skills:tdd-workflow` | Subagent design | Phase 4.4 |
| `anthropic-skills:performance-profiling` | Scan timing | Phase 5.5 |
| `anthropic-skills:systematic-debugging` | If GHA breaks | (as needed) |
| `code-simplifier:code-simplifier` (subagent) | Dead code removal | Phase 2.5, 5.2 |
| `engineering:tech-debt` | Prioritization | Phase 5.4 |
| `engineering:code-review` | Alternative to checklist | (as needed) |
| `engineering:debug` | Bugs in production | (as needed) |
| `Plan` (subagent) | Architecture decisions | (as needed) |
| `explorer-agent` | Codebase exploration | Phase 5 prep |

---

## Risk Notes

- Phase 1 is the highest-impact + lowest-risk. Do it first regardless of the rest.
- Phase 2 deletes code — must be careful that `classifyTickersWithGroq` still works
  (run `scan-now` after the delete to verify).
- Phase 3-4 add new Claude assets — they don't change radar behavior, so safe to merge
  even if not perfect.
- Phase 5 is a pure refactor — no behavior change expected, but the diff might be large.

## Estimated Total: 8-12 hours of focused work, spread across 2-3 sessions.

---

## Progress

| Phase | Status |
|---|---|
| 0. Cleanup + cabinet sync | ⬜ |
| 1. Smart Radar spam fix | ⬜ |
| 2. llmSummary cleanup | ⬜ |
| 3. radar:deep-dive skill | ⬜ |
| 4. radar-criteria-tester subagent | ⬜ |
| 5. Quality + simplification pass | ⬜ |
| X. Verification | ⬜ |
