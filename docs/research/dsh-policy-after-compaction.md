# Is the dispatcher policy re-injected when dsh compacts a session?

- Date: 2026-11-10.
- Question: dsh compacts long sessions. Our dispatcher policy is text we put into the conversation. Does a compaction take it away, and if it does, does anything put it back?
- Scope: the **installed, running** dsh build plus this repo's plugin code. Host read-only. No code was changed for this note; no tests, builds, or doc-lint were run.

---

## Question

Our dispatcher's whole contract (what it may do, how it talks to the user, how it treats workers and steer) is delivered as text when the session is activated. dsh also compacts: at some pressure threshold it summarizes an old span of the conversation and swaps the summarized nodes out for one summary message. A session that runs long enough gets compacted.

So: after a compaction, is the policy still in context? If not, is dsh meant to put it back, or is putting it back our job?

## Method

Read the installed build at `C:\Users\TZ\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*` (plain JavaScript, no sourcemaps needed) and the matching plugin code in this repo, then traced one concrete compaction from threshold to replacement.

The installed running build is the ground truth here, not dsh's docs and not our reading of our own plugin. The host ships compiled `lib/index.js`, so every claim below is a line in a file this machine actually executes. Host line numbers are from the installed copy; repo paths and lines are from the working tree as it stands after the fix.

## Findings

1. **The system prompt is assembled from scratch every model step.** `dsh-agent-loop/lib/index.js:679` — the per-step pre-phase calls `this.loopCtx.systemPrompt.assemble({...})` before dispatch. `dsh-system-prompt/lib/index.js:382-401` — assembly collects every registered section, resolves each section's text (or text function), sorts, and runs the `system-prompt/assemble` waterfall. There is no cached prompt: each step asks the registry again.

2. **Host compaction's range starts at the first non-system node.** `dsh-compaction-basic/lib/index.js:415` — `const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;`. Its doc block at `:403-404` says it plainly: "A `system/message` at surface node 0 is never inside the range; without one the range starts at node 0." The replacement is a **user** message: `createUserMessage(...)` at `:596`, appended by `session.append("user/message", checkpointMessage, ...)` at `:650`, shadowing the summarized seqs from `:629`.

   Consequence: the system head lies outside the compacted span and is re-projected by Finding 1 on the next step, so what the system prompt says survives. Everything user-role and assistant-role inside the span does not.

3. **The dispatcher policy is not a system-prompt section. It is one user-role message, injected once at activation.** `src/adapter/parent-agent.ts:36-48` — `pluginContextMessage` builds a `{ role: "user", content, source }` event; it never touches `ctx.systemPrompt`. The activation path injects it (`:984-1006`), under the comment "ADR-0005: policy is fixed for this session's lifetime" (`:978`; it was `:814` before the fix inserted code above it, which is the line the ticket cites). "Fixed" meant *written once*, not *kept alive* — nothing in the turn loop re-sent it.

   The worker contract, by contrast, **is** a system-prompt section: `src/worker/preset.ts:162-168` — `prompt.section({ name: WORKER_PERSONA_SECTION, order, text: def.persona, interpolate: false })`. That asymmetry answers the question. The policy lived in the conversation and was summarized away; the worker contract lived in the prompt registry and was re-established on every step.

4. **So host compaction deleted the policy and nothing put it back.** The policy is a user-role message inside the compacted span (Findings 2 and 3), so the checkpoint replaced it and no later step re-created it. The session kept running with its tools, its session id, and no policy — a stock chat with our surface attached, for the rest of its life.

   Microcompaction was never the culprit: `src/core/microcompact.ts:238` filters `node.role === "tool"`, so it prunes tool results only and cannot touch a policy node. Its durable boundary record is microcompact-only as well — `src/adapter/durable-marker.ts:322` rejects any layer that is not `"microcompact"` — so our own compaction machinery was not in this path at all. The loss came from the host.

5. **The fix now in the tree (ticket 296) makes the policy self-healing.** Three pieces in `src/adapter/parent-agent.ts`, all of them reading state, none mutating the session log:

   - `policyOnLiveSurface` (`:358-385`) walks `agent.session.surface.nodes`, reads each node with `session.eventAt`, and answers `"present"` only when a committed producer message's text equals the exact policy bytes; `"absent"` on a readable surface with no such node; `"unknown"` when the seam is missing or throws. `surface.nodes` already excludes shadowed nodes, so no seq arithmetic and no compaction history is involved.
   - A per-turn re-inject on the bound-dispatcher `agent/status === "running"` edge (`:819-847`) that fires *before* the turn reminder, so the reminder stays the newest tail. A `policyInjectInFlight` mark (`:713`, cleared at turn end `:880`) stops a copy queued at activation from being queued twice.
   - A narrow `ctx.on("session/event")` listener (`:900-932`) that reacts to `compaction/end` for a bound dispatcher session only — the earliest honest moment, since the replacement message lands immediately after that event.
   - The text is byte-identical to activation's: `policyBytes` (`:723-730`) calls the same `assembleSessionPolicy(true, origin, spawnGeneration, policyLanguage)`. Workers are excluded structurally: the probe and listener only reach sessions in the lifecycle's `sessions` map, and the worker branch (`:886-895`) is untouched.

## What our plugin assumed

Two assumptions, both wrong:

1. **"The policy is in the conversation, so it stays."** A user-role message is durable in the transcript but not durable in context. We treated "injected once" as "present forever" — the ADR-0005 comment reads that way — and never asked the surface whether it was still there.
2. **"Our compaction work is the only thing that can remove context."** True for microcompaction, which prunes tool results only. False for the host, which summarizes whole ranges on its own schedule, including the node holding the policy.

The generalisation worth keeping: anything we place in the conversation has the host's compaction as its lifetime, and only the system prompt is exempt. Whatever must be true on every step is either a prompt section (the worker contract) or re-established from state (the policy, now).

## Decision

Fixed in the plugin, not in the host: probe the live surface and re-inject the exact bytes — at activation, on the `compaction/end` boundary, and on every bound-dispatcher turn as the fallback. Implementation, constraints, and acceptance tests live in [ticket 296](../../Issue-tracker/open/296-dispatcher-policy-lost-after-host-compaction.md), which stays open until the live-session check in Residual uncertainty is done.

We did **not** move the policy into a system-prompt section. That was the other option and it would also survive compaction, but the policy is large, varies by session origin and spawn generation, and placing it in the cached prompt prefix is a different caching story from placing it in the message stream. Re-injecting one message restores parity with the pre-compaction state without moving where the text lives.

## Residual uncertainty

- **No live model session was compacted end-to-end.** The behavior is proven against the installed host's code paths and against fake sessions in the ticket's tests, not by driving a real session over the threshold and reading the outcome. The first honest confirmation is one long session that compacts and keeps acting like a dispatcher.
- **The probe depends on two host seams read through guarded casts:** `agent.session.surface` and the synchronous `session.eventAt(seq)`. If a future build makes `eventAt` async or drops the surface, the probe degrades to `"unknown"` — fail-open at activation (the old behavior), no per-turn duplicate, and the compaction listener would then re-inject blind. Safe, but the failure is silent rather than loud.
- **Rendering was not eyeballed.** Nobody looked at the conversation panel after a re-inject to confirm the restored policy reads correctly and that no duplicate block is visible to a human.
