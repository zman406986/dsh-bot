# RACOONS integration into dsh-bot — 2026-10-20

Branch `racoons-integration`, in the worktree `C:\Users\TZhen\Desktop\dsh-bot-racoons`
(`C:\Users\TZ\Desktop\dsh-bot-racoons` on the other device). Base commit `1f5ae26` on `main`.
The owner's tree at `C:\Users\TZhen\Desktop\dsh-bot` was never read or written.

## The seam

`agent/pre-step`, registered inside `ctx.effect(...)` from `src/adapter/racoons.ts`, gated on
`racoonsEnabled` (default `false`) and on dispatcher-session membership. Observations arrive on
`session/event`; history is projected from `session.surface.nodes` + `session.eventAt(seq)`;
publication goes through `session.append(...)` with
`surfaceOp: { op: "replace", startSeq, endSeq }` and `sourceEventSeqs`.

## The staged-entry protocol, and why

`CapRule` is entry-only: it fires when a tool result enters context. dsh offers no result-rewrite
seam at insertion time. Its only write window is the next `agent/pre-step`, by which point the
result is already in `session.surface.nodes`.

So the adapter splits the event into two phases:

1. **Observe.** A `tool/result` event becomes a *pending entry*: bytes, call id, evidence. Nothing
   is written.
2. **Publish.** On the next `agent/pre-step`, each pending entry is processed as
   `{ kind: "entry", result }`. The engine plans, the guard validates, and the port replaces the
   visible result in place before the model request.

The rule still sees an entry; the write still lands before the request. Refused entries keep their
original bytes and are not retried. An unknown outcome keeps the entry pending and stops the pass,
so a second removal can never stack on an unconfirmed one.

At-rest work (append-mode seal) rides the same pre-step call with `kind: "at-rest", reason: "step"`.

## Port mode matrix

| Mode | Result | Why |
| --- | --- | --- |
| `entry` | supported | replaces the staged visible result in place |
| `append` | supported | records only, no replacements |
| `rewrite` | refused (`unsupported`) | M3 scope; needs a cold boundary |
| `rehydrate` | refused (`unsupported`) | M3 scope |

## What is vendored

`vendor/racoons/core/` and `vendor/racoons/adapter/` hold a copy of `@racoons/core` and
`racoons-dsh` at M1. They are workspace members of the dsh-bot package, so imports resolve locally
and nothing depends on a sibling Desktop path. `npm run build:vendor` compiles them before the host
build. `vendor/racoons/README.md` records provenance and the replacement plan.

Tests, fixtures, `FileBlobStore`, `FakeTokenMeter`, and the root barrels are deliberately not
vendored: nothing in the integration imports them.

## What is transient

The ledger is **in memory**. Blobs are `MemoryBlobStore`; the SQLite ledger runs on `":memory:"`
when `node:sqlite` is available, and falls back to a refusing ledger that never throws out of the
listener when it is not. Recall works for the life of the process. After unload, sealed bytes are
gone even though the transcript keeps the markers.

If `node:sqlite` is missing at runtime, the engine returns `recovery-pending` and writes nothing.
That is deliberate: better to do nothing than to remove content it cannot archive.

## Verified

- `npm run typecheck` in the worktree: green (vendor build, host typecheck, client typecheck).
- `test/adapter-racoons.test.ts`: 9/9 — registration gating, disposal, empty pre-step, staging order,
  throw containment, refusal handling, unknown-outcome stop, missing-SQLite fallback.
- `test/adapter-racoons-port.test.ts` + `test/adapter-racoons-engine.test.ts`: 7/7 — the real engine
  caps a staged result and archives the original; real append-mode seal; stale-revision refusal;
  intent idempotency; single replacement with provenance; host throw becomes unknown; no receipt
  without a visible surface change.

## Not verified

- No live dsh boot. No browser pass. No API key. No mock-LLM end-to-end run.
- Host event payload shapes, append return values, and replace-bounds behaviour are assumed from the
  structural contracts read in `src/adapter/` and were exercised only against fakes.
- Durable ledger. That is the follow-up ticket.
- The model-facing recall tool. Recall is API-only in this integration.

## Constraints honoured

- `DOMAIN_VERSION` untouched.
- Existing compaction code untouched; none of it is imported.
- Clean-room: nothing copied from the dsh reference tree; the vendored code is RACOONS' own.
- Ticket filed before implementation: `Issue-tracker/open/114-racoons-integration.md`.
