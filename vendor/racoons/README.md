# Vendored RACOONS M1

Date: 2026-10-20.

This is a vendored copy of the required M1 modules from `@racoons/core` and `racoons-dsh`.
These packages are not published.
Replace this copy with a real dependency when the packages ship.

Source repo on the two devices:

- `C:\Users\TZhen\Desktop\racoons`
- `C:\Users\TZ\Desktop\racoons`

Integration worktree on the two devices:

- `C:\Users\TZhen\Desktop\dsh-bot-racoons`
- `C:\Users\TZ\Desktop\dsh-bot-racoons`

Files under `core/` correspond to `packages/core/src/`.
Files under `adapter/` correspond to `packages/adapters/dsh/src/`.
Their source text and relative `.js` import extensions are preserved.
The port files include the staged-entry changes made in the source repo on this date.
No source commit or byte comparison was checked. No shell command was run.

The copy contains only the modules reached by the integration and their dependencies.
It excludes source tests, fixtures, the file blob store, the fake meter, unused adapter modules, and package barrel files.
The packaging shim exports types only. Runtime imports use explicit subpaths.
No dsh reference-tree code is included.
The clean-room rule remains: adapted copying only, restructured and independently named; no verbatim dsh reference-tree source, prompts, or protocol artifacts.
The authorized exact copy here is from RACOONS itself.

## Local packages

The root package uses npm workspaces for `core/` and `adapter/`.
No sibling Desktop path or published RACOONS package is required.
The root build builds both vendor packages before the plugin.
The root pretest builds the vendor packages before offline tests.
No install, build, typecheck, test, or package operation was run.
The workspace lock entries were edited by hand and need npm verification.
The Apache-2.0 source license is included in `LICENSE`.

## Source files

- `core/config.ts`
- `core/engine/application.ts`
- `core/engine/committed.ts`
- `core/engine/engine.ts`
- `core/engine/journal.ts`
- `core/engine/notice.ts`
- `core/engine/planning.ts`
- `core/engine/recovery.ts`
- `core/engine/telemetry.ts`
- `core/engine/types.ts`
- `core/episodes/tracker.ts`
- `core/episodes/types.ts`
- `core/guard/application.ts`
- `core/guard/breaker.ts`
- `core/guard/bytes.ts`
- `core/guard/candidate.ts`
- `core/guard/checks-episodes.ts`
- `core/guard/checks-input.ts`
- `core/guard/checks-operations.ts`
- `core/guard/checks-output.ts`
- `core/guard/checks-shape.ts`
- `core/guard/checks-sources.ts`
- `core/guard/context.ts`
- `core/guard/finalize.ts`
- `core/guard/guard.ts`
- `core/guard/protection.ts`
- `core/guard/recall.ts`
- `core/guard/render.ts`
- `core/guard/types.ts`
- `core/ledger/application-integrity.ts`
- `core/ledger/blob-store.ts`
- `core/ledger/commit-preparation.ts`
- `core/ledger/event-store.ts`
- `core/ledger/integrity.ts`
- `core/ledger/manifest.ts`
- `core/ledger/memory-blob-store.ts`
- `core/ledger/prepare.ts`
- `core/ledger/recall.ts`
- `core/ledger/rows.ts`
- `core/ledger/schema.ts`
- `core/ledger/sqlite-ledger.ts`
- `core/ledger/types.ts`
- `core/meter/errors.ts`
- `core/meter/meter.ts`
- `core/meter/token-meter.ts`
- `core/rules/assets.ts`
- `core/rules/cap.ts`
- `core/rules/seal.ts`
- `core/rules/types.ts`
- `core/types/identity.ts`
- `core/types/telemetry.ts`
- `core/types/transcript.ts`
- `core/util/bytes.ts`
- `core/util/hash.ts`
- `core/util/lines.ts`
- `adapter/envelope.ts`
- `adapter/evidence.ts`
- `adapter/port-application.ts`
- `adapter/port.ts`

Added packaging files are `core/package.json`, `core/tsconfig.json`, `core/public-types.d.ts`, `adapter/package.json`, and `adapter/tsconfig.json`.

## Known source blocker

`core/guard/bytes.ts` imports `complementByteRanges` from `core/util/bytes.ts`.
That export is defined in `core/util/lines.ts`, and is absent from `core/util/bytes.ts`.
This is preserved from the source. It blocks the vendor TypeScript build.
The authorized source edits covered the adapter port and its test only.
The integration catches engine load errors and leaves the transcript unchanged.

## Transient state

The ledger uses `:memory:` and the blob store uses memory.
Archive bytes expire on unload or process exit. No model-facing recall tool is registered.
Missing SQLite selects an injected refusing ledger and recovery-pending.
The config is passed through. The source default `capHeadBytes: null` leaves cap inactive until configured.
Seal requires explicit structured miss evidence. The plugin does not infer it from display text.

## Integration limits

The registration is in `src/adapter/racoons.ts`; host projection is in `racoons-port.ts`, and structural types and text parsing are in `racoons-session.ts` in that directory.
The offline checks are authored in `test/adapter-racoons.test.ts`, `test/adapter-racoons-port.test.ts`, and `test/adapter-racoons-engine.test.ts`.
The last file uses the real engine with an inline ledger and explicit test config/evidence.
No test was run. The known import error blocks loading that engine.

The three integration findings are reflected in the implementation: no dependency on absent microcompact files; entry processing staged from session/event to pre-step; transient storage without a storage-domain change.
The explicit mode matrix governs: entry supported, append records only, rewrite and rehydrate refused.
Observation snapshots result bytes and evidence. Pre-step projects the visible surface, handles pending entries in sequence order, then makes one at-rest call.
Applied and definite non-applied entries leave the pending map. Recovery-pending keeps the entry and stops the pass.
Errors are logged and contained. Dispatcher membership is checked during observation, processing, and publication.

One synchronous append must publish an application. Entry uses one replace operation with sourceEventSeqs.
Multiple appended record bodies are kept as text blocks in one protected system event, identified by the first record id.
The bridge confirms the visible sequence change before accepting a publication receipt.
A thrown append or uncertain visible outcome stays unknown and is not replayed.
Host event payloads, surface node shape, synchronous append behavior, return shape, replace bounds, and listener timing have not been verified against this installed runtime.
The plugin-wide disabled path still has no dispatcher to handle. The RACOONS flag is separate from the other opt-in flags.
