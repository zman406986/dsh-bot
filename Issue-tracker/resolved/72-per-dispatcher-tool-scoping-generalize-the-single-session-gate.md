# 72 — Per-dispatcher tool scoping: verify host-side scopes, else generalize the single-session gate into session-keyed routing

**Status:** resolved
**Labels:** ready-for-agent
**Blocked by:** none (finding recorded: `docs/research/dsh-tool-scoping-seam.md`)
**Related:** ADR-0018 (multiple dispatchers are real — this is its verification item), 64 (commissioned this), 19 (the single-session activation gate this generalizes), 30 (session-scoped always-allow rows — same keying), 27/29 (roster/activity projections keyed by one session), 76 (implementation ticket spun out by this design)

## Problem

ADR-0018 rules multiple dispatchers real, each with its own dsh session. Today the dispatcher tool
surface is one process-wide registration on the plugin ctx with a single-session execute gate
(`lifecycle.dispatcherSessionId()`), pinned to one activation slot — a second dispatcher session
cannot exist. Finding and evidence: `docs/research/dsh-tool-scoping-seam.md`.

## Acceptance criteria

- [x] One read-only observation pass against the installed `@deepseek-ai/*` packages (offline;
      same method as ticket 29's seam survey; never the reference tree): does the host offer a
      session-/agent-scoped tool registration seam a plugin can use (per-scope `tools` service,
      per-session register, or agent-filtered availability)? Verdict with file:line recorded as a
      dated comment and appended to the research note.
- [x] If a host scope exists: design note (ADR draft) registering each dispatcher's tools in its
      own scope; the plugin-level singleton gate is retired. → `docs/adr/0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md`
- [ ] If not: design note (ADR draft) for **session-keyed gating** — registration stays global;
      `gatedExecute` routes `callerSessionId → dispatcher state` (per-session Multitask instance
      or keyed sub-registries — the note decides with evidence); unknown callers refuse with the
      existing structured copy; the worker-access tool gets the same keying. *(conditional — not
      triggered: a host scope WAS verified, see 2026-09-19 comment; per-scope visibility
      subsumes execute-time refusal, and the session-keyed state work the branch would have
      designed is folded into ADR-0019's keying table.)*
- [x] The design covers roster snapshot, wake bus, access relay, and recentActivity keying per
      dispatcher session (they all assume one session today).
- [x] No implementation in this ticket — it ends at the signed-off design; implementation gets
      its own ticket (repo rule). → implementation ticketed as **76**; ADR-0019 remains a draft
      pending human sign-off.

## Constraints

- Offline only (S8); the host survey is read-only on the INSTALLED dsh packages.
- Do not weaken the existing one-dispatcher behavior while designing; the generalized design must
  be a superset (single dispatcher = map of one).
- ADR-0018's exception list is the fidelity bar for any dispatcher-tool visibility question
  (workers stay leaves; workers never see dispatcher tools).

## Comments

### 2026-09-19 — agent (survey + design pass)

**Verdict: the host DOES offer a per-agent-scoped tool registration seam — remedy (a) is
available.** Read-only pass on the installed `@deepseek-ai/*` packages, all **0.1.5-rc.2**,
located afresh (flat profile tree `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`;
WinGet twin cross-checked, same version). Reference tree never opened. Full evidence with
file:line appended to `docs/research/dsh-tool-scoping-seam.md` (update 2026-09-19). Short form:

- Every agent loop mints its own Cordis scope: `dsh-agent-loop/lib/index.js:761-763`
  (`createScope(loopCtx, this)`; `this.ctx = this.scope.ctx`), and `Agent.ctx` is that scoped
  context (`dsh-agent/lib/types/runtime-types.d.ts:149`).
- `tools.register` writes the layer chosen by the calling ctx's scope tag:
  `dsh-tools/lib/types/index.d.ts:595-601` ("Register globally or in the calling agent scope.
  Scoped tools shadow globals"); `dsh-tools/lib/index.js:2773,2781` +
  `dsh-scope/lib/index.js:189-190` (`scopeOf(ctx)`); the host's own error copy names the idiom:
  "requires a scoped context **(agent.ctx)**" (`dsh-tools/lib/index.js:2792`).
- Model-facing visibility resolves per agent scope: `assembleContextFor` passes
  `{ agent, scope: agent }` (`dsh-agent/lib/index.js:258-264`) into
  `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`
  (`dsh-tools/lib/index.js:2609`).
- Inheritance runs DOWN the scope-parent chain only (`dsh-scope/lib/index.js:234,162-181`);
  parent links are bound solely by `dsh-agent-presets` to preset standing compositions
  (`dsh-agent-presets/lib/index.js:1504,1538,1702`) — never to a delegating chat's loop scope.
  So per-dispatcher registration keeps workers dispatcher-tool-blind (ADR-0018 conformance,
  now host-structural) and keeps sibling dispatchers' tools from leaking into each other.
- Registration lifetime rides the agent scope fiber (session end / HMR auto-unregisters;
  `dsh-scope/lib/index.js:192-217`), with an explicit idempotent disposer for our deactivation
  path.

**Design delivered:** `docs/adr/0019-per-dispatcher-scoped-tools-draft-nonhuman-approved.md`
(draft, non-human-approved; README index updated). Decision: register each dispatcher's tools
through its activated agent's scoped context and retire the plugin-level singleton (one
`activationTools` slot, one `dispatcherSessionId`, single host parent, single-session
`gatedExecute`, `already-active-elsewhere` copy); all single-session state becomes a
session-keyed superset. The ADR's keying table covers the AC's named surfaces: roster snapshot
(per-session publish, no single-active gate), wake bus (already `parentSessionId`-keyed — no
change), access relay (policy rows attributed per session with per-session clear; prompt pump
per session), recentActivity/lastActivityAtMs (already workerId-keyed — no change), plus two
hazards the survey surfaced: model-authored `stream_key` colliding across dispatchers in the
one global `liveByStreamKey` (uniqueness becomes `(parentSessionId, streamKey)`) and
`clearSession()` wiping every session-scope row globally today. Per-session Multitask instances
were considered and rejected — core state is already session-keyed; one Multitask stays.

**No implementation in this ticket, per its own AC.** Implementation is ticketed as
**76** (`Issue-tracker/open/76-per-dispatcher-scoped-tools-implementation.md`, ready-for-agent).
Nothing live was exercised: offline only (S8); read-only on installed MIT host packages.

**Handoff:** ADR-0019 is a **draft pending human sign-off** — sign-off and any live two-dispatcher
verification ride the human/live lane (tickets 45/33 chain), matching the ticket-37 precedent
for draft ADRs. All offline-settleable ACs above are done; `npm test` 807 pass / 0 fail (206 suites),
`npm run typecheck` clean (both configs) on the docs-only tree at commit time.

### 2026-09-19 — resolved

Resolved by the same pass: survey verdict recorded (this comment + research note update), design
ADR-0019 drafted and indexed, implementation spun out as ticket 76. Human sign-off of ADR-0019
remains open at the ADR level and does not block this ticket's ACs.
