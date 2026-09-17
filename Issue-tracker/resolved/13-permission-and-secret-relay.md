# 13 鈥?Permission and secret relay

**What to build:** What happens when a worker hits a wall only the user can clear 鈥?an action that needs approval, or a credential it does not have. Without this, the stream either fails silently or hangs forever, and "the dispatcher always tells you when work is done" stops being true.

**Blocked by:** 11 鈥?Dispatcher tools + policy prompts.

**Status:** resolved

Note: dsh ships approval and credential seams (`dsh-user-approval`, `dsh-credentials`, `dsh-permission-presets` 鈥?see `docs/research/dsh-local-install.md`). Build the relay on those rather than inventing a request flow.

Fork recorded in [ADR-0008](../../../docs/adr/0008-worker-access-ask-structured-relay.md): custom structured `request_access` tool + core relay; not dsh's child approval waterfall (delegation pin + default-deny timeout).

- [x] A worker that needs approval for an action emits a structured request instead of stalling.
- [x] The request wakes the dispatcher, which either asks the user or applies a stored policy for that class of action.
- [x] The answer is steered back into the same worker, which continues without restarting.
- [x] A request that is not answered within a defined timeout is denied by default, the stream is closed honestly, and the user is told the stream stopped waiting.
- [x] A denied request is reported to the user as a denied action, not as a task failure with no reason.
- [x] A worker that needs a credential receives it only by scoped injection 鈥?never as text in its prompt and never discoverable by asking.
- [x] No stream can wait on a permission request indefinitely; the timeout is observable in a test that never answers.

## Implementation notes (ticket 13)

| Piece | Where |
|---|---|
| Message shapes (`AccessClass`, `AccessRequestBody`, `AccessRequestEvent`, `AccessDecision`, `AccessTicket`, notices) | `src/core/access-types.ts` |
| Relay + timeout + `wrapAccessDecision` + policy table | `src/core/access-relay.ts` |
| Host seams (`onAccessRequest`, optional `resolveCredential`) | `src/core/dsh-host.ts`, `src/adapter/cordis-dsh-host.ts` |
| Fake host helper (`fireAccessRequest`) | `src/core/fake-host.ts` |
| Wake source `worker-access-request` + `accessRequests` / `accessNotices` | `src/core/wake-bus.ts` |
| Multitask wiring (clear on abort/settle, resolve 鈫?sendMessage) | `src/core/multitask.ts` |
| Worker tool `request_access` | `src/adapter/worker-access-tool.ts` |
| Assembler extension + access policy copy | `src/core/policy/assembler.ts`, `src/core/policy/prompts.ts` |
| Config `accessRequestTimeoutMs` (default 120_000) | `src/plugin.ts` |
| Tests T1鈥揟14 + policy/tool units | `test/access-relay.test.ts` |

Secret values never enter core types, prompts, steers, or logs. `AccessDecision` has no value field. Tickets are in-memory (ADR-0006 rule).

## Comments

- Moved to resolved by overnight sweep 2026-09-18: all ACs checked; verified via implementing commits and artifact spot-check on main.
