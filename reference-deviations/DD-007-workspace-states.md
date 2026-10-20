# DD-007 — Workspace loading/empty/connection states vs plain copy
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature (partly designed)
- **Date:** 2026-09-23

## What the reference does
The reference shell has a first-class family of workspace states, computed as explicit booleans and rendered as dedicated surfaces (the reference tree's `frontend/src/production/ProductionRenderer.tsx:3349-3351`):

- a root-loading flag — while the account is logged in but no agent is active and transport is still connecting, a full root-shell loading surface (a setup-in-progress copy) occupies the shell until the first roster lands.
- a root-empty-workspace flag — a distinct connected-but-zero-agents empty workspace surface, gated on a connected transport plus a loaded roster of zero agents, so "still loading" and "genuinely empty" are visually different states rather than one ambiguous blank.
- The root shell div carries state attributes (empty/loading/runtime flags) so chrome/CSS can react to shell phase (`ProductionRenderer.tsx:3426`).
- The roster renders its own status line: an empty kind when zero agents, an all-hidden kind (with an affordance to reveal hidden bots) when everything is filtered out (`:3380-3386`).
- A per-agent transcript load failure renders a dedicated transcript-load error surface with a retry path, scoped to the active agent (`:3420-3422`).
- Connection health is surfaced in-shell: a coordinator-connection host sits at the top of the sidebar grid (`:3448`), the sidebar receives a host-reachable flag derived from transport state (`:3449`), and a window status badge shows transport state (`:3428`).

Sign-in and access are the outermost gates of the same family: a sign-in flag plus the access-cover composition hold the whole shell behind auth/permission surfaces before any of the above states can appear (same block, `:3349-3361`).

## What the current build does
`src/client/shell.tsx` renders three plain-copy states and nothing else in this family:

- An empty-roster line: `sidebar.kind === "empty"` → one muted `shell.empty` div (`shell.tsx:665-666`).
- A no-selection line, or the onboarding component when the first-run flow is unsuppressed (`:702-714`).
- A conversation-pending line when no conversation pane is bound, explicitly framed as "honest pending copy instead of an invented surface" (`:725-731`).

There is no loading state, no transport-connected gating of any surface, no all-hidden roster status, and no transcript-error surface. The file header records this as deliberate: failure states are honest copy only — empty / presence-unavailable — and deliberately retry-less, with no retry control and no reconnect banner (`shell.tsx:36-37`). The account and transport the reference gates on do not exist in this layer: the host owns account/transport, and the dispatcher window is presence copy over a host-fed feed (`docs/surfaces.md:245-252`).

## The deviation
The reference treats "workspace phase" (connecting → loaded-empty → populated → failed) as something to render, with dedicated surfaces and shell-level state attributes; the build collapses everything into static honest copy. Most of the reference family is, however, a **deliberate absence**, not a gap:

- **Ruled absent (ADR-0018 exception list, item 12 / U-A):** no connection-lifecycle model at all — no transport state phases, no reconnect banner, no roster failure states, no privacy/account gates. That covers the loading-surface-as-connecting-splash, the coordinator-connection host, the host-reachable sidebar gating, the transcript retry surface (also independently covered by the recorded retry-less policy at `shell.tsx:36-37`), and the sign-in/access gates.
- **Sign-in / access gating** is separately owned by the host; the sign-in/access gating surface is analyzed separately in this audit's auth-area deviation file (DD number pending), so it is not detailed here.
- **Possibly unruled:** a *purely local* loading affordance that does not model transport — e.g. a transient line while a newly selected session's event window hydrates, or a "loaded, zero sessions" workspace surface distinct from the pre-activation empty line. No ADR or surfaces.md entry found that rules this case in or out; U-A excludes connection-lifecycle modeling, and a transport-free hydration line arguably sits outside it, but no recorded decision says so.

## Verdict: ASK-HUMAN
The core of this deviation is ruled, not overlooked: ADR-0018's U-A exception (accepted ADR, level 2 of the authority stack) explicitly excludes transport phases, reconnect banners, roster failure states, and privacy/account gates, and the build header at `shell.tsx:36-37` records the retry-less, honest-copy approach as intentional — so the connecting splash, connection host, host-reachable gating, and transcript retry surface stay out. Sign-in/access is host-owned territory, analyzed in this audit's auth-area deviation file (DD number pending), and equally out of scope here. The one narrow case that may be unruled — a transport-free local loading line, or a distinct connected-empty workspace state — has no recorded decision either way; per the authority stack, do not add it on this deviation's word alone. If that narrow case is ever wanted, take it to the human first (ASK-HUMAN on that sub-part), since it plausibly conflicts with U-A's rationale even though it does not literally model transport state.

## Incorporation notes
- **Where it would live:** if the human rules the local case in, a status line for loading or pending work beside the existing conversation-pending copy in `src/client/shell.tsx` (main-pane branch around `:725-731`), with a new i18n key pair in the locale dictionary (`src/client/overlay.ts`); a connected-empty workspace surface would reuse or extend the existing `shell.empty` copy. No transport or account surface would be added — that layer stays host-owned.
- **Constraints:** must not model transport state or connection lifecycle (U-A boundary); must keep the honest-copy, retry-less approach (`shell.tsx:36-37`); single locale dictionary with identical en/zh key sets; no liveness guessing — a status line describes only what the feed has actually delivered.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — one status line plus i18n keys; the risk is conceptual (drift into U-A territory), not implementation.
- **Key reference anchors:** the reference tree's `frontend/src/production/ProductionRenderer.tsx:3349-3351` (the sign-in, root-loading, and root-empty-workspace booleans); `:3426` (the empty/loading/runtime state attributes on the root shell class); `:3380-3386` (the roster status line's empty / all-hidden kinds); `:3420-3422` (the transcript-load-error gate); `:3428`, `:3444`, `:3448-3449` (the window status badge, the root-shell loading surface, the coordinator-connection host, and the host-reachable prop).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/production/ProductionRenderer.tsx` (lines 3349-3361, 3380-3386, 3420-3449; verified in place)
- Build: `src/client/shell.tsx` (header comment lines 36-37; empty roster `:665-666`; no-selection/onboarding branch `:702-714`; conversation-pending `:725-731`; verified in place)
- Rulings: `docs/adr/0018-imitate-reference-in-entirety-exception-list.md` (item 12 / U-A); `docs/surfaces.md:245-252` (presence-copy-over-empty-feed idiom); cross-reference: the sign-in/access gating surface is analyzed separately in this audit's auth-area deviation file (DD number pending).
