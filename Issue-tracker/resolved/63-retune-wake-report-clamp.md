# 63 — Re-tune the wake-report clamp (deviation A-7)

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** none.
**Related:** register item **A-7** (`docs/research/dsh-core-loop-deviations.md` Part B — approved addition, re-tuned); `docs/research/dsh-core-loop-salvage-map.md` §7 (the survey's one `unresolved` row, now resolved); ticket 55 (touches the same wake path indirectly)

## Why this exists

Ticket 54's survey could not classify `src/core/report-clamp.ts` (123 lines) or `test/report-clamp.test.ts` (116 lines) because the clamp is an **addition that changes the payload the dispatcher sees**, and ADR-0017 Q5 says such an addition is a deviation needing a ruling. Accurately counted, it sat in neither surviving bucket.

**The ruling (2026-09-18):** "copy the reference, or take the roomier option if there is nothing to imitate." Our notes establish the reference has **no** equivalent bound — `reference-core-loop-spec.md` specifies payload *substitution* for empty/aborted/error settles, never truncation. So there is nothing to imitate, and the protective addition stays with roomier bounds.

**Why roomier, and why the body specifically:** the wake notice is the dispatcher's **only** source for the user's answer. The user's answer arrives as the worker's final text, is clamped into the wake report, and is then delivered by the dispatcher. So the body bound is the one bound that can silently destroy a real deliverable mid-sentence — 2000 characters is plausibly below a normal research-summary length. The other bounds protect the dispatcher's context against high-frequency roster noise and are less load-bearing.

## What to change

`src/core/report-clamp.ts` — constants only:

| Constant | From | To |
|---|---|---|
| `REPORT_CLAMP_CHARS` | 2000 | **4000** |
| `ERROR_CLAMP_CHARS` | 800 | **1200** |
| `CHECK_ACTIVITY_CHARS` | 120 | **200** |
| `RECENT_RESULT_EXCERPT_CHARS` | 200 | **300** |
| `TOOL_RESULT_SUMMARY_MAX_ROWS` | 20 | **20 (unchanged)** |

No behavioural change, no new export, no signature change. Every consumer reads the constants, so this is a constant-level edit plus the tests that pin exact boundaries.

## Requirements

- **R1** No consumer changes — the clamp functions keep their signatures and semantics.
- **R2** The truncation marker keeps reporting `shown of total`, so a truncated report stays visibly truncated rather than looking complete.
- **R3** Tests that pin an exact boundary (`test/report-clamp.test.ts`, and the wake-turn assertions in `test/policy-assembler.test.ts`) must be updated to the new constants **by reading the constants, not by re-hardcoding** where practical — a hardcoded duplicate of the number is what makes this ticket necessary a second time if the bound moves again.
- **R4** Offline only (S8). No network, no LLM, no running dsh.
- **R5** The register's A-7 row already records the ruling and the date; do not add a second entry.

## Acceptance criteria

- [x] The five constants hold the values above. — `REPORT_CLAMP_CHARS 4000`, `ERROR_CLAMP_CHARS 1200`, `CHECK_ACTIVITY_CHARS 200`, `RECENT_RESULT_EXCERPT_CHARS 300`, `TOOL_RESULT_SUMMARY_MAX_ROWS 20` (unchanged). Each carries a comment naming ticket 63 / A-7 and its previous value.
- [x] `test/report-clamp.test.ts` passes with the new bounds and pins the boundary at the constant, not at a literal. — It already read the constants (`REPORT_CLAMP_CHARS + 100`, `ERROR_CLAMP_CHARS + 50`, `CHECK_ACTIVITY_CHARS + 20`); no edit needed, which is why it stayed green through the change.
- [x] The wake-turn clamp assertions in `test/policy-assembler.test.ts` still pass. — **Required an edit, and it is the interesting one:** the fixture was `"R".repeat(2500)`, a hardcoded length that happened to exceed 2000. At 4000 it no longer truncates, so the test would have **failed** — and, worse, a fixture just *below* the new bound would have silently passed while testing nothing. Now `REPORT_CLAMP_CHARS + 500`.
- [x] `npm test` 0 fail (baseline: 767 tests / 194 suites), `npm run typecheck` clean (both configs). — **769 tests / 194 suites / 0 fail** (two new cases from ticket 56); both tsconfigs clean.

## Comments

### 2026-09-18 — implemented

**Four constants changed, no consumer touched.** The clamp functions keep their signatures and semantics; every consumer reads the constants, so this is a constant-level edit.

**The re-tune flushed out two fixtures that were pinning a number instead of a bound.** This is the most useful thing the ticket produced, and it validates R3's instruction:

| Test | Was | Failure mode it was hiding |
|---|---|---|
| `policy-assembler.test.ts` — "clamps the report body…" | `"R".repeat(2500)` | Now **fails** correctly, but a fixture chosen just under the new bound would have passed *while asserting nothing about clamping* |
| `adapter-cordis-dsh-host.test.ts` — "clamps the phrase to CHECK_ACTIVITY_CHARS" | `"tool_".padEnd(150, "x")` | With the bound now at 200, a 150-char name **stopped clamping**, so the `endsWith("…")` assertion failed |

Both now derive their fixture from the constant. A third — `adapter-cordis-dsh-host.test.ts`'s excerpt case with `"y".repeat(5_000)` — did not break (5000 still exceeds 300) but was converted for the same reason.

**Every other clamp-sensitive test already read its constant** (`report-clamp.test.ts`, `roster-snapshot.test.ts`, and the rest of the excerpt cases), so the blast radius was exactly two fixtures — smaller than feared.

**Ticket 54's `unresolved` row resolves to `Keep`.** `src/core/report-clamp.ts` and `test/report-clamp.test.ts` now belong to the "survives untouched" bucket, and the salvage map's counts can be restated as **40 Keep / 13 Keep+adapt / 0 unresolved** with no `Rewrite`/`Delete`.

## Notes

- This ticket is small on purpose. Do not expand it into "make the clamp configurable" — a settings knob is a new design decision with no reference precedent, and it belongs in a separate ticket if it is ever wanted.
- The survey's `unresolved` row resolves to **Keep** on completion of this ticket; no other file in the tree is in that bucket.
