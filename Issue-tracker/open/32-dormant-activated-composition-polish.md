# 32 — Dormant/activated composition polish: copy, locale, surfaces README, prompt review

**Blocked by:** 27, 28, 30, 31 (polish passes over their landed surfaces).
**Status:** open

## Problem

The activated experience must feel like the reference's always-on dispatcher while dormant boot stays stock dsh (design-17 §3). After the per-surface tickets land, the composition needs a coherence pass: the activation copy does not yet tell the user where presence lives or what to expect; the enlarged locale faces need validation; the "no board, no milestones, no notifications" absences need to be written down once; and prompt text must be reviewed so no string implies surfaces that do not exist (design-17 §4.8–4.9, conflicts 2/3).

## What to do

Implementation lands in the worktree checkout `C:\Users\TZhen\Desktop\dsh-bot-always-on`, branch `clone/always-on-dispatcher`, one ticket at a time per `.scratch/clone-always-on/worktree-workflow.md`.

- [x] Activation success copy: append the presence hint ("The Workers panel shows live progress; results arrive in this chat as they finish." — `activation.presence-hint`, design-17 §7) exactly once to `DISPATCHER_START_SUCCESS` in `src/adapter/activation-command.ts`; zh face in the locale dictionary.
- [x] Dormant copy review: confirm dormant boot registers nothing visible beyond the two commands (`dispatcher-start`, `dispatcher-steer`) — extend the existing flag-matrix tests to assert no new dormant registrations crept in from tickets 27–31.
- [x] Deactivation honesty: verify (test) the panel path ages to "unavailable" after session end (stale window) and that re-activation rebuilds — the "what does the user come back to" answer (design-17 §3.2) asserted end-to-end with fakes.
- [x] Surfaces README: a short doc (repo `docs/` or `CONTEXT.md` section, clean-room) recording the designed absences and their reasons: no push notifications (no seam — pull surfaces only), no todo board (private ledger, ADR-0007; `todoId` is linkage metadata), no milestones (no runtime entity), no stop control (conversational stops, PRD §15.3), no worker console, no timeline cards (closed node-type domain), send journal is host-owned.
- [x] Prompt review (conflicts 2/3): grep the policy/prompt assets for any wording implying a task board, milestone view, or push notification; fix with new copy if found; record the pass in this ticket's comments.
- [x] Locale validation: run `validateLocaleDictionary` over the final enlarged dictionary in tests (identical en/zh key sets, all strings); sweep for stray untranslated literals added by 27–31.
- [ ] Optional (drop without ceremony if the seam does not verify at integration): a `settings.onboarding` list entry (seams Finding 5 catalog) describing the opt-in dispatcher in one screen — lightweight, no guided overlay, suppressed once seen is NOT attempted (no verified persistence for "seen" without inventing state; conflict with design-17 §3.1(c)).
- [x] Offline tests (S8): dormant-registration matrix, deactivation→unavailable→reactivate-rebuild flow, copy assertions, locale validator; full suite green, typecheck clean.

## Constraints

- Offline tests only (S8).
- Clean-room copy only; never open the reference tree in either checkout.
- No new seams, no new core state; this is a composition/copy/docs pass over landed tickets.
- Implementation one-at-a-time in the worktree; status/comments updated on MAIN.

## Comments

### 2026-09-17 — agent team (implementation, worktree `clone/always-on-dispatcher` @ `77baef8`)

