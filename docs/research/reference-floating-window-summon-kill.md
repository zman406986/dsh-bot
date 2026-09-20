# Research: how the reference summons and kills agents — and where those controls live

- Question: Ticket 102's open question — in the reference tree, is there a floating/detached window or overlay panel, and where do "add a session" and "delete/kill a session" controls live relative to it? Specifically: (a) does a floating chrome exist and what rides it, (b) where do add and delete controls live and what decides their visibility, (c) is the destructive control made less prominent than the additive one, (d) is agent/session management a window-chrome affordance or a list affordance?
- Scope: reference tree only (`reference material-NOT LICENSE SAFE DONT COPY-grok bot/`). Behavior and structure described in plain language; **no source bodies, prompts, or protocol artifacts were copied**. Reference identifiers and short UI strings appear only as evidentiary citations of where a behavior lives (path + symbol), never as implementation text; every finding is anchored to a file path and line.
- Caveat on the source: the tree is an unofficial, source-oriented **reconstruction** of a shipped desktop app (Product: Grok Bot, Version 0.18.0, per its `PROVENANCE.md`). The shipped renderer was optimized bundles, not authored source; the `frontend/` tree is a partial evidence-backed reconstruction. Treat every statement below as "what this reconstruction encodes", not as the vendor's verified binary behavior.
- Tree revision read: nested `.git` HEAD `a9f633e09d49a85829b8236331b9e21f7e612634` (2026-08-23), tree version `0.18.0-reconstructed.1`.
- Related: `reference-agent-lifecycle.md` (backend create/delete/abort flow, which this note does not repeat), `reference-behavior-notes.md` §1 (stop semantics), `reference-architecture-patterns.md` (module shape).
- Date: 2026-09-21

---

## Verdict

**The reference has no separate floating/detached dispatcher window.** There is exactly one product session window — the main window — plus an always-on-top security-key prompt that is not a session surface (see (a)). "Floating" in this tree names an in-window **overlay primitive family** (menus, popovers, tooltips, select popups, context menus) and a set of **modal overlay surfaces** (Settings, Plugins, Hidden Bots, About, Feedback, sign-out, deep-link info) rendered inside the main window — they are not OS windows a user can summon or kill a session from.

**Summon and kill are both list affordances, not chrome affordances.** The additive control (a new-chat plus-icon button) is always visible in the sidebar header; the destructive control (row delete) is reachable only through a right-click / Shift+F10 **context menu on a session row**, placed **last** in that menu, and gated behind a modal confirm dialog. Window chrome carries nothing but minimize / maximize / close.

So the reference's answer to ticket 102's question is: it does not solve session summon/kill with a window-chrome affordance at all. It puts the "+" in the list header and hides the kill behind a row context menu.

---

## (a) Is there a floating/detached window or overlay panel? What rides its chrome?

**No detached session window, and no always-on-top window that serves as a session surface. The one always-on-top product window in the tree is a WebAuthn security-key prompt.**

Evidence (positive — what does exist):

- **Main window chrome carries only the three OS controls.** `frontend/src/recovered/features/window-chrome/view.tsx:48-54` renders a drag region plus three buttons — minimize, maximize-or-restore, close — wired to the platform window-control bridge. Nothing agent- or session-related is here. The chrome component's props (`view.tsx:28-33`) are the desktop bridge and fullscreen / maximized / overlay-tone flags only.
- **The Windows/Linux chrome is a custom titlebar overlay, still window-only.** `source/electron-main/window-chrome.ts:91-107` (`windowChromeOptions`) returns a Windows titlebar-overlay treatment for win32 and a hidden-inset titlebar for mac — a titlebar treatment, not a second window.
- **"Floating" is an in-window primitive.** `frontend/src/recovered/ui/sand-floating-primitives.tsx` defines popover / tooltip / menu / context-menu / select primitives. The floating surface is fixed-position, stacked above page content, and portalled to the document body (`sand-floating-primitives.tsx:192-211`) — an anchored popup, not a window.
- **Modal overlay surfaces are also in-window.** `frontend/src/production/ProductionRenderer.tsx:340-348` defines one full-viewport scrim frame style reused by the Settings, Plugins, Hidden Bots, About, Feedback, sign-out and deep-link dialogs (`ProductionRenderer.tsx:3630-3665`).
- **The recovered surface taxonomy has no "window" member.** `frontend/src/recovered/runtime/entrypoints.ts:1` — `RecoveredSurface` is `"overlay" | "workspace"`. The five recovered entrypoints are all overlay or workspace; none is a detached window.

