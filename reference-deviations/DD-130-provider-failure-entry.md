# DD-130 — Synthetic error transcript entries vs settle-event error reporting
- **Area:** inference routing & streaming (A15)
- **Type:** deliberate-divergence (opposite honesty stance: the reference disguises the failure as an assistant reply)
- **Date:** 2026-09-23

## What the reference does
When a queued prompt's executor rejects, the prompt-send dispatcher's catch handler (in the node-agent-coordinator router) fabricates a message by wrapping a hard-coded error prefix around the thrown error's text, then appends it to the agent's persisted transcript as an assistant-role entry, and emits a transcript-append event so clients render it in-conversation. The failure thus appears as something the assistant said, indistinguishable in role from real model output (the reference tree's source/node-agent-coordinator/inference-router.ts:216-224; this error-prefix pattern appears exactly once in the reference tree).

## What the current build does
Executor/worker failure surfaces as a `SettledEvent` (`{ workerId, status, report }`) raised from the adapter's `subagent/end` subscription and fanned out to settled callbacks — the wake/report path, not a transcript row. The report text comes from `normalizeSettleReport`, which for an aborted status keeps only real last-assistant text and otherwise returns empty ("Abort must not invent a report"), and ticket 41's excerpt clamp stores nothing when the report is empty — an absent excerpt rather than an invented one. Status is honestly attributed by mapping the stop reason to a terminal status (`error`/`aborted`/etc.), and the roster's check row shows the terminal status per the ticket 29 rule that settled workers show their real final status (src/adapter/cordis-dsh-host.ts:463-494; normalizeSettleReport at src/adapter/cordis-dsh-host.ts:380-388, rule at :386).

## The deviation
Both designs make provider/executor failure user-visible, but they take opposite stances on honesty. The reference disguises the failure as a synthetic assistant transcript entry — fabricated role, persisted, event-emitted — so the conversation history itself contains an invented statement. The build never writes a fabricated entry; the failure is attributed as an error settle carrying real (possibly empty) text, and the "no invented report" rule is ADR-documented. The build's absence of a synthetic error row is a deliberate divergence, not a gap.

## Verdict: DO-NOT-INCORPORATE
The build's behavior is the ADR-0012-cited rule taken to its root: never invent state — and that principle applies with full force to a fabricated assistant message, which is precisely what ADR-0012 and the ticket 29/41 rules forbid (empty report → no excerpt, never an invented one). Both approaches do surface errors to the user, so nothing of user value is lost by the divergence; the only difference is whether the failure is disguised as an assistant message or honestly attributed as an error settle. Incorporating the reference pattern would also violate the build's "no second transcript" discipline (ticket 41 comments in src/adapter/cordis-dsh-host.ts:452-456). Human reversal remains possible under the authority stack, but there is no recorded decision pointing that way.

## Incorporation notes
- **Where it would live:** If a human ever overrode this, the place to change would be the same adapter settle path in `src/adapter/cordis-dsh-host.ts` (`subagent/end` handler / `normalizeSettleReport`), plus the primary's report rendering — not a router-level transcript append; the build has no persisted per-worker transcript to append to by design.
- **Constraints:** Honesty rules (ADR-0012 "never invents state the markers do not carry"; ticket 29 terminal-status honesty; ticket 41 no-invented-excerpt) forbid fabricating assistant-role content; the core stores no report text and no second transcript exists.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — no code change; this entry exists so reviewers do not mistake the missing synthetic error row for a gap (DD number for related streaming deviations: pending, see reference-deviations index).
- **Key reference anchors:** the reference tree's source/node-agent-coordinator/inference-router.ts:216-224 (executor-failure catch: error-prefixed synthetic assistant entry appended to store + transcript-append emission; :218 is the sole error-prefix construction in the tree).

## Evidence
- Reference: "reference material-NOT LICENSE SAFE DONT COPY-grok bot"/source/node-agent-coordinator/inference-router.ts:216-224 (verified: synthetic assistant-role append + transcript-append event in the failure catch; :218 sole occurrence of the error-prefix pattern).
- Build: src/adapter/cordis-dsh-host.ts:463-494 (verified: `subagent/end` → `SettledEvent` with `normalizeSettleReport` report via settled callbacks, no transcript fabrication); src/adapter/cordis-dsh-host.ts:380-388 (verified: "Abort must not invent a report; keep any real text, else empty"); docs/adr/0012-restart-replays-durability-never-work-draft-nonhuman-approved.md:11 ("invents state the markers do not carry" never-rule).
