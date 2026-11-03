# 177 — A different sidebar icon for each dispatcher class

**Status:** resolved
**Type:** task
**Labels:** ready-for-agent
**Blocked by:** nothing.
**Origin:** owner-directed, 2026-11-03. The owner asked for a different icon for the two dispatcher classes: one the user started, one another dispatcher summoned.
**Related:** ticket 173 (the two policy classes; its "Known limitation" is fixed here), ADR-0032 (a summoned dispatcher is a top-level session — untouched), ADR-0024 (one additive seat: the sidebar leading cell), ADR-0027 (`sessionKind` is the dispatcher identity source), ticket 123 / 146 (the glyph and its bot portrait), ticket 147 (the resume seam that reads the same projection), ticket 158 (a recorded generation defect at the same resume seam — **not** touched here).

## Problem

Both dispatcher classes render the same sidebar glyph. Ticket 173 split the two classes' **instructions** (chief of staff vs team leader) but nothing on screen says which class a row is. The owner wants the row to say it.

## The three questions, answered

### 1. Where the glyph comes from

Two halves, and only one of them is ours:

- **The projection (ours).** `src/adapter/session-kind-projection.ts` folds each session's own log for the `/dsh-bot` `command/run` + `command/done` pair and publishes one wire value under the key `sessionKind`: `"dispatcher"`, or `null`. A session no log can identify is settled from the adapter's durable `dispatcher_sessions` mark through the late-bound probe (`dispatcherMarkAnswer`).
- **The rendering (stock dsh, ours via one seat).** The stock sidebar reads `projectionValues.sessionKind` off each session row and mounts the `sidebar.session.row.leading` list cell. Our single entry there (`src/client/index.ts`, id `multitask-dispatcher-kind`, order 20) is `createSessionKindGlyph("dispatcher", t)`, which calls `resolveSessionKind` (`src/client/session-kind.tsx`) and draws the inline-SVG bot portrait when the value is `"dispatcher"`.

So today the projection carries **one** value for both classes: it answers "is this a dispatcher", never "which class". The projection needs a second value. The client already reads a free-form string and fails closed on anything it does not recognize, so a second value is additive on the wire.

### 2. Is "summoned" durably knowable — and why the ticket-173 fallback happened

Yes, and it already was; the bug was that nothing read it back.

- Every row in the durable `dispatcher_sessions` table came from a spawn. `writeDispatcherMark` has exactly one caller, `spawnDispatcher` (`src/adapter/cordis-dsh-host.ts`), and `parseDispatcherMark` rejects `generation: 1` on purpose, because a user-started dispatcher never carries a row. So **a mark row's existence is the durable "spawned" fact.** No new field is needed; adding `origin: "spawned"` to a table that can only ever hold spawned rows would be a constant, not information.
- Why ticket 173 saw a fallback anyway: since ADR-0032 a summoned dispatcher is a **top-level** session, so on a cold resume it enters the host's parentless branch and reaches `resumeUserStartedDispatcher`, not `resumeMarkedDispatcher`. That path only asked "is this a dispatcher?" and then called `lifecycle.activate(agent)` with no origin, so `parent-agent.ts` defaulted to `"user"`. The class was never read, not never written.

The fix therefore has two halves, both required:

- **Record the class in the projection's own durable state** (`dispatcherClass`, settled from the mark probe), so a restart's cached row already knows it.
- **Read it at the resume seam** and pass it into `lifecycle.activate`, so the policy class comes back too. This is also ticket 173's recorded limitation, closed here.

`stateVersion` stays **1**. A bump would discard every cached row, including every user-started dispatcher's `active: true`, which is exactly the regression ticket 140's review rejected. Recorded residual instead: a cache row written *before* this change carries `active: true` with no class, so it reads as the chief-of-staff class until that session's log is refolded from scratch. No data is lost and no row lies; the class is simply derived again at the next full fold.

### 3. Which icon

The client supports no image-asset pipeline at all: the marks are inline SVG authored in `src/client/session-kind.tsx`, painted with `currentColor` and `--dsw-alias-*` tokens, animated by CSS keyframes emitted from the component. Adding a raster or an icon pack would be new machinery for no gain.

Chosen: keep the seat, the entry, the registration and the motion, and draw a **second portrait** — the same 16×16 grid, different silhouette.

| Class | Wire value | Portrait |
|---|---|---|
| User-started (chief of staff) | `dispatcher` (unchanged) | Round-eared head, single antenna stem + tip, round eyes (shipped) |
| Summoned (team leader) | `dispatcher-team-leader` | Blockier head, a flat top bar instead of the antenna, square eyes, two-tick mouth |

Both keep the same two animations (`bob`, `blink`) and the same reduced-motion override, so the existing CSS pins hold with no new keyframes and no raw colour. The wrapper stays `role="img"` with a localized `title` / `aria-label`, and now carries `data-session-kind="dispatcher"` or `"team-leader"` so the two are testable and styleable apart.

The wire value keeps the `dispatcher` stem on purpose: an older client bundle that compares `=== "dispatcher"` still fails closed (renders nothing) instead of drawing the wrong class.

## What to change

