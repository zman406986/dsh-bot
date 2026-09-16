# 13 — Permission and secret relay

**What to build:** What happens when a worker hits a wall only the user can clear — an action that needs approval, or a credential it does not have. Without this, the stream either fails silently or hangs forever, and "the dispatcher always tells you when work is done" stops being true.

**Blocked by:** 11 — Dispatcher tools + policy prompts.

**Status:** ready-for-agent

Note: dsh ships approval and credential seams (`dsh-user-approval`, `dsh-credentials`, `dsh-permission-presets` — see `docs/research/dsh-local-install.md`). Build the relay on those rather than inventing a request flow.

- [ ] A worker that needs approval for an action emits a structured request instead of stalling.
- [ ] The request wakes the dispatcher, which either asks the user or applies a stored policy for that class of action.
- [ ] The answer is steered back into the same worker, which continues without restarting.
- [ ] A request that is not answered within a defined timeout is denied by default, the stream is closed honestly, and the user is told the stream stopped waiting.
- [ ] A denied request is reported to the user as a denied action, not as a task failure with no reason.
- [ ] A worker that needs a credential receives it only by scoped injection — never as text in its prompt and never discoverable by asking.
- [ ] No stream can wait on a permission request indefinitely; the timeout is observable in a test that never answers.