# DD-172 — Redelivery: hidden ack-obligation redrive vs the build's visible-turn redrive
- **Area:** A20 session & durability
- **Type:** behavior-delta
- **Date:** 2026-09-23

## What the reference does
The reference tracks delivery through a dedicated acknowledgement-obligations module under the transcript extension (`the reference tree's source/host/extensions/transcript/ack-obligations.ts`). When a message is delivered visibly for the first time, the module attaches an acknowledgement obligation to that delivery; the obligation is cleared once the recipient acknowledges, and is otherwise carried as outstanding state (persisted by a companion obligation store, `the reference tree's source/host/extensions/transcript/sand-ack-obligation-store.ts`).

When an obligation stays unmet, a redrive path re-attempts delivery. The attempts are bounded by a module-level maximum-attempt constant set to three (`ack-obligations.ts:6`), and the retry is scheduled after a fixed idle delay of five seconds (`ack-obligations.ts:7`). The bound is checked before each attempt and, once exhausted, the obligation is marked lost with an explicit terminal reason (`ack-obligations.ts:186-187`; the terminal-reason union includes an exhausted-redrive case at line 113). The redrive is scheduled both on idle and on host boot (`ack-obligations.ts:136-169`), and the re-attempt itself is carried out by synthesizing a redrive prompt and dispatching it into the transcript with a synthetic provenance tag (`ack-obligations.ts:226-288`). That is the important part of the design: the redelivery is injected into the conversation machinery rather than surfaced as an ordinary user-visible turn.

## What the current build does
The build has an equivalent redelivery path named `redriveUndelivered` in `src/core/multitask.ts` (roughly lines 791-850). It runs on dispatcher-turn end and on activation, and it re-offers any landed-but-undelivered result. It is bounded by a lifetime maximum-attempt constant set to two, defined in `src/core/todo-reconciler.ts:51` and re-exported through the core module.

Structurally the build mirrors the reference in the parts that matter for durability: the bound is a lifetime budget (spent attempts are mirrored onto the roster record and persisted, so a restart continues the same budget rather than resetting it — see the comment at `src/core/multitask.ts:828-841`), the pure bound logic lives in one reconciler, and the action layer only persists the counter and triggers the delivery. The decisive difference is the delivery act itself. The build's redrive opens a **visible** turn (`src/core/multitask.ts:843-847`, with the rationale recorded inline at lines 844-845): the redelivery appears as a user-visible state change rather than as hidden injected machinery.

## The deviation
Both trees solve the same problem — a result that landed but was never delivered must be re-offered, and the re-offering must be bounded so it cannot loop forever. They differ in two ways.

First, the reference keys redelivery off a per-message acknowledgement obligation attached at first visible delivery, with a dedicated obligation store; the build keys it off the landed-undelivered todo items already tracked by its reconciler, with no separate obligation token. The reference's obligation concept is finer-grained (it tracks whether a specific delivered message was acknowledged) than the build's item-level delivered flag.

Second, and more consequentially, the reference redrives through a hidden path (a synthesized prompt injected with synthetic provenance), whereas the build's redrive opens a visible turn. The build's choice is arguably the more accurate one: ADR-0010's rule that state changes the user can see must reflect real state (no optimistic flip) favors state changes the user can actually see over hidden machinery that silently rearranges the conversation. The build's visible-turn redrive is therefore best read as a deliberate stance shaped by that ruling, not as a shortfall against the reference.

## Verdict: ADAPT
Recorded rulings bear on part of this and not the rest. A4/D-5 (ADR-0018) is the recorded ruling touching hidden machinery and lifetime bounds, and the build already follows it — its bound is explicitly a lifetime budget mirroring the reference's, and the hidden-run concern A4/D-5 names is exactly why the build declines the reference's hidden injection path. ADR-0010's rule that displayed state must reflect real state supplies the positive reason for the visible turn. What is **not** recorded is the specific hidden redrive mechanism itself: no ADR or ticket ruling the team has signed addresses whether redelivery may be injected invisibly. ADAPT is the accurate reading: take the acknowledgement-obligation concept (per-message ack tracking with a dedicated store) as a genuine gap worth closing, but keep the build's visible-turn delivery and its lifetime bound, both of which a recorded ruling already covers.

## Incorporation notes
- **Where it would live:** `src/core/todo-reconciler.ts` for the obligation/bound state and `src/core/multitask.ts` for the redrive action layer; the store would sit beside the existing durability markers.
- **Constraints:** keep the lifetime-bound semantics (do not reset attempts on restart); keep delivery via an opened visible turn — do not adopt the reference's hidden injection path. Any per-message ack token must be derived independently from the build's own roster/todo model, not transplanted from the reference's obligation shape.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the bound and redrive already exist; the new work is per-message ack tracking and its persistence, and the risk is adding a second source of delivery truth beside the reconciler's delivered flag.
- **Key reference anchors:** `the reference tree's source/host/extensions/transcript/ack-obligations.ts` (max-attempt bound at line 6, idle delay at line 7, bound check at 186-187, boot/idle arming at 136-169, prompt-and-dispatch at 226-288); `the reference tree's source/host/extensions/transcript/sand-ack-obligation-store.ts`.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/ack-obligations.ts`; `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/extensions/transcript/sand-ack-obligation-store.ts`
- Build: `src/core/multitask.ts` (791-850, redrive path; 828-847 lifetime-budget persist and visible-turn open); `src/core/todo-reconciler.ts:51` (lifetime maximum-attempt constant); `docs/adr/0010-dispatcher-presence-is-a-projection-of-core-state-draft-nonhuman-approved.md`; `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (A4/D-5)
