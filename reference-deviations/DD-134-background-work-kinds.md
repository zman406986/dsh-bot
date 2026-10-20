# DD-134 — Background shell/cloud watches vs single wake family
- **Area:** agent runner / turn execution (A16)
- **Type:** deliberate-divergence (recorded C15)
- **Date:** 2026-09-23

## What the reference does
The reference runner has a dedicated background-work layer. The reference tree's `source/host/runner/background-work.ts` defines a background-work registry that can be revived — a registry of background work items whose completion sets up the wake again, and which survives re-watching across turns — plus two watch starters: one for background shells, which sets up a pending wake of the shell kind and polls the shell's terminal output file until the command settles, and one for cloud agents, which sets up a cloud-agent pending wake and awaits a remote watcher's completion promise. Adjustable settings: a 10-second default poll interval (overridable by an environment variable), a 5-hour maximum wait, and a give-up threshold of 5 consecutive missing file reads. The reference tree's `source/host/runner/shell-terminal-watch.ts` implements the poll loop: it reads the terminal file against the 5-hour deadline, parses a footer for an exit code (success on 0, error otherwise, with a stream-failure distinction), stops after the missing-read give-up threshold, and on timeout reports the command as still running while pointing the agent at the output file. Both watches are shown to the model as async tasks through the turn-observation module's async-task listing.

## What the current build does
`src/core/wake-bus.ts` recognizes a single closed family of wake sources: `user`, `worker-settled`, `worker-access-request`, `peer`, and `timer`. There is no shell-terminal watcher, no cloud-agent watcher, no background-work registry, and no shell or cloud wake kind anywhere in the build surface; background command completion is not a wake source, and long-running shells are not tracked as async tasks.

## The deviation
The reference turns finished background shells and remote cloud-agent runs into first-class wake sources that re-open a turn and report their result; the build deliberately carries only the one wake family ruled in ADR-0018 exception C15 (single wake kind, no background one-shots, no remote/cloud jobs). The entire reference background-work/watch layer is unbuilt.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 exception C15 explicitly records this divergence: the dispatcher has one wake family, and background one-shots plus remote/cloud jobs are out. The authority stack settles it — an accepted ADR outranks reference practice, and cloud-agent watching additionally sits in remote-infra territory the PRD's non-goals exclude. Shell-terminal watching is only indirectly remote-adjacent (it watches local shell output files), but it exists in the reference to feed the same background one-shot wake machinery C15 rules out, so the two halves stand or fall together. Reversal requires a new human ruling, not a port.

## Incorporation notes
- **Where it would live:** if ever ruled in, a wake-bus source extension in `src/core/wake-bus.ts` (the bus already anticipates later sources), a watch module beside the worker core, and async-task surfacing on the dispatcher's task list.
- **Constraints:** ADR-0018 exception C15 must be superseded by a human ruling first; the build's worker model exposes no terminal output file to poll, and cloud-agent watching is remote-infra adjacent (excluded scope).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the wake-bus accepts additional sources by design, but end-to-end needs a shell-file poller, revival/persistence semantics, and task-list surfacing.
- **Key reference anchors:** `background-work.ts` L5 (registry class), L29–L31 (10 s poll default, 5 h max wait, give-up = 5), L48 (the cloud-agent watch starter), L49 (the background-shell watch starter); `shell-terminal-watch.ts` L178 (deadline), L209–L216 (footer exit-code parse), L221–L222 (missing-read give-up); `turn-observation.ts` L262 (the async-task listing), L316 (cloud watch entries).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/background-work.ts`, `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/shell-terminal-watch.ts`, `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/host/runner/turn-observation.ts`
- Build: `src/core/wake-bus.ts` (wake-source union, lines 16–28)