Implemented as follows (one line per file). The list below is what was specified; the "Files changed" comment records what actually landed.

- `src/adapter/session-kind-projection.ts` — second wire value `TEAM_LEADER_SESSION_KIND = "dispatcher-team-leader"`; `dispatcherClass` on the projection state, settled to `"spawned"` by a `"dispatcher"` mark answer and to `"user"` by a `"dsh-bot"` success; `viewSessionKind` returns per class; parse + wire schema accept both; `sessionKindOf` returns the class-carrying kind.
- `src/adapter/cordis-dsh-host.ts` — the parentless resume path reads the class and passes it to the resume hook.
- `src/plugin.ts` — supplies the class-carrying kind (and the class probe) to the host; `onUserDispatcherResumed` activates with the durable origin.
- `src/client/session-kind.tsx` — `team-leader` kind, resolution, `TeamLeaderPortrait`, per-class label, shared motion classes.
- `src/client/index.ts` — the one cell renders either class (still one registration).
- `src/client/overlay.ts` — `indicator.team-leader` in EN and ZH.
- `docs/surfaces.md` — the glyph row's one-line description.

## Requirements

- **R1** The projection publishes two distinct kinds: `"dispatcher"` for a user-started dispatcher, `"dispatcher-team-leader"` for a summoned one; `null` stays the not-a-dispatcher answer.
- **R2** The class is durable, not in-memory: it is recorded in the projection state (the host checkpoints it) and re-derived from the durable `dispatcher_sessions` mark when a cell is built from scratch.
- **R3** A cold-resumed summoned dispatcher comes back with its **team-leader** class — both the sidebar icon and the policy text — not the chief-of-staff fallback ticket 173 recorded.
- **R4** One seat, one registration: ADR-0024's rider still licenses exactly the `sidebar.session.row.leading` entry. No new slot, no new asset pipeline, no new event.
- **R5** ADR-0032 stands: the summoned class stays a top-level session. No parent, no `origin: "subagent"`, no delegation depth.
- **R6** EN and ZH locale strings move together; the dictionary key sets stay identical.
- **R7** Offline tests only — no network, no LLM, no live dsh run.

## Acceptance criteria

- [x] `resolveSessionKind` maps both wire values and still fails closed on anything else.
- [x] The team-leader row draws a visually distinct portrait (different geometry), a distinct `data-session-kind`, and a localized label; the chief-of-staff row is unchanged.
- [x] The stylesheet still has exactly two keyframes, a reduced-motion override covering both animated parts, and no raw colour literals.
- [x] `indicator.team-leader` exists in both faces and the scaffold key-list pin includes it.
- [x] A spawned session projects `"dispatcher-team-leader"`; a `/dsh-bot` session projects `"dispatcher"`.
- [x] A cold-resumed summoned dispatcher is activated with origin `"spawned"` (team-leader policy), and a cold-resumed user chat with `"user"`.
- [x] `npx tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.client.json --noEmit` exit 0 (`npm run typecheck` exit 0).
- [ ] `npm test` fully green — **blocked by ticket 174's in-flight deletions**, see the last Comment. The 22 remaining failures all trace to `request_access` / access-prompt / resolve-command removals that this ticket did not make; every suite this ticket touched is green.

## Notes

**Investigation, 2026-11-03 (both questions above are the record).** Three facts decided the shape:

