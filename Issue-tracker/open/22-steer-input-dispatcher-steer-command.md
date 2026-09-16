# 22 — Steer input: /dispatcher-steer command (+ optional input.dock affordance)

**Blocked by:** 19 (activation lifecycle — steering targets the activated dispatcher's session).
**Status:** open

## Problem

Mid-run steering exists only as the model-facing `steer_worker` tool; the user has no direct input affordance. Design 16 (§4.3) splits the element: v1 is a **host slash command** (verified seam, offline-testable, no client face needed); v2 is an optional `conversation.input.dock` client affordance. The transport does not change: the core's last-wins queue, delivered at step boundaries, is untouched.

## What to do

- [ ] Host: register `dispatcher-steer` via `ctx.commands.register` (Finding 2 contract) with `input: {hint}` per design §6. Handler: gate on an activated dispatcher session; parse worker id + instruction; validate the worker exists and is steerable (reuse the core's refusal vocabulary from `src/core/tools.ts` steer handling); enqueue through the same core path `steer_worker` uses; return success copy.
- [ ] Namespacing: `dispatcher-` prefix, fail-loud collision rule (design §5) — if the name collides, pick a replacement and record it here.
- [ ] Optional (only after the host command lands, and only if #20's scaffold is merged): a `conversation.input.dock` list entry (`id: "multitask-dispatcher-steer"`, `order` deconflicted with the shipped command popup at `order 1`, Finding 6) that submits the same payload through the same path. The dock must not bypass the command/core steer path. If the dock child-slot wiring differs from the contract at integration, ship v1 only and record it.
- [ ] Tests (offline): command handler → core steer queue ordering and last-wins unchanged (`test/steer-queue.test.ts` stays green); refusals for unknown worker, inactive dispatcher, empty instruction; payload shaping unit tests for the dock (if built).
- [ ] Copy from design §6 (`dispatcher-steer` description, hint, success, placeholder) as new clean-room strings in the locale namespace.

## Constraints

- Offline tests only (S8): FakeDshHost / fake seams / fake invocation; no network, no LLM, no running dsh.
- Steer semantics are core-owned: no restart, context preserved, last-wins (PRD steer rules) — the command is an input path, not new semantics.
- Clean-room: all copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
