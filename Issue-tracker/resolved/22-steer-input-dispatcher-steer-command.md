# 22 — Steer input: /dispatcher-steer command (+ optional input.dock affordance)

**Blocked by:** 19 (activation lifecycle — steering targets the activated dispatcher's session).
**Status:** resolved

## Problem

Mid-run steering exists only as the model-facing `steer_worker` tool; the user has no direct input affordance. Design 16 (§4.3) splits the element: v1 is a **host slash command** (verified seam, offline-testable, no client face needed); v2 is an optional `conversation.input.dock` client affordance. The transport does not change: the core's last-wins queue, delivered at step boundaries, is untouched.

## What to do

- [x] Host: register `dispatcher-steer` via `ctx.commands.register` (Finding 2 contract) with `input: {hint}` per design §6. Handler: gate on an activated dispatcher session; parse worker id + instruction; validate the worker exists and is steerable (reuse the core's refusal vocabulary from `src/core/tools.ts` steer handling); enqueue through the same core path `steer_worker` uses; return success copy.
- [x] Namespacing: `dispatcher-` prefix, fail-loud collision rule (design §5) — if the name collides, pick a replacement and record it here. *(No collision: `dispatcher-steer` was unclaimed; no replacement needed. `CommandDefinitionLike` gained the optional `input: {hint}` field per Finding 2.)*
- [x] Optional (only after the host command lands, and only if #20's scaffold is merged): a `conversation.input.dock` list entry (`id: "multitask-dispatcher-steer"`, `order` deconflicted with the shipped command popup at `order 1`, Finding 6) that submits the same payload through the same path. The dock must not bypass the command/core steer path. If the dock child-slot wiring differs from the contract at integration, ship v1 only and record it. *(Deferred — see comment: the slot's registration seam is verified, but the offline repo cannot verify the dock's submit/pre-fill wiring into the command path, so v1 shipped alone per this checkbox's own escape hatch.)*
- [x] Tests (offline): command handler → core steer queue ordering and last-wins unchanged (`test/steer-queue.test.ts` stays green); refusals for unknown worker, inactive dispatcher, empty instruction; payload shaping unit tests for the dock (if built).
- [x] Copy from design §6 (`dispatcher-steer` description, hint, success, placeholder) as new clean-room strings in the locale namespace. *(Description, hint, and success shipped verbatim from design §6 drafts; the placeholder is dock copy, so it ships with the deferred dock. Refusal copy (inactive dispatcher, wrong chat, usage, unknown worker, not-running) written new clean-room in `src/adapter/steer-command.ts`.)*

## Constraints

- Offline tests only (S8): FakeDshHost / fake seams / fake invocation; no network, no LLM, no running dsh.
- Steer semantics are core-owned: no restart, context preserved, last-wins (PRD steer rules) — the command is an input path, not new semantics.
- Clean-room: all copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.

## Comments

### 2026-09-17 — agent team (ticket 22 implementation)

**Landed** (commit `d4ea74b` "Add dispatcher steer command surface (ticket 22)"):

- `src/adapter/steer-command.ts` (new): `createDispatcherSteerCommand` / `registerDispatcherSteerCommand`, mirroring the `activation-command.ts` lifecycle pattern (ticket 19) — registered at apply (flag ON), handler-gated on the activated dispatcher session. Handler: gate (session-equality with the activation; a non-top-level chat can never hold the activation, so the equality gate refuses child chats too) → `parseSteerInput` (first token = worker id, rest = instruction) → `Multitask.steerWorker` — the **same core path the `steer_worker` tool uses** (existing last-wins `SteerQueue`; no new transport, no new semantics). Core refusal vocabulary reused: `unknown-worker` → "Unknown worker: …", `not-running` → "Worker … is not running; it may already be done." Success copy per design §6: "Steer queued for {workerId}."
- `src/adapter/cordis-dsh-host.ts`: `CommandDefinitionLike` gained the optional `input: { hint, attachments? }` field (Finding 2 contract); the command advertises `input: { hint: "worker id, then your instruction" }`.
- `src/plugin.ts`: dormant apply registers `dispatcher-steer` next to `dispatcher-start`; its disposer joins the unload/HMR effect chain.
- Copy: all new clean-room strings in `steer-command.ts` (description + hint + success verbatim from design §6 drafts; refusal/usage copy written new).

**Tests**: `test/steer-command.test.ts` (new, 16 tests, offline FakeDshHost-style ctx driving real plugin apply + real host + real core): flag OFF inert; dormant registration exactly once with namespacing + advertised hint; refusals — dormant, unresolvable chat, wrong chat, non-top-level chat, empty/missing input, unknown worker, settled worker; end-to-end routing — command → queue (`running` → `steering`, success copy) → step-boundary delivery as `[Parent correction]` → back to `running`; core last-wins unchanged (two queued steers deliver only the latest); HMR dispose-all reverses the command. Updated 4 stale dormant-surface assertions in `test/activation-lifecycle.test.ts`, `test/feature-flag.test.ts`, `test/plugin-scaffold.test.ts` (the dormant command surface is now two commands). `test/steer-queue.test.ts` untouched and green. Suite: **389 passing, 0 failing** (was 373); `npm run typecheck` clean (both configs).

**Deferred gap — `conversation.input.dock` affordance (v2, ticket bullet 3)**: the slot's *registration* seam is verified (Finding 5: `conversation.input.dock` is a shipped list slot; universal `slots.inject` → `slots.register` idiom), but what the dock entry must *do* — submit the payload "through the same path" — needs either composer-state access (pre-fill) or a client→host command-invocation channel, neither of which the research note verifies and neither of which can be checked in this offline repo (S8; no live dsh). Shipping a dock whose submit path is unverified would risk exactly what this ticket forbids — bypassing or guessing at the command/core steer path — so per this checkbox's own escape hatch ("if the dock child-slot wiring differs from the contract at integration, ship v1 only and record it") v1 shipped alone. Follow-up when live integration is possible: verify the child-slot wiring, then add the `multitask-dispatcher-steer` dock entry (order deconflicted with `command-popup` order 1) that pre-fills or submits `/dispatcher-steer …` through this command.

**Integration notes for that follow-up** (same live session as tickets 20/21's deferred live checks): command invocation `agent` shape is contract-level (.d.ts) — the handler refuses rather than guesses if it differs; the `input.hint` field follows Finding 2's `lib/index.js:142-173` contract.

### 2026-09-18 — verifier: AC satisfied vacuously (optional v2 dock, deferred by design per this checkbox's own escape hatch)

The AC is optional by its own first word ("**Optional** (only after the host command lands…)")
and carries its own escape hatch: "**If** the dock child-slot wiring differs from the contract
at integration, **ship v1 only and record it**." That condition is explicitly recorded as met in
the deferral sense: the offline repo (S8, no live dsh) cannot verify the dock's submit/pre-fill
wiring into the command path, so v1 shipped alone — deferred by design, documented inline and in
the "Deferred gap — `conversation.input.dock` affordance" comment above with a concrete
follow-up plan. Independently re-verified: v1 shipped (`src/adapter/steer-command.ts`, whose
header itself records the dock deferral; `dispatcher-steer` registered with `input: {hint}` per
`cordis-dsh-host.ts`), no `conversation.input.dock` entry exists anywhere in `src/` (grep: only
the deferral note in `steer-command.ts`), and `npm run typecheck` + the offline suite are green
at HEAD (515 pass / 0 fail). The offline constraint means the trigger condition cannot arise
until the ticket-33 live pass; nothing further is actionable in this ticket.
