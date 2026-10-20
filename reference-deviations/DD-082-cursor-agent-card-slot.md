# DD-082 — Reserved cursor-agent card slot vs none
- **Area:** message cards (A10)
- **Type:** missing-feature (a readable recovered reference implementation exists; the enumeration premise "reserved slot with no readable implementation" was corrected on verification — see Verdict)
- **Date:** 2026-09-23

## What the reference does

The reference product renders a dedicated transcript card kind for **Cursor cloud agents** — remote agents it delegates coding work to, watched live inside the chat transcript.

The recovered catalog for this kind is complete, not an empty slot:

- **Registry slot** — `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/registry.ts` lines 73–79 reserves a cursor-agent slot in the send-message card family: an entry type for the cursor-agent kind, placeholder height 180, a hashed chunk file, and a question-frame variant carrying a reference-side cursor-agent card-wrap class. Its recorded source-path field points at the upstream original (an upstream path inside the app's Electron-renderer chat-card tree), which is metadata about where the upstream file lived — that original path itself was never recovered. Evidence comments at lines 7 and 11 (notes about the lazy-loaded view and the placeholder metadata) pin the bundle byte offsets.
- **Protocol entry** — the reference's card protocol module declares the cursor-agent kind as an entry type (line 13), defines a card message carrying a required agent id plus an optional title (lines 60–63), and projects it by requiring a non-empty id (lines 271–274, dispatched at line 435). That id is the handle for the remote agent.
- **Resolver wiring** — the reference's card resolver (line 12) loads the view for this slot lazily from its cloud-agent view module — the same hashed chunk the registry names.
- **Recovered view** — the reference's cloud-agent view is a full, readable implementation: a status card that subscribes to a cloud-agent provider keyed by the agent id and shows (a) a status badge with five lifecycle states (creating, running, finished, error, expired) plus a skeleton body while loading, (b) the agent title and the originating prompt, (c) branch name with PR state icon, PR number, (d) files-changed and line add/remove stats, and (e) footer actions to view the PR and to open the agent in its host app. Staleness disables the actions.

## What the current build does

The build has **no counterpart** for this card kind. A text search for the card kind across `src/` and `client/` returns nothing. The build's only worker-facing cards live in `src/client/approval-cards.ts`, and they are a different mechanism: worker-dispatch cards are built at render time only from the dispatcher conversation's own `spawn_worker` tool-call record, joined with approval tickets and expiry notices by `workerId` — a display of the build's own local spawn events, not a live status feed for remote agents. On policy: ADR-0021 (accepted, human-ruled) keeps stock dsh as the primary UI with dispatcher surfaces in a floating window, and keeps worker runtime management excluded; approval cards are a re-hosted set of surfaces within that window.

## The deviation

The reference transcript can host a live status card for a delegated *external* cloud agent (identity, lifecycle state, prompt echo, branch/PR outcome, diff stats, deep-link action); the build has no such card kind at all — its cards cover dispatch/approval of its own workers only. The gap is therefore two-layered: (1) no protocol/registry/view path exists for a background-agent status card in the build's message surface, and (2) no provider-side live state feed backs one. Note the two mechanisms are not equivalents to be compared line by line: the reference watches a remote service by id; the build displays its own tool-call records.

## Verdict: ADAPT

The honest evidence state must be stated plainly, because it corrects this file's own enumeration premise: the reference side was catalogued as a reserved slot with no readable implementation, but verification found a complete one — the cloud-agent view plus its protocol and resolver wiring — so there *is* something to learn from, and the original "nothing to incorporate from" limit does not hold; what remains un-recovered is only the upstream file at its original recorded source path, which the recovered view replaces. The card itself should not be ported: it is bound to the Cursor ecosystem (cloud agents and a deep-link into the Cursor app), which the PRD non-goals exclude, and the build has no remote-agent service to watch. The adaptable part is the pattern — a background-worker card carrying live status badge, task echo, outcome linkage, and diff stats, fed by a provider keyed on worker id, with skeleton-while-loading and stale-disables-actions — which the build could attach to its existing worker state (cross-file numbers: DD number pending) inside the ADR-0021 floating window, as display only.

## Incorporation notes
- **Where it would live:** the build client's message-card surface next to `src/client/approval-cards.ts` (a sibling worker-status card displaying existing worker/roster state channels), rendered inside the ADR-0021 floating window; a provider keyed on `workerId` would mirror the reference's agent-id-keyed watcher.
- **Constraints:** display only, built from data that already exists (per `src/client/approval-cards.ts` header, design §4 C15); no worker runtime management from the card (ADR-0021 amends runtime management for dispatcher sessions only — worker runtime stays excluded); status-only surface, no controls that dispose or steer workers; independent re-derivation, byte-offset evidence lines are pointers, not templates.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the view itself is small, but the work is the provider connection that feeds it live worker state; risk is low (pure presentation) provided the display-only rule holds.
- **Key reference anchors:** `the reference tree's frontend/src/recovered/features/conversation/cards/transcript-card/registry.ts` lines 73–79 (slot) and evidence lines 7, 11; the card protocol module lines 13, 60–63, 271–274, 435 (message shape and projection); the card resolver line 12 (lazy view wiring); the cloud-agent view (status badge states, skeleton, stats footer, actions).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/cards/transcript-card/registry.ts` (lines 7, 11, 73–79); `.../transcript-card/protocol.ts` (lines 13, 60–63, 271–274, 435); `.../transcript-card/resolver.ts` (line 12); `.../transcript-card/views/cloud-agent.tsx` (whole file)
- Build: `src/client/approval-cards.ts` (worker-dispatch card projection header and workerId joins); `docs/adr/0021-addon-coexistence-floating-dispatcher-window.md` (floating-window design, worker-runtime exclusion); `docs/adr/README.md`; absence evidence: a search for the card kind over `src/` and `client/` returns no matches
