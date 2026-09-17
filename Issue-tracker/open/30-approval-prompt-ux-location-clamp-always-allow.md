# 30 — Approval prompt UX: location line, clamped detail, session always-allow, expired/secret copy

**Blocked by:** None — builds on the shipped ticket-23 prompt pump.
**Status:** open

## Problem

The reference's approval cards carry concepts our prompt surface lacks (inventory §6): a local-vs-remote location line, detail clamped with an explicit omission marker, a persistent "always allow this rule" choice, and stale/pending projections so resolved or expired asks answer honestly. Our pump (`src/adapter/access-prompt.ts`) offers Allow/Deny only, renders unclamped reason text, and an expired answer surfaces nothing. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.5 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [x] Option set: Allow / **Always allow (this session)** / Deny. "Always" inserts a **session-scope** allow row (class + target fingerprint) through the relay's existing policy table (`src/core/access-relay.ts` — `lookupPolicy`/session rows); a later ask matching that row auto-answers without prompting (shipped policy no-op path). **Profile/preset writes are out of scope** (consent trap) — record the boundary in the module comment.
- [x] Session-row clearance: session-scope rows are cleared on deactivation (and unload) — no "always" leaks across sessions; add a core/adapter API only if the table is not already session-lifetime-scoped, and test the clearance.
- [x] Location line: constant honest line "Runs on your computer." on every prompt detail (workers are local dsh child sessions; per-class lines arrive only if a non-local producer kind ever lands — design-17 conflict 6).
- [x] Clamped detail: apply the `src/core/report-clamp.ts` pattern to the prompt's rendered reason/target text — hard cut + omission marker with counts (`approval.detail.omitted` copy); never truncate inside the target name.
- [x] Expired-answer path: when the user answers a prompt whose ticket already timed out/denied (ADR-0008), surface `approval.expired` copy ("This request already expired and was denied by default.") instead of silence; resolve nothing.
- [x] Secret stored-state copy: on a credential ask's post-decision notice, include the "stored securely, never shown" reassurance (`approval.secret.stored`) — names-never-values invariant untouched.
- [x] Copy: design-17 §7 `approval.*` strings (en + zh via the locale face where the client renders them; host command/prompt copy as clean-room constants). The prompt pathway stays `ctx.userQuestions.ask` — **never** `conversation.approval.detail`, never a new prompt pathway (design-16 §4.4 forbidden list).
- [x] Offline tests (S8): option routing (always → row insert → auto-answer), clearance on deactivation, expired-answer copy path, clamp marker math, secret copy presence; full suite green, typecheck clean.

## Comments

### 2026-09-17 — agent team

Landed in worktree `clone/always-on-dispatcher`, commit `0e2e9fa` ("Enrich access-request prompt UX (ticket 30)"; 8 files, +699/−27).

- **Option set + row insert**: `ACCESS_PROMPT_ALWAYS_ALLOW` ("Always allow (this session)") added between Allow and Deny in `src/adapter/access-prompt.ts`; pump option `alwaysAllow` inserts a session-scope allow row (class + exact target) via `Multitask.accessPolicy.set`, then routes the same allow decision. Matching later asks auto-answer on the shipped policy no-op path (no prompt, no wake). Profile/preset writes deliberately not plumbed — boundary recorded in the module doc.
- **Clearance**: the table was not session-lifetime-scoped (it lives per plugin apply), so the sanctioned core API was added: `AccessPolicyTable.clearSession()` + `Multitask.clearSessionAccessPolicy()`, wired on deactivation and unload/HMR in `src/plugin.ts`. Tested at table and Multitask level, plus a plugin test proving a re-activated session prompts again after "always".
- **Location line**: constant `APPROVAL_LOCATION_LOCAL` on every prompt detail; present even with an empty reason.
- **Clamped detail**: `clampApprovalDetail` (240 chars, report-clamp pattern, `approval.detail.omitted` marker with omitted count); target names never truncated.
- **Expired answers**: pump fences every explicit answer on core liveness (`listPending`) — a gone ticket surfaces `approval.expired` via the wake bus as a timeout-deny notice (`accessExpiredNotice`) and resolves nothing; an expired "always" click inserts no row. Dismissed answers stay silent. Relay untouched (timeout/deny-by-default/dedupe/re-queue).
- **Secret copy**: allowed credential asks emit `secretStoredAccessNotice` (allow note = `approval.secret.stored`); assembler now renders allow notes in the Resolved section. Names-never-values untouched.
- **Copy shape**: prompts are host-rendered (`ctx.userQuestions.ask`), so the `approval.*` strings ship as clean-room en constants per this checkbox's own qualifier; no client surface renders them, so no zh locale-face keys were added. Prompt pathway unchanged; no forbidden slots claimed.
- **Not adopted** (per constraints): classifier-gated auto-review (design-17 conflict 5).
- **Gates**: `npm run typecheck` clean (both configs); `npm test` 572 pass / 0 fail (551 baseline + 21 new). Identifier grep over the diff: clean.

Deferred: none blocking. Session-row clearance covers deactivation + unload; profile-scope "always" remains out of scope by design (consent trap).

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- Relay semantics frozen: timeout (ADR-0008), deny-by-default, dedupe (`suppressesConversational`), released-ask re-queue — this ticket changes presentation + option plumbing only.
- Classifier-gated auto-review is explicitly NOT adopted (design-17 conflict 5) — do not add any auto-decision layer beyond the shipped policy table lookup.
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.