All checkboxes done except the **optional** `settings.onboarding` item (dropped, see below).
`npm test` **612 pass / 0 fail / 162 suites** (baseline before this ticket: 599 / 0 / 158 — confirmed,
not assumed); `npm run typecheck` clean on **both** configs; `npm run build` and `npm run build:client`
(35163-byte bundle) both succeed. Offline only (S8); no network, no LLM, no running dsh.
Worktree commit: `77baef8` ("Polish dormant/activated composition: presence hint, locale, surfaces
README (ticket 32)"), 7 files (2 new).

What landed:
- **Activation presence hint** (`src/adapter/activation-command.ts:26-41`): new exported constant
  `ACTIVATION_PRESENCE_HINT` = exactly the design-17 §7 string, appended once to
  `DISPATCHER_START_SUCCESS`. Exported through `src/adapter/index.ts`.
  - en (host copy, the authority): `The Workers panel shows live progress; results arrive in this chat as they finish.`
  - zh (`src/client/overlay.ts`, key `activation.presence-hint`): `“工作者”面板会显示实时进度；结果完成后会直接送达本聊天。`
  - **Parity:** the en dictionary value is asserted *identical* to `ACTIVATION_PRESENCE_HINT` (not a
    retyped near-miss); the zh value is asserted present, non-empty, distinct from en, and exactly the
    §7 draft. `validateLocaleDictionary` is green over the enlarged dictionary; en/zh key sets compared
    element-wise, all values non-empty strings.
- **Dormant-registration matrix**: extended `test/activation-lifecycle.test.ts` (new flag-matrix case)
  plus a full matrix in the new test file. Result: dormant boot registers **exactly** the two commands
  (`dispatcher-start`, `dispatcher-steer`), **zero** tools, **exactly four** passive listeners
  (agent/disposed + agent/status + subagent/end + session/event), **zero** roster snapshots published,
  **zero** access prompts asked, **zero** restart notices injected. Tickets 27–31 introduced no new
  dormant-visible registration. The six dispatcher tool names are asserted individually absent.
- **Deactivation honesty** (new test, design-17 §3.2): after `agent/disposed` the activated tool
  surface is gone and the last mirrored snapshot still renders rows *exactly at* the stale window but
  flips to unavailable **one ms beyond** it; a deliberate re-activation then republishes a **newer**
  snapshot (same session id) whose rebuilt roster — including the durable-rebuild-restored row — renders
  live rows again. The restart-honesty notice stays silent on the second activation.
- **Surfaces README**: `docs/surfaces.md` (new, clean-room). Records and reasons every designed absence
  — no push notifications (no seam; pull surfaces only), no todo board (ADR-0007, `todoId` is linkage
  metadata), no milestones (no runtime entity; PRD §13 milestones are process milestones), no stop
  control (conversational stops, PRD §15.3, `stop_worker` agent-facing only), no worker console, no
  timeline cards (closed `conversation.chat.node` key domain), host-owned send journal — plus the
  contrast table of surfaces that *do* ship.
- **Prompt review (conflicts 2 and 3)**: swept every shipped policy/prompt asset
  (`src/core/policy/prompts.ts`, `src/core/policy/assembler.ts`, `src/worker/prompt.ts`,
  `src/worker/report.ts`, `src/adapter/wake-copy.ts`, `src/adapter/restart-notice.ts`,
  `src/adapter/access-prompt.ts`, `src/core/report-clamp.ts`, `src/adapter/steer-command.ts`) and the
  `prompts-draft/*.md` assets for board / milestone / notification / toast / badge / alert wording.
  **Finding: no offender.** The only matches are the ticket-31 prohibitive narration rule itself
  ("…never reference a task board or milestone view"), which forbids the implication rather than
  creating one. **Conflict 3 conclusion: no prompt text implies milestone UI.** **Conflict 2 position:
  no prompt text implies a task board; `todoId` narration is absent entirely, so the chip cannot be
  reinforced into a board by policy.** No copy was changed by the review.
- **Locale + literal sweep**: `validateLocaleDictionary` over the final dictionary; every locale key
  the client code can request (roster states, all six section heads, the finished-count key, blocked
  phrases for every `AccessClass`, all toolview field labels, the degraded key, the new presence-hint
  key) asserted present in both faces. New test strips comments + the self-contained CSS string and
  regex-extracts every quoted literal from `panel.tsx` / `toolview-panel.tsx`: no literal containing a
  space survives that is not a dotted locale key, i.e. **no hard-coded user-facing sentence bypasses
  the dictionary** in the tickets 27–31 additions.
- **Clean-room guard** repeated at the composition layer over the dictionary + copy strings: none of
  `sand` / `executor` / `MessageSubagent` / `SAND_MULTITASK` appears.

New tests (`test/composition-polish.test.ts`, 12 cases / 4 suites): the copy append/presence/exact-string
case; the command-result case; the host↔locale parity case; the no-push wording case; the dormancy
matrix; the dormant-unrelated-write case; the activation-raises-surface case; the
deactivation→unavailable→reactivation-rebuild case; the dictionary-validation case; the
every-requested-key-resolves case; the hard-coded-literal sweep; the clean-room identifier guard.
Extended: `test/activation-lifecycle.test.ts` flag matrix (+1 case); `test/client-face-scaffold.test.ts`
key-set pin now includes `activation.presence-hint`.

Dropped / unfinished:
- **Optional `settings.onboarding` entry — deliberately dropped.** Its own ticket text authorises
  dropping it "without ceremony if the seam does not verify at integration". The seam catalog
  (`docs/research/dsh-plugin-ui-patterns.md:74`, seams Finding 5) lists `settings.onboarding` only as a
  *slot name in the catalog table*; there is no verified registration shape, no offline way to exercise
  it, and adding an entry would mean shipping a client-face registration the offline suite cannot
  validate — against this ticket's "no new seams" constraint. Everything the item would have
  communicated is now covered by the activation presence hint + `docs/surfaces.md`.
- No new seams and no new core state were introduced; the only production changes are one appended
  string constant and one dictionary key pair.
- Noted for ticket 33: **ADR-0010/0011/0012** (design-17 §9) still do not exist on the branch; tickets
  27/30/31 each flagged this forward. Ticket 33 should either file them or amend the design.

### 2026-09-17 — session handover (implementation landed, verification PENDING)

The implementation is committed in the worktree at `77baef8` ("Polish dormant/activated composition:
presence hint, locale, surfaces README (ticket 32)"; 7 files, 2 new) and its checkboxes + implementation
comment were checked off on MAIN in `803ea88`. **The session wrapped up before any independent
verification pass: this ticket is implemented but unverified, not verified. `Status:` is deliberately
unchanged.** A fresh session must run a read-only verification pass at `77baef8` before treating it as
done — specifically:

- **Presence hint:** `ACTIVATION_PRESENCE_HINT` (`src/adapter/activation-command.ts`) is appended
  exactly once to `DISPATCHER_START_SUCCESS`; the en locale value is identical to the constant (not a
  retyped near-miss); the zh face carries `activation.presence-hint`; both faces stay in lockstep under
  `validateLocaleDictionary` and the scaffold key-set pin. Verify from code and asserted tests, not from
  the implementation comment.
- **Dormant-registration matrix:** the extended flag matrix genuinely shows nothing new visible from
  tickets 27–31 — dormant boot registers exactly the two commands, zero tools, only the pre-existing
  passive listeners, zero roster publishes, zero prompts, zero restart notices — and it would fail if a
  new dormant registration were introduced.
- **Deactivation → reactivation flow:** tested end-to-end with fakes (stale-window boundary exactly at
  the window and one ms beyond; a deliberate re-activation publishing a newer snapshot that includes the
  durable-rebuild-restored row; the restart notice staying silent on the second activation).
- **`docs/surfaces.md`:** exists (present at `77baef8`), is clean-room, and its claimed absences actually
  match design-17 §5 `revisit-before-merge` conflicts 2/3 (no todo board — `todoId` is linkage metadata;
  no milestone UI).
- **No new seams / no new core state:** the production diff at `77baef8` is only the appended copy
  constant plus one locale key pair (and an export) — no client-face registration, no core-state change.
- **Optional `settings.onboarding` item: deliberately dropped** — confirm the drop reasoning holds
  against the seam catalog (no verified offline registration shape; shipping it would violate the "no new
  seams" constraint) and that its intent is covered by the presence hint + `docs/surfaces.md`.

Until that pass completes, the claimed `npm test` **612 pass / 0 fail / 162 suites** at `77baef8` and
every tick above stand as unverified implementation claims (the newest count in the epic that no
independent run has reproduced; ticket 28's verifier reproduced 599 / 0 / 158 at `6874cf2`).

Also for the verifier to check while reading this comment: it says tickets 27/30/31 each flagged the
missing ADRs forward, but in the ticket files only ticket 31 mentions `ADR-0012` (and this ticket
mentions the set); tickets 27 and 30 do not mention `ADR-0010`/`ADR-0011`. Ticket 33 still owns resolving
them.

2026-09-18 — **Considered passed (human deferral).** The independent verification pass at `77baef8` (612/0/162, typecheck/build/locale) has **not** been run; all counts remain implementation claims. For continuation-of-work purposes only, this ticket is **considered passed** so the epic may proceed. The human deferred the verification run until the client UI surfaces are complete and will verify in one consolidated pass. Ticket 33 (closeout) still owns reproducing the gates before merge.

### 2026-09-18 — live presence observed (re-pass #2): dormant composition GREEN in a real browser; activated composition + footer flag blocked (tickets 44-defect-2 / 45)

Live smoke for this ticket's composition surfaces, from the ticket-44 re-pass #2 (`C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\`): on a real `multitask`-profile boot the capsule renders the dormant experience exactly as composed — collapsed chip (`data-expanded="false"`, `data-dot="dormant"`), expand → activation pitch + single start affordance, roster sections and deliverables line absent, footer copy-only Settings hint with the flag segment honestly `unknown` (`shots/01–03`, `07`; zh face rendered under the zh UI). The activated composition could not be exercised live: activation IS real host-side (RPC A/B matched; policy injected), but the client roster/flag watch never fires (capsule stays dormant even with a roster document present in the namespace — ticket 44 re-pass comment, defect 2) and ticket 45's tool-schema defect prevents any worker state from existing. Activation presence hint itself is confirmed shipped in the start success copy (matched command result text). No checkboxes moved here.
