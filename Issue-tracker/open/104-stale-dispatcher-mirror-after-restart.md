# 104 — Stale dispatcher mirror after restart: a deactivated session still renders as a killable dispatcher row

**Status:** open
**Labels:** needs-triage
**Related:** 102 (resolved — the same "visible but inert" family, in the summon/kill direction), ADR-0010 (mirror honesty — the presence/mirror posture this finding tests), ADR-0021 (the floating window and the add/delete ruling)

## Problem

Observed live, 2026-09-21, in the overnight ticket-102/103 lane (one lane, one host restart): after a host restart, a session whose dispatcher binding was **no longer live** still rendered in the floating window's roster as a dispatcher row — carrying the unavailable-status rendering (`状态不可用`) — and the host **refused** `/dispatcher-stop` on it with `kind:"error"` and the message "This chat is not an activated dispatcher session — nothing to deactivate. Run /dispatcher-start in a chat first to activate one."

Evidence (in-repo, git-ignored under `.scratch/testing/2026-09-21-live-102-103/live-inject-fix/`):

- `obs-c3-execute-response.json` — the host's refusal: `POST /api/commands/execute` `/dispatcher-stop` returns HTTP 200 whose body carries `kind:"error"` with the message above, while the same measurement records `rowDispatcherAfter: "true"` (the row still renders as a dispatcher).
- `obs-stale-flag-explain.json` — the lane's explanation: `renderedRows` lists the target `session-650bc552…` with `dispatcher: "true"` and text `dsh-bot状态不可用`, alongside ten other rows all `dispatcher: "false"`.
- The lane's README residue entry: `.scratch/testing/2026-09-21-live-102-103/live-inject-fix/README.md` §Residue item 2 (and §Observation C / §Deviations item 2) — "The stale persisted `dispatcher=true` mirror (a deactivated session renders as a dispatcher row after a restart, with `状态不可用`) was observed but is a separate concern from the transport fix; not filed."

**Actual behaviour (observation).** The row's `data-dispatcher` comes from a **mirror of persisted settings** that survives a restart. The mirror is honest about what was last WRITTEN into it, not about what is LIVE now — so after a restart it can present a deactivated session as a dispatcher.

**Expected.** Either the roster should not present a deactivated session as a dispatcher row after a restart, or the affordance should not be offered where the host will refuse the command — at minimum, the stale row should not look killable.

**Why it matters.** This reproduces the class of complaint that produced ticket 102 — a control that is visible but cannot do anything — now in the **kill** direction, on a freshly restarted app. A user who drags the floating window open and clicks delete on such a row gets a two-press confirmation, a wire request, and an error the UI does not surface as a refusal of that control.

**Evidential weakness (stated deliberately).** This was observed **once** (one lane, one host restart, one target session). The mechanism is **attributed, not proven**: the lane's own words are "Guessed, not proven: the exact reason `session-650bc552` kept a stale `dispatcher=true` (attributed to the persisted settings mirror from `shell-mirror-feed.ts`; the host's own 'not an activated dispatcher' error is the direct evidence, the mirror mechanism is the read-code corroboration)." Do not treat the mirror attribution as established — establish it in the diagnose step.

## What to do

- [ ] Reproduce it live first (read `read-before-running-live-and-browser-tests.md` before anything live; kill timers mandatory at launch; send only trivial tasks; testing artifacts under `.scratch/testing/<yyyy-mm-dd>-<slug>/`, created before the session starts — never on the Desktop): activate a dispatcher in a throwaway chat, restart the host, and confirm whether the row still renders as a dispatcher (with `状态不可用`) and whether the host refuses `/dispatcher-stop` on it. Record the roster `data-dispatcher` state on both sides of the restart. Diagnose-first, in the same spirit as ticket 102 — the explanation must come before any fix is selected.
- [ ] Establish whether the **persisted setting** is the right source of truth for the row's dispatcher flag, versus the **live binding**. Cite the read path (the roster mirror feed and the settings namespace backing it) and state which surface is authoritative for the row's `data-dispatcher` after a restart.
- [ ] Decide whether the fix is **display-honesty** (do not present a non-live session as a dispatcher row / do not offer the affordance where the host will refuse), **mirror authority** (make the persisted source agree with live binding state across a restart), or **both**.
- [ ] Pin the outcome offline in the existing rendered suites (`test/client-floating-window.test.ts`, `test/client-session-management.test.ts`): the rendered roster state and the affordance-gating rule, as source-text and/or rendered pins in the established style.
- [ ] If the answer is a change to mirror authority semantics, that is a design decision touching the recorded honesty posture (`ADR-0010`) — propose an ADR first and do not implement until signed (the authority stack puts accepted ADRs above this ticket).

## Constraints

- No optimistic flips: the mirrors remain the truth (ADR-0010 honesty; honest mirror lag allowed) — the fix must not introduce local guessing about liveness.
- ONE command transport (`ctx.remote.commands.execute(sessionId, line, [])`).
- No new host seams, no invented push channels.
- The U-G boundary stands: no worker create/delete/manage affordances appear through this work (no worker affordances in the client).
- Token-only CSS if any styling changes; `multitask-dispatcher-` class discipline.
- Any new user-visible copy lands in BOTH locales (en+zh lockstep).

## Comments

### 2026-09-21 — trace session

Filed from the ticket-102/103 overnight live work, out of the ticket-102 lane's own residue (`.scratch/testing/2026-09-21-live-102-103/live-inject-fix/README.md` §Residue item 2). The finding surfaced while the lane was establishing the kill transport (ticket 102's cause 2): its target row was not live, and the host's honest refusal is what exposed the stale flag. It was **deliberately NOT folded into ticket 102's closure** — 102 is the transport/discoverability repair, and this is a separate display/honesty concern. It was observed only once (one lane, one restart) and its mechanism is **attributed but not proven** (persisted `roster.<sessionId>` settings mirror through `shell-mirror-feed.ts`); the direct evidence is the host's own "not an activated dispatcher" error, and the mirror is a read-code attribution. Labelled `needs-triage`: the right fix is a design call (display-honesty vs. mirror authority vs. both), not an immediate implementation, and the mirror-authority branch would need an ADR against ADR-0010 before any code moves.