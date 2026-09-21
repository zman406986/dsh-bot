# 107 — Replace the plain launcher chip with a floating capsule showing [dispatcher count | running workers]

**Status:** resolved
**Labels:** ready-for-agent
**Related:** 102 (resolved — in-window affordances), 103 (resolved — the per-event-delta drag pattern to reuse), ADR-0021 (accepted — partially superseded by ADR-0022), ADR-0022 (human-ruled 2026-09-22 — the ruling this ticket implements), ADR-0010 (mirror honesty — where the counts come from)

## Problem

The human requests (2026-09-22, in-session, verbatim): *"current window collapses at top left [dispatcher] button, change to a floating capsule instead [No. of dispatcher | number of running workers]"*.

Today the collapsed state is a plain chip — `createLauncherChip` (`src/client/floating-window.tsx:331-354`), label key `launcher.chip.label` (en "Dispatchers", `src/client/overlay.ts:330`; zh "调度台", `overlay.ts:485`), deliberately "launch affordance ONLY — no presence counters" (module comment `floating-window.tsx:4-12`, chip comment `:324-329`, locale comments `overlay.ts:324-329` en / `overlay.ts:480-484` zh).

**The ADR situation, stated explicitly:** accepted, human-ruled ADR-0021 (`docs/adr/0021-addon-coexistence-floating-dispatcher-window.md`) records in its Consequences: "The capsule itself stays retired — the floating window is not a capsule revival: it hosts the whole dispatcher shell, not a collapsed chip". The human's 2026-09-22 explicit request is authority-stack level 1 (human override, dated, spoken/recorded) and sits ABOVE accepted ADRs; per the ADR-0021 precedent (a dated human ruling recorded as a human-ruled ADR), the ruling is recorded as **ADR-0022** (`docs/adr/0022-floating-capsule-revived-by-human-ruling.md`), which supersedes ADR-0021's capsule-retirement clause in part. The anti-revival clause ("a new ticket with its own evidence, not a revival" — recorded on cancelled ticket 73 and echoed in ADR-0021's Consequences) is satisfied: this ticket is the new ticket, and its evidence is the human's dated verbatim ruling quoted above. Cancelled ticket 66 was the capsule-era home of the same collapsed-chip-shows-counts request.

## What to do

- [x] Replace the chip with a floating, draggable capsule showing the dispatcher count and the running-workers count (e.g. "2 | 3") with an accessible label. The capsule keeps the LAUNCHER role — toggle the floating window open/close, `aria-pressed` — per ADR-0021 decision 2: this changes the chip's SHAPE and CONTENT, not the launch seam (`LAUNCHER_ENTRY_ID`, `src/client/overlay.ts:52`; `LAUNCHER_OVERLAY_ORDER` −10, `:61` — both stay).
- [x] Counts derive from the client mirror store: dispatcher count = mirrors with kind `"snapshot"` (`src/client/shell-store.ts:114-131`), running workers = the sum of `describePresence(snapshot).working` over those snapshots (`shell-store.ts:145-160`), respecting the staleness rule (`ROSTER_STALE_WINDOW_MS`, used by `view()` at `shell-store.ts:234-250`) so stale snapshots do not count as live. Derive it as a PURE function so it can be pinned offline.
- [x] Close the wiring gap: `createLauncherChip` currently receives only (t, store, content) — the composition at `src/client/index.ts:516-533` must pass the shell store (`mount.store`) or a derived counter in.
- [x] Drag reuses the per-event-delta pattern (`beginDrag`, `floating-window.tsx:265-287`; contract pinned at `test/client-floating-window.test.ts:674-748`) against the capsule's own position state — in-memory like the window's x/y (no persistence unless trivially free).
- [x] The chip-text pin at `test/client-floating-window.test.ts:539` (chip text == `launcher.chip.label`) is deliberately broken and replaced with counts pins; en+zh lockstep for any aria/title copy (e.g. aria-label "N dispatchers, M workers running" / the zh equivalent; `validateLocaleDictionary`, `overlay.ts:507-540`, enforces identical key sets).
- [x] Offline pins for the counter derivation (pure function: snapshots count, stale excluded, working sums) and the capsule drag.
- [x] `client/index.js` is a build artifact — run `npm run build:client` and include the regenerated file if tracked-git shows it changes. (`client/` is git-ignored; bundle regenerated locally, nothing bundle-shaped to commit.)

## Constraints

- Token-only CSS; `multitask-dispatcher-` class discipline; no animation.
- No new host seams, no invented push channels — counts come from the existing mirror feed; no optimistic flips (ADR-0010 honesty: the mirrors are the truth, honest mirror lag allowed).
- Do not reintroduce the glossary avoid-word "bot" outside verbatim human quotes.
- The floating window remains the whole dispatcher shell (ADR-0022 decision 3) — the capsule is not a second shell.
- en+zh locale lockstep for every new user-visible string.

## Comments

### 2026-09-22 — scribe session

Filed from the human's in-session request of 2026-09-22 (quoted verbatim in Problem). **ADR-0022 records the ruling**: the human's level-1 dated override supersedes ADR-0021's capsule-retirement clause in part, so this ticket implements recorded authority rather than conflicting with it — the ticket cites ADR-0022 in Related for that reason. The scribe pass verified the cited facts by code reading only (no implementation): the chip renders only the static label, the composition passes it no shell store, and the mirror store already carries everything the counts need (snapshot kind, presence summary, stale window). The launch seam, the floating window's crash isolation, and the add/delete affordances are all untouched by this ticket. Labelled ready-for-agent: the behavior is fully specified by the ruling plus the existing patterns.

### 2026-09-22 — implementation session

Implemented offline only (no live dsh/LLM/browser work; no push).

**What changed**

- `src/client/shell-store.ts` — the counts derivation, pure and single-source. New `describeCapsuleCounts(mirrors, nowMs?)` → `{dispatchers, workers}`: dispatchers = live `kind: "snapshot"` mirrors in the store's mirror map (the activation authority, ADR-0010 — read directly, no rows invented, no push channel), workers = the sum of `describePresence(snapshot).working` over those. The staleness discipline is now ONE shared predicate, `mirrorSnapshotStale(mirror, nowMs)` — extracted from the sidebar's `view()`, which now calls it, so the sidebar chips and the capsule can never disagree about what counts as live (`>` `ROSTER_STALE_WINDOW_MS`; without a render clock nothing is declared stale — `view()`'s exact rule, `nowMs`-injected, no `Date.now` inside). Cleared, unavailable, and stale mirrors contribute nothing; zero mirrors derive `0 | 0`.
- `src/client/floating-window-store.ts` — the capsule's own placement store (in-memory like the window's x/y, no persistence, no `window` reads): `createCapsuleStore()` with `subscribe`/`getBox`/`moveBy(dx, dy, viewport)` — the same immutable-emit, absorbed-delta-early-return contract as the window store's `moveBy`. New pure math: `clampCapsulePosition` (FULLY-visible clamp — deliberately not the window's peek rule: the capsule is small and has no titlebar strip to keep grabbable; a viewport smaller than the capsule pins at 0 deterministically, never NaN), `defaultCapsulePlacement` (top-left margin — the ruling's own "collapses at top left" — through the same clamp), and a nominal `CAPSULE_NOMINAL_WIDTH/HEIGHT` (96×32) so the pure store never measures the DOM (recorded in the comment as an honest approximation).
- `src/client/floating-window.tsx` — the capsule. `createLauncherChip` keeps its name (the launch role is unchanged) and gains a parameter: `(t, store, shellStore, content)`. It now subscribes to TWO stores via `useSyncExternalStore` — the window store as before, and the shell store (the same `mount.store` the hosted shell consumes), closing the wiring gap; the counts re-render on every mirror write. The button keeps `data-launcher="dispatcher"` + `aria-pressed` and renders the ruling's shape as plain text `"2 | 5"` (one text node — text-first and test-friendly), plus `data-dispatcher-count` / `data-worker-count` attributes and `aria-label`/`title` with the counts in words (`launcher.capsule.aria` via the existing `formatTemplate` interpolation, exactly how `shell.row.working` does it). Class is `multitask-dispatcher-fwin__capsule` (the `-chip` rules are replaced): `position:fixed` INSIDE the single injected entry (no second overlay entry — the host layer is untouched), z-index 1000, token-only colours, no animation, `cursor:grab`/`grabbing`, `touch-action:none`. Drag: new `beginCapsuleDrag` is the ticket-103 `beginDrag` pattern with a face — left-button only, per-event own-delta into `capsuleStore.moveBy`, window listeners removed on up/cancel; the window's pinned drag contract is untouched. One deliberate addition the ticket did not name: because the capsule is a BUTTON, a real browser fires a click after a drag's pointerup, which would toggle the window on every drag-end — `beginCapsuleDrag` accumulates travel and flags a drag once past `CAPSULE_DRAG_THRESHOLD_PX` (4px, exported and pinned); the click handler consumes that flag once and resets it on the next press, so a jittery press still toggles. Reversed comments rewritten in place to cite ADR-0022 (module header; the launcher factory's doc; the CSS note — nothing silently deleted).
- `src/client/overlay.ts` — `launcher.chip.label` removed from BOTH faces (grep confirmed the renderer was its only consumer); new key `launcher.capsule.aria`: en `"{dispatchers} dispatchers, {workers} workers running"`, zh `"{dispatchers} 个调度会话，{workers} 个工作者进行中"` (the zh maps the human's shape to the glossary vocabulary: 调度会话 = dispatcher session, 工作者 = worker). The reversed retirement comments above the launcher keys rewritten in place citing ADR-0022. `validateLocaleDictionary` lockstep holds.
- `src/client/index.ts` — the launcher inject passes `mount.store` into `createLauncherChip`; the comment block updated (capsule form, ADR-0022, the shell-store subscription). Still exactly ONE `shell.overlay` entry, same id (`multitask-dispatcher-launcher`) and order (−10) — `launcherOverlayRegistration()` byte-identical.
- Deliberately untouched: `launcher.window.failed`'s copy still points at "the Dispatchers button" / “调度台”按钮 — the launcher is still the only capsule in the overlay and the copy stays directionally true; changing shipped window chrome copy was not ticketed. The factory name `createLauncherChip` stays for the same reason (the launch role is unchanged; the ticket itself names the function).

**Pins added/updated**

- `test/client-floating-window.test.ts` — the chip-text pin (text == `launcher.chip.label`) deliberately broken and REPLACED (ticket-specified): the toggle test now pins `data-dispatcher-count`/`data-worker-count`, visible text `"0 | 0"`, and aria-label/title from `launcher.capsule.aria` at the empty-store start. New pure describe `capsule counts`: zero mirrors → 0|0; two snapshots with 2 and 3 running → 2|5; only non-terminal rows count as working; the stale edge pinned exactly (at the window edge still live, 1ms past → the dispatcher and its workers drop out together); no render clock → nothing stale; cleared + unavailable mirrors contribute nothing — all built through the REAL store (`applyPresence`/`applySessionMirror`), not hand-built maps. New pure describe `capsule placement store`: default top-left margin placement; a drag is the sum of per-event `moveBy` calls; clamp keeps the capsule wholly inside with the degenerate-viewport collapse pinned; absorbed delta silent (box reference stable, the `moveBy` contract); subscribe/disposer. New rendered describes: counts re-render from real mirror writes and a stale snapshot is NOT counted (and a `null` clear drops the dispatcher) — mirroring the ticket's stale pin; drag = sum of per-event deltas through the REAL clamp (three monotonic moves → +30/+15px), clamp at jsdom's own viewport, right-button press starts no drag; and the click-discrimination pins (a drag's trailing click never toggles; a press below the threshold still toggles, aria-pressed flips). Registration posture pins unchanged in substance and still green: exactly ONE `shell.overlay` entry, same id/order, no root/main, teardown/re-apply — wording updated only where it encoded the old chip ("the capsule entry stays retired" now names the RETIRED ROSTER-capsule entry, since our launcher is itself a capsule now).
- `test/client-face-scaffold.test.ts` — the exact-locale-key-list pin: `launcher.chip.label` → `launcher.capsule.aria` (sorted position kept), both faces still asserted identical.

**Gates (before → after)**: `npm run typecheck` green → green; `npm test` **1199/293/0 → 1214/297/0** (+15 tests); `npm run lint:docs` green → green; `npm run build:client` green (`client/index.js` regenerated locally; git-ignored, so nothing bundle-shaped to commit — verified via `git check-ignore`). One intermediate red run (1214/297/1) was a bad edge calculation in a NEW test fixture (the "aged" snapshot was already past the window at the edge check), fixed in the pin; no production code changed. Evidence: `.scratch/testing/2026-09-22-live-105-106-107/offline-107/` (README with the artifact→claim map, baseline/after gate outputs). Ticket left in `open/`.

### 2026-09-22 — live lane

Live-verified against the real host + served bundle (lane
`.scratch/testing/2026-09-22-live-105-106-107/live/`, served bundle fingerprinted first).
Verdict: **PASS on every functional clause**, plus ONE live finding (styling lifecycle,
below — recorded, not fixed).

- **One launcher entry, information-bearing at rest:** exactly one
  `[data-launcher="dispatcher"]` in the page; text `[N | W]` ("0 | 0"), matching
  `data-dispatcher-count`/`data-worker-count`; aria-label/title
  "0 个调度会话，0 个工作者进行中"; `aria-pressed` reflects the closed window
  (`obs-capsule-initial.json`).
- **Click toggles, drag moves, drag's trailing click does NOT toggle:** capsule dragged by
  measured deltas moved (24,24)→(204,114) for a (+180,+90) dispatched sum — EXACT, per-step
  +60/+30 — and the window stayed OPEN through the drag's trailing click (the 4 px
  threshold works live); with the window moved aside, a plain click toggled CLOSED and
  another toggled OPEN (`obs-capsule-drag.json` + `obs-capsule-click-control.json`).
- **Counts are LIVE and honor ADR-0010's non-stale rule:** with THREE dispatcher rows
  rendering (two stale persisted mirrors from prior boots + one live) the capsule counted
  exactly 1; picker activations +1 each; the working worker showed within 2 s of the
  spawn-style trivial prompt — capsule `1 | 1`, row chip "1 个进行中", worker pane
  "Reply OK only / 进行中" — and dropped back to `1 | 0` when the worker finished; the
  right-click close took it to `0 | 0`. A reply-only prompt (no spawn) left the count at
  `1 | 0` for 120 s — no fabricated count (`obs-activate-1.json`,
  `obs-capsule-counts*.json`, screenshot 17-worker-working.png).
- **LIVE FINDING (offline pins missed it; needs a ruling/repair decision):** the capsule's
  floating CSS — `position:fixed`, the pill shape, `cursor:grab` — lives in
  `FLOATING_WINDOW_CSS`, which renders as a `<style>` INSIDE the window's portal tree, so
  it exists ONLY while the window is open. Observed live: with the window closed the
  capsule computes `position: static`, `cursor: default`, 41×23 px at its overlay-flow
  spot, and its store `left/top` are ignored (the draggable-fixed capsule shape returns the
  moment the window opens). All FUNCTIONALITY (counts, aria, click-toggle, drag store
  updates, trailing-click suppression) holds in both states — the gap is the ruling's
  "floating capsule" shape when the window is closed. Suggested direction: mount the
  capsule's CSS at the overlay-entry/body level, not inside the window's portal.
- **Residue note:** the capsule can be dragged UNDER the floating window (the body-level
  portal paints above the overlay layer where they overlap); a covered capsule is
  unclickable until the window moves. No clamp prevents the overlap.

Ticket stays in `open/` for the closer (along with the finding above).

### 2026-09-22 — live-lane repair session

Repaired both findings recorded by the live lane above. Offline work only —
no live dsh/LLM/browser pass was run for the repair; the live lane's styling
observation stands as the motivating evidence, and the repair is
**offline-verified only** (a future live pass should confirm the capsule's
computed `position:fixed` and paint order on the real host).

**Finding 1 (capsule unstyled while the window is closed) — fixed, shape (a).**
The capsule's rules split out of the merged stylesheet into `CAPSULE_CSS`
(`src/client/floating-window.tsx`), rendered as the launcher ENTRY's own
`<style>`, present whenever the entry is mounted regardless of window state;
the window's rules stay in `FLOATING_WINDOW_CSS` inside the window's portal.
Shape (a) was chosen over (b) (hoisting one merged stylesheet into the entry)
because it keeps the window's portal tree self-contained and its pinned child
order (style, titlebar, body) untouched — the ticket-100/105 structural pin
needed no update because the window tree keeps its `<style>` child.

**Finding 2 (capsule draggable under the floating window) — fixed.** Two
halves, both inside the single injected entry: the capsule BUTTON now portals
into the SAME module-owned body-level layer the window uses
(`.multitask-dispatcher-fwin-layer`) — a plain z-index bump inside the overlay
entry could not be trusted, because the module's own recorded DOM-technique
evidence says the overlay layer carries a stacking context in which no integer
outranks the body-level window (the same reason the window portals) — and
`CAPSULE_CSS` gives the capsule `z-index:1001`, one above the window root's
1000, so with both surfaces `position:fixed` in the ONE shared layer the
higher integer wins deterministically. The capsule is the always-present
affordance (Windows-taskbar-like) and stays clickable where the two overlap.
The entry remains the ONE `shell.overlay` seam (id and order unchanged;
`launcherOverlayRegistration()` byte-identical) — a portal is view technique,
not a second entry, the window's own recorded posture. Offline (no document)
the capsule now renders nothing — the window's existing no-document posture
(`src/client/index.ts` comment updated in place).

**Pins added** (`test/client-floating-window.test.ts`, new describe
`launcher capsule — styling lifecycle (2026-09-22 live-lane repair)`, +2
tests): finding 1 rendered over a CLOSED store — the window renders nothing,
the entry renders its own `<style>` carrying
`.multitask-dispatcher-fwin__capsule{position:fixed`, the capsule carries the
styled class and its store placement while closed, and it portals out of the
entry's container into the shared layer; finding 2 at source level (jsdom does
not cascade stylesheet rules into getComputedStyle) — entry style declares
`z-index:1001`, the window's portal `<style>` keeps the window root at
`z-index:1000` with no capsule rules, and both fixed surfaces `closest()` into
the ONE layer container. **No existing pins were updated or removed** — the
structural pin stays truthful, and the ticket 105/106 pins stay green. The
window-open path keeps its stylesheet (drag/resize/maximize rules ride the
window's own portal `<style>`), and the capsule's rules are disjoint
selectors, so both surfaces style correctly while open.

**Gates (before → after)**: `npm run typecheck` green → green; `npm test`
**1214/297/0 → 1216/298/0** (+2 tests, +1 suite); `npm run lint:docs` green →
green; `npm run build:client` green (`client/index.js` regenerated locally;
git-ignored — nothing bundle-shaped to commit). Evidence:
`.scratch/testing/2026-09-22-live-105-106-107/offline-107/` (`repair-README.md`
with the artifact→claim map, `repair-before-typecheck-test.txt`,
`repair-after-all-gates.txt`). Ticket left in `open/` for the closer.

### 2026-09-22 — resolution (team-leader close-out)

Resolved by the independent closer, which re-ran every gate itself before closing:
`npm run typecheck` green; `npm test` **1216 pass / 298 suites / 0 fail** (measured, not
claimed); `npm run lint:docs` green; constraint spot-checks clean — still exactly ONE
`shell.overlay` launcher entry (same id `multitask-dispatcher-launcher`, order −10), the
`launcher.capsule.aria` key exists in BOTH en and zh faces under
`validateLocaleDictionary`, the counts derive from the ADR-0010 non-stale mirror snapshots
(no new channel, no optimistic flips), and ADR-0022 is indexed with the human's verbatim
2026-09-22 ruling quoted.

**Shipped** (`1ad8744`, live-lane repair `40505ca`): the launcher chip is a floating,
draggable capsule with live `[dispatchers | running workers]` counts (pure
`describeCapsuleCounts`, its own placement store, 4 px trailing-click suppression) per the
human-ruled ADR-0022; the live lane's two findings were repaired in `40505ca` — the
capsule's `CAPSULE_CSS` now renders from the always-mounted launcher entry (styled while
the window is closed) and the capsule portals into the shared body-level layer at
`z-index:1001` so it paints above the window. Live lane: **PASS on every functional
clause** — counts live 0|0 → 1|1 → 1|0 → 0|0 with stale mirrors excluded
(`obs-capsule-*.json`, README per-claim verdict map), evidence
`.scratch/testing/2026-09-22-live-105-106-107/live/`; the CSS-lifecycle/paint-order repair
is offline-verified only, exactly as its own comment records. Final gates: **1216/298/0**;
lint green.
