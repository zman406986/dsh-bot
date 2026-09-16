# 12 — Feature flag + profile split

**What to build:** The switch that decides whether a dsh installation has a dispatcher at all. It is on in the dedicated multitask profile, off everywhere else, and it is decided at the start of a session so it can never be half-applied.

**Blocked by:** 11 — Dispatcher tools + policy prompts.

**Status:** ready-for-agent

Note: the multitask profile must be created — only `web` exists on this machine (`docs/research/dsh-local-install.md`). Ticket 01 establishes it; this ticket owns the flag semantics.

- [ ] The `multitask_dispatcher` flag is ON in the dedicated multitask profile and OFF in stock/default profiles.
- [ ] The flag is read once at dispatcher-session start and fixed for that session's lifetime; the core never observes a mid-session change.
- [ ] The setting is exposed as a profile/UI control that writes the value for future sessions — no file hand-editing and no rebuild required to change it.
- [ ] With the flag off, a session behaves exactly like stock dsh: no dispatcher policy, no dispatcher tools, no wake handling.
- [ ] No off-while-running state exists and no held-result behavior is implemented.
- [ ] A session started with the flag on runs normally with no reference to the flag in any user-visible output.