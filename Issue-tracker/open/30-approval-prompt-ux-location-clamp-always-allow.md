# 30 — Approval prompt UX: location line, clamped detail, session always-allow, expired/secret copy

**Blocked by:** None — builds on the shipped ticket-23 prompt pump.
**Status:** open

## Problem

The reference's approval cards carry concepts our prompt surface lacks (inventory §6): a local-vs-remote location line, detail clamped with an explicit omission marker, a persistent "always allow this rule" choice, and stale/pending projections so resolved or expired asks answer honestly. Our pump (`src/adapter/access-prompt.ts`) offers Allow/Deny only, renders unclamped reason text, and an expired answer surfaces nothing. Design: `.scratch/clone-always-on/design-17-always-on-dispatcher.md` §4.5 (worktree).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [ ] Option set: Allow / **Always allow (this session)** / Deny. "Always" inserts a **session-scope** allow row (class + target fingerprint) through the relay's existing policy table (`src/core/access-relay.ts` — `lookupPolicy`/session rows); a later ask matching that row auto-answers without prompting (shipped policy no-op path). **Profile/preset writes are out of scope** (consent trap) — record the boundary in the module comment.
- [ ] Session-row clearance: session-scope rows are cleared on deactivation (and unload) — no "always" leaks across sessions; add a core/adapter API only if the table is not already session-lifetime-scoped, and test the clearance.
- [ ] Location line: constant honest line "Runs on your computer." on every prompt detail (workers are local dsh child sessions; per-class lines arrive only if a non-local producer kind ever lands — design-17 conflict 6).
- [ ] Clamped detail: apply the `src/core/report-clamp.ts` pattern to the prompt's rendered reason/target text — hard cut + omission marker with counts (`approval.detail.omitted` copy); never truncate inside the target name.
- [ ] Expired-answer path: when the user answers a prompt whose ticket already timed out/denied (ADR-0008), surface `approval.expired` copy ("This request already expired and was denied by default.") instead of silence; resolve nothing.
- [ ] Secret stored-state copy: on a credential ask's post-decision notice, include the "stored securely, never shown" reassurance (`approval.secret.stored`) — names-never-values invariant untouched.
- [ ] Copy: design-17 §7 `approval.*` strings (en + zh via the locale face where the client renders them; host command/prompt copy as clean-room constants). The prompt pathway stays `ctx.userQuestions.ask` — **never** `conversation.approval.detail`, never a new prompt pathway (design-16 §4.4 forbidden list).
- [ ] Offline tests (S8): option routing (always → row insert → auto-answer), clearance on deactivation, expired-answer copy path, clamp marker math, secret copy presence; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- Relay semantics frozen: timeout (ADR-0008), deny-by-default, dedupe (`suppressesConversational`), released-ask re-queue — this ticket changes presentation + option plumbing only.
- Classifier-gated auto-review is explicitly NOT adopted (design-17 conflict 5) — do not add any auto-decision layer beyond the shipped policy table lookup.
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.
