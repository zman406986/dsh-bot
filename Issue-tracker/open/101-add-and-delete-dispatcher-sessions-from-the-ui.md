# 101 — Add and delete dispatcher sessions from the UI (ADR-0021; U-G amended for dispatcher sessions)

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** 99 (the add/delete affordances live in the re-based UI posture)
**Related:** ADR-0021 (decision 3 — the add/delete ruling), ADR-0019 (per-session keying carries), ADR-0018 exception U-G (amended for dispatcher sessions ONLY), 68 (resolved — no-runtime-management scoping re-based), 98 (deferred), 89 (resolved — the client start affordance died with the capsule)

## Problem

There is NO add/delete path for dispatcher sessions. The only create path is the host slash command `/dispatcher-start` (`src/adapter/activation-command.ts` → lifecycle `activate`); deactivation fires ONLY on host `agent/disposed` or plugin unbind (`src/adapter/parent-agent.ts` — `deactivateSession` is private, driven by the dispose listener). There is no `/dispatcher-stop` and no UI affordance either way — the client's one start affordance was deleted with the capsule (resolved ticket 89). ADR-0021: dispatcher sessions can be added and deleted from our UI (the human's "add new or delete existing dispatcher bots" = activated dispatcher sessions).

## What to do

- [ ] Adapter: a `/dispatcher-stop` host command. Pattern: `src/adapter/activation-command.ts` `DISPATCHER_START_COMMAND` → a lifecycle deactivate path — verify the exact deactivate entry the host dispose path uses (`deactivateSession` in `src/adapter/parent-agent.ts`) and expose it to the command. Refuse honestly when the invoking chat is not an activated dispatcher; success copy states what deactivate means (binding off, chat untouched).
- [ ] Roster mirror cleared on deactivate: `SettingsRosterChannel.clearSession` exists (`src/adapter/roster-channel.ts`) — wire the command's deactivate path through the same `onDeactivated` handling the host dispose path uses, so tools unregister, access-policy rows clear, outstanding prompts abandon, and the mirror clears for THAT session only (ADR-0019 per-session keying).
- [ ] Client: an ADD affordance (activate a dispatcher in a session), reachable per the client command path — `ctx.remote.commands.execute(sessionId, line, attachments)` (`src/client/context.ts`), the pattern `/dispatcher-start` rides today. If creating a BRAND-NEW dsh chat is not client-reachable, surface honest guidance (how to create the chat in dsh) + activation of an existing session, and record that limitation in this ticket rather than faking it.
- [ ] Client: a DELETE affordance that calls `/dispatcher-stop` under the conservative semantics of ADR-0021 decision 3 — deactivate the dispatcher binding (tools unbound, roster mirror cleared); NEVER dispose the dsh chat itself (chat disposal stays a dsh-native action).
- [ ] Offline tests for the command (activate/deactivate round-trip over the fakes, per-session isolation) + the UI store (affordance states, honest degrade).

## Constraints

- **U-G amendment scope: dispatcher sessions ONLY.** Worker runtime management stays excluded — no worker create/delete/manage tools; resolved ticket 68's no-runtime-management scoping is re-based to this boundary by ADR-0021, not erased.
- Delete never disposes the dsh chat; deactivation is reversible (the chat can re-activate with `/dispatcher-start`).
- ADR-0019 per-session keying carries: a deactivate touches only that session — a sibling dispatcher session is untouched.
- Honest copy everywhere; no invented seams; no live testing in this pass (ADR-0015 / ticket-33 convention — live confirmation is a later live lane).

## Comments

### 2026-09-20 — team-leader session

Filed with ADR-0021. Vocabulary: the human's "dispatcher bot(s)" maps to the glossary term "activated dispatcher session"; the avoid-word "bot" is not reintroduced in repo prose outside verbatim quotes. Multi-dispatcher identity — the undecided halves of cancelled tickets 50/51 — becomes live through these affordances: each activated dispatcher session is individually addable and deletable, and ADR-0019's per-session keying (resolved ticket 76) is the data path that makes per-session add/delete safe. Deferred ticket 98's gap (1) note: with the root frame retired by ticket 99, host approval asks should answer natively in the stock UI — unaffected by this ticket, tracked on 98.
