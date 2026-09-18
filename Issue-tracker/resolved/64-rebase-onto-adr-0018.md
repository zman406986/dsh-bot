# 64 — Re-base the repo onto ADR-0018 (records, PRD, register, UI epic, session seam)

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none — ADR-0018 is accepted; this is its consequence pass.
**Related:** ADR-0018 (master rule), `.scratch/adr-0018-trim-state.md` (session record), ADR-0005/0009/0013/0016 (superseded), tickets 27–35, 46, 49 (UI epic re-scope), 50/51 (retracted premises)

## Problem

ADR-0018 (2026-09-18) replaced the project's governing model — *imitate the reference in its entirety, except an enumerated exception list* — after the human retracted two fabricated premises (ADR-0009's activation story; ticket 50/51's "verbatim directive") and trimmed the exception list across a recorded session. The repo's records, PRD, tickets, and open defects still assume the old model (flag + dormant + command activation, capsule plugin-UI, clean-room copy rule). Nothing may proceed on the old assumptions.

## What to do

- [x] **PRD amendments** (explicit edit, not silent): void the feature-flag/kill-switch requirements (§11.5, §15.6 — always-on now); completion semantics become first-visible-ack (not "delivered to user"); §8/§12/§17 clean-room sections replaced by the no-verbatim copy policy (AGENTS.md is the operative wording); S7's clean-room grep gate is removed from the success criteria.
- [x] **Register reclassification** (`docs/research/dsh-core-loop-deviations.md`): A-4 → superseded by ADR-0018; A-5, A-6 → `not-a-deviation` (verified conformances, cite `reference-behavior-notes.md:60`); A-7/A-8 → carried as ADR-0018's D21/D22; R-1 → carried as A2; Part A rows stay closed; B-1 stays a bug (ticket 59 closed it — verify its fix is unaffected).
- [x] **UI epic re-scope**: tickets 27–35, 46, 49 were designed for the capsule/right-panel/plugin-UI vehicle that ADR-0013 fixed and ADR-0018 voided. Re-base each ticket onto the wrapper-UI vehicle (or close as moot with a pointer); do not silently close. Ticket 33's provenance review becomes a no-verbatim-copy review.
- [x] **Retracted tickets**: 50 and 51 — already marked DO NOT IMPLEMENT; move to `Issue-tracker/cancelled/` with the retraction pointers.
- [x] **Seam verification (design input, no product code)**: per-dispatcher dsh sessions — can each session's dispatcher get its own tool scope, given the recorded process-global `ctx.tools.register` constraint? Write findings to `docs/research/` (new note). This gates any multi-dispatcher design work.
- [x] **Scope tickets for the newly in-surface areas**: wrapper shell UI, onboarding flow, classifier-gated auto-review, peer tier, remote-computer/desktop area — each needs its own research/design ticket before implementation (repo rule: issue first). Seed them from `always-on-dispatcher-behavior.md` areas 1, 4–6, 9 and the remote-box notes; respect the ADR-0018 exception list (e.g. U-A/U-B/U-C/U-D stay OUT of scope).

## Constraints

- The exception list in ADR-0018 is exhaustive and is the fidelity bar; do not re-litigate trimmed items.
- Copy policy: no verbatim copying from the reference tree; adapted copying permitted (AGENTS.md, human risk decision 2026-09-18).
- Offline-first testing discipline (S8) survives the re-base even though S7 does not.

### 2026-09-19 — seam verification result (AC: per-dispatcher dsh sessions / tool scoping)

Finding written to `docs/research/dsh-tool-scoping-seam.md`; design work ticketed as **72**. In
brief: `ctx.tools.register` is called on the plugin-level ctx (process-global;
`src/adapter/dispatcher-tools.ts:201`), our code pins it to a single activation slot
(`src/plugin.ts`), and per-session behavior is purely an execute-time gate against ONE session id
(`gatedExecute`, `src/adapter/dispatcher-tools.ts:140-155`). Multi-dispatcher therefore needs
either a host-side per-session scope (unverified — ticket 72 commissions the observation pass) or
generalized session-keyed gating (implementable now, no host change). Multi-dispatcher design
work stays gated on ticket 72.

### 2026-09-19 — RESOLVED: all ACs executed, per-AC evidence and commit hashes

- **PRD amendments — `49ba8a0`.** Flag/kill-switch voided (§3 banner, §6.1 intro, §11.5, §15.6 —
  always-on, ADR-0018 cited); completion = first-visible-ack (§6.1 bullet, §6.5, §10 row, §12
  reconciler row); clean-room sections replaced by the no-verbatim adapted-copy policy (§3
  rewritten with the policy table, §8 block, §17 Appendix B, header posture + goal 9); S7 grep
  gate voided (§4 S7 row) and M4's audit exit re-scoped.
- **Register reclassification — `d1e1e18`.** A-4 superseded; A-5/A-6 → not-a-deviation citing
  `reference-behavior-notes.md:60`; A-7/A-8 carried as D21/D22; R-1 carried as A2 (acknowledgment
  discharged); U-1 closed by the ADR; Part A stays closed; B-1 stays a bug and its ticket-59 fix
  verified unaffected (fix lives in stream-key durability, untouched by the re-base).
- **UI epic re-scope — `43948e6`.** Dated re-base comments on 27, 28, 29, 30, 31, 32, 34, 46, 49
  (what survives / what is voided / what re-derives); ticket 33 re-scoped per ADR-0018's
  consequence (provenance review → no-verbatim-copy review; still open, still owns close-out);
  epic 35 closed as moot → `cancelled/` (its subject IS the voided vehicle).
- **Retracted tickets — `62a6849`.** 50 and 51 → `cancelled/`, Status: cancelled, retraction
  pointers retained.
- **Duplicate-number fix — `889a1c5`.** Collapsed-capsule ticket renumbered 64 → 66 (next free
  number); ticket 65's references updated; the re-base ticket kept 64.
- **Seam verification — `86f9dc7`.** Finding in `docs/research/dsh-tool-scoping-seam.md`:
  registration is process-global on the plugin ctx with a single activation slot; per-session
  behavior is only our execute-time gate. Host-side scope question commissioned; design ticketed
  as **72** (gates multi-dispatcher design work).
- **Scope tickets — `4216a27`.** 67 wrapper shell (ready-for-agent), 68 onboarding, 69
  auto-review, 70 peer tier, 71 remote computer (needs-triage, blocked by 67); 72 seam design.
  Mapping note: areas 4–5 and most of area 9 are exception-excluded (A4, C13/C14, U-B), so no
  tickets were seeded for them; U-A/U-B/U-C/U-D exclusions are written into 68/69/71's constraints.
- **Re-triage — `a23dd86` + `94da021`.** 63/66/65 stay needs-triage with dated reasons (65 notes
  the ADR-0016 retraction it cited uncritically; its substance is absorbed by 67/72).
- **Governance docs — `8b06091`.** ADR index: 0018 row added; 0016 filename + RETRACTED status;
  0005/0009/0013 superseded-by annotations; CONTEXT.md flag / imitation-boundary / copy-policy
  entries amended.

Status: resolved. No product code was touched (docs/tracker only); the seam check read `src/`
read-only.
