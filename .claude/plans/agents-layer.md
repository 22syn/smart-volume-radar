# Plan: Agents Layer — Multi-Agent Analysis on Top of Radar

**Status:** Draft for review
**Date:** 2026-05-18
**Scope:** RADAR ONLY — `src/lean/*` and `src/lean.ts` MUST NOT be touched.

## Context

Inspired by Guy Stein's multi-agent LinkedIn post. The radar pipeline today produces rich `StockData` (RVOL, Champion Score, momentum, RS percentile, fundamentals, news) and ships a Telegram report. We have a single `llmSummary.ts` doing per-stock + batch commentary.

The agents layer adds *structured reasoning on top of the existing signals*. Each agent is a small, typed unit with a single responsibility. They read `StockData`, produce a typed output, and feed downstream agents. We do NOT replace `setup.ts`, `championScore.ts`, `rvolCalculator.ts` — they remain the source of truth for signals. Agents *interpret*, they don't *re-derive*.

## Non-Goals

- No changes to `src/lean/*` or `src/lean.ts`
- No new signal logic in agents (they consume what `setup.ts` / `championScore.ts` produce)
- No autonomous trading / order placement
- No replacing the Telegram pipeline — agent output augments it
- No fundamental data layer beyond what `finnhubFundamentals.ts` already provides (Phase 1)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ EXISTING (untouched):                                   │
│   marketData → RVOL → setup → championScore → news     │
└─────────────────────────────────────────────────────────┘
                        ↓
              actionableStocks[]
                        ↓
┌─────────────────────────────────────────────────────────┐
│ NEW: Agents Layer (src/agents/)                         │
│                                                         │
│  Layer 2 — Specialists (parallel, per stock):           │
│    • TechnicalAnalyst    → TechnicalView                │
│    • CatalystAnalyst     → CatalystView                 │
│    • RiskAnalyst         → RiskView                     │
│                                                         │
│  Layer 3 — Synthesis (once per scan):                   │
│    • LeadAnalyst         → RankedPicks (top 3-5)        │
│                                                         │
│  Layer 4 — Review (per pick):                           │
│    • SeniorReviewer      → FinalCall (approve/reject)   │
│                                                         │
└─────────────────────────────────────────────────────────┘
                        ↓
              AgentReport (typed)
                        ↓
        Telegram (augmented) + Vault MD (new)
```

**Why this shape:** Layer 2 runs in parallel per stock (cheap, p-limit'd). Layer 3 runs once on the aggregated specialist outputs. Layer 4 runs only on the Lead's top picks (≤5 calls). Total LLM calls per scan ≈ `3 × actionableCount + 1 + topPicks`. For 15 actionable + top 5 = ~51 calls. Tunable via config.

## The 5 Agents (Phase 1)

### 1. TechnicalAnalyst
- **Input:** Single `StockData` (already enriched with RVOL, SMA, RSI, BB, A/D days, momentum, championScore, action)
- **Job:** Interpret the technical picture beyond the existing tags. Identify: trend stage, S/R proximity, RSI divergence hints, BB squeeze context, A/D pattern.
- **Output:** `TechnicalView { ticker, trendStage, strength: 1-10, observations: string[], concerns: string[] }`
- **Why a separate agent:** All technical signals already exist as numbers; this agent translates them into a coherent narrative the Lead can use.

### 2. CatalystAnalyst
- **Input:** Single `StockData` + its `news[]` array (from `enrichWithNews`)
- **Job:** Classify the catalyst type (earnings / FDA / M&A / guidance / macro / none), rate strength, flag stale-vs-fresh news.
- **Output:** `CatalystView { ticker, catalystType, freshness: 'today'|'recent'|'stale'|'none', strength: 1-10, summary: string }`
- **Why separate:** News interpretation is a different mode from price action; mixing them in one prompt dilutes both.

### 3. RiskAnalyst
- **Input:** Single `StockData` (price, ATR-ish via BB width, liquidity proxies, distance from SMA21/ATH, monthsInConsolidation)
- **Job:** Compute suggested entry, stop, target. Flag gap risk, low liquidity, extended-from-base.
- **Output:** `RiskView { ticker, entryHint: number, stopHint: number, targetHint: number, riskRewardRatio: number, warnings: string[] }`
- **Why separate:** Risk math is deterministic enough that the agent can output numbers, not just prose. Keeps the math out of the synthesis prompt.

### 4. LeadAnalyst
- **Input:** Array of `{ stock, technical, catalyst, risk }` for all actionable stocks
- **Job:** Rank, pick top 3–5, explain the *why* for each pick and the *why not* for the rejected ones.
- **Output:** `RankedPicks { picks: Pick[], rejected: Rejection[] }` where each `Pick` references the underlying ticker + cites the specialist views.
- **Why separate:** Synthesis is a different cognitive task than analysis. Also: this is where the *scoring* happens that the existing Champion Score doesn't capture (catalyst quality, narrative coherence).

### 5. SeniorReviewer
- **Input:** A single `Pick` + all three specialist views for that stock
- **Job:** Devil's-advocate review. Approve, reject, or downgrade. Add final stop/entry adjustments. Flag anything that doesn't add up.
- **Output:** `FinalCall { ticker, verdict: 'approve'|'downgrade'|'reject', adjustedEntry?, adjustedStop?, rationale: string }`
- **Why separate:** Same prompt that *generates* a pick is biased to defend it. A clean separate reviewer with only the data + the pick (no synthesis context) catches sloppy reasoning.

## File Structure

```
src/agents/
  types.ts                    # TechnicalView, CatalystView, RiskView, Pick, FinalCall, AgentReport
  llmClient.ts                # Thin wrapper around existing llmSummary callers — reuses callLlm
  prompts/
    technical.ts              # SYSTEM_PROMPT + buildPrompt(stock)
    catalyst.ts
    risk.ts
    lead.ts
    senior.ts
  specialists/
    technicalAnalyst.ts       # runTechnicalAnalyst(stock) → TechnicalView
    catalystAnalyst.ts
    riskAnalyst.ts
  leadAnalyst.ts              # runLeadAnalyst(bundles) → RankedPicks
  seniorReviewer.ts           # runSeniorReviewer(pick, views) → FinalCall
  pipeline.ts                 # runAgentsLayer(stocks) → AgentReport — orchestrates all 5
  formatters/
    telegram.ts               # formatAgentReportForTelegram(report) → string
    markdown.ts               # formatAgentReportForVault(report, date) → string
