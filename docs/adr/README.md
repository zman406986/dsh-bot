# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-in-process-multitask-core.md) | TypeScript in-process multitask core (dsh/Cordis plugin) | accepted |
| [0002](0002-peer-agents-in-scope.md) | Peer agents in scope for this project | accepted |
| [0003](0003-dispatcher-only-spawning.md) | Dispatcher-only spawning (flat team topology) | accepted |
| [0004](0004-reference-as-feature-inventory.md) | Reference is a feature inventory, not a build list | accepted |
| [0005](0005-feature-flag-session-scoped-toggle.md) | Feature flag is session-scoped, not a live toggle | accepted |
| [0006](0006-worker-record-durability-split.md) | WorkerRecord durable (minimum-to-reconstruct); SteerTicket in-memory | accepted |
| [0007](0007-todo-stays-dispatcher-only-with-structural-worker-link.md) | Todo stays the dispatcher's private ledger; the worker link is structural | accepted |
| [0008](0008-worker-access-ask-structured-relay.md) | Worker access asks use a custom structured relay, not dsh's child approval waterfall | accepted |
| [0009](0009-activation-explicit-command-no-capture-on-load.md) | Activation is an explicit user command; the plugin no longer captures the primary chat on load | accepted |
| [0013](0013-capsule-shell-overlay-slot-choice-draft-nonhuman-approved.md) | The dispatcher capsule is one additive shell.overlay entry — not a sidebar takeover or a keyed claim | draft (non-human-approved) |
| [0014](0014-client-bundle-materialization-contract-draft-nonhuman-approved.md) | dsh.client.inject obligates consumer-driven materialization: smallest boot-time set, never immediately for ordinary plugin packages | draft (non-human-approved) |
| [0015](0015-browser-test-infrastructure-playwright-draft-nonhuman-approved.md) | Real-browser verification is Playwright against a dsh --profile web --patch launcher boot; execution consolidates in ticket 33's browser pass | draft (non-human-approved) |

Draft ADRs 0013–0015 (capsule epic 35, ticket 37) are agent-drafted and **pending human
sign-off** (ticket 33's close-out pass). Numbers 0010–0012 are reserved to design-17 §9's
ADR plan (presence projection, session-scope always-allow, activation-replay durability);
each draft's header records this resolution.
