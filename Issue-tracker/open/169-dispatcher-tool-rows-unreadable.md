# 169 — Dispatcher tool rows render labels and values run together, unreadable

**Status:** open
**Labels:** ready-for-agent
**Origin:** owner report, 2026-10-30, after seeing the rows in the live Web GUI at `http://127.0.0.1:3080`.
**Related:** ticket 24 (the per-tool call views), ticket 152 (added the `message_agent` / `await_agent` / `spawn_dispatcher` rows — stays resolved: the renderers exist), ticket 158 §4 (the sibling live-render gap), `src/client/toolviews.ts`, `src/client/overlay.ts` (field labels), `docs/surfaces.md` (tool-view row).

## Problem

The owner pasted what our tool rows actually look like on screen today:

```
Worker 063f41a2-9897-4936-95de-1cd3f2f76132 Title Add stale-build guards to both launchers Stream launcher-staleness-guard Outcome ok
Outcome ok
063f41a2-9897-4936-95de-1cd3f2f76132 Add stale-build guards to both launchers completed
482cbced-2ee2-4da8-8a5d-eda12994501a Diagnose peer dispatcher showing as subagent completed
d25342e4-2ce8-46be-9412-1d9bd166343d Build and verify the peer-dispatcher fix completed
```

(with the spaces lost between segments in the rendered row — the pasted text has no separator between
label, value and the next label: `Worker063f41a2…TitleAdd stale-build…Streamlauncher-staleness-guardOutcomeok`).

Two defects in one row:

1. **No separation between label and value, or between fields.** `Worker`, the id, `Title`, the
   title and so on collapse into one unbroken run of text. A row that names four things reads as one
   nonsense string.
2. **The outcome line appears twice** — once as the last field of the row and once again on its own
   line immediately below.

The status rows have the same problem: `id + title + status` run together with no column or
separator (`063f41a2…Add stale-build guards to both launcherscompleted`).

Effect: every dispatcher tool call is harder to read than the plain generic row it replaced. The
row does carry the right data — the ids and titles are correct — so this is presentation, not data.

## Where it comes from

`ToolviewModel` returns `fields: { labelKey, value }[]` plus `statusRows` (`src/client/toolviews.ts:136-166`),
and each `describe*` parser builds the same shape (`describeSpawn` `:228-253`, `describeCheck` `:255-292`).
The label strings come from `TOOLVIEW_FIELD_KEYS` (`:103-120`) resolved through the dictionary
(`src/client/overlay.ts:136-152`). So the label and the value both reach the renderer; the missing
thing is whatever should sit between them.

Not yet established, and this is the first job: which layer drops the separation.

- Is the renderer supposed to space the pair itself, and are we handing it a shape it spaces only for
  some widgets? Our model is `labelKey` + `value`; confirm that is the contract the stock renderer
  actually consumes for `tool.call.toolview`, and not a near-miss shape that happens to render.
- Does the duplicate outcome line mean we emit the outcome twice (field + a row-level status the host
  also derives), or does the host add its own outcome line on top of ours?

Both answers need the live page or the shipped renderer source, not another read of our own module —
our module is self-consistent and its unit tests pass.

## Acceptance

- [ ] A rendered `spawn_worker` row shows its fields visibly separated (label, value, and each
      subsequent field distinguishable at a glance).
- [ ] The outcome appears exactly once.
- [ ] `check_workers` status rows separate id, title and status.
- [ ] The same holds for all nine claimed keys: `spawn_worker`, `check_workers`, `steer_worker`,
      `stop_worker`, `deliver_result`, `message_agent`, `await_agent`, `spawn_dispatcher`, and the
      retained historical `send_peer`.
- [ ] Confirmed by eye in the running GUI at `http://127.0.0.1:3080`, on at least one real
      `spawn_worker` and one real `check_workers` call, after a page refresh.
- [ ] If the separation belongs to the host renderer rather than to our model, that is recorded here
      with the file:line, and the accepted workaround is stated (e.g. a separator character we add
      to the value) rather than left implicit.
- [ ] `docs/surfaces.md` and the `toolviews.ts` module comment describe what the rows actually look
      like.

## Constraints

- Read `read-before-running-live-and-browser-tests.md` before any live/browser check; kill timers are
  mandatory at launch.
- Views stay read-only presentation: render only what the call already carries; no fetches, no actions
  (`src/client/toolviews.ts:20-22`).
- Never claim a shipped keyed cell (`SHIPPED_CLAIMED_TOOLVIEW_KEYS`, `:72-75`).
- Ticket 152 is not reopened by this: its three renderers exist and keep their parsers. The fix here
  is the shared presentation path, so it must not reintroduce the generic fallback those parsers
  replaced.
- The client bundle must be rebuilt (`npm run build:client`) before any by-eye check, and the page
  refreshed — a stale bundle is what caused the last misdiagnosis (see ticket 167's comment).
