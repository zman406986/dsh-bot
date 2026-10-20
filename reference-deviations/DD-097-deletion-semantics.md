# DD-097 — Destructive delete (agent + history) vs non-destructive unbind
- **Area:** sidebar / roster / agent management (A11)
- **Type:** deliberate-divergence (safety-ruled)
- **Date:** 2026-09-23

## What the reference does
The reference sidebar's delete affordance opens a dedicated destructive-confirmation dialog (a confirm button styled as dangerous, keyboard focus trapped inside, Escape or backdrop click to cancel). Its copy states the action **permanently destroys the agent together with its entire chat history**, with no way to undo it. For the group variant the copy is scoped differently: the group and its history are destroyed, but the member bots survive and stay individually available. The confirmation is presented as UI recovered verbatim from the shipped bundle (evidence pointer to the shipped renderer bundle in the file header), so destructive delete of agent + history is the reference's actual production behavior, not a mock.

## What the current build does
The build's delete and close buttons never destroy anything. Both route the same single intent: the composition runs `/dispatcher-stop` in that session through the one command transport, which deactivates the dispatcher binding only — tools unbound, access-policy rows and the roster mirror cleared. The comments are explicit that **the dsh chat itself is NEVER disposed**: after the host's mirror clear arrives, the row simply re-renders as a normal (non-dispatcher) session, with all of its history intact and no optimistic flip. The two-step confirmation (a second press inside a time window) gates the click, but what it confirms is an unbind, not a destruction. The wording of the close button ("Close dispatcher") was chosen deliberately to stay clear of stop/cancel/kill-style host keys while naming the session-lifecycle action.

## The deviation
Same button label ("delete"), radically different thing being destroyed. The reference deletes the durable artifact — the agent record plus its whole conversation history — irreversibly. The build deletes only a binding: the dispatcher's activation of a session that continues to exist. Under the reference model, confirm means permanent data loss; under the build model, confirm means the session stops being a dispatcher and drops back into the ordinary roster. A user migrating expectations from the reference would believe history is being destroyed when it is not (a safe direction to fail), but the inverse — expecting unbind and getting destruction — is the dangerous direction, which is exactly what ADR-0021 rules out.

## Verdict: DO-NOT-INCORPORATE
ADR-0021 decision 3 is a human-ruled, conservative default and the second level in the precedence order: delete = deactivate the dispatcher binding, and "disposing the dsh chat itself" remains a dsh-native action, never a button of ours — a ruling the build's shell comments repeat verbatim. A genuinely destructive delete of a session and its history from our plugin surface would therefore be a major change of approach requiring a dated human reversal of ADR-0021 decision 3 (and a re-examination of ADR-0018's U-G amendment, which was scoped to dispatcher sessions only, not to transcript destruction). The recorded rulings settle the question and are not reopened on their own, so the reference behavior stays unincorporated unless the human explicitly rules again.

## Incorporation notes
- **Where it would live:** if ever re-ruled, the destruction path could not be the current button (which is one `/dispatcher-stop` transport in the composition, per ticket 101; ticket 106's close button shares it). It would need a dsh-native or host-level deletion path for the session record/transcript, a revised confirmation whose copy names the destruction (mirroring the reference's agent-vs-group copy split), and a new ticket + ADR amendment recorded before implementation.
- **Constraints:** ADR-0021 decision 3 (never-dispose rule); ADR-0018 U-G as amended (runtime agent management excluded beyond dispatcher binding); ADR-0010 no optimistic flip; PRD non-goals (no dsh chat/transcript runtime rebuild); the single-transport rule in the shell comments.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — a new destructive backend path plus an ADR-level human reversal; high risk (irreversible loss of user chat history from a plugin surface, contradicts the ruled safety approach).
- **Key reference anchors:** `the reference tree's frontend/src/production/AgentDeleteConfirmation.tsx` — the deletion-description copy constant (permanent delete of agent + history; group variant spares member bots) and the danger-styled confirm button in the alert dialog.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/AgentDeleteConfirmation.tsx` (destructive copy lines 19–22, danger confirm line 100)
- Build: `src/client/shell.tsx` (header comments lines 46–57; delete button lines 284–292 with the never-disposed rule at 289; close button lines 293–306, row re-renders as normal session at 297–300); `src/client/shell-store.ts` (ADD/Delete affordance view-model comments from line 370); `docs/adr/0021-addon-coexistence-floating-dispatcher-window.md` decision 3 (line 19)
