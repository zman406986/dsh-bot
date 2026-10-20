# DD-158 — Task/spawn tool parameter surface
- **Area:** A19 tool surface
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
The reference's task tool is built by a dedicated schema module
(the reference tree's `task-tool-schema.ts`) whose parameter surface is wide and option-gated. The
field set covers: a short human-facing title for the launched agent; the task
text itself; a selector for which model the child runs on (with guidance text
that steers toward inheriting the parent's model); a resume field whose value may name a prior agent id,
and — under a flag — a sentinel meaning "the current agent's own", i.e. fork
from self, plus resume-mode overrides carried in each subagent's config
(`task-tool-schema.ts:9`, `:107`–`:111`); a subagent-type selector validated
against a configured catalog with normalization and a default
(`task-tool-schema.ts:87`–`:104`); an array of file paths for media attachment
(`:113`); a placement selector naming the execution target, expressed as a discriminated union —
run on this machine, on a fresh cloud VM with an optional base branch and
environment build, or on one named self-hosted worker, or on a pool worker with
optional labels (`:48`–`:74`); an interrupt flag that only becomes legal when
both the client-side-subagent and interrupt switches are on (`:112`, `:134`); and a
run-in-background flag whose accepted values are preprocessed from the textual
true/false strings (`:135`–`:139`).

Two structural traits matter more than any single field. First, the builder
returns a **pair** of schemas — one for the model and one for parsing —
built from the same closure with different description and type fields
(`task-tool-schema.ts:41`–`:44`, `:122`–`:150`). Second, both carry a
cross-field refinement pass: a cloud-only base-branch field and a cloud-only
environment-build field are rejected unless the environment selector says
cloud (`:140`–`:144`). The long field descriptions live in the schema rather
than in the tool description; the separate description builder
(`:195`–`:275`) only elaborates the subagent-type catalog, the model catalog,
and the resume/interrupt etiquette.

## What the current build does
The build's spawn tool takes four parameters and no more: the stream key (a
required stable id for the logical stream), a short human title, the
self-contained work instruction, and an optional optional-`todo_id` link into
the ledger (`src/core/tools.ts:205`–`:223`, `:263`–`:280`). The object schema is
closed with `additionalProperties: false`, so an extra field is not silently
accepted.

There is no model selector, no resume field (and no self-fork sentinel), no
subagent-type selector, no attachment array, no placement/machine union, no
interrupt flag, and no run-in-background flag. There is also no strict/lenient
schema pair and no refinement pass: the build emits a single schema literal and
leaves validation to the host's tool-calling layer — the tool body re-checks
the few args it needs by hand (`src/core/tools.ts:283`–`:286`) rather than
encoding cross-field rules.

Two build stances are encoded around the spawn surface rather than inside it.
Concurrency is one-live-worker-per-key: the spawn contract states that a key
with a live (non-terminal) worker is refused and that a terminal worker frees
the key (`src/core/multitask.ts:131`–`:139`, `:557`), matching the parameter's
own description at `src/core/tools.ts:209`, with the refusal surfacing as a
`duplicate-stream-key` result (`:342`–`:348`). And work is terminal: the worker
contract tells the worker to finish one job, that its only channel back is the
final answer, and that a denied ask is not retried (`src/worker/prompt.ts:50`,
`:58`–`:61`, `:65`, `:77`).

## The deviation
The reference treats the subagent invocation as a set of placement and lifecycle
controls: model, machine, subagent class, attachments, interrupt and
background all ship as first-class knobs, and resume is a first-class verb. The
build treats the spawn as a single, self-contained, terminal delegation and
keeps the tool surface minimal, pushing the surrounding decisions (which agent
implementation, what approval requirements, what quota) onto parts of the host or onto dispatcher
policy instead of onto the model-visible schema.

Two of the reference's knobs are inapplicable by architecture rather than by
taste. There is no model selector counterpart and no machine/placement
counterpart, because the build delegates the actual launching to the host's own
agent spawner and does not own provider choice or execution target. One is
ruled out: a resume parameter would let a worker be re-entered after its final
answer, which collides with the recorded terminal-work stance — restart replays
durability, never work (ADR-0012) — and with prompts that close the worker out
at the final answer. One is offered elsewhere: the media/file attachment
array overlaps the attachment family (DD number pending).

What remains genuinely open is the shape of the schema itself — the reference's
model/parse schema pair and its cross-field refinement pass. The build has
neither, and its dependence on host-side validation is a behavior consequence,
not merely a style difference.

## Verdict: ASK-HUMAN
ADR-0012 covers the resume parameter specifically — resuming a completed
worker would reintroduce the work-replay the ruling forbids — so resume is
settled against, not open. The model selector and machine selector are
inapplicable by architecture (the build does not own the spawn target), and the
attachment array is covered by the attachment-family tickets (DD number pending).
That leaves the schema-shape question (paired schemas plus cross-field
refinement versus relying on host validation) with no recorded ruling in the
authority stack, and it is a deliberate stance choice rather than an
oversight — the PRD's non-goals and the one-per-key stance both push toward a
thin surface. Per the stack, an uncovered conflict stops and asks the human
rather than silently picking.

## Incorporation notes
- **Where it would live:** `src/core/tools.ts` (the spawn tool's `parameters`
  literal, `:263`–`:280`), with any cross-field rule landing either in the
  tool's own validation before `spawnWorker` or in a new schema-building helper
  beside the tool definitions; concurrency semantics stay in
  `src/core/multitask.ts`.
- **Constraints:** ADR-0018 B9 — re-derive independently; no field named,
  described, or shaped by copying the reference's schema module. The
  one-live-worker-per-key rule (`src/core/multitask.ts:131`–`:139`) is the
  build's concurrency stance and must not be relaxed to accommodate a
  placement or background knob. Any resume or re-enter capability is barred by
  ADR-0012 unless the human reverses it. The worker contract's terminal framing
  (`src/worker/prompt.ts`) must keep matching whatever the tool surface allows.
  Closing the object with `additionalProperties: false` is existing behavior
  and should stay.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying
  from the reference tree. Reference tool/field names are to be treated as
  needing independent renaming on our side; describe them by role only.
- **Effort/risk:** S if the human confirms the thin surface is the intended
  stance (the deviation is then documentation plus a test fixing the closed
  object); M if a validation layer is added; L and high-risk if any lifecycle
  knob is imported, because it touches the state machine and ADR-0012.
- **Key reference anchors:**
  `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/tools/task-tool-schema.ts`
  lines 9, 41–44, 48–74, 87–104, 107–113, 122–150, 195–275.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/packages/agent/tools/task-tool-schema.ts` (lines 9, 41–44, 48–74, 87–104, 107–113, 122–150, 195–275)
- Build: `src/core/tools.ts` (205–223 parameter nodes, 263–280 spawn tool definition, 283–286 hand validation, 342–348 duplicate-key result), `src/core/multitask.ts` (131–139, 557 one-live-worker-per-key), `src/worker/prompt.ts` (50, 58–61, 65, 77 terminal-work contract), `src/core/policy/prompts.ts`
