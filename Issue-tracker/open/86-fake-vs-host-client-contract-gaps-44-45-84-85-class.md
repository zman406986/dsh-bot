# 86 — Fake-vs-host client contract gaps (the 44/45/84/85 class): a hygiene pass aligning offline fakes with VERIFIED host contracts

**Status:** open
**Labels:** needs-triage
**Blocked by:** none
**Related:** 44, 45, 84, 85 (the four known instances), 33 (live close-out lane), 78 (the cutover that surfaced 85)

## Problem

Four tickets in a row share one root pattern: an offline fake modeled a host
seam GENTLER than the real host, so the 1,000+-test offline gate passed while
the live host aborted a user-visible flow. The offline gate cannot catch
fake-vs-host divergence — today the only detector is a live pass, and each
divergence so far was a boot- or activation-level failure.

## The four known instances

1. **44 (host half, commands):** the fake accepted a `ctx.effect`-registration
   shape the live host never registered — activated dispatcher commands were
   silently absent live. Fixed in-ticket; the fake was taught cordis's
   effect/unload semantics afterwards.
2. **45 (host half, tools):** fake-accepted tool schemas were rejected by the
   real provider — every activated turn failed live.
3. **84 (client half, service reads):** fakes let the composition read
   undeclared service faces bare; the live context proxy throws
   `cannot get property "X" without inject` wherever the read happens — the
   launcher click died live (pass 2). Fakes were taught the guard
   (commit `154e7c7`).
4. **85 (client half, slot registration):** the slots fakes accepted a
   no-priority `root` registration; the shipped single-slot register defaults
   an absent priority to 0 — the shipped AppFrame's own effective value — and
   THROWS on the collision, so the WHOLE loader entry aborted and the client
   showed the fail-loud screen (live pass 3, 2026-09-19). Fakes were taught
   the SlotCore collision rule (cell model: `?? 0` default, same-priority
   throw, ascending "lowest renders" election, per-entry dispose) in the 85
   fix.

## Pass-3 hazard note

Live pass 3 also demonstrated the failure AMPLIFIER: a client-side
registration throw does not degrade one widget — it aborts the entire loader
entry, the failsafe never engages (the entry dies pre-election), and the user
gets the host's "Failed to load plugins" screen instead of the stock app.
Fake-vs-host divergence in registration-adjacent code is therefore a
whole-surface hazard, not a cosmetic one.

## Proposal (the hygiene pass this ticket asks for — NOT executed yet)

A scoped pass that inventories the remaining offline fakes against VERIFIED
host contracts and aligns them, so the next contract divergence fails
offline:

- Enumerate every fake seam in `test/` (client slots/locale/guard, host
  commands/tools/settings/storage) and its verified host source (installed
  tree under `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`, read
  only), noting which fakes still model a shape nobody has verified.
- Align the highest-risk ones first: seams where a host throw/abort kills a
  whole entry or activation (the 84/85 amplifier class) over seams whose
  divergence degrades one widget.
- Prefer teaching the existing fakes the host rule (as 84/85 did) over
  building a shared fake framework — keep per-file fakes, one divergence fix
  per seam.
- Record each alignment with the host citation (file + line) in the fake's
  header comment, so the next divergence is a diff against a cited contract.

## Acceptance criteria

- [x] (offline) an inventory comment/table exists (in this ticket or its
      answer) listing every fake seam → host citation → aligned/not;
      — DONE 2026-09-19: the 24-row table in `## Comments` below (every host
      citation re-read from the installed tree in this pass).
- [x] (offline) each HIGH-risk divergence found by the inventory is either
      aligned in the same pass or spun into its own ready-for-agent ticket;
      — DONE 2026-09-19: the client slot-register class (rows 1-5) is ALIGNED
      in this pass (7 of 7 client slot fakes now run the shipped SlotCore
      rule); the host registry duplicate-throw class (rows 16/17) is spun
      into `Issue-tracker/open/90-host-registry-duplicate-throws-unmodeled-in-fakes.md`
      (`ready-for-agent`). No HIGH row is left un-dispositioned.
- [x] `npm test`, `npm run typecheck`, `npm run build:client` green after the
      pass.
      — DONE 2026-09-19: `npm test` 1049/1049 (257 suites, 0 fail),
      `npm run typecheck` clean both configs, `npm run build:client` green
      (`client/index.js` 161,087 bytes). Exact commands + evidence in the
      closing comment.

## Notes

- Filed by the ticket-85 agent (2026-09-19) as the small tracker add-on of the
  85 fix; the hygiene pass itself is deliberately NOT part of 85.
- The 85 fix already aligned the two slots fakes that drive the `root`
  contract (`test/client-shell-mount.test.ts`, `test/coexistence.test.ts`);
  the scaffold fake (`test/client-face-scaffold.test.ts`) still accepts
  no-priority single-slot registrations and is inventory item #1.

