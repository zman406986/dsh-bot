# 01 鈥?Plugin scaffold + `DshHost` seam + fake host

**What to build:** A dsh/Cordis plugin that loads into the harness with nothing in it yet, plus the one boundary the whole core depends on: an interface describing what the core asks the host to do, and a hand-written stand-in that answers those requests in tests without dsh or an LLM. This is what makes every later ticket testable.

**Blocked by:** None 鈥?can start immediately.

**Status:** open

- [x] The plugin follows the shape of an existing small dsh plugin: an ES module exporting `name`, `inject`, a schemastery `Config`, and `apply(ctx, config)`; a package manifest with `type: module`, a `main` entry, and `peerDependencies` on the dsh services it touches (`@deepseek-ai/cordis` plus the specific `@deepseek-ai/dsh-*` packages). Read `@deepseek-ai/dsh-web-search-exa` in the local profile's `node_modules` as the worked template 鈥?dsh is MIT and safe to imitate; the forbidden reference tree is not.
- [x] A TypeScript module exporting an `apply(ctx)` function loads as a dsh/Cordis plugin without error, and its registrations are reversible on unload.
- [x] The plugin registers into a dsh profile through that profile's patch layer (an `insert` row), not by editing the profile root. Settle and record the dev-time install workflow: either a `--patch` overlay for transient loading, or `dsh plugin --profile <name> add file:...` for a persistent install.
- [x] The dedicated multitask profile exists (only `web` exists today), seeded from a shipped template, and the plugin loads in it. The stock profile is verified unaffected.
- [x] An interface exists describing the host operations the core depends on: spawn a worker (non-blocking, returns a worker id), interrupt a worker, subscribe to worker-settled events, and request a dispatcher wakeup.
- [x] A hand-written fake implementation of that interface records spawn, interrupt, and wake calls, and lets a test fire a settled event on demand. No mocking framework is used.
- [x] A test drives the core through the core's public surface and observes the fake, with no network, no LLM, and no running dsh. `npm test` (or the chosen runner) is green.

## Comments

2026-09-16 鈥?Implemented as package `dsh-multitask-dispatcher` at the repo root (`type: module`, `main: lib/index.js`, peerDep `@deepseek-ai/cordis`, dep `@deepseek-ai/schemastery`). Core seam lives under `src/core/`: `DshHost`, `FakeDshHost`, `createMultitask`. Tests: `npm test` via `tsx` + `node:test` (9 green). Install workflow settled in `docs/research/plugin-install-workflow.md`: persistent `dsh plugin --profile multitask add file:...` + `insert` row in `cordis.patch.yml`; `--patch` overlay for transient experiments. Multitask profile seeded from `web` template; stock `web` dump has no dispatcher row. Profile boot verified: `dsh --profile multitask` came up with no plugin-load error.

Ready for human review. Next unblocked ticket: 02 (worker lifecycle FSM).
