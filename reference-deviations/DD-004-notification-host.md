# DD-004 — In-window notification tray vs none
- **Area:** UI shell / window chrome (A1)
- **Type:** missing-feature (designed absence)
- **Date:** 2026-09-23

## What the reference does

The reference tree's `frontend/src/recovered/features/window-chrome/notification-host.tsx` implements a coordinator-driven, in-window error-tray stack mounted in the root shell:

- **Tray model** — the notification-tray type (one error kind only): an id, a title, optional detail/request-id/error-kind fields, up to 3 projected actions, and an occurrence count rendered as a multiplied-count label. Projection helpers (the tray-projection helper, lines 74–86) defensively whitelist fields; actions are an open-URL kind (http/https URLs only, lines 54–72) or a dashboard-action kind (invoked via the account bridge).
- **Lifecycle** — a lifecycle factory (lines 109–183): an initial tray fetch, a tray-channel subscription reduced by an event reducer (push upserts by id, dismiss removes by id, clear empties the stack), queued events during an in-flight fetch (generation counter prevents stale publishes), and a transport-reconnect hook that re-fetches on connect.
- **Account gating** — an account-changed handler (lines 161–170) clears the stack and disables events unless the new status is logged-in; the host wires this to the cursor-account bridge's status-change callback (line 253).
- **Stack UI** — the notification-stack component (lines 197–214): a `role="region"` aria-labelled container of `role="alert"` trays, a clear-all button when more than one tray, per-tray copy-request-id button (clipboard, with copied-state feedback) and per-tray dismiss. A special case rewrites one overload-error detail copy behind an experiment flag (line 205).

This is the **in-window tray UI** only; the reference's OS-level push stack is a separate deviation (DD-209) and is not covered here.

## What the current build does

Absent. A case-insensitive grep for `notification|toast` across `src/client` returns only two code comments, no surface:

- `src/client/shell-feed.ts:110` — the word "notification" appears in a doc comment about feed rows, not a UI surface.
- `src/client/shell-store.ts:414` — the build's own record of the absence: "the codebase has no modal/toast seam and the shell adds none." That absence matters there: the delete affordance's armed-window confirmation pattern (ticket 101) was designed *because* no tray or modal extension point exists.

Attention instead routes through surfaces the user pulls from, per `docs/surfaces.md` §"No push notifications" (lines 20–28): the Workers panel's **Needs you** section (`roster-store.ts` `rosterSectionFor`) and the dispatcher's conversational narration.

## The deviation

The reference gives transient coordinator errors a persistent, dismissible, actionable in-window surface (error trays with request-id copy, occurrence counts, state that survives reconnects, account-scoped gating). The current build has no equivalent: errors surface only where the user is already looking (roster markers, in-chat narration), and there is deliberately no extension point a tray could plug into. `docs/surfaces.md` records the rule ("no notification or toast seam"; the user must pull information, nothing is pushed), and ADR-0020 (draft) disposition row for the reference's area 8 reads "Notifications: no toasts; roster markers + per-surface notices only — conforms on absence; markers re-hosted" (ticket 79). The build conforms to that recorded absence rather than deviating from it.

## Verdict: DO-NOT-INCORPORATE

The absence is designed and recorded, not an oversight: `docs/surfaces.md` states that no notification extension point exists, and ADR-0020 (draft, fourth level of the authority stack, above process docs) explicitly disposes the reference's area-8 notification surface as "conforms on absence." The reference host is also tightly coupled to surfaces dsh does not have — a coordinator tray RPC contract for fetch/dismiss/clear and a cursor-account dashboard-action bridge — so porting it would drag in foreign architecture, contrary to the PRD's dispatcher model. One precision note: the recorded rulings name "toasts" and a general notification rule; whether a persistent, non-toast, per-surface error notice (e.g. request-id copy inside a panel the user already opened) is a permitted "per-surface notice" under ADR-0020 is not explicitly ruled. If that narrow case is ever wanted, it needs a fresh ruling rather than this deviation being treated as a gap.

## Incorporation notes
- **Where it would live:** Only under a new ruling: a per-surface notice region (e.g. inside the Workers panel or a shell status strip) in `src/client/`, fed by a dsh-side error store — not a global root-shell overlay. dsh has no coordinator RPC shaped like a tray fetch; the feed would come from dispatcher/worker error paths.
- **Constraints:** Attention must be pulled by the user, per `docs/surfaces.md` (no proactive interruption); no account/coordinator gating — dsh's equivalent for that gate is session/dispatcher state; copy must be new (ADR-0018 B9); the overload-error experiment copy is reference-specific and must not be carried over.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S to keep absent (zero work; the shell-store comment shows designs already adapt to the absence of any notification extension point). A future per-surface error notice would be M (new error store + notice region + tests) and carry medium risk of drifting into the excluded global-tray shape without a ruling.
- **Key reference anchors:**
  - `notification-host.tsx` lines 92–105 — the event reducer (push/dismiss/clear cases).
  - Lines 109–183 — lifecycle: initial tray fetch, queued events during fetch, transport-reconnect refresh, account-changed gating.
  - Lines 74–86 — tray projection: field whitelist, ≤3 actions, occurrence count (>1 only).
  - Lines 197–214 — stack UI: `role="alert"` trays, clear-all, multiplied-count label, copy request-id, per-tray dismiss.
  - Lines 241–256 — host wiring: tray fetch / tray-channel subscription / transport subscription / account-status hook.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/window-chrome/notification-host.tsx`
- Build: `src/client/shell-feed.ts` (line 110, comment-only mention); `src/client/shell-store.ts` (line 414, "no modal/toast seam" — that absence is why ticket 101's armed-window pattern exists); grep of `src/client` for `notification|toast` returns no surface
- Intent docs: `docs/surfaces.md` §"No push notifications" (lines 20–28); `docs/adr/0020-wrapper-shell-vehicle-own-frame-over-shipped-runtime-draft-nonhuman-approved.md` line 62 (area-8 disposition: "no toasts; roster markers + per-surface notices only — conforms on absence")
