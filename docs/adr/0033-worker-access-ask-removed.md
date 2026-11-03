# Worker access asks are removed; a blocked worker reports and stops

**Status:** accepted (owner-ruled 2026-11-03)
**Supersedes:** ADR-0008 (`0008-worker-access-ask-structured-relay.md`)

A delegated worker has **no ask channel**. When the work needs access it does not have, it says so in its final answer and ends. There is no `request_access` tool, no relay, no dispatcher-side approval prompt, and no `/dispatcher-resolve`.

## Context

ADR-0008 introduced a custom structured `request_access` relay because dsh pins delegated children to `approval: 'never'`, so a child cannot ask for approval through the host's own waterfall. The relay gave workers a way to ask through the dispatcher instead.

That whole mechanism was our invention. It does not exist in the reference:

- No `request_access`, `requestAccess`, or access-relay name anywhere in the reference tree `source/`. The only matches are unrelated generated proto files.
- The reference's only asking-related copy is the opposite: `buildAntiAskQuestionUserRule` tells agents not to ask for help, details, feedback, or confirmations (`source/packages/agent/prompts/anti-ask-question-copy.ts`).
- Its one approval path is a retry flag on MCP calls (`requestSmartModeApproval`) — a user-facing approval card, not a worker relay.
- The reference's subagent tooling has no access tool.

The reference's actual answer to a blocked worker is: the host pins the child's approval to `never`, the child's `subagent:delegation` runtime-context section states that scope cannot be widened, and the worker reports the limitation.

The owner reviewed this and ruled the feature out (2026-11-03): *"delete Access policy entirely"*, confirmed as *"cut the whole feature"*.

## Decision

Remove the worker access-ask feature in full. The worker contract's `## Limits` states the surviving rule: scope is fixed at start, you cannot widen it, so when the task needs more, report what was blocked and why instead of asking.

Kept, deliberately:

- **`subagent:delegation`** — the host's own fixed section. It is now the sole statement of the access limit, and the worker contract leans on it rather than restating it (the contract header's standing rule).
- **`reply_to_dispatcher`** — the mid-task reply channel (ADR-0028). A separate lane; a blocked worker still reports early through it.
- **The worker tool barrier** — unrelated to asking.

## Consequences

- A worker that genuinely cannot proceed now ends the task with an honest report. The dispatcher reads the blocker and decides: steer with what it knows, stop the worker, or dispatch different work. This is the ADR-0028 path, which already existed.
- No new negative outcome is created: with `approval: 'never'` pinned by the host, the old relay could only ever produce an allow the host had already decided against or a deny. The path was a round trip to a decision the host had made at spawn.
- `accessRequestTimeoutMs` disappears from Config; one settings-card row and its EN/ZH locale strings go with it.
- The roster snapshot loses its `pendingAsks` field — a wire-format bump (v4 → v5).
- `/dispatcher-resolve` is withdrawn. Anyone scripting it loses the command; there is nothing to resolve.
- Tickets were in-memory (ADR-0006's durability rule), so nothing persisted is orphaned.
- Secret values can no longer travel through an ask path at all, because the path is gone. ADR-0008's T11–T12 secret-hygiene tests are deleted with the feature; the name-only rule survives in the worker contract's `## Safety`.

## Alternatives considered

1. **Keep the relay, delete only the prompt text** — rejected by the owner. The tool would stay registered while nothing tells a worker to use it, which is a dead surface with a maintenance cost and a misleading tool list.
2. **Re-wire the relay onto dsh's native approval** — rejected. It fights the host's deliberate delegation pin, and ADR-0008 already examined and declined that path.
3. **Remove the feature and rely on the host pin plus honest reporting** — **chosen**. It matches the reference, removes our invention, and loses no capability the host actually grants.
