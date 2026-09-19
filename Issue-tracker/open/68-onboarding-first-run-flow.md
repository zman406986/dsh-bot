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

- [x] Verify the reference's onboarding beat structure and re-entry rules from the research notes
      (cite file:line; never open the reference tree).
      Evidence: `docs/research/always-on-dispatcher-behavior.md:18` — the guided first-run
      sequence (sign-in, animated intro, computer-readiness demo, background-jobs explainer,
      tools beat, first-agent creation, hand-off), re-entry suppressed once seen OR once the
      user owns ≥1 agent, probe failures fail open; `:87` — the honesty note (reference
      onboarding is account/product-bound; ours is a lightweight flow). Beat table below.
- [x] Map each beat to our reality on dsh (what we can honestly show; where dsh differs).
      Evidence: the beat table (below) and its in-code mirror in `src/client/onboarding.ts`'s
      module header — every reference beat dispositioned honest-counterpart / U-A gap /
      71-dependent capability gap.
- [x] Persistence of "seen": design the suppression state honestly (no invented seams).
      Evidence: the seen record rides OUR settings namespace under the `onboarding` key
      (A5 — delivered by the SAME `ctx.settingsScope` bind the roster watch and the settings
      card own; never a second bind/channel); "≥1 dispatcher session" reads the shell store's
      per-session mirrors (a non-`cleared` `roster.<sessionId>` key — tickets 76/79 keying).
      `src/client/onboarding.ts` + the wiring in `src/client/index.ts`.
- [x] Draft ACs for implementation once the vehicle (67) is decided.
      Evidence: the 2026-09-19 triage brief below (vehicle = ADR-0020); implementation landed
      against it the same day (commit 247b33d).

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

### 2026-09-19 — agent (implemented; commit 247b33d — offline ACs closed, AC 5 stays open for the 45/33 lane)

**Beat table (AC 1).** Every beat of the reference's first-run sequence
(`docs/research/always-on-dispatcher-behavior.md:18`; honesty note `:87`) dispositioned —
mirrored in code as the module-header table in `src/client/onboarding.ts`:

| Reference beat (cite) | Disposition | Our reality |
|---|---|---|
| Sign-in (`:18`) | **U-A gap** (ADR-0018 exception 12) | No privacy/account gates; recorded, never invented — no beat exists |
| Animated "meet your agents" intro (`:18`) | Honest counterpart | `intro` beat — static (no animation: the shell CSS discipline), adapted copy (B9) |
| Computer-readiness demo (`:18`) | **71-dependent capability gap** | Remote computer/desktop area is ticket 71's gate; recorded until it resolves — no beat exists |
| Background-jobs explainer (`:18`) | Honest counterpart, narrowed | `background` beat — our wake model is single-kind (ADR-0018 C15): only dispatched workers, stated plainly |
| Tools beat (`:18`) | Honest counterpart | `tools` beat — workers act through tools under the user's approvals; the dispatcher asks first |
| Creating the first agent (`:18`) | Honest counterpart, user-driven only (**U-G**) | `first` beat — create a chat and ask it to start dispatching; no auto-create, no runtime agent management |
| Hand-off into the shell (`:18`) | Honest counterpart | `handoff` beat — hands off to OUR shell frame's sidebar/panes |
| Re-entry suppression: seen OR owns ≥1 agent (`:18`) | Honest counterpart | Seen record OR ≥1 non-`cleared` dispatcher mirror (below) ⇒ suppressed |
| Probe failures fail open (`:18`) | Honest counterpart | Corrupt/unreadable suppression record ⇒ SHOW the flow; never silently hide |

**AC 2 (suppression) — done, offline-pinned.** `src/client/onboarding.ts`:
`isOnboardingSeenRecord` accepts ONLY a well-formed `{seen: true}` record (extra
bookkeeping fields tolerated); every corrupt/unreadable shape — string, number, array,
`{seen:"yes"}`, absent — reads as NOT seen (**fail-open**, the deliberate inverse of
ticket 79's data mirrors, which fail closed: here the risk is stranding first-run, not
wrong data). `isOnboardingSuppressed(seenValue, mirrors)`: suppressed iff a well-formed
seen record stands OR ≥1 shell-store mirror is non-`cleared` (a live snapshot, or a
corrupt `roster.<sessionId>` payload whose key still proves the session is ours —
tickets 76/79 keying). Persistence: the record rides OUR settings namespace under the
`onboarding` key, read and written through the ONE existing `ctx.settingsScope` bind
(A5; no second store, no second channel). Round-trip + fail-open pinned in
`test/client-onboarding.test.ts` ("seen record — parse + fail-open", "suppression
decision", "store — seen-flag lifecycle": 11 corrupt shapes, mirror-kind matrix,
`applyDocument` feed + explicit `undefined` reset on an unavailable namespace).

