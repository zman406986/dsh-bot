# DD-089 — Interactive retry/reconnect surfaces vs retry-less honest states
- **Area:** sidebar / roster / agent management (A11)
- **Type:** deliberate-divergence (recorded)
- **Date:** 2026-09-23

## What the reference does
The roster's failure and connection states are interactive and imply a live transport that can be re-driven by the user:

- A loading state presents a connecting status row (role=status) while the roster reaches the host machine (`the reference tree's frontend/src/recovered/features/roster/status.tsx`, the loading branch, ~line 17-26).
- An unreachable state (a message saying the host machine cannot be reached) renders a reassurance body plus an explicit retry button that flips to a non-interactive retrying label while a retry is in flight (`status.tsx` ~lines 37-49; the retry/retrying labels come from a local copy constant).
- A separate reconnecting banner re-states the reconnect attempt with its own retry button, likewise disabled-while-retrying (`the reference tree's frontend/src/recovered/features/roster/reconnect-notice.tsx`, ~lines 9-18).

Together these constitute a connection-lifecycle model: transport phases (connecting / unreachable / reconnecting) with a control the user can press to ask again at each failure point.

## What the current build does
The build renders the same failure cases as honest, non-interactive copy with no recovery control:

- Stale, corrupt (`invalid`), or missing (`channel-missing`) roster mirrors all degrade to a single view outcome — an "unavailable" line keyed `roster.unavailable` — described in the store as never a spinner that hangs; there is no retry prop, no button, no banner anywhere in the mapping (`src/client/roster-store.ts`: `describeRosterPanel` ~lines 409-419, `rosterViewCopyKey` ~lines 265-276, and the module comment ~lines 18-22).
- The sidebar shell follows the same rule: its header comment states failure states are honest copy only (empty / presence-unavailable) and deliberately RETRY-LESS — no retry control, no reconnect banner — citing ADR-0018 U-A, with ticket 82 noting the ADR-0020 row tension (`src/client/shell.tsx` header comment, ~lines 36-38).
- The only refresh-like motion in the store is a silent staleness re-check on a fixed timer (`ROSTER_STALE_RECHECK_MS`) that re-renders the view without new data or any user-facing control (`src/client/roster-store.ts` ~line 65).

## The deviation
The reference makes failure recovery a user action (retry buttons, a reconnect banner, an explicit connecting phase); the build makes it a truthful observation (one non-interactive unavailable/empty copy line, no way to ask the host again, no banner). This is not a gap — it is the recorded U-A exception: the build's roster is a pull-only mirror over a settings-watch feed with no client-initiated reconnect transport, so a retry button would promise an action the architecture does not have.

## Verdict: DO-NOT-INCORPORATE
ADR-0018's exception list explicitly rules out a connection-lifecycle model — no transport state phases, no reconnect banner, and roster failure states among the things not imitated — and the shell's retry-less rule cites that ruling directly (`src/client/shell.tsx` ~lines 36-38). The pull-only, never-poll honesty rule (ticket 27; design-17 §4.8's no-simulated-push rule) is recorded architecture: a retry button implies a way to ask the host again that the build deliberately avoids, and adding one would simulate a capability the settings-mirror transport does not offer. ADR-0020's draft list of re-hosted surfaces acknowledges the tension (ticket 82) but does not reverse U-A, and no human ruling supersedes it. If the human ever wants interactive recovery, that is an explicit-override conversation, not an incorporation.

## Incorporation notes
- **Where it would live:** (nothing to incorporate; if ever overridden) the failure branches of the roster view mapping (`src/client/roster-store.ts`, `describeRosterPanel` / `rosterViewCopyKey`) and the panel/shell renderers that consume those view kinds (`src/client/panel.tsx`, `src/client/shell.tsx`).
- **Constraints:** ADR-0018 U-A (no connection-lifecycle model, no reconnect banner); pull-only honesty — no surface may promise or simulate push or re-query that does not exist (ticket 27, design-17 §4.8); one copy vocabulary (`roster.*` locale keys), never a second; presentation-only rule — the shell never drives transports, so a retry control would need verified host support first.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a button is trivial; the cost is contractual (a new way to ask the host again + a U-A reversal), which is exactly why it stays out.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/roster/status.tsx` loading branch (~lines 17-26) and unreachable branch with retry/retrying actions (~lines 37-49); `the reference tree's frontend/src/recovered/features/roster/reconnect-notice.tsx` banner with retry action (~lines 9-18).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/roster/status.tsx`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/roster/reconnect-notice.tsx`
- Build: `src/client/shell.tsx` (header comment, retry-less rule citing ADR-0018 U-A, ~lines 36-38); `src/client/roster-store.ts` (mapping unavailable state to a view outcome, ~lines 18-22, 265-276, 409-419); `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (item 12, U-A); `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md` (U-A exclusion rows, ticket 82 tension)
