# A delegated child cannot be given a working approval/ask channel from inside the plugin

**Status:** proposed (pending owner confirmation) — agent-drafted 2026-11-09 from a re-read of the installed dsh host 0.2.2-rc.1 (every line cited below was re-read, not carried over) plus one isolated live probe. This records a recommendation, not an owner ruling: nothing ships on it until the owner confirms.

**Numbering:** 0036, the first free number at filing (2026-11-09; highest in use was draft 0035).

A delegated dsh child cannot be given a working approval/ask channel from an in-plugin seam without breaking the rule that **a child's scope must never exceed its parent's**. The sandbox half of the fallback is already true on this deployment. The remaining real gap — a child putting a question or a plan to the human — needs a host change, and the honest position is to ask upstream rather than fake it in the plugin.

**This ADR is not ADR-0008 coming back.** 0008's `request_access` relay was our own invention, a dispatcher-mediated substitute for a seam the host declines to offer, and ADR-0033 removed it as such. Here the seam under discussion is the host's own event, and the conclusion is to grant nothing. ADR-0033 stands untouched.

## Context

**Children are pinned.** When the parent has an approval service, the child's policy is set to `"never"` (`dsh-subagent/lib/index.js:414`), appended to the child's own log as a delegation-tagged record (`:431-434`), and applied from the child's create setup (`:1807`), before the first turn. The capture comment is explicit: only the parent's own explicit sandbox override travels — never deployment defaults (`:403-405`).

**Nothing gets past the pin.** With policy `never` the approval service returns `"rejected"` at `dsh-user-approval/lib/index.js:200`, one line before the sole dispatch of `approval/request` at `:201`. No request is ever created for such a child, so a would-prompt action becomes a hard error (gate `dsh-tools/lib/pipeline.js:386-390`; outcome handling `:624-651`).

**Sandbox already inherits.** The child copies `sandboxPolicy.overrideOf(parent.session)` (`dsh-subagent/lib/index.js:413`; `dsh-sandbox-policy/lib/index.js:180-182`), and the permission preset writes a real sandbox-mode event on each root session (`dsh-permission-presets/lib/index.js:387`). Parent `danger-full-access` therefore gives a child `danger-full-access`, confirmed in live session projections. The sandbox half of the owner's fallback needs no work.

**Un-pinning is technically reachable, and pointless on this deployment.** The session store is public and appendable (`dsh-session/lib/types/index.d.ts:28`, `:286`), approval policy is a last-write-wins fold read per ask (`dsh-user-approval/lib/index.js:58-63`, `:177-179`), and `agent/created` is awaited before the first turn (`dsh-agent/lib/types/runtime-types.d.ts:242-254`). But the parent's own effective policy here is already `never` — the `danger-full-access` preset pins approval to `never` (`dsh-permission-presets/lib/index.js:383-389`, mapping at `:152-155`) — so mirroring the parent writes `never` and changes nothing.

**Un-pinning is also unsafe as a grant.** Forcing the child to `ask` and then answering it lets the child run wider than its parent: an allow-once *is* the grant, and escalation hands back the **requested** mode (`dsh-sandbox/lib/index.js:151-152`) from a wider-modes table that never consults the parent (`:68-71`), while the request carries the target mode only as prose (`:147`). It also routes a child's ask into the human's approval UI (`dsh-client-ui-approval/lib/client.js:475`) — a worker addressing the user, which AGENTS.md forbids.

**The genuine gap is questions and plan approval.** `dsh-user-questions` throws `UserQuestionError("DELEGATED_CALLER")` for any owned child (`dsh-user-questions/lib/index.js:539-543`), before its own waterfall at `:707-712`, because roots exclude owned agents (`dsh-agent/lib/types/index.d.ts:378`). No approval policy, listener, or spawn option reaches it. The callers that hit it are `ask_user_question` (`dsh-tool-ask-user/lib/index.js:180-198`, `:305-314`) and plan review (`dsh-plan-mode/lib/index.js:264-291`).

## Decision

1. **No in-plugin approval/ask channel for children.** Every in-plugin path that could produce an allow either grants more than the parent could grant itself or needs a host change to be bounded, so none of them is taken.

2. **The sandbox half stands as it is.** Children already inherit the parent's sandbox mode; there is nothing to build and the owner's fallback needs no change there.

3. **Status quo for permission asks.** A would-prompt action stays an immediate, fail-closed error that the child reports in its final answer; the dispatcher decides what to do with the blocker (ADR-0033's path).

4. **The seam is real, and we still do not use it.** In one isolated live probe (port 3099, throwaway home), setting a spawned child's policy to `ask` from `agent/created` and registering a plugin listener on `approval/request` made the listener fire, with the child ending in its answer in about 1 ms and no hang; on the control child, with the host pin untouched, the listener never fired and the ask returned `rejected` in about 1 ms, also without hanging. That proves mechanics only: the probe's child received the listener's fixed outcome string, not a value round-tripped from a parent agent.

5. **Ask upstream for the rest.** A genuinely parent-answered ask needs a request id, an in-memory store, a parent-facing answer tool, a later parent turn, and a bounded wait ending in deny — a host change. User questions and plan approval need a host change outright. Ticket 294 carries that request as an option for the owner; this ADR recommends it and takes neither path itself.

## Consequences

- A child that hits a gate keeps failing closed and instantly, which is the behaviour ADR-0033 already recorded.
- **Nothing shipped, and nothing to ship:** no source change, no config, no listener, no policy write, no ticket edited by this pass. The tracker now reads: tickets 289 (un-pin), 290 (parent answerer) and 291 (contract wording) are cancelled and point here; 292 holds the isolated probe behind decision 4; 293 records the limit that stands; 294 records the upstream host change as an option for the owner, which this ADR recommends and does not take.
- If a future ticket ever does use the `agent/created` append, it must stay on that hook: it is serial and runs before the child's first turn, so it does not race — a post-start append would.
- Any future ask must carry its own bound ending in deny: the host puts no TTL on an approval request (bounded only by the request signal, `dsh-user-approval/lib/index.js:197-213`) and the child's tool call blocks while it waits (`dsh-tools/lib/pipeline.js:387`, `:624`), while a parent can only answer on a later turn, because `sendMessage` steers and acks only (`dsh-subagent/lib/index.js:3087`).
- The risk is asymmetric: faking an ask channel would put a worker in front of the user and hand out a grant its parent never had. The limit is stated to the worker as a limit.

## Alternatives considered

1. **Un-pin the child at `agent/created` and answer its ask** — rejected. On this deployment it is a no-op (mirroring the parent writes `never`), and as a real grant it opens the widening hole: the answer returns the requested escalation mode without consulting the parent, and it puts a worker's request in front of the human.
2. **A deny-only fence on `tools/pre-execute`** — rejected. It can only deny what `never` already denies, so it adds a listener and a maintenance surface for no change in outcome.
3. **A host change, requested upstream** — **chosen** for ask-tool and plan questions. It is the only path that can bound the wait, keep the parent's authority, and keep a worker away from the user.
4. **Status quo** — **chosen** for permission asks: the child reports the blocker, which is what the host already enforces and what ADR-0033 recorded.
5. **Create worker sessions directly, bypassing the subagent activation path** — rejected. It does not escape the pin either: the permission preset also runs on `agent/created` (`dsh-permission-presets/lib/index.js:193-195`, filling at `:376-395`) and writes the default preset's approval policy, `never` on this deployment, so root sessions already carry it. It would only work under an `ask`-effective preset, and it reimplements about five internal-only behaviours (settlement notices, resident-only quiescence, the activation pool, catalog membership, send-message adjacency) — out on both counts.

