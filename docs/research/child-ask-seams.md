# Child ask seams: can a delegated dsh child ask the user anything?

**Question:** when a worker we spawn hits a permission gate, or wants to put a question to the
human, does that request reach an answerer at all — and if it could, which seam would carry it?
This note pins the evidence so a design decision (and its ADR) can cite it without re-reading the
host.

**Scope:** the installed host at `C:\Users\TZ\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`
(`@deepseek-ai/dsh` and `dsh-subagent` are **0.2.2-rc.1**; the `dsh-*` packages sit under its
nested `node_modules/@deepseek-ai/`). Method: read-only, one targeted read per claim. Repo-side
refs are this tree. The reference folder was not opened.

## Findings

1. **A delegated child's approval policy is pinned to `never`.** When the parent has an approval
   service, the capture function returns policy `"never"` regardless of the parent's own setting
   (`dsh-subagent/lib/index.js:414`); the value is appended to the child's own log as an
   `approval/policy` event tagged `source: "delegation"` (`dsh-subagent/lib/index.js:431-434`);
   and it is applied from the child's create setup hook, before the first prompt is queued
   (`dsh-subagent/lib/index.js:1807`; the prompt is submitted at `:1466`).

2. **The pin is checked before any answerer is reached.** `decide()` returns `"rejected"` at
   `dsh-user-approval/lib/index.js:200` when the session's effective policy is `never`, one line
   before the `approval/request` waterfall at `:201`, so a pinned child's ask never leaves the
   process (`dsh-user-approval/lib/index.js:197-201`). Precise phrasing: the audit pair is still
   written (`approval/asked` at `:157`, `approval/decided` at `:164`) — what never happens is
   dispatch to an answerer.

3. **The answering seam that does exist is an open waterfall.** `approval/request` is declared as
   a scoped waterfall, `(req, next) -> ApprovalOutcome`
   (`dsh-user-approval/lib/types/types.d.ts:75-81`), with a closed outcome vocabulary:
   `allowed-once` | `rejected` | `cancelled` | `unavailable`
   (`dsh-user-approval/lib/types/types.d.ts:26`). A waterfall listener that returns without calling
   `next` vetoes the rest of the chain including the built-in behavior
   (`cordis/lib/index.js:903-918`), and `prepend` puts a listener ahead of the existing ones
   (`cordis/lib/types/events.d.ts:101-106`). So an in-process plugin can answer with no UI at all.

4. **User questions are blocked harder than approvals.** `assertLiveRoot` throws
   `DELEGATED_CALLER` for any agent owned by another live agent
   (`dsh-user-questions/lib/index.js:539-543`, throw at `:542`) and runs before the
   `user-questions/request` waterfall at `:709`. Real callers pass the calling agent:
   `dsh-tool-ask-user/lib/index.js:186-189`, `:305-314`, and `dsh-plan-mode/lib/index.js:268-289`.
   A child therefore gets an immediate error, not a wait — the error text tells it to carry the
   unresolved question in its final result.

5. **The pin exists only in the subagent path.** A child created directly through
   `ctx.agents.create({ parentAgent })` is not pinned, so for it `approval/request` would dispatch
   and honour a plugin answerer. It still cannot ask a user question: `roots()` returns live
   top-level agents only, those created without an owning agent context, so an owned child is not in
   it (`dsh-agent/lib/types/index.d.ts:378`).

6. **There is no spawn-time override.** Neither `SubagentActivationSpec`
   (`dsh-subagent/lib/types/types.d.ts:25-38`) nor `SubagentStartRequest`
   (`dsh-subagent/lib/types/types.d.ts:127-174`) carries an approval or permission field; the setup
   hook that applies the pin is minted inside the manager (`dsh-subagent/lib/index.js:1802-1830`);
   and the subagent plugin's own config has just two knobs, `maxDepth` and `maxActiveSubagents`
   (`dsh-subagent/lib/index.js:2992-2995`). A caller cannot opt out.

7. **The permission-preset service cannot undo the pin.** `pinInitialPermission` fills only knobs
   that are still missing — the all-null fresh-session branch
   (`dsh-permission-presets/lib/index.js:383-390`) and the per-knob `=== null` fills (`:393-394`) —
   and a child already carries `approval` from its delegation event, so nothing is overwritten.

8. **Today the human is reached through the browser client.** Both answerer families are registered
   as client-side waterfall remotes (`dsh-client-ui-approval/lib/client.js:475`,
   `dsh-client-ui-user-questions/lib/client.js:2277`), forwarded by `dsh-api-remotes/lib/index.js:27`,
   `:144`, and surfaced as `pendingInput` kinds by
   `dsh-api-session-controller/lib/index.js:2361-2368`. Because a waterfall is first-claimer-wins
   (finding 3), a plugin that answered with `prepend` for a **root** session would run ahead of the
   web UI and take the question away from the human.

9. **UNSETTLED — the fork backend.** Whether `dsh-subagent-fork-in-process` pins the same way was
   not established; the command I ran and what it did and did not show are recorded below.

10. **Our own spawn call has no permission field either.** `startActivation`
    (`src/adapter/cordis-dsh-host.ts:4132`) passes provider, label, childId, request, signal and
    delivery only, and `SpawnOptions` (`src/core/types.ts:66-95`) declares none. The pin is not
    something our adapter chose; it arrives with the host's delegated-spawn path.

Every citation above was re-read at the stated lines in this pass; none was left unverified.

## What this means

- **A delegated child cannot ask anyone, by construction** — not by a policy we set. Approval is
  auto-rejected before the answerer chain; user questions throw before the waterfall. Any design
  that expects a worker to pause for a human decision does not work on this host path.
- **The consequence is a contract, not a workaround:** unresolved questions and decisions have to
  travel back in the child's final result and be asked by the dispatcher, which is a root.
- **`approval/request` is a usable seam only outside the pinned path.** In-process answering with
  `prepend` is real and honoured, but only for agents whose policy is not `never` — i.e. not for the
  children we spawn.
- **Do not register a plugin answerer to intercept root asks.** First-claimer-wins would preempt the
  browser UI and silently swallow the human's interaction.
- **Reaching a child's ask would mean leaving the subagent path** (finding 5) — and even then user
  questions stay refused, so the gain is approvals only.

## Unsettled

- **Does `dsh-subagent-fork-in-process` pin like the spawn path?** Command run:

  `rg -n -e "approvalPolicy|approval/policy" ...\dsh-subagent-fork-in-process\lib`

  Result: **no matches**, and that does not settle it — the package is 55 lines that only register a
  provider, so it holds no policy code either way. One more read narrows it without closing it:
  providers exposing `prepareContinuable` are routed to the local start path
  (`dsh-subagent/lib/index.js:3062`), which is where the pin is captured (`:1418`) and applied
  (`:1807`) — dispatch evidence, not evidence from a fork child's log. To close it, spawn one fork
  child and read its session log for an `approval/policy` event with `source: "delegation"`; without
  a live host the question stays open.