tests/agents/
  technicalAnalyst.test.ts
  catalystAnalyst.test.ts
  riskAnalyst.test.ts
  leadAnalyst.test.ts
  seniorReviewer.test.ts
  pipeline.test.ts            # mocks callLlm, asserts orchestration order
```

## Integration with `src/index.ts`

Add a single new step between step 7 (news enrichment) and step 8 (Telegram):

```ts
// 7.6. Agents layer (optional, behind config flag)
let agentReport: AgentReport | null = null;
if (config.enableAgentsLayer) {
    try {
        agentReport = await runAgentsLayer(enrichedMomentum, scanDate);
        logger.info(`🤖 Agents: ${agentReport.picks.length} picks, ${agentReport.rejected.length} rejected`);
    } catch (err) {
        logger.warn(`Agents layer failed (non-fatal): ${(err as Error).message}`);
    }
}
```

Pass `agentReport` into `sendDailyReport` as an optional field. The Telegram formatter renders an "🎯 ניתוח סוכנים" block at the top of the report when present.

Vault output: separate function `writeAgentReportToVault(agentReport, scanDate)` writes a structured MD to `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Maestro/06-outputs/YYYY-MM-DD-agents-report.md`.

## Config Additions

| Var | Default | Purpose |
|---|---|---|
| `ENABLE_AGENTS_LAYER` | `false` | Master switch — off by default until validated |
| `AGENTS_MAX_PICKS` | `5` | How many picks Lead Analyst is allowed |
| `AGENTS_CONCURRENCY` | `3` | p-limit for specialist parallelism |
| `AGENTS_VAULT_OUTPUT` | `true` | Write MD to vault (when layer enabled) |

`LLM_PROVIDER` reused as-is.

## Phased Rollout

### Phase 1: Foundation
- 🟦 Define types in `src/agents/types.ts` — all view shapes + `AgentReport`. **Verify:** `npx tsc --noEmit` passes.
- 🟦 Create `src/agents/llmClient.ts` exporting `callAgentLlm(systemPrompt, userPrompt)`. Reuse the provider-routing logic from `llmSummary.ts` (extract to shared helper if needed; do NOT duplicate). **Verify:** unit test mocks `fetch`, asserts correct provider URL.
- 🟦 Add config flags to `src/config/index.ts`. **Verify:** unit test reads env, checks defaults.

### Phase 2: Specialists (one at a time, with tests)
- 🟦 `technicalAnalyst.ts` + prompt + unit test (mocked LLM returns canned JSON). **Verify:** fixture stock with `championScore=85, action=BUY` produces `strength≥7`.
- 🟦 `catalystAnalyst.ts` + prompt + unit test. **Verify:** stock with empty `news[]` returns `freshness='none', strength≤3`.
- 🟦 `riskAnalyst.ts` + prompt + unit test. **Verify:** RR ratio is computed (not just returned by LLM) — risk math is deterministic in code, not prompt.

### Phase 3: Synthesis + Review
- 🟦 `leadAnalyst.ts` + prompt + unit test. **Verify:** given 10 bundles with varied specialist outputs, picks ≤ `AGENTS_MAX_PICKS` and respects rank order by combined strength.
- 🟦 `seniorReviewer.ts` + prompt + unit test. **Verify:** pick with `risk.warnings.length>0` and `catalyst.strength<3` gets `verdict='reject'` or `'downgrade'` in ≥80% of golden cases.

### Phase 4: Orchestration
- 🟦 `pipeline.ts` — `runAgentsLayer(stocks, date)` orchestrates Layer 2 (parallel) → Layer 3 → Layer 4 (parallel per pick). **Verify:** integration test with mocked LLM asserts call order and counts.
- 🟦 Wire into `src/index.ts` step 7.6 behind `ENABLE_AGENTS_LAYER`. **Verify:** with flag off, no behavior change (snapshot test on existing scan).

### Phase 5: Output Formatters
- 🟦 `formatters/telegram.ts` — compact HTML block for the daily report. **Verify:** preview-report script renders cleanly with a fixture `AgentReport`.
- 🟦 `formatters/markdown.ts` + `writeAgentReportToVault` — writes structured MD to Maestro `06-outputs/`. **Verify:** fixture writes deterministic MD; snapshot test.

### Phase 6: Validation
- 🟦 Run end-to-end with `ENABLE_AGENTS_LAYER=true` on a real scan day, eyeball output. Tune prompts.
- 🟦 Add agents picks to `results/scan-YYYY-MM-DD.json` so `evaluate-setups` can later measure agents-vs-non-agents hit rate.
- 🟦 Once stable for 2 weeks: write a short retro in `docs/` comparing agent picks to existing Champion Score top-N.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM cost balloons | Behind config flag; specialists run only on `actionableStocks` (already filtered); Senior runs only on top picks |
| Specialist outputs hallucinate numbers | Risk math computed in code, LLM only adds prose; Technical/Catalyst outputs validated against StockData fields before being passed to Lead |
| Bias: Lead defends its own picks | Senior Reviewer gets specialist views only, not Lead's reasoning |
| Pipeline gets slow | p-limit concurrency at `AGENTS_CONCURRENCY` (default 3) per layer; can disable per-agent via config later if needed |
| Agents step on `setup.ts` source of truth | Agents are read-only consumers of signals; tests assert no agent output mutates StockData |
| Lean version accidentally touched | All agent files live under `src/agents/`; `src/lean/*` not imported anywhere in agent code; eslint rule? (manual review for Phase 1) |

## Open Questions for Review

1. **Output language:** Hebrew (matching current Telegram messages) or English (matching code/logs)? Suggest: Hebrew for end-user facing, English in JSON/logs.
2. **Vault output:** write to Maestro `06-outputs/` (per global instructions) or to project `outputs/`? Suggest: Maestro vault, per global standard.
3. **JSON provider for agents:** force structured JSON output (Gemini/OpenAI both support) or stick with regex-parsed prose like current `llmSummary.ts`? Suggest: JSON mode where the provider supports it, regex fallback otherwise.
4. **Senior override:** does a `'reject'` from Senior remove the pick from Telegram entirely, or show it as "rejected by review"? Suggest: show as rejected — transparency over silence.
5. **Devil's Advocate as 6th agent:** the original 8-agent sketch had a separate Devil's Advocate. I folded that into the Senior Reviewer for Phase 1 to keep call counts down. Worth a separate agent? Suggest: defer to Phase 7.

## What Phase 1 Does NOT Cover (Future Phases)

- Sector Analyst, Fundamental Analyst, Sentiment Analyst (Layer 2 expansion)
- Devil's Advocate as separate agent
- Feedback memory: tracking which specialists' calls correlate with `evaluate-setups` hits
- On-demand `/analyze TICKER` Telegram command
- Multi-language reports