1. `writeDispatcherMark` has one caller and `parseDispatcherMark` rejects generation 1, so a mark row can only describe a spawned dispatcher. That is why no new column was added.
2. The ticket-173 fallback was a **read** gap at the resume seam, not a write gap. `onUserDispatcherResumed` had no origin argument.
3. The projection state is the one durable channel both the client glyph and the host resume path already read, so the class rides it instead of a new projection key (ADR-0031's rejected option 2 stands rejected).

**`stateVersion` stays 1.** The bump rule exists so rows an older unit wrote are not forward-applied into garbage. Here they are not: `dispatcherClass` is optional and additive, and every row that lacks it is one written by a unit that could not have known the class — it reads as the class the user-started path has always produced. The alternative (a bump) discards every cached `active: true`, which is the ticket-140 review regression. The residual — a pre-change summoned row showing the chief-of-staff icon until refold — is recorded rather than hidden.

**Not touched, deliberately:** the generation read-back defect recorded in ticket 158's comment (same seam, different fact). This ticket passes only the class.

## Comments

**2026-11-03 — filed before implementing**, unlike tickets 172/173/174 which recorded the reverse. Investigation first, then the ticket, then the change.

**2026-11-03 — renumbered from 175 to 177.** While this ticket was being worked, a concurrent pass created tickets 175 (`class-split-wake-and-standing-blocks`) and 176 (`spawned-dispatcher-cannot-summon`). The number collided, so this file moved to 177 and every comment in the changed source was renumbered with it. The other two tickets are unrelated in scope but touch one shared line: ticket 176 asks "is this session the spawned class?" and answers it from `dispatcherClassBySession`, while this ticket answers the same question from the durable projection. Both are wired at the same two hooks (`onDispatcherSpawned`, `onUserDispatcherResumed`) and agree, because both read the class the spawn/resume path was handed. Neither depends on the other.

**2026-11-03 — ticket 173's limitation is closed, and its pins were rewritten by the concurrent pass.** `test/spawn-dispatcher-activation.test.ts` used to assert the cold-resume fallback to "chief of staff" as a known limit. That assertion now asserts the opposite: a cold-resumed summoned dispatcher comes back with the team-leader text. The rewrite landed under the ticket-176 edit; the behaviour it now pins comes from this ticket's `dispatcherClassOf` seam (and ticket 176 is what needed the class at resume time in the first place).

**2026-11-03 — one pre-existing failure in this area is NOT this ticket's.** `test/spawn-dispatcher-activation.test.ts` "spawns through the host seam and activates the child without the top-level gate" fails on `ctx.globalToolNames() === ["request_access"]`. `request_access` no longer exists: ticket 174 (in flight, uncommitted) deleted it from `src/` and has not yet updated this assertion. Confirmed by `grep -c request_access src/plugin.ts` → 0 and by the four deleted source files in `git status`.

**2026-11-03 — test record.** The smallest failing-then-passing set, run together:

| Suite | Result |
|---|---|
| `test/session-kind-projection.test.ts` | 21 pass, 0 fail (13 new in the ticket-177 block) |
| `test/client-session-kind.test.ts` | 27 pass, 0 fail (4 new in the two-class block) |
| `test/spawned-dispatcher-kind.test.ts` | 6 pass, 0 fail (3 pins moved to the class-carrying value) |
| **these three together** | **54 pass, 0 fail** |

`npm test` once: **716 tests, 694 pass, 22 fail**. All 22 trace to ticket 174's in-flight deletions, none to this ticket:

- module-not-found on deleted files (`worker-access-tool`, `access-types`, `resolve-command`) — `tool-schema-shape`, `composition-polish`, `feature-flag`;
- missing exports (`DISPATCHER_RESOLVE_COMMAND`) — `restart-honesty`, `client-command-transport`, `multi-dispatcher`, `steer-command`;
- `request_access` gone from the global tool layer — `spawn-dispatcher-activation`, `dispatcher-resume-reactivation`, `ticket-118`/`ticket-145`/`ticket-147` blocks;
- the `approval` liveness status removed — `policy-peer-roster`;
- the access settings keys and roster copy removed — `client-face-scaffold`, `settings-card-*`, `panel`, `theme-tokens`, `coexistence`, `ticket-116`.

`npm run typecheck`: **exit 0** (vendor build + both tsconfigs). `node tools/doc-lint.mjs`: **0 findings across 6 rules**. `npm run build:client`: bundle rewritten, `dispatcher-team-leader` present in `client/index.js`.

## Files changed

| File | Change |
|---|---|
| `src/adapter/session-kind-projection.ts` | Second wire value `TEAM_LEADER_SESSION_KIND`; optional `dispatcherClass` on the state; a `"dispatcher"` mark answer settles `"spawned"`, a successful `/dsh-bot` settles `"user"`; `viewSessionKind` picks per class; both parsers accept the new field/value; new `dispatcherClassOf` reader; `sessionKindOf` narrows back to the identity answer. |
| `src/adapter/cordis-dsh-host.ts` | New optional `dispatcherClassOf` option; `onUserDispatcherResumed` gains an `origin` argument; `resumeUserStartedDispatcher` reads the class; new module-level `readDispatcherClass` guard. |
| `src/plugin.ts` | Wires `dispatcherClassOf` to the projection registry; passes `origin` into `lifecycle.activate` on resume. |
| `src/adapter/index.ts` | Re-exports `dispatcherClassOf` and `TEAM_LEADER_SESSION_KIND`. |
| `src/client/session-kind.tsx` | `team-leader` kind + `TEAM_LEADER_PROJECTION_VALUE`; `TeamLeaderPortrait`; per-class labels resolved from the rendered class; new `createDispatcherClassGlyph`; `isDispatcherKind` / `DISPATCHER_KINDS`. |
| `src/client/index.ts` | The one sidebar cell now composes `createDispatcherClassGlyph` (still one registration). |
| `src/client/overlay.ts` | `indicator.team-leader` in EN and ZH. |
| `docs/surfaces.md` | Glyph row says one entry marks both classes with different portraits. |
| `test/session-kind-projection.test.ts` | New `ticket 177` block: 13 tests (class settling, wire values, cache round-trip, pre-177 row, `dispatcherClassOf` fail-closed). |
| `test/client-session-kind.test.ts` | 4 new resolution/render tests for the two classes; label-distinctness assertion. |
| `test/spawned-dispatcher-kind.test.ts` | 3 pins moved from `"dispatcher"` to `TEAM_LEADER_SESSION_KIND`, since a mark row means a summon. |
| `test/client-face-scaffold.test.ts` | Locale key list gains `indicator.team-leader`. |
| `client/index.js` | Rebuilt bundle (git-ignored build output). |

### 2026-11-04 — PM closure

Shipped in commit `643a801` on `main`. Full suite green at closure (754 tests, 0 fail),
both tsconfigs clean, `npm run lint:docs` clean.
