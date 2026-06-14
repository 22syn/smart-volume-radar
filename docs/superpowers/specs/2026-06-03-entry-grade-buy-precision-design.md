# Design — Raise BUY/Full precision by activating the entry grade

**Date:** 2026-06-03
**Author:** Kobi + Claude (brainstorm)
**Status:** Draft — pending user review
**Goal:** Maximize the precision of the *actionable* tier (action=BUY / Full
momentum) — when the radar says "buy", be right as often as possible. Fewer,
higher-hit-rate actionable alerts; volume is explicitly secondary.

---

## 1. Background & baseline (empirical, not assumed)

Source: `results/precision-analysis-2026-06-03.json` — **4,556** historical
flags with known outcomes. Win-rate is already strongly differentiated by
signals the radar **already computes**:

| Cut | Win rate | Median fwd | n |
|---|---|---|---|
| championScore 85+ | 58.5% | +18.8% | 925 |
| championScore 70–85 | 46.5% | +11.1% | 2,147 |
| Full momentum 🎯 | 57.4% | +16.0% | 408 |
| WATCH action | 55.8% | +8.6% | 405 |
| **BUY action** | **51.8%** | **+5.3%** | 228 |
| CAUTION_NO_VOL (bulk) | 43.4% | +8.8% | 3,168 |

**The key finding (`src/utils/championScore.ts:414-433`):** the TD-25/TD-26
entry grade is **already empirically validated** (n=403):

> **A+ 87% win / +33.7% peak · A 75% · B 66% · ungraded ~53%**

…but it is **flag-only**. It decorates the Telegram block (💎/⭐/✦) and does
**not** gate the BUY action. `tradingViewWatchlist.ts:73` puts *every*
`action==='BUY'` into the "Smart Radar – BUY" list regardless of grade. That is
why BUY wins only ~52% while A+ wins 87%: a ~53% ungraded BUY and an 87% A+ BUY
share the same bucket and the same watchlist.

**Conclusion:** the highest-leverage precision lever is not a new momentum
factor (those are mined; RVOL-acceleration and earnings-proximity already
returned NEGATIVE/inconclusive results — adding more risks overfitting a
bull-only sample). It is to **promote the already-validated grade from
decoration to a gate** on the actionable tier — but only after confirming it
holds on the full 4,556-flag set, not just the n=403 window it was born on.

**Out of scope (deliberate):** no new momentum criteria/dials; no change to the
raw scoring model. This effort only *uses* existing, validated signal better.

---

## 2. Plan: two phases with a hard decision gate between them

### Phase C — Validation study (research first)

**Question:** does the grade's precision (A+ 87% / A 75% / B 66%) hold on 4,556
flags and across time, or was it a bull-run artifact?

**Method:**
1. **Re-grade history.** Current precision flags lack `entryGrade` and `adrPct`
   (the TD-26 dial). Extend the reconstruction pipeline
   (`scripts/reconstruct-radar.ts` / precision-analysis) to compute
   `computeEntryGrade()` for every historical actionable flag using the
   **production function** — no re-derivation.
2. **Grade win-rates on the full set** — A+/A/B/ungraded, each with n.
   - **Primary win metric:** `peak21d ≥ 0.10` (consistent with how the grade
     was originally stated).
   - **Secondary (anti-self-deception):** realized `forwardNow` — median + a
     realized-win rate (`forwardNow ≥ 0.10`). Peak is reachable-but-not-captured;
     realized is what a trade actually returns. Report both.
3. **Walk-forward stability** — split the timeline into monthly windows; grade
   win-rates per window. Real edge = A+/A stay high in *most* windows, not only
   on average.
4. **Regime split** — bucket by `marketRegime` / benchmark trend (bull vs
   chop/down). **Honest caveat up front:** the sample is mostly bull, so this
   likely yields "cannot confirm out-of-bull" — itself a finding that bounds how
   hard we gate.
5. **Cutoff / volume tradeoff** — for `action==='BUY'` specifically, tabulate
   win-rate **and** alert-count at each gate: all-BUY (today) · BUY∩≥B ·
   BUY∩≥A · BUY∩A+. This curve is how we pick the gate, eyes open on volume
   given up.

**Acceptance criteria (set BEFORE seeing results):** proceed to Phase A only if,
on the full set:
- A+ ≥ **80%** win, A ≥ **70%** win, combined **≥A ≥ 73%**, AND
- no monthly window where the **≥A** cohort drops below **~60%**.

If it fails → **stop and do not gate.** A disproven edge is a valuable result
and prevents shipping an overfit signal. Document and reconsider.

**Output:** dated report in `docs/` + `results/grade-validation-2026-06-*.json`
(criteria-analysis style). No production code changed in this phase.

### Phase A — Grade-gate the actionable tier (only if C passes)

- **New layer after `determineAction`:** if base action is BUY but `entryGrade`
  is not ≥ the configured floor → demote to WATCH. Threshold via env
  `BUY_MIN_GRADE` (values `A+`/`A`/`B`/`off`; default `off` until C passes,
  then `A` per the cutoff curve). Configurable so it can run **A/B against the
  current ungated radar** for a few weeks (same pattern as Smart-vs-Lean).
- **Grade promoted from flag-only to gating input** (still computed where it is).
- **TV "Smart Radar – BUY"** tightens automatically (it filters `action==='BUY'`).
- **Telegram report:** BUY block = gated set; demoted B/ungraded appear under
  WATCH with a reason ("B-grade → watch").
- **Backtest-continuity constraint (critical):** the raw classification /
  championScore written to JSON history must NOT change — per `memory.md`, the
  legacy scanner drives the JSON history that backtests consume. The gate is an
  action/presentation layer. Store the gated action as an **additional** field
  so `reconstruct` can reproduce both gated and ungated views (apples-to-apples).
- **Tests (`setup.ts` / `championScore.ts` suites):** B-grade BUY → WATCH;
  A/A+ → BUY; ungraded BUY → WATCH; TV BUY list reflects the gate.

**Ship criteria for Phase A:** backtested gated-BUY win-rate ≥ ~75% with the
volume drop quantified and accepted.

---

## 3. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Overfit / bull-only** — grade born on n=403 bull data | Phase C full-set + walk-forward + regime split; hard acceptance gate; ship behind configurable env for A/B |
| **Volume collapse** — gating BUY to ≥A cuts alert count | Quantified in Phase C cutoff curve; precision is the stated goal, volume secondary; `BUY_MIN_GRADE` tunable |
| **Break backtest history** — altering stored classification | Gate is additive layer; raw action/score preserved; reconstruct reproduces both |
| **`.TA` data-freshness lag** (known) | Note in study; prefer US-ticker subset for the stability check if `.TA` noise distorts a window |

---

## 4. Decision flow

```
Phase C study ── A+≥80% & A≥70% & ≥A≥73%, stable? ──no──▶ STOP (don't gate; document)
                              │ yes
                              ▼
              Phase A: grade-gate behind BUY_MIN_GRADE (A/B test) ──▶ ship if gated win ≥ ~75%
```