Evidence (the one always-on-top product window in the tree, and why it is not a session surface):

- `source/electron-main/coordinator/coordinator-executors.ts:130-137` — the prompt-window options set `alwaysOnTop: true` and disable resize/minimize/maximize, with a title naming it a security-key request. This is the WebAuthn security-key prompt, built by `createWebAuthnPromptWindow` (`source/electron-main/adapters/coordinator-native.ts:55`), and it is the only always-on-top **product** window in the tree. Non-product windows are outside the count: hidden offscreen helper windows for attachment/avatar work (`source/electron-main/adapters/attachment-gateway.ts:127`, `avatar-images.ts:67`), and dev tooling's own Dev Controls panel (`source/electron-main/dev/dev-controls-window.ts:168`, `source/electron-dev-controls/main.ts:120`). The point is the same either way: the reference's sole always-on-top window is a security-key prompt, not a session surface, and none of these is a dispatcher or roster surface.

**Verdict (a): no floating/detached session window exists; "floating" means in-window popups, and window chrome is OS controls only. No evidence found of a floating-window chrome affordance for session management.**

---

## (b) Where do add/new and delete/stop/kill controls live? What decides visibility?

**Add lives in the sidebar header, always visible. Delete lives in a per-row context menu, revealed on right-click, last in the menu, then confirmed in a modal.**

Add / summon:

- `frontend/src/recovered/features/conversation/workspace/sidebar.tsx:123-137` — `AgentSidebarHeader` renders a plus-icon button for starting a new chat, with a new-chat click handler (`sidebar.tsx:135`). It is inside the header, always rendered when the header renders; the only conditional is the collapsed-rail variant (a circle instead of a square) and the two collaboration buttons beside it (`sidebar.tsx:129-132`, shown only when expanded and collaboration actions exist).
- The header itself is chosen by an either/or, not an extra control: `sidebar.tsx:455` renders `SidebarSelectionActions` when a multi-select is active, else `AgentSidebarHeader`. So the "+" is replaced by selection actions while selecting — it is never hidden behind hover.
- Creation then runs through RPC, not local state: `ProductionRenderer.tsx:2810-2823` (a create-agent call with a default new-chat name, then open the created agent).
- A keyboard path exists too: `frontend/src/recovered/features/window-chrome/global-keyboard-shortcuts.ts:47` registers a `sand.newAgent` action labelled "New Bot" on `mod+n`, enabled in content-editable fields.

Delete / kill (per session):

- `frontend/src/production/AgentRowActions.tsx:45-107` wraps each row in `SandContextMenu`. The menu is opened by `onContextMenu` (`:55-58`) or Shift+F10 / ContextMenu key (`:59-64`); it is not rendered inline and has no hover trigger. The row itself (`sidebar.tsx:215-284`) is a `<button>` with no delete affordance in its own markup.
- The menu content is built by `agentRowActions(...)` in `frontend/src/production/agent-row-actions-model.ts:45-55`. **Delete is appended last**, after Pin/Unpin, Mark read/unread, Duplicate, Copy conversation ID, and Hide from sidebar.
- Delete is confirmed in a modal, not executed directly: `ProductionRenderer.tsx:3449` wires the row's delete request to open the dialog, and `ProductionRenderer.tsx:3729` renders `AgentDeleteConfirmation`; the dialog is at `frontend/src/production/AgentDeleteConfirmation.tsx:94-102`, has alert-dialog and modal ARIA roles, an irreversible-loss sentence (`:20-21`), and focuses the **confirm** button on open (`:40`). The confirm button uses `sentiment="danger"` (`:100`).
- The actual call is an RPC delete over the agent id list (`ProductionRenderer.tsx:3130-3137`).

Multi-select delete is a second, separate surface:

- `sidebar.tsx:144-173` (`SidebarSelectionActions`) renders a `Delete` button with `sentiment="danger"` (`:170`) into the header slot while a selection is active, alongside a `Move` menu and `Clear`. This is the only place a delete control is always visible — and only while a selection exists.

Stop / kill a *running* session is not in the roster at all:

- The frontend search for stop/interrupt controls on an agent row returns nothing; the only stop-labelled strings found are unrelated — a dictation-stop control (`composer.tsx:202`) and a recording-stop control (`computer/teach-recording/view.tsx:87`). Backend stop is a dispatcher-facing tool (`reference-behavior-notes.md` §1) with no roster control evidenced here.

