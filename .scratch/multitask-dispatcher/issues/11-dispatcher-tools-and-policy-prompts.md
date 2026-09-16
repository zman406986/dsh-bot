# 11 — Dispatcher tools + policy prompts

**What to build:** The dispatcher's own working surface and the instructions that make it act like one busy person: short turns, delegating the heavy work, steering instead of cloning, reconciling before it speaks.

**Blocked by:** 10 — Worker agent type + tool barrier.

**Status:** ready-for-agent

- [ ] The dispatcher can spawn a stream, check running workers, steer one, stop one, and deliver a message to the user — each surfaced as its own dsh-native tool with dsh-native wording.
- [ ] The spawn result tells the dispatcher the worker runs in the background and its final response will arrive on completion, so it should not wait or poll.
- [ ] The check surface returns elapsed time, tool-call count, recent activity, and the transcript location for each running worker.
- [ ] The dispatcher policy is injected as new copy covering: dispatcher not workhorse; non-trivial multi-step work spawns a worker; independent work runs in parallel; a correction steers rather than clones; a todo entry precedes a spawn; reconcile on every wake; worker prompts are self-contained; workers never message the user; the machinery is never named to the user.
- [ ] Short reminders re-inject the todo list and the policy highlights at the start of each dispatcher turn, rather than relying on a one-time system prompt.
- [ ] The wake turn instructs the dispatcher to lead with the concrete thing that finished and to stay silent when the result is stale or duplicate.
- [ ] Worker report text arriving in the dispatcher's context is clamped with a transcript reference attached, and check/steer results are summarized rather than dumped.
- [ ] No shipped prompt string, identifier, or tool description comes from the reconstruction — all copy is written for this project.
- [ ] A short manual demo shows a long fake worker with rapid user messages: the user is answered within seconds, a mid-run steer changes the worker's direction without restarting it, and the result is delivered to the user at the end.