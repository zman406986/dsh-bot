# DD-058 — Caret scroll & emacs line-motion plugins vs native textarea behavior
- **Area:** composer editor (A6)
- **Type:** missing-feature (mostly moot given the build's plain-textarea composer)
- **Date:** 2026-09-23

## What the reference does
The reference prompt editor is a TipTap/ProseMirror contenteditable surface, so it carries two bespoke extensions in the rich-text-editor module. The first, a caret-scroll extension, hooks `appendTransaction`: whenever a transaction changed the document while the selection is empty (i.e. a bare caret) and no transaction already asked the view to scroll, it appends a `scrollIntoView` step so typing keeps the caret on screen. The second, an emacs-style line-motion extension, is a keydown handler that intercepts Ctrl-A / Ctrl-E on macOS (ignored when meta/alt are held): Ctrl-A moves the caret to the start of the current textblock, Ctrl-E to its end, and holding Shift turns the move into a selection extension. Boundary computation walks the textblock's children and treats hard-break nodes as line separators, so the "line" is the soft line inside one paragraph, and the resulting selection dispatch also scrolls into view.

## What the current build does
The build's composer (`Composer` in `src/client/conversation.tsx`) is a plain `<textarea>` with send-state and an Enter/Shift+Enter/IME-aware keydown map. A repo-wide search of `src/` finds no `scrollIntoView` call, no caret-scroll plugin, and no line-motion key handling of any kind.

## The deviation
The build has neither the caret-follows-typing scroll nor the emacs line-motion shortcuts. This is real as an enumeration gap but almost entirely moot as a product gap: a native textarea already scrolls its own caret into view as you type, and OS/browser text-editing conventions supply line-start/line-end motion (Home/End everywhere; Ctrl-A/Ctrl-E come from the platform's readline-style bindings on macOS at the OS level, not from app code). The reference only needed those plugins because its input is a contenteditable document surface, where the browser gives you none of that for free. Neither plugin is implementable against a textarea in any meaningful sense — the ProseMirror transaction/selection machinery they are built on does not exist there.

## Verdict: DO-NOT-INCORPORATE
Under the ruling order (defined in `docs/agents-rulebook.md`) this is an ADR-0018 (U-B — no rich chat ergonomics) scope call, and the PRD's composer is deliberately a plain textarea + send (the build file itself cites U-B for that shape). Porting either plugin would first require replacing the composer with a rich editable surface — a product change no recorded ADR asks for — to solve a problem the textarea does not have. The correct disposition is to record the gap as reference-only behavior: if a future decision upgrades the composer to contenteditable/ProseMirror, this deviation should be re-opened then, and only then.

## Incorporation notes
- **Where it would live:** nowhere today; hypothetically a composer-editor module beside `src/client/conversation.tsx` (or wherever a future rich editor lands), mirroring the reference's extension-per-plugin layout.
- **Constraints:** only meaningful on a contenteditable/ProseMirror surface; must not be bolted onto the textarea composer; mac-only, hard-break-aware semantics would need re-derivation against whatever node schema such an editor uses.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S (moot as specified — zero work now); re-rate M if the composer ever becomes a rich editor.
- **Key reference anchors:** the caret-scroll extension (appendTransaction + empty-selection + scrollIntoView) and the emacs-style line-motion extension with its action and boundary helpers (Ctrl-A/Ctrl-E move-or-extend, hardBreak-aware boundaries) in the reference rich-text-editor module.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/rich-text-editor.tsx` (the caret-scroll extension :579-591; the line-motion action :593-598; its boundary helper :600-618; the line-motion extension :620-641)
- Build: `src/client/conversation.tsx` (:16, :179-223 — plain textarea composer, Enter-only keydown map); no matches for caret-scroll or line-motion machinery anywhere under `src/`