What decides visibility, in code terms:

- Add: unconditional render inside the header (`sidebar.tsx:135`), overridden only by the collapsed variant.
- Row delete: conditional **menu composition** — `agentRowActions` returns `[]` for a hidden agent (`agent-row-actions-model.ts:46`) and includes delete only when the `onRequestDelete` prop is non-null (`:53`; wired at `AgentRowActions.tsx:48`).
- Section-level delete: also a context menu, `sidebar.tsx:379-390` (Rename / Move up / Move down / Delete), opened from `SidebarSectionActions` (`:363-393`).
- Hover-reveal does exist in this sidebar for a *decorative* element only: the section header's trailing chevron is `opacity: 0; width: 0` until `:hover`/`:focus-visible` (`frontend/src/recovered/features/conversation/workspace/view.css:43-45`). Hover-revealed actions elsewhere are generic (message hover actions, `view.css:128-134`) — not used for agent add/delete.

**Verdict (b): add is an always-visible header icon; delete is context-menu-only on the row, last item, behind a modal confirm. Visibility is decided by menu composition and modal state, not by hover CSS (hover CSS only hides the section chevron).**

---

## (c) Is the destructive control deliberately less prominent than the additive one?

**Yes — three independent signals point the same way, and all are additive-safe.**

1. **Placement asymmetry.** Add is a permanently visible icon button in the header (`sidebar.tsx:135`). Delete requires discovering a right-click context menu on a row (`AgentRowActions.tsx:55-64`) and is the **final item** in that menu by construction (`agent-row-actions-model.ts:53` — delete is the last spread in the array literal).
2. **Sentiment asymmetry.** The two always-visible delete buttons that do exist carry `sentiment="danger"` (`sidebar.tsx:170`; `AgentDeleteConfirmation.tsx:100`), resolving to a danger background in the kit (`frontend/src/recovered/ui/sand-kit-primitives.css:61`, `--cursor-danger`). The add button is the neutral/primary icon button — no danger sentiment (`sidebar.tsx:135`).
3. **A confirmation gate the additive path does not have.** Delete cannot execute from the menu: the menu item calls `onRequestDelete` (`AgentRowActions.tsx:95`), which sets a target and opens an alert dialog whose confirm button is focused-by-default (`AgentDeleteConfirmation.tsx:37-44, 94-102`) and whose copy states the action "can't be undone" (`:20-21`). `createAgent` has no confirm step (`ProductionRenderer.tsx:2810-2823`).

The library-level primitives support, but do not themselves enforce, this: `SandMenuItem` has a `disabled` flag (`sand-floating-primitives.tsx:364-382`) and the context-menu/select/menu surfaces have no generic "destructive" styling — so the asymmetry is expressed by **call-site choice** (placement + `sentiment` + confirm modal), not by a primitive that automatically demotes destructive actions.

**Verdict (c): yes. Destructive controls are demoted by placement (buried in a context menu, last), by danger styling, and by an extra irreversible-action confirm step; additive controls get none of these barriers.**

---

## (d) Is agent/session management a window-chrome affordance rather than a list affordance?

**No. Every session-management control the tree evidences is a list affordance; window chrome carries only OS window controls.**

- Window chrome: minimize / maximize / close only (`window-chrome/view.tsx:48-54`). No agent affordance rides the chrome.
- List header: the new-chat plus button (`sidebar.tsx:135`), and the collaboration actions Broadcast / Org-chart-network (`sidebar.tsx:129-132`).
- List row: rename (double-click, `sidebar.tsx:262-265`), agent actions context menu (pin/unread/duplicate/copy id/hide/delete, `AgentRowActions.tsx:73-101`), multi-select via modifier-click (`sidebar.tsx:250-261`).
- List footer (still the sidebar column, not chrome): the Hidden Bots button, `ProductionRenderer.tsx:3451` — rendered only when hidden agents exist alongside visible ones; the Plugins pill (`:3453`); the account menu (`:3454`).
- The only management action reachable from a *global* surface is the command palette (`mod+k`): `ProductionRenderer.tsx:3321-3322` registers a command to open the Hidden Bots overlay, and the global shortcut registry includes a new-agent action (`global-keyboard-shortcuts.ts:47`). The palette also cannot delete — no delete command was found in `command-palette-root-commands.ts` (its rows are Members / Channels / Chat Settings / computer update, `:34-76`).
- Note the One Exception That Proves The Rule: the `Hidden Bots` **unhide** control is rendered inline on each row of the Hidden Bots *overlay* (`hidden-chats/overlay/view.tsx:127`), i.e. inside a modal content surface, not in chrome. So even the "bring a session back" affordance is content, not chrome.

