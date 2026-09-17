# The dispatcher capsule is one additive `shell.overlay` entry — not a sidebar takeover or a keyed claim

**Status:** draft

**Approval:** non-human — agent-drafted, pending human sign-off

**Numbering:** 0013, the first free number. 0010–0012 are **reserved to design-17 §9's ADR plan** (ADR-0010 presence-as-projection → tickets 27/28; ADR-0011 session-scope always-allow → ticket 30; ADR-0012 activation-replays-durability → ticket 31) even though those ADRs are not yet filed, and that reservation supersedes design-16 §9's older *conditional* ADR-0010 sketch (client-face surfaces, tickets 20/21 — never written, its content is covered by ADR-0009's consequences and the tickets themselves). The capsule epic's drafts therefore start at 0013 (this file), 0014, 0015.

The dispatcher's always-available control surface is a **floating, expandable capsule registered as exactly one additive `shell.overlay` list entry** (existing id `multitask-dispatcher-roster`, order −10): collapsed = one small chip (activation-state dot, worker count, wake badge); expanded = the panel card anchored to the chip. The capsule does **not** take over the right sidebar and does **not** claim a `sidebar.right.pane.tab` key. This records epic 35's fixed design direction as a draft decision; implementers refine it, they do not reopen it.

## Context

- Ticket 36 re-verified the slot's anatomy against the installed dsh 0.1.5-rc.1 tree (**VERIFIED**, `docs/research/dsh-capsule-seams.md` seam 1): `shell.overlay` is a frame-wide additive `list` slot, `scope: "root"` — entries append beside shipped ones, sorted by `order ?? 0`, each rendered inside its own error boundary; a crashing `list` entry **abdicates** (is retired from the layer with a bare error marker) instead of taking the shell down. The layer is `pointer-events:none` with a direct-child opt-back-in rule; through the slot outlet's `display:contents` anchor, pointer events inherit to every entry subtree, so an entry blocks only where it draws. There is **no geometry, anchor, or positioning API** — entries position themselves with their own DOM.
- The shipped registry's own convention statement points here: the `root` SlotMap entry says DO **NOT** register there — "For a surface of your own that floats over the whole app, register into `shell.overlay` instead (a list slot: additive, and click-through until your entry opts into pointer events)" (`dsh-client-ui-renderer lib/types/client/registry.d.ts:16–38`). dsh prescribes exactly this slot for exactly our use case.
- Research Finding 1's lesson (`docs/research/dsh-plugin-ui-examples.md`): Better Sidebar abandoned its own floating panel for native slots. Our equivalent reading is about *safety*, not mimicry — `shell.overlay` is additive, order-sorted, click-through, and safe to stack with other plugins' entries; a takeover of a shared single slot is none of those things.
- The chip must be visible in every chat, dormant or activated (ticket 32's dormant composition is the unactivated chat's whole experience): a surface confined to the right panel cannot carry the glanceable presence projection.
- The five dispatcher tool-call views stay keyed in `tool.call.toolview` where the calls happen (ticket 24); the capsule at most links to the latest (epic §4, ticket 42) — the slot decision does not move them.

## Considered options

| Option | Rejected/kept because |
|---|---|
| **A. One additive `shell.overlay` entry: collapsed chip + expanded panel (epic design direction)** | **Chosen.** Additive and safe to stack; per-entry error boundary contains crashes (list-kind abdication); frame-wide root scope keeps the chip glanceable in every chat; the slot dsh's own docs prescribe for floating plugin surfaces; anatomy verified end to end by ticket 36. |
| B. Right-sidebar takeover (displace or shrink the shipped `rightbar` single slot) | Rejected: `rightbar` is a single slot owned by the shell — displacing its content is a takeover of a shared surface, not additive stacking. It breaks plugin coexistence, hides the dormant pitch, and repeats the exact lesson the research flagged about migrating into takeover surfaces. |
| C. `sidebar.right.pane.tab` keyed claim (unclaimed key `dispatcher`); `sidebar.panellist` list entry considered alongside | Rejected: the pane-tab kind is **shadowing per cell**, the surface is confined to the right panel (invisible until the user opens it), and it forfeits the frame-wide layer. Keyed claims that happen to be free today are ours only until a shipped tab wants the key. Same confinement objection applies to `sidebar.panellist`. |
| D. Register `root` | Refused outright by the shipped DO-NOT convention (registry.d.ts:16–38): a second `root` entry shadows the AppFrame. Never a candidate. |

## Consequences

- Exactly one `shell.overlay` entry, unchanged id `multitask-dispatcher-roster` and order −10 (`src/client/overlay.ts`); expansion/collapse is the entry's **own component state** — the host offers no expansion, geometry, or anchoring API, so the chip and its card position and size themselves.
- Click-through is ours to manage: the entry inherits pointer events over its whole subtree; any pass-through region (e.g. outside the expanded card, if no dimming backdrop is wanted) must set `pointer-events:none` itself.
- A crashing capsule entry is **silently retired** from the layer (list-kind `abdicate: true`); the `ctx.slots.onEntryError` supervision seam should be used to log/flag the abdication rather than leaving a vanished chip unexplained (bounded follow-up for ticket 38).
- Root scope is deliberate: the chip is the glanceable presence projection in every chat, and the activation row acts on the *current* session via `ctx.sessions.list.current` (seams note, seam 2) — per-session scoping would strand the dormant composition.
- The capsule never embeds a tool view; the link-only rule for `tool.call.toolview` (ticket 42) is part of this decision's boundary.
- Sources: epic 35 (design direction, §4); ticket 36 / `docs/research/dsh-capsule-seams.md` seams 1–2; `docs/research/dsh-plugin-ui-patterns.md` Finding 5 (slot kinds/scopes, the `root` DO-NOT) and its `sidebar.right.pane.tab` catalog row; `docs/research/dsh-plugin-ui-examples.md` Finding 1. No reference-plugin code was read into this decision beyond the abstract mount-pattern note.
