# Real-browser verification is Playwright (headless Chromium) against a `dsh --profile web --patch` launcher boot; execution consolidates in ticket 33's browser pass

**Status:** draft

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0015, closing the capsule epic's block started at 0013. 0010–0012 are reserved to design-17 §9's ADR plan (ADR-0010 presence-as-projection → tickets 27/28; ADR-0011 session-scope always-allow → ticket 30; ADR-0012 activation-replays-durability → ticket 31), which supersedes design-16 §9's older conditional ADR-0010 sketch; the capsule ADRs start at 0013 (slot choice), 0014 (materialization contract), 0015 (this file).

The epic's real-browser mount verification uses **Playwright driving headless Chromium** against a **real dsh web instance booted by the launcher** (`dsh --profile web --patch`, the desktop `dsh-bot.ps1` route) with the plugin's built artifact installed. **Execution lives in ticket 33's browser pass** — this epic's sub-tickets (38–42) verify offline (unit suites over pure view models, `npm run typecheck`, `npm run build:client`) — and epic AC 1 (capsule Playwright-asserted dormant and activated) is asserted there, gating the epic's resolution.

## Context

- Epic 35 process req 3 demanded a Playwright real-browser test per chunk; the epic's chunking adaptation (2026-09-18 comment) consolidated per-chunk browser runs into ticket 33's launcher/browser pass, which already holds ticket 34's deferred browser ACs: the served-page/boot-graph row check, the dormant-composition assertion, and the `/dispatcher-start` activation flip.
- Ticket 34 proved offline suites cannot see browser boot: while the module was registered-but-dormant (ADR-0014's failure mode), 515 offline tests stayed green. Only a real boot materializes the graph — the mount smoke test is the sole check that the bundle registers, materializes, and does not crash the shell.
- Mount-test pattern recorded abstractly by ticket 36 (clean-room; one reference repo shallow-cloned, pattern-level only), confirmed at repo level: the **server is out of the spec's hands** — a shell script boots the real dsh web instance and exports the base URL through an environment variable; the browser lane is a **crash probe run serially** (one worker, zero retries, no parallelism) because "the plugin mounts and the shell does not crash" only stays meaningful without retries; browser-lane specs use a **filename pattern the offline unit runner never matches**, so the lanes never collect each other.
- S8 discipline interpreted for this lane (epic AC 2): browser local, no network/LLM dependency in assertions; live dsh receives only trivial tasks during self-tests, and every launched browser/process gets a **kill timer set at launch** (AGENTS.md browser rule) so an interrupted session cannot orphan instances.

## Considered options

| Option | Rejected/kept because |
|---|---|
| **A. Playwright headless Chromium against a launcher boot; consolidated in ticket 33's browser pass** | **Chosen.** Exercises the real boot graph, bundle route, and slot mounting end to end; the serial crash-probe shape is the pattern the ecosystem's own mount lanes converged on; consolidation avoids per-chunk browser infrastructure and reuses ticket 34's deferred ACs. |
| B. Unit tests only | Rejected: exactly the gap ticket 34 exposed — offline green, browser dead. Mount smoke is the only check covering registration → materialization → render without crashing the shell. |
| C. jsdom / fake-DOM mount inside the unit runner | Rejected: fakes the boot graph and manifest materialization — the very things under test. Offline fakes (transport doubles, store fixtures) remain the sub-tickets' lane, not a browser substitute. |
| D. Manual eyeball on a launcher boot | Rejected: not repeatable, not an assertion, silently rots across refactors; suitable for exploration, not verification. |

## Consequences

- **Ticket 33's browser pass is the single execution point:** mount smoke (serial, one worker, zero retries, filename-separated so `npm test` never collects it), the served-page/bundle-presence check, and the dormant + activated capsule assertions (epic AC 1); ticket 34's three unchecked ACs discharge in the same pass.
- Sub-ticket "Verification" sections (38–42) name offline methods and are final **only jointly** with ticket 33's pass: a sub-ticket is offline-verifiable, but the epic closes on the browser gate.
- The verification lane, not the shipped plugin, carries the tooling: the plugin package gains no runtime dependency; Playwright is dev/verification infrastructure for the pass.
- Process hygiene is binding: launcher boot and browser launch set kill timers immediately (AGENTS.md), run serially and locally, and assert without network/LLM.
- Version fragility: the launcher route (`--profile web --patch`) and the mount pattern are pinned to dsh 0.1.5-rc.1 and the 2026-09-18 research; re-verify flags and served-page shape on dsh upgrades (standing drift rule).
- Sources: epic 35 process req 3 + chunking adaptation comment; ticket 34 (deferred browser ACs, offline-green-while-dormant evidence); ticket 36 / `docs/research/dsh-capsule-seams.md` (mount-test pattern, abstract); `docs/research/dsh-plugin-ui-examples.md` Findings 1 and 3; AGENTS.md browser self-testing rules.
