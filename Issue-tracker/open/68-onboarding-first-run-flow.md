# 68 — Onboarding first-run flow (ADR-0018 in-scope area)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none — 67 resolved (ADR-0020); 77 resolved; 78's staging mount landed (the cutover slice stays open but does not gate this ticket: the flow is built in-shell, cutover-proof — see the 2026-09-19 triage comment)
**Related:** ADR-0018 (in scope: "onboarding first-run flow"), `docs/research/always-on-dispatcher-behavior.md` area 1 (first-run sequence), 32 (composition polish — its coherence goal re-bases here)

## Problem

The reference runs a guided first-run sequence (sign-in, an intro beat, computer-readiness demo,
background-jobs explainer, tools beat, first agent creation, hand-off into the shell), with
re-entry suppressed once seen or once the user owns an agent, and probe failures failing open.
Under the old model this was excluded (no dormant/onboarding state); ADR-0018 brings it in scope.

## What to do (research/design ticket)

- [ ] Verify the reference's onboarding beat structure and re-entry rules from the research notes
      (cite file:line; never open the reference tree).
- [ ] Map each beat to our reality on dsh (what we can honestly show; where dsh differs).
- [ ] Persistence of "seen": design the suppression state honestly (no invented seams).
- [ ] Draft ACs for implementation once the vehicle (67) is decided.

## Constraints

- Respect exception U-A (no privacy/account gates, no connection-lifecycle phases) — the
  reference's sign-in/account beats may have no honest counterpart; record the gap rather than
  inventing one.
- New or adapted copy only (AGENTS.md no-verbatim rule).

## Comments

### 2026-09-19 — agent (vehicle hand-off from 67)

The vehicle is decided (draft): **ADR-0020** — the wrapper is our own frame over the shipped
dsh client runtime, staged through a `main` page (tickets 77–78) before surfaces land. Your
dependencies on it: (a) first-run renders *inside our frame* (or the staging page), so beats
that need shell chrome wait for 77/78; (b) the shipped `settings.onboarding` slot is usable
only during the staging stage — once the frame election flips, the settings surface is displaced
and onboarding must be ours; (c) "seen" persistence rides our settings namespace (no second
store, A5). U-A still binds: no sign-in/account beats, no connection phases. Blocked-by line
updated mentally: implementable once 77/78 land and your research ACs are done.

### 2026-09-19 — agent (triage: actionable NOW → ready-for-agent)

Verdict (a). All discharge conditions from the hand-off are met: 77 landed (518030b), 78's
staging mount landed (8fcffad — the keyed `main` page exists, `src/client/shell-mount.ts`
`MAIN_PAGE_SLOT`/`SHELL_PAGE_KEY`), and the research ACs are agent-executable today. The
pending 78 cutover does NOT gate this ticket provided the flow is built as an in-shell
surface (it renders on the staging page now, in the `root` frame after cutover) — the
staging-only shipped `settings.onboarding` slot must not be load-bearing.

**Agent-ready brief**

- **Scope-in:** beat verification from the research note; honest-dsh mapping table; "seen"
  suppression persistence; first-run flow as an in-shell surface; first-agent beat = first
  dispatcher-session creation; fail-open on probe/suppression-read failure (reference rule,
  adapted).
- **Scope-out:** sign-in/account/privacy beats (U-A — record the gap, never invent a
  counterpart); computer-readiness demo beyond a recorded gap until 71's capability gate
  resolves; a second store (A5 — suppression rides our settings namespace); runtime agent
  management (U-G — the first-agent beat is user-driven creation only, `ctx.sessions.create`,
  `wrapper-vehicle-seams.md` Finding 1).
- **Builds on:** `docs/research/always-on-dispatcher-behavior.md:18` (beat list, re-entry
  suppression, probe fail-open), :87 (honesty note: reference onboarding is account/product-
  bound; ours is a lightweight flow); shell store/skeleton `src/client/shell-store.ts` +
  `src/client/shell.tsx` (77); staging page + launcher entry `src/client/shell-mount.ts`
  (78); settings-namespace write/read precedent `src/adapter/roster-channel.ts` +
  `src/client/shell-feed.ts` (79's dual-key pattern).
- **ACs:**
  1. Beat table citing the research note file:line (never the reference tree): every beat
     dispositioned honest-counterpart / U-A gap / 71-dependent capability gap.
  2. Suppression state in the settings namespace: seen-flag OR ≥1 dispatcher session
     exists ⇒ suppressed; offline tests pin the round-trip and fail-open on a corrupt
     or unreadable suppression record.
  3. In-shell first-run surface: renders via the shell (staging page path proven);
     token-only CSS (ticket-49 contract); en+zh copy, new/adapted only (B9).
  4. `npm test` + `npm run typecheck` green; no AC requires a live LLM.
  5. **Live-only, marked for the 45/33 lane (not claimable offline):** first-run visual
     pass in a real browser, post-cutover.
- **Risks:** a fail-closed suppression read would strand first-run — fail-open is the
  reference's rule and is pinned by AC 2; beat copy drift toward reference phrasing (B9).
- **Size:** M.
