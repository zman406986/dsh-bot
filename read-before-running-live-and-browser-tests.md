# Read before running live dsh or browser tests

> **Source note:** every rule below was **moved from `AGENTS.md` §Browser self-testing (authorized) + §Kill timers (mandatory), 2026-09-20, unmodified** (ticket 97). `AGENTS.md` is a local-only pointer stub; this tracked guide is the rule's home. ADR-0015 cites these as the "AGENTS.md browser rule" — see the dated pointer note in `docs/adr/README.md`.

Playwright / computer-use browser self-testing is **authorized** for this project.

- The dsh (DeepSeek) key is provided in the human's browser session — use it as-is; do not export, copy, or move the key anywhere.
- **Send only trivial tasks** to live dsh/LLM during self-tests. Never burn the human's tokens on long or redundant runs; keep prompts/outputs small.

## Kill timers (mandatory)

Every test process and browser instance must get a **kill timer set at launch time — immediately, before doing anything else** — not cleanup-only at the end. If an agent gets stuck or interrupted, cleanup-at-end never runs and orphans stack up; the timer is the safety net.

- Launch pattern: start process/browser → immediately set a timer (e.g. `timeout`/`Start-Process`-with-timeout, `setTimeout` + kill, or OS-level `taskkill`/`pkill` scheduled) that force-kills it.
- Choose the timer generously longer than the expected run (e.g. 2–5 min for a smoke test) so normal runs finish first.
- On normal completion, kill early and cancel/clear the timer if the mechanism allows; the timer is a backstop, not the primary cleanup.

## Evidence and process artifacts: the in-repo testing layout (operator rule, 2026-09-20)

**Operator instruction (human explicit override, authority-stack level 1), recorded 2026-09-20.**

- **All** future live-test/process artifacts go in the repo under `.scratch/testing/<yyyy-mm-dd>-<slug>/` — evidence subfolders, boot/teardown logs, probes, kill-timer records, driver scripts and their outputs, any process artifacts. Create the folder **before** the session starts, not after.
- **No new evidence/process folders on the Desktop, ever.** Existing Desktop folders (the old `dsh-live-pass5-*` pattern) stay where they are; closed tickets may still cite them, and those citations stand as written.
- The layout is git-ignored (`.gitignore`): artifacts may contain private dsh session content — **never commit them**.
- From now on, ticket comments cite the in-repo path, not a Desktop path.

The folder carries a short local README describing what belongs there and the naming convention. The same rule is recorded in `docs/agents-rulebook.md` §Testing artifacts & evidence layout.

## Where this rule is recorded elsewhere

- The browser-test infrastructure ADR carries the same obligations for its lane: `docs/adr/0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md` (draft, non-human-approved — this guide's rules stand independently of that draft's sign-off state).
- Network/proxy environment facts (GitHub via local proxy): `docs/agents-rulebook.md` §Environment & network.
