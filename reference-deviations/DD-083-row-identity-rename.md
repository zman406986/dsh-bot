# DD-083 — Renameable agent identity vs read-only host session titles
- **Area:** sidebar / roster / agent management (A11)
- **Type:** missing-feature (caused by the host owning session identity)
- **Date:** 2026-09-23

## What the reference does
In the reference tree, the sidebar label is a mutable property of the agent, not just a display string. A small pure model owns the rename commit rule: the draft is trimmed, and committing yields the new name only when the trimmed draft is non-empty and actually differs from the current name — otherwise the edit is a no-op (`the reference tree's frontend/src/production/agent-name-editor-model.ts`, header notes the rule was recovered with cited evidence). The workspace sidebar exercises it: a double-click on a row opens an inline editor for the name (`the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar.tsx`). Agents additionally carry a fuller identity — name, title, description — editable through a profile editor (`the reference tree's frontend/src/recovered/features/agent-info/settings/model.ts`). Renaming is a first-class agent-management affordance.

## What the current build does
The dispatcher shell renders sidebar rows straight from the host's standard sessions feed. The pure projection takes each row's title as the host's human-facing label first, then the plain title, then the raw session id — mirroring the host's "never blank" precedence — and the binding only reads: it upserts, selects, opens, and removes rows, and writes nothing back to the host (`src/client/shell-feed.ts`, ticket 79 / ADR-0020 slice 3). The `ShellRow` component (`src/client/shell.tsx`) renders that title with no edit affordance, and its header comments tie rows to the host sessions contract under ADR-0018/ADR-0020 (workers are leaves; row presence is re-hosted, not rebuilt). A search across `src/client/` finds no rename capability of any kind.

## The deviation
The reference treats the row label as user-owned identity edited in place; the build treats it as a read-only projection of host session state. The gap is structural, not just a missing editor: the build's titles are host-owned data (`displayTitle`) arriving over a read-only feed, so no client-side change can make a rename real unless the host exposes a way to rename a session. The reference's rename also targets an "agent" entity, which has no direct counterpart among dispatcher rows — by design, rows are dsh sessions (ADR-0018/ADR-0020).

## Verdict: ADAPT
Under the authority stack, rows are deliberately scoped to dsh sessions (ADR-0018 as the human-ruled master, carried into ADR-0020's re-host slices), and the PRD makes no rename a success criterion, so the reference's inline rename is not copied as-is. If rename is ever wanted, the real constraint is that `displayTitle` is host-owned: a rename needs a host-side rename feature wired through the existing feed binding, at which point the reference's trim/no-op commit rule could be re-derived independently for the draft input UX. Until that exists or the PRD asks for it, the read-only row is correct behavior and this stays a recorded gap rather than work.

## Incorporation notes
- **Where it would live:** a host-side rename operation, surfaced through `src/client/shell-feed.ts` as a write path alongside the existing read binding, with the edit affordance in `ShellRow` (`src/client/shell.tsx`); the commit-rule model would be a new pure module beside the feed, offline-tested like it.
- **Constraints:** `displayTitle` precedence is the host's — a client-only rename would be overwritten by the next feed sync and would be a lie, not a feature. Any editor must keep the no-blank/no-op guarantees of the reference's rule (re-derived, not copied). Rows are sessions, not agents: renaming an "agent" is out of scope unless the PRD grows agent identity. Subagent rows are already excluded from the feed projection.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** L — depends on a host-side rename API that does not exist today; the client slice alone is small but does nothing without it.
- **Key reference anchors:**
  - `the reference tree's frontend/src/production/agent-name-editor-model.ts` — trim/no-op rename commit rule
  - `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar.tsx` — double-click inline row editor
  - `the reference tree's frontend/src/recovered/features/agent-info/settings/model.ts` — full profile editor (name/title/description)

## Evidence
- Reference: `the reference tree's frontend/src/production/agent-name-editor-model.ts`; `the reference tree's frontend/src/recovered/features/conversation/workspace/sidebar.tsx`; `the reference tree's frontend/src/recovered/features/agent-info/settings/model.ts` (sidebar.tsx and profile editor cited from enumeration, not re-opened)
- Build: `src/client/shell-feed.ts` (title precedence and read-only binding, verified); `src/client/shell.tsx` (`ShellRow` at ~line 335 with ADR-0018/ADR-0020 scoping comments, verified); grep of `src/client/` — no rename affordance anywhere (verified)
