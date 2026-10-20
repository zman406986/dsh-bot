# DD-018 — Shortcut mechanics machinery vs none
- **Area:** keyboard shortcuts (A2)
- **Type:** missing-feature (machinery behind DD-016)
- **Date:** 2026-09-23

## What the reference does
The registry DD-016 catalogued sits on a machinery layer that makes it work. (1) Key normalization (a normalization helper, `global-keyboard-shortcuts.ts:87-96`): `event.key` is lowercased and aliased — arrow names folded to their plain form, punctuation keys mapped to their spelled-out names — so the declarative hotkey strings and live keyboard events agree. (2) Chord matching (a matcher pair, :115-130): a hotkey string may carry comma-separated alternate chords (focus-prompt's two-alias entry at :51 is the only shipped user), and a chord matches only when the normalized key equals and every modifier compares exactly — the mod modifier means `metaKey || ctrlKey`, and alt/shift must match exactly, so near-misses never fire. (3) Content-editable gating (an editable-element helper at :98-113 plus an action resolver at :132-141): the resolver treats the target's editability as a veto unless the action carries an editable-context flag that allows it; every root action carries the flag except focus-prompt — the deliberate jump-into-the-editor exception. Resolution is first-match-wins via a table scan with a `defaultPrevented` bail-out, so there is no user-facing conflict resolution, only registry order. (4) Subscription discipline (a shortcut controller factory, :164-208): a reference-counted document-level keydown listener — the first subscriber attaches, the last unsubscribe detaches — with live action-table and overlay-state swapping and an Escape branch that defers to `defaultPrevented`.

## What the current build does
None of this machinery exists anywhere in `src/client/`. A grep of `src/client/` and `src/core/` for `keydown|KeyboardEvent|onKeyDown|metaKey|ctrlKey|hotkey|chord` finds exactly two keyboard handlers, both local and both trivial: the composer's own gesture map at `src/client/conversation.tsx:210-222` — plain Enter submits, Shift+Enter keeps the line break, IME composition Enter confirms the candidate, plus ticket 92's accelerated Ctrl/Meta+Enter submit — which mirrors stock dsh, not the reference shell; and `src/client/shell.tsx:595-604`'s document keydown whose only job is closing the row context menu on Escape. There is no normalization table, no chord parser, no editable-context gate, and no subscription controller — and nothing for them to act on, because the registry itself is the DD-016 absence.

## The deviation
DD-016 recorded the missing registry; this records the missing machinery underneath it. Four reusable mechanics would have to be re-derived before any binding can exist: key-name normalization, exact multi-chord matching, editable-context gating, and listener lifecycle. None is hard — they are pure functions plus one small controller — but one piece of the reference shape is specifically the wrong shape for this build: the ref-counted *document-level* subscription encodes a single-owner app shell, while the floating window shares one DOM document with stock dsh and must gate on focus-within (DD-016's coexistence constraint), so that piece would be adapted rather than mirrored. The area is unruled in the same way DD-016 is: no ADR, surface note, or ticket ruling records any of it.

## Verdict: ADAPT
This is the machinery layer for DD-016 and inherits its disposition: DD-016's verdict is ADAPT, explicitly unruled and pending a human nod on the binding subset — nothing here has been ruled either. If that subset is approved, build the machinery to serve it: exact-mod chord matching, minimal key normalization, and an editable-context-style gate (the reference's own model of "don't steal chords while typing", already named in DD-016's constraints), re-derived in our own words. The one deliberate non-adoption is the ref-counted document-global controller, which the focus-scoped coexistence approach replaces; comma-separated alternate chords and first-match-wins ordering can ride along for free. Nothing should be built ahead of DD-016's ruling — machinery without an approved registry is dead code.

## Incorporation notes
- **Where it would live:** beside whatever module holds the DD-016 binding table (proposed `src/client/shortcuts.ts`): pure normalize/match/gate helpers plus one focus-scoped subscribe function, wired in `src/client/shell.tsx` next to the existing Escape listener.
- **Constraints:**
  - Sequence: build only after DD-016's subset is approved; the machinery follows the registry, never leads it.
  - Focus-scoped, not ref-counted document-global: attach while the floating window has focus-within, detach on blur/unmount; `preventDefault` only for chords the build actually claims.
  - Exact modifier semantics (`mod` = meta OR ctrl; alt and shift compared exactly) and a normalize list limited to the chords actually shipped.
  - Editable gating with the focus-prompt exception pattern; IME-safe like the composer handler (`conversation.tsx:219` — never claim keys during `isComposing`).
  - No conflict-resolution layer: keep the table small enough that registry order (first match wins) suffices.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a handful of pure functions plus one gated listener; the risk is platform key/IME quirks, and scope creep toward the full document-global controller is blocked by DD-016's focus constraint.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:87-96` — the key-normalization alias table
  - `:115-130` — the hotkey/chord matchers (comma-separated alternate chords; exact mod/alt/shift comparison)
  - `:98-113` + `:132-141` — the editable-element helper + the action resolver (content-editable gate, first-match-wins, `defaultPrevented` bail-out)
  - `:51` — focus-prompt's two-alias entry, the sole root action without the content-editable flag
  - `:164-208` — the shortcut controller factory (ref-counted document-level subscription — the shape NOT to copy; the focus gate replaces it)

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts` (:87-96 normalization; :115-130 chord matching; :98-113 and :132-141 editable gating and resolution; :51 focus-prompt exception; :164-208 ref-counted controller)
- Build: grep of `src/client/` + `src/core/` for `keydown|KeyboardEvent|onKeyDown|metaKey|ctrlKey|hotkey|chord` → only `src/client/conversation.tsx:210-222` (composer gesture map, ticket 92) and `src/client/shell.tsx:595-604` (Escape closes context menu); `src/client/` file listing contains no shortcut/registry module
