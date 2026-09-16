# Worker access asks use a custom structured relay, not dsh's child approval waterfall

**Status:** accepted

Workers that hit a gated action or need a credential emit a **structured `request_access` tool ask**, relayed through the dispatcher core. The answer rides the existing `host.sendMessage` path into the same worker (context preserved, no restart). We do **not** override dsh's child `approval/policy` pin and we do **not** relay worker asks through `dsh-user-approval`'s waterfall.

**This is a deliberate divergence from dsh's native child-approval path.**

## Context

- dsh pins delegated children to `approval: 'never'` whenever the approval capability is composed (`docs/research/dsh-adapter-api-notes.md` §9). A child's interactive approval asks are rejected deterministically — "a delegated child acts only within the sandbox scope fixed at delegation."
- Ticket 13 AC requires: structured request → wake dispatcher → ask user / stored policy → steer answer back; default deny + timeout; honest deny reporting; credentials scoped-injection only; a testable unanswered timeout.
- Fighting the pin (override after start + waterfall relay) leaves us without first-class timeout default-deny and contradicts an intentional host rule.
- Pre-approving everything via `toolFilter` + scoped credentials is chosen for credentials and the boring default class of tools, but is not sufficient alone — unknown gated actions still need a path.

## Decision

| Piece | Choice |
|---|---|
| Worker ask | Custom `request_access` tool (new copy). One outstanding ask per worker. |
| Relay | In-memory `AccessTicket` + `createAccessRelay` in the multitask core. |
| Answer | Existing `host.sendMessage` with `wrapAccessDecision` — not a new host method, not a steer ticket. |
| Wake | Additive `worker-access-request` source + `accessRequests` on `WakeEvent`. |
| Policy | Session/profile table (`createAccessPolicyTable`); no hit → ask. Shipped seed is empty (every class asks). |
| Timeout | `accessRequestTimeoutMs` (Config, default 120s). Unanswered → deny `reason: "timeout"`. |
| Credentials | `SpawnOptions.credentialNames` allow-list; resolve only inside adapter/tools. `AccessDecision` has **no value field**. |
| dsh glue still used | `dsh-permission-presets` (stored policy classes), `dsh-credentials` (scoped injection). `dsh-user-approval` is dispatcher-side only, optional, never the worker path. |

## Consequences

- Timeout / default-deny / one-slot discipline are ours; we do not inherit waterfall semantics we cannot observe.
- Tickets are in-memory (same durability rule as `SteerTicket` — ADR-0006). Restart while an ask is pending is honest amnesia.
- Secret values never enter core types, prompts, steers, or logs. Tests T11–T12 lock that in.
- If a future dsh release offers a first-class child-ask bus that respects timeout and honest deny, we may revisit — until then this fork stands.

## Alternatives considered

1. **Override child `approval/policy` after start, relay via waterfall** — rejected: fights the delegation pin; no first-class timeout default-deny.
2. **Custom structured ask tool + dispatcher relay** — **chosen**.
3. **Pre-approve everything via toolFilter + scoped credentials** — partial; chosen for credentials and boring tools only.
