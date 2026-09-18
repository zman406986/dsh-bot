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

### 2026-09-17 — agent team (security rework: wildcard always-allow fence)

Read-only verification FAILED check 2a: an always-allow row persisted whatever `target` the worker supplied, and `matchTargetPattern` (`src/core/access-relay.ts`) honors `*` and trailing-`*` as class/prefix patterns. `toAccessRequestBody` only requires a non-empty target, so a worker asking for `*` (or `gh-api*`) and getting an "Always allow" click stored a session row matching an entire class (or prefix family) of targets — privilege escalation.

- **Fix, consent time (not matching semantics)**: `isWildcardAccessTarget` added to `src/adapter/access-prompt.ts` — true when the target contains `*`, the only metacharacter `matchTargetPattern` special-cases. Checked anywhere in the string so consent never covers a pattern shape; exact targets are unaffected.
- **Option set**: `accessPromptQuestion` degrades to Allow / Deny for a wildcard target — no "Always allow (this session)" is ever offered.
- **Pump**: an always-shaped answer that still arrives for a wildcard target (constructed or queued path) is not forwarded to the row insert; it degrades to this ask's plain one-shot allow.
- **Defense in depth at the row sink** (`src/plugin.ts` `alwaysAllow`): refuses to write any session row whose target carries a wildcard, so no class/prefix pattern can be remembered even if a caller bypasses the pump. Profile rows, already-stored rows, and `matchTargetPattern` semantics are untouched.
- **Tests** (6 new, offline): bare-`*` ask offers Allow/Deny only; `gh-api*` ask drops Always allow; the fence predicate covers `*` anywhere and leaves exact targets alone; pump always-shaped answer for `*` is not forwarded to the row insert and still resolves as a one-shot allow; a wildcard target still routes a plain Allow; plugin end-to-end — a `gh-api*` ask offers Allow/Deny only, and after an always-shaped answer the prefix neighbour `gh-api-2` prompts again instead of auto-allowing (a leaked `gh-api*` row would auto-allow it silently).
- **Red first**: with the fence absent the new tests failed on their behavioral assertions; with only the option-set degradation applied the pump and plugin tests still failed (plugin: `actual: 1, expected: 2` — the leaked `gh-api*` row auto-allowed `gh-api-2`), so the row-leak path is covered independently of the option set. Full fix → all green.
- **Gates** (worktree `clone/always-on-dispatcher`): baseline `npm test` 582 pass / 0 fail (157 suites); final `npm test` 588 pass / 0 fail; `npm run typecheck` clean (both configs); `npm run build` ok; `npm run build:client` ok. Clean-room identifier grep over the diff: clean.
- **Commit**: worktree `7c90a25` — "Reject wildcard targets in always-allow consent (ticket 30 fix)" (4 files, +169/−8).

Not changed, deliberately: `toAccessRequestBody` still accepts wildcard targets (the ask still happens — only the memory option is withdrawn), and stored rows keep their existing matching semantics.

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- Relay semantics frozen: timeout (ADR-0008), deny-by-default, dedupe (`suppressesConversational`), released-ask re-queue — this ticket changes presentation + option plumbing only.
- Classifier-gated auto-review is explicitly NOT adopted (design-17 conflict 5) — do not add any auto-decision layer beyond the shipped policy table lookup.
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.

### 2026-09-19 — re-based onto the wrapper-UI vehicle (ADR-0018; ticket 64)

The session-scoped always-allow choice now matches exception **U-D** exactly (session-scoped,
never persisted; no settings-managed rule store) — the profile-writes out-of-scope boundary was
right and stays. Two things re-base:

- The constant "Runs on your computer." location line is superseded: ADR-0018 brings the
  remote-computer area with location labels, so location lines become honest per-producer-kind.
- The prompt pathway (`ctx.userQuestions.ask`) was the plugin-UI constraint; under the wrapper the
  approval surface may move to the wrapper's own UI (reference-style approval cards, minus U-D
  persistence).

Classifier-gated auto-review remains NOT adopted here (per this ticket's constraint) and is seeded
as its own scope ticket. Status stays open, re-scoped.