**AC 3 (in-shell surface) — done, offline-pinned.** `src/client/onboarding-pane.tsx`:
a beat-walk pane (title, body, step count, progress dots, Skip, Next/Get-started) hosted
by the shell's no-selection main seat via the new `ShellHosts.onboarding` seat
(`src/client/shell.tsx`) — IN-SHELL by construction, never the staging-only shipped
`settings.onboarding` slot, so it survives the ticket-78 cutover. Render states are the
pure `describeOnboardingPane` view model: beats / settled (settled = suppressed or done;
the settled state renders the shell's own `shell.noselection` copy — one vocabulary —
plus the one honest save-failed line when the flag write did not land; retry-less, U-A).
Seen write: `writeOnboardingSeenRecord` through the wired scope, silent on success (the
watch re-delivers and suppression closes the pane — no fake success), `markSaveFailed`
on a missing/rejected write (flow shows again next launch — fail-open). CSS token-only
(no hex/rgb/hsl, evidenced `--dsw-alias-*` allowlist, `multitask-dispatcher-`
namespacing, no animation); copy `shell.onboard.*` en+zh, new/adapted only (B9), pinned
retry-less/push-less and free of invented account/sign-in beats. Composition
(`src/client/index.ts`): the existing settings watch feeds `applyDocument` per accepted
document (explicit `undefined` on unavailable — fail-open reset) and hands the seen
write; `mountShellPage(ctx, wiring)` hosts the seat only when wired (bare mounts keep
the old no-selection copy).

**AC 4 — done.** `npm test` 986 pass / 0 fail (244 suites; +40 tests over ticket 80's
946, including the scaffold key-set pin extended with the 15 `shell.onboard.*` keys);
`npm run typecheck` clean (both configs); `npm run build:client` green
(client\index.js, 156886 bytes). No AC requires a live LLM.

**AC 5 — OPEN, deliberately unticked (live-only, 45/33 lane).** First-run visual pass in
a real browser — post-cutover (the flow renders on the staging `main` page today, in the
`root` frame after; the seat itself is cutover-invariant). 2026-09-19: left open per the
triage brief; not resolvable offline.

### 2026-09-19 — live pass 3: AC 5 still open — the cutover aborts the client before any UI renders (ticket 85)

The pass booted HEAD `c437ee8` (onboarding code included) against a real `multitask`
profile, but the 78 cutover's no-priority `root` registration throws on the real host and
the whole loader entry fails: the page shows the host's fail-loud screen — no shell, no
no-selection seat, no onboarding pane, and no settings surface to walk
(`C:\Users\TZhen\Desktop\dsh-live-pass3-2026-09-19\`, `shots/01-boot-blank-or-not.png`).
Zero LLM traffic. AC 5 remains with the live lane once 85 lands.

**Hazards for the live-pass / cutover agents:**
- The `onboarding` seen key is an extra-schema field written CLIENT-side through
  `scope.set` (the roster mirror keys are written host-side). If the live Host rejects
  unknown fields on `set`, the write fails and the pane shows the honest save-failed
  line — fail-open (flow re-shows next launch), never stranding. Verify the write lands
  in the live document during the pass; if the Host refuses extra-schema client writes,
  the fallback is a host-side `onboarding` field in `src/adapter/settings-section.ts`'s
  schema with the client still writing through the same scope (one line of schema).
- "≥1 dispatcher session" suppression uses the persisted `roster.<sessionId>` keys;
  plugin unload/HMR clears them (`clearAllSessions`) — suppression then rides the seen
  flag alone. Expected, but check on the live pass that a seen flag survives an HMR swap.
- The pane renders in the no-selection state only; a user who selects a session mid-flow
  leaves the flow open at the same beat (state, not persistence — by design, no
  step-persistence beyond the seen flag).
