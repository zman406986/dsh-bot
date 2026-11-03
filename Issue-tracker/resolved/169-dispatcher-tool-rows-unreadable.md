# 169 — Dispatcher tool rows render labels and values run together, unreadable

**Status:** resolved
**Labels:** ready-for-agent
**Origin:** owner report, 2026-10-30, after seeing the rows in the live Web GUI at `http://127.0.0.1:3080`.
**Related:** ticket 24 (the per-tool call views), ticket 152 (added the `message_agent` / `await_agent` / `spawn_dispatcher` rows — stays resolved: the renderers exist), ticket 158 §4 (the sibling live-render gap), `src/client/toolviews.ts`, `src/client/toolview-panel.tsx`, `src/client/toolview-styles.ts`, `src/client/overlay.ts` (field labels), `docs/surfaces.md` (tool-view row).

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

- [x] A rendered `spawn_worker` row shows its fields visibly separated (label, value, and each
      subsequent field distinguishable at a glance).
- [x] The outcome appears exactly once.
- [x] `check_workers` status rows separate id, title and status.
- [x] The same holds for all nine claimed keys: `spawn_worker`, `check_workers`, `steer_worker`,
      `stop_worker`, `deliver_result`, `message_agent`, `await_agent`, `spawn_dispatcher`, and the
      retained historical `send_peer`.
- [ ] Confirmed by eye in the running GUI at `http://127.0.0.1:3080`, on at least one real
      `spawn_worker` and one real `check_workers` call, after a page refresh. — **not done by this
      agent** (offline lane; see Comments). The bundle is rebuilt and fresh, so the check is ready
      to run.
- [x] If the separation belongs to the host renderer rather than to our model, that is recorded here
      with the file:line, and the accepted workaround is stated (e.g. a separator character we add
      to the value) rather than left implicit. — separation belongs to **us**, not the host:
      `dsh-client-ui-tool/lib/client.js:1964-1973` renders our keyed cell *instead of* the generic
      card, and hands it only `{phase, block}`; it adds no styling and no outcome line.
- [x] `docs/surfaces.md` and the `toolviews.ts` module comment describe what the rows actually look
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

## Comments

### 2026-11-04 — resolved (offline lane)

**Root cause.** `src/client/toolview-panel.tsx` built the class names
`multitask-dispatcher-toolview__field`, `__field-label` and `__field-value` and rendered them as
`<span>`s, but **no stylesheet anywhere in the tree defined those classes**: there was no
`<style>` element in the component and no CSS constant for it (unlike `ROSTER_PANEL_CSS`,
`SETTINGS_CARD_CSS`, `APPROVAL_CARD_CSS`, which every other surface ships). Bare `<span>`s are
inline boxes, so `Worker`, the id, `Title`, the title and the rest concatenated with no visual
break — the owner's `Worker063f41a2…TitleAdd stale-build…Outcomeok`.

**Where the separation belongs: us, not the host.** The shipped dispatch is
`dsh-client-ui-tool/lib/client.js:1964-1973` (`ToolCall`): `renderSlot("tool.call.toolview", …)`
renders our keyed cell **or** the generic card (`fallback`), never both, and it passes the cell only
`ToolCallCommonProps & ToolCallPhaseProps` — `{callId, toolName, phase, block, …}`. It adds no
wrapper styling and no outcome line. So both pasted defects are ours to fix, and the accepted
workaround is not "a separator baked into a value": the separation is structural in the component.

**The duplicate outcome is the same defect.** The row emits its outcome field exactly once; the
component never mirrors it anywhere. The second line the owner saw was the **next**
`check_workers` call's row. With every field inline and no gap, two consecutive rows read as one
run, so `…Outcomeok` looked like it belonged to the row above. The new status-list block
(`__rows{flex-basis:100%}`) and the per-field separator make the row boundary visible, and
`test/client-toolviews.test.ts` now pins one `Outcome` and one `ok` per row.

**Files changed.**

