# 25 — Coexistence + clean-room QA close-out for #16

**Blocked by:** 19, 20, 21, 22, 23, 24.
**Status:** open

## Problem

Ticket 16's Phase 3 requires coexistence verified alongside another plugin using the same seam type, and the repo's ship gate is clean-room QA (S7 / PRD §12). Design 16 (§5) defined the namespacing/conflict rules; this ticket proves them and closes out #16.

## What to do

- [x] **Offline coexistence tests:** on the fake seam providers, prove the plugin's registrations coexist with a second fake plugin on the same seam types — duplicate settings namespace / command name / slot entry id each fail loud and do not corrupt the first claimant (Finding 1 `settings namespace "X" is already registered`; Finding 2 duplicate command throw; Finding 5 list-slot additivity). Namespaced names per design §5 (`multitask-dispatcher` namespace, `dispatcher-` commands, `multitask-dispatcher-` entry ids).
- [x] **Dormant-state coexistence:** flag ON + not activated = stock experience: no capture on session-start, no policy inject, stock tool surface (asserts the #19 contract end to end at the plugin boundary).
- [x] **Clean-room grep (S7 / PRD §12):** run the banned-identifier grep over the shipped tree (excluding the reference folder): `grep -rinE "sand|MessageSubagent|SAND_MULTITASK|executor-as-codename-context"` — judge hits: ordinary English words are fine; reconstruction codenames are a fail. Record the command and result in the ticket comments. Grep the new UI copy too — all strings must originate in design §6 / the tickets.
- [x] **Full suite offline green** (`node --test` via tsx): no network, no LLM, no running dsh — including #18's deny-list tests if that ticket has landed (independent; if not landed, note it and proceed — do not block on it). *(#18 landed — commit `6477ed7`; its tests are in the suite.)*
- [x] **ADR completeness:** confirm `docs/adr/0009-*` exists and the ADR index is updated (from #19); confirm any ADR-0010 decision from #21 (client data path) is recorded or explicitly deemed unnecessary per design §9.
- [x] **Design-vs-shipped drift log:** list every place the shipped implementation deviated from design 16 (names, seams, fallbacks used) in the ticket comments, and tick the corresponding Phase-3 items on #16. *(Drift log below. Ticking #16's Phase-3 boxes is left to the orchestrator — this agent does not edit #16's file; the substance is verified and summarized below.)*
- [x] Close-out comment on #16 summarizing: activation model shipped, surfaces shipped/deferred, fallbacks used, verification results. *(Comment content written below for the orchestrator to post when closing #16 — this agent does not edit #16's file.)*

## Constraints

- Offline only (S8); the "coexistence alongside another real plugin" live check is documented as a follow-up manual step, not run here (no running dsh in CI/tests).
- Never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree; never commit into it.
- No new features in this ticket — verification and close-out only; anything broken found here gets its own ticket.

## Comments

### 2026-09-17 — agent team (ticket 25 implemented; close-out for #16)

**Landed:** commit `9f2c095` ("Verify seam coexistence and run clean-room QA
(ticket 25)") — new `test/coexistence.test.ts`, 11 offline tests (S8). **No
product-code changes were needed: nothing broken was found**, so no follow-up
tickets are required from this ticket. Verification and close-out only, per
the constraint.

**Coexistence evidence** (fake seam providers carrying the shipped fail-loud
semantics — Finding 1 duplicate-namespace throw, Finding 2 duplicate-command
throw, Finding 5 list additivity / keyed cells — driving the REAL `apply()`
on both faces alongside a simulated foreign plugin that registers on the
SAME seam types):

- **Settings (Finding 1):** both namespaces (`multitask-dispatcher`,
  `foreign-helper`) coexist. A latecomer claiming EITHER namespace throws
  `settings namespace "X" is already registered`; the first claimant's owner
  scope still reads, writes, and notifies watchers afterwards.
- **Commands (Finding 2):** `dispatcher-start` / `dispatcher-steer` and the
  foreign command coexist. Duplicate registration of either name throws
  `command "X" is already registered …`; the ORIGINAL handler stays live
  (activation still returns success copy after the interloper is refused;
  the foreign command still routes to the foreign handler).
- **Global tools:** dormant = stock surface (foreign tool only). Activated =
  six dispatcher tools alongside the foreign tool; the foreign tool still
  executes as the foreign one; a non-activated chat is still refused by the
  exec-shape gate (`not-activated`) — the documented process-global name
  leak with its documented mitigation (design-16 §3.8).
- **Client slots (Finding 5):** `shell.overlay` holds both plugins' entries
  additively (unique ids, per-plugin prefixes; the documented `order ?? 0`
  sort puts our quiet-status entry at −10 first); `tool.call.toolview` holds
  our five wire-tool keys plus the foreign key — each cell its own
  component, foreign keys unaffected.
- **Locale:** both namespaces coexist; `bind` resolves per namespace with no
  key bleed.
- **HMR:** unloading ONE plugin's fiber (host or client face) removes
  exactly that plugin's registrations — commands, tools, settings namespace
  (Finding 1 lifecycle), slot entries, locale — and leaves the other plugin
  fully functional; post-HMR re-apply re-registers cleanly with no
  duplication of the survivor's entries.
- **Dormant-state matrix (design-16 §3.7), end to end at the plugin
  boundary:** flag ON + not activated → a simulated `agent/session-start`
  captures nothing, injects no policy, and the tool surface stays stock; the
  dormant affordances are exactly the two `dispatcher-` commands. Activation
  raises the six-tool surface without disturbing the foreign plugin's
  registrations, and the roster snapshot mirrors into OUR namespace only
  (the foreign plugin's settings document is untouched).

**Clean-room grep (S7 / PRD §12)** — command run at the repo root (Git Bash),
shipped-tree scope, reference tree / `.git` / `node_modules` excluded:

```
grep -rinE "sand|MessageSubagent|SAND_MULTITASK|executor" \
  src test scripts docs *.json *.md agent.md \
  --exclude-dir=node_modules --exclude-dir=".git" \
  --exclude-dir="reference material-NOT LICENSE SAFE DONT COPY-grok bot" \
  --exclude-dir=lib
```

77 raw hits, judged per `docs/research/clean-room-license-audit.md` (ticket
15's method):

- Product code: ONE hit — `src/core/access-types.ts:11`, the ordinary
  English word **sandbox** (host-isolation term; non-finding in ticket 15).
- Tests: only the intentional `FORBIDDEN_VOCAB` guard arrays in
  `policy-assembler` / `report-clamp` / `worker-agent-type` tests — the
  ongoing new-copy guard, kept deliberately.
- Docs: policy text naming the prohibition (AGENTS.md, PRD) and
  `docs/research` + `docs/diagrams` evidence notes that cite reference paths
  by design — out of product scope per ticket 15.
- New UI copy grepped inside `src/` (`activation-command.ts`,
  `steer-command.ts`, `access-prompt.ts`, `client/*`) — clean; all strings
  originate in design-16 §6 / ticket-written clean-room additions.
- Supplementary sweeps (ticket 15 method): word-boundary `sand` variants
  over `src test scripts` → none; reconstruction file basenames over
  `src test scripts` + package manifests → none; compiled `lib/` and the
  built `client/index.js` after a fresh `npm run build` / `npm run
  build:client` → none. **Verdict: clean.**

**Full suite offline green (S8):** `npm test` → **512 passing, 0 failing**
(was 501; +11 from this ticket), duration ≈ 120.2 s — of which ≈120 s is the
known `test/access-relay.test.ts` default-timeout parking (pre-existing,
flagged in #23's comment; NOT claimed by this ticket — see Remaining).
Includes #18's deny-list tests (#18 landed, commit `6477ed7`).
`npm run typecheck` clean on both configs; `npm run build` and
`npm run build:client` green.

**ADR completeness:** `docs/adr/0009-activation-explicit-command-no-capture-on-load.md`
exists (accepted) and is indexed in `docs/adr/README.md` (from #19) ✓.
ADR-0010: explicitly **deemed unnecessary** — the #21 data path resolved to
design-16's own prescribed settings-watch fallback, so there is nothing
non-obvious to record; the decision record is #21's comment (design §9.2
leaves the call to the implementer) ✓.

**Design-vs-shipped drift log (design-16 → shipped):**

1. §3 activation model — shipped exactly as designed (ADR-0009). No drift.
2. §3.8 tool gating — primary exec-shape gate shipped; the weaker
   "activation exists" gate applies only when the exec shape is unresolvable
   (documented + tested, exactly as the design allowed).
3. §4.2 roster data path — the design's known-good fallback (settings
   namespace mirror + client watch) shipped as-is: a prescribed fallback,
   not a deviation. Panel `order: -10` mirrors the shipped `-10` convention.
4. §6 status-label vocabulary — design prose listed
   `pending/running/completed/error`; the shipped core FSM vocabulary is
   `spawned/running/steering/completed/error/aborted`. Per design §6's own
   "reuse the core FSM vocabulary as-is" rule, the panel renders the core's
   actual words (recorded in #21).
5. §4.3 v2 `conversation.input.dock` steer affordance — DEFERRED: the
   registration seam is verified but the dock's submit/pre-fill wiring into
   the command path is unverifiable offline; v1 host command shipped alone
   per the checkbox's escape hatch (#22).
6. §4.2 toolview keys — the design table listed four; #24 shipped all five
   including `deliver_result` (that ticket's own text allowed "and
   deliver_result if it benefits"). Additive; keys remain core-owned and
   disjoint from shipped-claimed cells.
7. §6 copy — design drafts shipped verbatim plus minimal ORIGINAL
   additions: an unresolvable-invocation refusal (#19) and steer
   refusal/usage copy (#22). No replacements.
8. ADR-0010 — not written, deemed unnecessary per design §9.2 (see above).

No name replacement was ever forced: `dispatcher-start` / `dispatcher-steer`,
the `multitask-dispatcher` namespace, and `multitask-dispatcher-roster` all
landed collision-free. Collision semantics were exercised fail-loud in tests
instead of in production.

**#16 Phase-3 status + close-out (for the orchestrator — this agent does not
edit #16's file):** Phase 3 is satisfied in substance: the dispatcher no
longer hijacks on load; activation composes with the ticket-12 flag/profile
split; roster, steer, and access-request surfaces shipped per the design;
coexistence is verified against a simulated second plugin on every seam type
the plugin uses (offline; the alongside-a-real-plugin live check remains a
documented manual follow-up per this ticket's constraint); the forced
architectural decision is recorded as ADR-0009. Close-out summary for #16:
*activation model* — explicit `/dispatcher-start` per chat, once per
session, no deactivate (ADR-0009; flag ON means available, not captured);
*surfaces shipped* — activation + steer host commands, dormant flag matrix,
roster `shell.overlay` panel over the settings-watch data path, access asks
through the host prompt seam, five per-tool `tool.call.toolview` views;
*deferred* — `conversation.input.dock` steer affordance (v2), `deliverToUser`
wiring (no verified send seam), per-session tool scoping (documented global
registry, execution-gated); *fallbacks used* — settings namespace as roster
channel (design's own fallback), conversational access relay when the prompt
seam is absent or fails. The orchestrator may tick #16's Phase-3 items and
post this summary there when closing.

**Remaining (nothing blocking #16 close; all live-verification or
pre-existing):**

- Live dsh checks documented in #20/#21/#22/#24 (profile re-creation per
  research Finding 0, boot-graph scan, overlay rendering, prompt waterfall
  scoping, dock wiring, toolview prop face, settings `update` merge
  semantics).
- Pre-existing issues observed but NOT claimed by this ticket's checkboxes:
  (1) `test/access-relay.test.ts` parks tickets on the real 120 s default
  timeout, adding ≈2 min to every suite run; (2) the unbound-parent
  deny-delivery throw path from #23's comment (a deny delivered via
  `host.sendMessage` after the parent unbinds throws into a void'd promise —
  potential unhandled rejection in the real host). Both warrant their own
  tickets per this ticket's "anything broken gets its own ticket" rule.