**Verdict (d): no — agent/session management is entirely a list affordance (header + row context menu + selection header), everywhere it is evidenced. Window chrome carries nothing but window controls.**

---

## Implications for dsh (ticket 102)

These are the reference's actual choices, not recommendations; ticket 102 is the human's call.

1. **The reference does not answer "summon/kill from the floating window" — it has no floating session window.** If dsh puts its dispatcher in a floating/overlay surface, the reference offers **no precedent** for summon/kill controls on that surface's chrome. That is new design, not imitation.
2. **The reference's separable patterns are portable.** Always-visible `+` in the header; per-row actions behind a context menu; destructive item last; danger sentiment; irreversible-action confirm modal; multi-select bulk delete in the header slot while selecting. Each is independently evidenced (paths above) and is a low-risk adapted-imitation candidate.
3. **The reference's "stop a running session" has no roster control.** If ticket 102's "kill old ones" means *stop a running dispatcher*, the reference's only stop paths are a dispatcher-facing tool (`reference-behavior-notes.md` §1) and a backend interrupt; there is no user-facing roster button to imitate. "Kill = delete the session" is the only roster-level destructive action the reference evidences.
4. **Watch the asymmetry when copying.** The reference puts delete in a right-click menu, which is desktop-mouse-native. A web/overlay dispatcher with a touch or keyboard-reachable surface may need a visible per-row affordance — which the reference's own multi-select delete button (`sidebar.tsx:170`) shows is acceptable to it in a selection context.

---

## Method / reproducibility

Read the production renderer's session surfaces end-to-end (`ProductionRenderer.tsx` create/delete/hide/duplicate/rename handlers, sidebar wiring, overlay frame, command palette), the sidebar component and its action model (`sidebar.tsx`, `AgentRowActions.tsx`, `agent-row-actions-model.ts`), the delete confirm dialog, the window-chrome component and its Electron options, the floating-primitive library and its CSS, the recovered surface taxonomy, and every `BrowserWindow` creation site in the tree (the always-on-top WebAuthn prompt, the main window, and the hidden helper and dev-tooling windows). Grepped the whole tree for `alwaysOnTop` / `setAlwaysOnTop` / `detach` / `floating window` / `add agent` / `spawn agent` / `summon` / `stopAgent` / `interruptAgent` / `killAgent` to establish the negatives in (a) and the stop-control negative in (b); those negatives are search-bounded, not proofs.

Counts read: ~15 frontend files in full and ~10 more by targeted section; the Electron-side window-creation sites across 7 files (window chrome, coordinator, adapters, dev tooling; several by targeted section); ~60 line-anchored citations.

Not done: the multi-agent selection header's full CSS was inferred from markup only; the packaged renderer bundle was not disassembled (the reconstruction's own citations to `index-UbX-y3il.js` were not independently re-verified); no comparison against dsh's current floating-window implementation was performed; no network or LLM calls.

---

## Open / unclear

- **Whether the shipped product had a detached "always-on" mini-window** that this reconstruction dropped. `frontend/src/recovered/features/computer/overlay/view.tsx:6-8` is an explicit placeholder noting the shipped 0.18.0 Computer view renders nothing, so at least one shipped overlay view is *not* recovered — a detached dispatcher window, if it existed, could be in similar un-recovered space. No evidence found either way.
- **The Windows-only `titleBarOverlay` tone path** (`window-chrome/view.tsx:38-41`, `bridge.windowControls.setTitleBarOverlayTone`) hints the chrome is theme-aware, but nothing suggests it ever hosts session controls.
- **Stop/interrupt of a top-level run from the UI**: `reference-behavior-notes.md:27` already flags the renderer's cancellation presentation as only partly recovered; this note found no roster stop control, which is consistent with that gap rather than proof of absence.
- **The `mod+n` "New Bot" shortcut is labelled "New Bot"** while the sidebar button is "New chat" (`global-keyboard-shortcuts.ts:47` vs `sidebar.tsx:135`) — a copy inconsistency in the reconstruction, noted because it affects any adapted copy we take.