- `src/client/toolview-styles.ts` — **new.** `TOOLVIEW_CLASS` + `TOOLVIEW_CSS`. Namespaced
  classes; every colour a host `--dsw-alias-*` token (`label-tertiary` for labels, `label-caption`
  for the separator dot — the shipped tool row's own separator colour); no raw colour, no token
  fallback, no animation.
- `src/client/toolview-panel.tsx` — renders `<style>{TOOLVIEW_CSS}</style>` with the row;
  `__field` is a flex row, the row is a flex container with `gap`, and a real `__sep` element sits
  between fields; `data-field-label` / `data-field-value` attributes make each pair assertable; the
  roster list becomes its own block. Also carries one literal space (`FIELD_SPACE`) between
  label/value and between roster cells, so even a total stylesheet loss degrades to separated text
  rather than the fused run.
- `src/client/toolviews.ts` — module comment states the row's real look and that separation is the
  renderer's job (a model value must never carry presentation punctuation). No parser change: the
  parsed data was already correct, which is why the old unit tests passed.
- `src/client/overlay.ts` — **untouched.** The EN/ZH field labels (`Worker`/`工作者`,
  `Title`/`标题`, …) were already correct and both families still move together.
- `docs/surfaces.md` — the tool-view row now names all three files and says how a row reads; §No
  worker console describes the single labelled line, the separator, and the one-outcome-plus-roster
  shape.
- `test/client-toolviews.test.ts` — new suite `toolview — the rendered row separates label, value
  and fields (ticket 169)`, 10 tests over `react-dom/server` static markup (no DOM, no jsdom):
  stylesheet exists and is rendered; label and value are separate elements; the line never contains
  `TitleAdd` / `Outcomeok` / `launcherscompleted`; one separator per field boundary; one outcome per
  row; status-row separation; the degraded line; and the same claims for all nine claimed keys.

**Red-then-green evidence** (`.scratch/testing/2026-11-04-ticket169-toolview-rows/render-row.ts`,
git-ignored per the 2026-09-20 operator rule). Rendered text of the owner's exact payload:

- Before: `"Worker063f41a2-9897-4936-95de-1cd3f2f76132TitleAdd stale-build guards to both
  launchersStreamlauncher-staleness-guardOutcomeok"` — character-for-character the ticket's paste.
- After: `"Worker 063f41a2-9897-4936-95de-1cd3f2f76132 Title Add stale-build guards to both
  launchers Stream launcher-staleness-guard Outcome ok"`
- `check_workers`, after: `"Outcome ok → 063f41a2-… Add stale-build guards to both launchers
  completed wrote two launcher guards"` (fields on one line, each roster row on its own line).

Against the pre-fix renderer the new suite fails **8 of 10**; against the fix all pass.

**Tests.** `npx tsx --tsconfig tsconfig.client.json --test test/client-toolviews.test.ts
test/client-face-scaffold.test.ts` → 54 tests, 54 pass, 0 fail. `npx tsc -p
tsconfig.client.json --noEmit` → clean. Also run because they read my files:
`test/composition-polish.test.ts` (its dictionary-bypass sweep inspects `toolview-panel.tsx`) and
`test/client-theme-tokens.test.ts` — both green. Full `npm test` deliberately not run (other lanes
mid-edit).

**Bundle.** `npm run build:client` rebuilt `client/index.js`; `npm run check:client` reports fresh
(161604 bytes, sha256 `36a59f57…ab5d`). The bundle is git-ignored build output.

**Not done: the by-eye GUI check.** This lane was offline-only, so the last acceptance box is left
open for the owner: launch the GUI, refresh, and look at one real `spawn_worker` and one real
`check_workers` call. The bundle is fresh, so a plain refresh should show the separated rows.

**Structural, not cosmetic.** Three independent layers: (1) flex block layout — a flex child is a
block-level box, so label and value are separate boxes even with every other declaration gone;
(2) `gap`; (3) a real separator element plus literal whitespace text nodes, which survive total
stylesheet loss. The regression net is rendered-markup assertions over all nine claimed keys, so a
future edit that drops the stylesheet or fuses the spans fails the suite instead of shipping.
