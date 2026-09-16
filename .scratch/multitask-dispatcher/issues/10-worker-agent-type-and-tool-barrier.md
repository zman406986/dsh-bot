# 10 — Worker agent type + tool barrier

**What to build:** What a worker actually is. It gets the full set of work tools and nothing else: no way to talk to the user, no way to reach another agent, no way to spawn, and no todo list. Its prompt is self-contained and its final answer is the stream's report.

**Blocked by:** 09 — dsh adapter wiring.

**Status:** ready-for-agent

- [ ] A worker starts with a blank context — no dispatcher memory, no sibling transcripts, no user chat.
- [ ] A worker is offered the work tools (shell, filesystem, search, web, and the other task tools as available).
- [ ] A worker is not offered, and cannot execute, any user-messaging tool, any peer/agent-messaging tool, any spawn tool, any worker-management tool, or any todo tool. The restriction removes them from the worker's prompt and refuses execution.
- [ ] The worker's prompt states: it is a delegated worker, it must complete the task autonomously, it has no way to talk to the user, it must not ask follow-ups, and it must end with a concise plain-text final answer that goes back to the parent.
- [ ] A worker's final text arrives as that stream's report; an empty result is replaced with a placeholder noting no text output, and an error outcome carries the error message.
- [ ] A worker never spawns another worker — attempting it is impossible via the tool barrier, not merely discouraged.