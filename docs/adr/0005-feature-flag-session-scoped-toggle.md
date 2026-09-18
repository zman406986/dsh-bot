# Feature flag is session-scoped, not a live toggle

**Status:** SUPERSEDED by ADR-0018 (2026-09-18) — flag/toggle semantics voided; the dispatcher is always-on with no mode

The `multitask_dispatcher` flag ships **ON by default in the dedicated multitask profile and OFF in stock/default profiles**. The kill switch is a **user-facing config-profile/UI control, but it is not live-applied to a running session**: a change takes effect at the **start of the next session with the dispatcher**. There is therefore **no "dispatcher OFF while workers run" state**, and no held-result semantics to define.

## Context

- PRD §11.5 (Integration checklist): "Feature flag: `multitask_dispatcher` default **ON** for the chosen profile; kill switch without rebuild if dsh supports live config."
- PRD §15.6 was the last open item under §15: "Default feature flag ON/OFF for first release."
- Interview question (Q5/Q9): ship `multitask_dispatcher` ON or OFF by default, and in which profile? Does the kill switch need live config, or is a config/profile flip enough? Human's first answer: "need to add a live config button." Human's later answer (Q9), on what a held result is in the durable store when the dispatcher is toggled off while workers run, was to **avoid the state entirely**: the switch is **not hot** — the flag can only be applied at the beginning of a session with the dispatcher, and flipping it affects the next dispatcher session, not a running one.
- The profile split is uncontested and stands; the later answer scopes *when* a flag change applies, not *which* profiles default ON.
- A single flag suffices; no experiments/feature-flag framework is in scope (`docs/research/prd-vs-reference-capability-gaps.md`, "Deliberately out of scope").

## Considered options

| Option | Rejected because |
|---|---|
| **A. Profile default (ON in multitask profile, OFF in stock) + session-scoped config toggle** | **Chosen.** The toggle is still a user-facing control with no rebuild and no file hand-editing, but it is read once at dispatcher-session start. Removes the entire off-while-running state and its held-result bookkeeping. |
| B. Live runtime toggle applied mid-session | **Superseded** (this ADR's earlier version). It forced an undefined held-result state, a durable-holding requirement, and a toggle-ON backlog policy (re-deliver vs history). The human removed the state rather than specifying it. |
| C. Config-file-only flip requiring restart | Still rejected: the human asked for a UI control, and a disk edit is not user-facing. Session-scoped application keeps the control while matching what dsh's session model supports. |
| D. Compile-time flag | Requires a rebuild to change state, contradicting the "without rebuild" posture of PRD §11.5. |
| E. No flag at all | No way to disable an always-on dispatcher. |

## Consequences

- The flag is read **once at dispatcher-session start** and fixed for that session's lifetime. The multitask core reads and honours the value it was started with; it never observes a mid-session change.
- The config surface (profile setting / UI control) is a **host/dsh-adapter** concern; it writes the setting for *future* sessions. This matches the layer split in AGENTS.md and the in-process core boundary of ADR-0001.
- ~~Dispatcher enable/disable transition. In-flight workers are **not aborted and not parked**: on OFF they **run to completion with results retained**. Host jobs are not silently orphaned; a worker that settles while the flag is OFF keeps its result instead of dropping it or waking a disabled dispatcher.~~ **Superseded by this ADR's corrected decision:** there is no toggle-OFF-while-running transition, so no run-to-completion rule is needed. (This paragraph also supersedes **Q6**; see PRD §15.)
- ~~Held results are written to **dsh's session/job store** (durable, survives restart; no second transcript DB — AGENTS.md "Persistence"). This overrides PRD §7.5's v1 deferral of durable storage (amended).~~ **Superseded by this ADR's corrected decision:** with no off-while-running state there are no held results, so nothing needs holding. (This paragraph also supersedes **Q8**; see PRD §7.5 and §15.)
- ~~For a result that settles while OFF the delivered/undelivered decision in this window, and what toggle-ON does with the backlog (re-deliver, or treat it as history), are **not decided here**.~~ **Superseded — moot:** the window no longer exists.
- For everything the PRD leaves open, the pre-existing rule in AGENTS.md "Source of truth" governs with no special case: observe the reference implementation and imitate it.
- ~~**Unresolved (real open question, not decided here):** whether `WorkerRecord` and `SteerTicket` should be durable in the dsh session/job store at all. Reference recon has since found the reference keeps worker records and steer tickets **in memory**, persisting only per-agent transcript/KV state, conversation state including the todo list, and small control-plane obligation files. Durable core state is therefore **not** a settled override of PRD §7.5; see PRD §7.5 and §15.~~ **Resolved by ADR-0006 (Q10): hybrid split** — a minimum-to-reconstruct `WorkerRecord` (worker id, transcript pointer, todo link, status) is durable via the control-plane obligation-marker idiom, while `SteerTicket` stays in-memory. The durable half is a deliberate divergence from the reference, not an imitation. See PRD §7.5 and §15.7.
- PRD §6.1, §11.5, §15.6 and §7.5 are amended to match; PRD §15.6 is closed. The one open item this ADR previously surfaced (durable `WorkerRecord`/`SteerTicket`) is now closed by ADR-0006, so **PRD §15 has no open items**.
- AGENTS.md "Open decisions" line already points at the ADR index as the record of resolved decisions; its §15.7-open wording was amended by ADR-0006 to state that §15 is fully resolved.