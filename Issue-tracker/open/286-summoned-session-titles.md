# 286 — Summoned team-leader sessions show “Untitled” in the sidebar

**Status:** open
**Labels:** ready-for-human
**Blocked by:** nothing. The adapter change and its offline tests are normal agent work; the manual Web check needs a plugin build and a dsh restart, so it is left staged for a human.
**Related:** `.scratch/auto-title/PLAN.md` (the plan and its evidence index), ticket 285 (plan 1, merged at `2e2e551`), ticket 159 (recorded that the spawn title was never persisted), ADR-0032 (a summoned dispatcher is a top-level session), ADR-0027 decisions 2–3 (`subagent.label` is the worker label).

**Decision (2026-11-08): route 2 — the adapter renames the summoned session with the dispatcher's team title at spawn through the host's native title service; no model-generated wording; the title is pinned; workers are not renamed.**

## Problem

`spawn_dispatcher` requires a human title, and the host carries it as the peer-roster label, but nothing writes the session's stored title. The sidebar therefore renders the stock localized “Untitled” label for every summoned team leader.

The host's title service cannot fill the gap on its own: its automatic path accepts only `user/message` events whose `source.kind` is exactly `"user"`, and the summoned session's only first turn is delivered as a plugin wake (`plugin:multitask-dispatcher`). Zero eligible messages means no fallback title, no model title, no `session/title` event. Plan §1–§2 records the full evidence.

## Why route 2

The owner did not answer the plan's §12.1 wording question (“is the dispatcher's team title acceptable, or must the model choose the words?”). The decision taken was route 2 — the in-repo option that needs no dsh change and does not fake message provenance:

- **In-repo.** No dsh change, no session-format change, no new release dependency. Route 3 (a model-written title from the handoff) needs both the title service and the v3→v4 format validator changed upstream (plan Appendix A).
- **No model cost and no latency.** One synchronous in-memory title append; no assistant request, no network.
- **Durable.** It writes the host's normal `session/title` event with source `user`, so the title survives a restart — the current roster label does not (ticket 159).
- **Native precedent.** It is the same public API the host uses for schedule-created sessions, and the same one the sidebar rename action uses. Not a private back door.
- **Immediate.** The title exists before the first turn, so the first sidebar paint already shows it.
- **Route 1 stays rejected.** Faking the handoff as a human message misattributes machine text as human and produces a “Summoning dispatcher session id: …” fallback title (plan §2.4).

## What it does

After `ctx.agents.create` resolves and before the handoff `followup` queues the first turn, the host adapter calls the title service's `rename` on the created session's live session object (not the reserved id string), with the trimmed `spawn_dispatcher` title.

- Skips silently when the title service is absent (minimal/headless profiles keep working), when the title normalizes to empty, or when a title already exists.
- A throwing read or `rename` is caught and warned once under `[multitask-dispatcher]`; naming is bookkeeping and never turns a successful spawn into a refusal or suppresses the first turn.
- The tool row and peer roster keep reading the same title as before; only the sidebar row gains it.
- The user can still rename the row from the sidebar; that native rename overwrites the stored title.

The exact touch list and code shape are plan §4.1–§4.3.

## What the user sees

- The sidebar row for a summoned team leader shows the dispatcher's title (e.g. “Invoice import fix”) instead of “Untitled”.
- The title survives a dsh restart / cold resume.
- The peer roster and the `spawn_dispatcher` tool result are unchanged.
- A user rename wins; no auto-retitle afterwards.

## Limitations (accepted and recorded)

1. **Pinned, user-sourced title — no model auto-generation.** The rename stores source `user`, so the host's model provider never runs for this session later. The title is the dispatcher's words, not a model's; if the owner requires model-chosen words, that is plan Appendix A and a dsh-side change. A later human message does not regenerate the title.
2. **Duplicate titles are allowed.** Two sessions may share a title; there is no conflict error or dedupe. Distinct titles remain the dispatcher's responsibility, as the tool description already asks.
3. **Workers stay label-only.** No session title is written for workers. They are not sidebar rows, `subagent.label` already gives them a durable identity, and the native first-prompt provider excludes subagent-origin sessions.
4. **Rename-after-spawn is not supported.** There is no dispatcher rename tool; the human renames in the sidebar. A tool would need an authorization rule and is a separate ticket (plan §7).
5. **No title service → “Untitled” stays.** The optional service is the capability switch; failure is silent by design.
6. **Provenance is imprecise.** The stored event says a user chose the title even though the dispatcher did. The host already does this for scheduled sessions; recorded, not solved.
7. **No settings toggle.** Unmounting the title service is the off switch.
8. **Owner questions still open:** exact title vs a team-leader marker (§12.3), pin forever vs regenerate on a later human message (§12.4), settings toggle (§12.6), duplicate handling (§12.8), rename tool (§12.9), and confirmation that durable survival is wanted (§12.10).

## Offline test list

From plan §9.1; no network, no model, no live dsh. Tests 1–5, 7 and 8 live in `test/spawn-dispatcher-host.test.ts`; test 6 in `test/adapter-cordis-dsh-host.test.ts`.

1. Names the child from the spawn title, before the first turn: exactly one rename, session id equals the returned dispatcher id, title is the exact spawn title, `followupSeen === false`, first turn still delivered.
2. Does not overwrite an existing title: `get` returns a title → zero renames, spawn still succeeds.
3. Missing title service is harmless: `ctx.get("sessionTitle")` undefined → spawn succeeds, `followup` called, no throw.
4. A throwing `get` or `rename` is harmless: a throwing `get` still renames; a throwing `rename` leaves the spawn successful and the first turn delivered.
5. Empty/whitespace title is skipped (direct host caller; the tool path already refuses it).
6. Worker spawn is not named: zero renames, worker id still returned.
7. Two concurrent summons keep their own titles — no cross-pairing (ticket 159 class).
8. No title service stub at all: the existing spawn tests keep passing, proving the optional path.

Suggested focused commands:

    npx tsx --tsconfig tsconfig.client.json --test test/spawn-dispatcher-host.test.ts test/spawn-dispatcher-tool.test.ts test/multi-dispatcher.test.ts

    npx tsc -p tsconfig.json --noEmit
    npx tsc -p tsconfig.test.json --noEmit

No client build is needed (no client code changes).

## Verification status

- Filed 2026-11-08 as plan step 7; the `DispatcherSpawnOptions.title` comment was updated in the same pass (plan step 4) to state the durable write and that workers are unaffected.
- This docs pass did not run the tests and did not verify the adapter change; the ticket records the decision and the checklist, it does not claim the code or the tests are green.
- The manual Web check (plan §9.3) is **staged, not performed**: it needs `npm run build` and a restart of the dsh profile that hosts the plugin, then the sidebar/restart/rename/CJK-long/worker checks in the existing Web GUI at `http://127.0.0.1:3080` (do not start a second server).
- Label `ready-for-human`: the remaining human-only half is that staged manual Web check plus the owner questions listed above; the code lane itself is ordinary agent work.

## Comments

- 2026-11-08 — Filed as plan step 7. Records route 2, the owner-unanswered wording question, the accepted limitations, and the staged manual Web check. Docs only: this ticket, the `src/core/types.ts` comment, ticket 285's move, open-index regeneration. No tests, no builds, no source behaviour change.