## Comments

- **2026-09-19 (agent, hygiene pass landed)** — AC1 inventory below; AC2:
  the one HIGH class not aligned in this pass is spun into **ticket 90**
  (`Issue-tracker/open/90-host-registry-duplicate-throws-unmodeled-in-fakes.md`);
  AC3 gates re-run green (numbers at the bottom of this comment). Host
  citations were re-read read-only from the installed tree
  (`C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`, 0.1.5-rc.1);
  every citation below was verified in THIS pass (file opened, lines read),
  not copied from a prior comment.

### AC1 — fake seam inventory (seam → host behavior → citation → aligned? → risk)

| # | Fake seam (file:line) | Host behavior it must model | Verified host citation | Aligned? | Risk |
|---|---|---|---|---|---|
| 1 | **Client slot register** — `client-face-scaffold.test.ts:80-243` (fake), new pins at `:616-722` | One global cell per slot name; `priority ?? 0`; same-(priority) registration on the entry's identity axis (single/keyed-by-key/list-by-id) THROWS; entries sorted ascending at insert ("lowest renders") | `dsh-web-frontend/dist/assets/index-BKQ_L1z6.js` minified `SlotCore.register` (`a=t.priority??0`; per-kind `entries.find(...)` + throw; insert `sort((m,g)=>(m.options.priority??0)-(g.options.priority??0))`); winner rule `dsh-client-ui-renderer/lib/types/client/registry.d.ts:156-164` | **ALIGNED this pass** (was: accepted any registration, incl. the pre-85 no-priority `root`) | HIGH → fixed |
| 2 | **Client slot register** — `client-toolviews.test.ts:136-222` (fake) + `:40-134` helper | same rule | same | **ALIGNED this pass** | HIGH → fixed |
| 3 | **Client slot register** — `client-settings-card.test.ts:155-256` (fake) + `:260-344` helper | same rule | same | **ALIGNED this pass** | HIGH → fixed |
| 4 | **Client slot register** — `client-roster-panel.test.ts:142-261` (fake) + `:263-336` helper | same rule | same | **ALIGNED this pass** | HIGH → fixed |
| 5 | **Client slot register** — `client-onboarding.test.ts:686-755` (fake) + `:53-137` helper | same rule | same | **ALIGNED this pass** | HIGH → fixed |
| 6 | **Client slot register** — `client-shell-mount.test.ts:106-262` | same rule; keyed/list message text | same | aligned in 85; **message text corrected this pass** (keyed/list said "already has a registration for key/with id"; host says "already has an entry for key/with id") | LOW → fixed |
| 7 | **Client slot register** — `coexistence.test.ts:425-560` | same rule; keyed/list message text | same | aligned in 85; **message text corrected this pass** (same correction) | LOW → fixed |
| 8 | **Client `slots.inject`** — all 7 client fakes above | Declaration wait: the callback runs only once the parent slot is DECLARED; a wrong slot key means the body never runs (ticket 46's live lesson) | `dsh-client-ui-renderer/lib/client.js:991-1074` (via `docs/research/dsh-plugin-ui-patterns.md:61`) | NOT modeled (fakes invoke the callback unconditionally) — mitigated: every suite pins the slot key as a literal (`client-toolviews.test.ts:268`, `client-settings-card.test.ts:385`, `client-face-scaffold.test.ts:380-426`) | MED (recorded; no ticket — the literal pins cover the failure mode) |
| 9 | **Client service-face guard** — `client-face-scaffold.test.ts:266-320` (`createStrictHostCtx`) | Context proxy throws `cannot get property "X" without inject` on any undeclared service read | cordis `src/reflect.ts:144` (message), `lib/index.js:675` (shipped copy); `src/registry.ts:300-302` (`inject` runs the callback as a child fiber) | ALIGNED in 84 — and it drives the FULL `apply()` (so apply-time reads of `layout`/`settingsScope`/etc. throw in that suite). The other 6 client fakes proxy nothing, so an EVENT-time read (inside a seat/click handler, the live-pass-2 shape) is still unmodeled there | MED (recorded; candidate for a later pass — apply-time half is covered) |
| 10 | **Client `ctx.effect`** — all client fakes | `execute` runs at apply; returned function = unload disposer | cordis `lib/index.js:1168` (`effect`), `:1141-1143` (`safeCollect`) | Aligned in scaffold/shell-mount/toolviews/roster-panel/settings-card/coexistence; `client-onboarding.test.ts` (fake at `:686-755`) collected nothing — **fixed this pass** (collects + `runFiberTeardown`); `client-shell-seat-composition.test.ts:238-243` returns but never collects (never unloads a fiber — noted LOW) | LOW → fixed / LOW noted |
| 11 | **Client `ctx.locale.register(ns, dict)`** — all client fakes | Dictionary registration keyed by namespace + locale; a repeated locale under the same ns throws; the disposer removes only its own entries | `dsh-client-locale/lib/client.js:1256-1282` | NOT modeled (fakes accept any shape, throw nothing, and do not model the multi-locale signature) — no test asserts a duplicate/removal contract | LOW (noted) |
| 12 | **Client `ctx.sessions`** — `client-shell-mount.test.ts:265-296`, `client-shell-seat-composition.test.ts:177-215` | `sessions.list.getSnapshot()/subscribe`, `sessions.open(id)`, `sessions.scope(id)` | `dsh-api-session-controller/lib/client.js:3087` (`reflect.provide("sessions", …)`), `:3093` (`open`), `:3254` (`scope`); provider's own inject `dsh-client-ui-session/lib/client.js:314` (`["sessions","slots"]`) | Aligned (shape) — the fakes provide exactly the read verbs the module uses; `scope()` returns `undefined` (offline absence, exercised as the degrade path) | LOW |
| 13 | **Client `ctx.settingsScope`** — `client-roster-panel.test.ts:171-190`, `client-settings-card.test.ts:194-210`, `client-onboarding.test.ts:750-755` | `bind({namespace})` → `{getSnapshot, subscribe}`; no `watch(ns, cb)` anywhere | `src/client/context.ts:89-146` (contract notes cite `settings-scope.d.ts:88-92,130-139`, `settings-contract.d.ts:50-58`) | Aligned — the roster fake deliberately omits `watch` so the pre-46 shape throws | LOW |
| 14 | **Client `ctx.approval`** — `dispatch-approval.test.ts:43-49` (`serviceReturning`) | `request(req)` requires an OPEN TURN: throws `approval.request() outside an open turn …`; outcomes are a closed vocabulary, rogue → `unavailable` | `dsh-user-approval/lib/index.js:131-145` | Aligned for the outcome vocabulary (the seam normalizes rogue values to `unavailable`); the open-turn precondition is NOT modeled by the fake `serviceReturning` (it returns whatever the test hands it) — our seam collapses every throw to `unavailable`, so the divergence cannot pass a broken flow | LOW (noted) |
| 15 | **Host `ctx.effect`** — `plugin-scaffold.test.ts:64-82`, `activation-lifecycle.test.ts:115-133`, `feature-flag.test.ts:66-84`, `composition-polish.test.ts:141-150`, `access-prompt.test.ts:697-712`, `coexistence.test.ts:205-220`, `multi-dispatcher.test.ts:145-160`, `restart-honesty.test.ts:139-148` + `:457-466`, `steer-command.test.ts:75-92`, `roster-snapshot.test.ts:1008-1017` | `execute` runs at apply; a returned function OR each yielded value is the unload disposer (the 44 fix) | cordis `lib/index.js:1168` + `:1141-1143` | Aligned everywhere (generator effects are drained where unload matters) | LOW |
| 16 | **Host `ctx.commands.register`** — `plugin-scaffold.test.ts:93-99`, `activation-lifecycle.test.ts:146-152`, `feature-flag.test.ts:98-104`, `steer-command.test.ts`, `restart-honesty.test.ts`, `roster-snapshot.test.ts`, `multi-dispatcher.test.ts:189-196`, `composition-polish.test.ts`, `access-prompt.test.ts` | Duplicate command name THROWS `command "X" is already registered …` | `dsh-commands/lib/index.js:82` (`NamedEntries` error factory) | **NOT aligned** in the fakes above (they silently overwrite/push); only `coexistence.test.ts:240` models the throw | HIGH (amplifier: the registration rides a generator effect at apply — a throw aborts the whole activation) → **spun into ticket 90** |
| 17 | **Host `ctx.tools.register`** — `adapter-dispatcher-tools.test.ts:16-60`, `plugin-scaffold.test.ts:100-112`, `activation-lifecycle.test.ts`, `feature-flag.test.ts`, `multi-dispatcher.test.ts:100-110` + `:200-215`, `restart-honesty.test.ts`, `roster-snapshot.test.ts`, `steer-command.test.ts`, `coexistence.test.ts`, `tool-schema-shape.test.ts:88-106` | Duplicate tool name THROWS `tool "X" is already registered …` | `dsh-tools/lib/index.js:2538` (`NamedEntries` error factory) | **NOT aligned** — no fake throws on a duplicate tool name (they push into arrays/maps) | HIGH (same amplifier; also the per-agent scoped registry) → **spun into ticket 90** |
| 18 | **Host tool SCHEMA validation** — `tool-schema-shape.test.ts` (the 45 fix) | The provider rejects an invalid JSON Schema (`required` must be an object-level array) | PRD/ticket 45's live finding; the offline stand-in is the structural walk in that file | Aligned (structural walk over every emitted schema, incl. the worker-side access tool) | LOW (fakes still do not validate; the walk is the detector) |
| 19 | **Host `settings.installSection`** — `coexistence.test.ts:151-200` vs `plugin-scaffold.test.ts`/`feature-flag.test.ts`/`multi-dispatcher.test.ts` (`inject` → no-op or inline stub) | Duplicate namespace THROWS `settings namespace "X" is already registered`; the namespace dies with the claiming fiber | `dsh-settings/lib/index.js:283` | Aligned in coexistence only; the other fakes model an absent/optional settings service (no namespace registry at all, so no duplicate is possible there) | MED (recorded; folded into ticket 90's scope note) |
| 20 | **Host `ctx.on` / lifecycle bus** — every host fake (`on(name, cb)` → disposer) | `on` returns the unsubscribe disposer; events carry the documented payloads | shapes from `docs/research/dsh-adapter-api-notes.md`; `FakeDshHost` mirrors `DshHost` structurally | Aligned structurally (the fakes are typed against our own `AdapterContext`); no host file cites a bus-name table, so this is a MED-verification gap in the RESEARCH, not in the fakes | MED (noted) |
| 21 | **`FakeDshHost`** — `src/core/fake-host.ts` (spawn/interrupt/sendMessage/wake/interruptDispatcher/settled/stepBoundary/accessRequest) | Worker-spawn contract: ids, settle events, step boundaries, access asks | `dsh-subagent/lib/index.js:432-437` (`resolveChildDepth`, cited by `adapter-cordis-dsh-host.test.ts:177`); `dsh-approval`/`dsh-user-questions` faces per `docs/research/dsh-adapter-api-notes.md:220-247` | Aligned structurally — `DshHost` is OUR adapter interface (the host-native glue maps it), so divergence here surfaces as an adapter-unit failure, not a host abort | LOW |
| 22 | **Adapter `ctx.subagents` / `ctx.agents`** — `adapter-cordis-dsh-host.test.ts:42-140` | `startContinuable` → `{childId, messageId}`; `interrupt(target, authority)`; `sendMessage(sender, target, content, {signal})`; `agents.get(id).followup(msg)` | `docs/research/dsh-adapter-api-notes.md`; depth math `dsh-subagent/lib/index.js:432-437` | Aligned (recorded call shapes pinned per method) | LOW |
| 23 | **Client `slots.register` kind precondition** — all 7 client fakes | `keyed slot "X" requires options.key` / `list slot "X" requires options.id` | same SlotCore.register branches (`if(t.key===void 0) throw …`) | NOT modeled — the kind comes from the slot CATALOG (no offline stand-in); the fakes infer the kind from the options shape | LOW (noted) |
| 24 | **Fake error-message registrant suffix** — all client slot fakes | `… at priority N (registered by X) — …` | same SlotCore.register (`m.registrant!==void 0 ? " (registered by …)" : ""`) | NOT modeled (fakes have no registrant identity) — message text only, no behavioral effect | LOW (noted) |

### AC2 — HIGH-risk disposition

- **Aligned this pass:** the client slot-register class (#1-#5; #6/#7 already aligned in
  85, message text corrected here). All 7 client slot fakes now run the shipped rule, so
  the pre-85 no-priority `root` register fails OFFLINE with the host's own error text.
  New pins: `client-face-scaffold.test.ts` — "shipped slot register semantics (ticket 86)"
  (5 tests: -1 shadows a shipped priority-0 frame; the no-priority negative control throws
  the live-pass-3 message verbatim; keyed same-key collision throws + a different key stays
  additive; every entry lands in its declared cell; teardown frees every cell so a re-apply
  cannot collide). The other four suites' re-apply tests now use `assert.doesNotThrow`
  around the post-teardown `apply()`, which the collision rule turns into a real contract
  check instead of a count.
- **Ticketed:** #16 + #17 (host registry duplicate throws unmodeled) →
  `Issue-tracker/open/90-host-registry-duplicate-throws-unmodeled-in-fakes.md`
  (`ready-for-agent`, 3 ACs).
- **Recorded, not ticketed:** #8, #9, #11, #19, #20, #21-24 — MED/LOW, each with its
  mitigation named in the table.

### AC3 — gates (2026-09-19, this tree, offline)

- `npm run typecheck` → clean (both configs, no output).
- `npm test` → **1049 tests / 257 suites, 1049 pass, 0 fail**. The pass adds 5 tests:
  `test/client-face-scaffold.test.ts` went 16 → 21 (both counts observed by running that
  file before and after the change).
- `npm run build:client` → green, `client/index.js` **161,087 bytes**.