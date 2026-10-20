# DD-016 — Global shortcut registry vs none
- **Area:** keyboard shortcuts (A2)
- **Type:** missing-feature (undocumented absence)
- **Date:** 2026-09-23

## What the reference does
The reference ships a root shortcut registry — one ordered table of chord → action bindings created by a shortcut-action factory (the reference tree's `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:45-74`), whose handlers are built in the production renderer and subscribed to the whole `document` (the reference tree's `frontend/src/production/ProductionRenderer.tsx:2826-2894`, controller subscribing to the document at :2893). The shipped bindings, by action:

- a new-bot (new agent) chord
- a jump-to-command-palette chord
- an open-settings chord
- a tools-customizer chord
- two alias chords for focusing the prompt (one action)
- a search-agents chord
- previous / next agent (a pair of arrow chords)
- navigate back / forward (a pair of bracket chords)
- focus sidebar agent 1–9 (numbered modifier chords)
- a toggle-compact-sidebar chord (appended at :69; carries an `@evidence` byte-offset comment marking it as recovered shipped behavior)
- a find-in-chat chord — conditionally spliced into position 6 only when a find-in-chat handler is provided (:70-72)

Each entry also carries an editable-context flag — the shipped registry already models "do not steal chords while the user is typing" — and the registry order is explicitly documented as the shipped global registry order.

## What the current build does
Nothing, globally. A grep of all of `src/` for `keydown` / `KeyboardEvent` / `onKeyDown` finds exactly two handlers, both local and both trivial:

- `src/client/shell.tsx:595-600` — a `document` keydown listener whose only job is closing the row context menu on Escape (alongside pointerdown/scroll dismissal).
- `src/client/conversation.tsx:210-222` — the composer's `onKeyDown`: plain Enter submits (Shift+Enter keeps the line break, IME composition Enter confirms the candidate), per the shipped composer gesture map recorded under ticket 92.

No modifier-key chord is handled anywhere in the build; the floating window has zero key handling beyond those two local cases. The composer case shows the build does honor shipped keyboard behavior where a surface exists — it is the global registry tier that is absent.

## The deviation
The reference has a whole product tier the build lacks: a document-level shortcut registry giving keyboard access to every root action. The build has none of it — no chord handling, no registry structure, no focus-prompt or prev/next-session acceleration. This is an **undocumented absence, not a designed one**: grep of `docs/adr/*`, `docs/surfaces.md` (literally titled "the designed absences"), and the PRD for keyboard/shortcut/hotkey/keybind/`mod+` returns no hits. No ADR, surface note, or ticket ruling records the omission, so this is an unruled area under the authority stack.

## Verdict: ADAPT
No doc records this absence — the enumeration found nothing ruling it in or out, so this is an unruled area and the verdict below is a proposal, not a settled call. Most bindings are moot because their targets do not exist in the floating window: command palette, search agents, find in chat, settings dialog, tools customizer, compact-sidebar toggle, and back/forward history all reference surfaces the build never shipped (and per DD-003 navigation history is itself absent). A few are cheap, self-contained ADAPT candidates that operate on surfaces the floating window *does* have: focus prompt (its two alias chords), previous/next session (the arrow chords), focus sidebar session N (the numbered modifier chords), and arguably new session (the modifier-letter chord, now meaningful since ADR-0021 decision 3 added the add affordance). Any subset must be limited to the floating window rather than working document-wide — ADR-0021/0022's additive coexistence arrangement means stock dsh stays the primary UI in the same DOM document, so chords captured while the user is working in stock dsh would be exactly the interference the ruling forbids, and chords the browser already reserves (the find-in-chat, new-window, and palette chords) should be avoided entirely. Because the area is unruled, the concrete subset and its gating rule should get a human nod (ticket or ADR note) before implementation rather than being slipped in.

## Incorporation notes
- **Where it would live:** a small binding-table module beside the floating-window shell (e.g. `src/client/shortcuts.ts`), wired in `src/client/shell.tsx` next to the existing Escape listener; a single keydown listener gated on focus-within-the-floating-window, mirroring the shipped registry's shape (an id, a label, a hotkey, an editable-context flag, and a run action) without copying it.
- **Constraints:**
  - Focus-scoped, never document-global: fire only when the event target is inside the floating window; `preventDefault` only there (ADR-0021 coexistence; the DOM window shares one document with stock dsh and the host page, so chords pass through both ways).
  - Only bindings whose targets exist today: focus prompt, prev/next session, focus sidebar session 1–9, new session. Skip palette/search/find-in-chat/settings/tools/sidebar/back-forward until (unless) those surfaces exist.
  - Respect typing contexts: keep an editable-context-style guard so chords never fire while the composer or an editable has focus (except focus-prompt, which is the point of that chord).
  - IME-safe like the composer handler (`conversation.tsx:219`); avoid browser-reserved chords; keep bindings additive and individually removable.
  - Unruled area: record the chosen subset as a dated ruling/ticket comment before implementing, per ADR-0017's rule that deviations need approval and the authority stack's "no recorded decision → stop and ask" rule.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one focus-scoped listener plus a four-to-six-row binding table; risk is chord collision with stock dsh/browser and scope creep toward the full registry, both contained by the focus gate and the subset rule.
- **Key reference anchors:**
  - the reference tree's `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:45-74` — the registry (the compact-sidebar binding appended at :69 with an `@evidence` byte-offset comment; conditional find-in-chat splice :70-72)
  - `frontend/src/production/ProductionRenderer.tsx:2826-2894` — handlers built in a memoized block at :2826; the shortcut controller subscribing to the document at :2893
- **Build anchors:** `src/client/shell.tsx:595-600` (Escape closes context menu); `src/client/conversation.tsx:210-222` (composer Enter submit, ticket 92 gesture map)

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts` (:45-74 registry, :68-72 evidence-commented append/splice); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (:2826-2894 handler construction and document subscription)
- Build: grep of `src/` for `keydown|KeyboardEvent|onKeyDown` → only `src/client/shell.tsx:595-604` and `src/client/conversation.tsx:210-222`; grep of `docs/adr/*`, `docs/surfaces.md`, `PRD-dsh-multitask-dispatcher.md` for `keyboard|shortcut|hotkey|keybind|mod+` → no hits (absence undocumented)
