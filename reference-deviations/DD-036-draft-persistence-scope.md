# DD-036 — Persisted per-agent composer drafts vs ephemeral component state
- **Area:** composer drafts (A9)
- **Type:** deliberate-divergence (recorded gap)
- **Date:** 2026-09-23

## What the reference does
The reference client treats composer drafts as first-class persisted state. A dedicated store module (declared as client-persisted and account-sensitive, and carrying a schema version) keeps one record per agent, each holding the current draft, a draft identity, and a recovery draft. The store talks to a persistence adapter through account-scoped calls (read/write/clear) under a namespaced key, and a restore entry point taking an account slot loads state from disk on startup — the read is tagged with a generation counter so a late result from an earlier account switch is ignored, and a corrupt payload or schema-version mismatch clears the slot rather than crashing. Scope-switch and reset operations drop the in-memory records, after which the store loads state again for the newly selected account. Net effect: drafts survive restarts and account switches, and each agent's unsent text is preserved when the user navigates away and back.

## What the current build does
The build keeps the draft as ephemeral component state: `src/client/conversation.tsx:186` holds the composer text in `useState("")` inside the `Composer` component, which is remounted per session via `key={sessionId}` (conversation.tsx:446-451). Switching sessions therefore discards whatever was typed. The module comment above the pane factory (conversation.tsx:376-381) records this as intentional: the composer is keyed by session so a switch starts a fresh, empty draft, explicitly citing ADR-0018 U-B (no draft persistence). There is no client persistence layer anywhere under `src/client` — no browser-storage or bridge-backed store for drafts (or anything else of this kind) exists to hook into.

## The deviation
Same feature, opposite lifecycle. The reference makes per-agent drafts durable, per-account, restart-surviving state with a recovery channel; the build makes them volatile, per-session component state that dies on remount. The build's behavior is not an oversight — it is the recorded U-B exclusion from ADR-0018, noted in the module comment — but the divergence in user-visible behavior is real: the reference preserves unsent text across session switches and restarts, the build loses it.

## Verdict: DO-NOT-INCORPORATE
ADR-0018 (the human-ruled top-level ADR) excludes per-agent draft persistence under U-B, and the build's module comment cites that ruling, so the gap is deliberate and recorded — the ruling order settles it rather than reopening it. Incorporating the reference behavior would require two things this repo does not have: a human decision to reverse U-B, and a client persistence layer that does not exist today (no storage layer under `src/client` at all), so the storage question — host slice vs in-memory session persistence — is an architecture decision that must come before any implementation. Until both are ruled on, the ephemeral behavior stands as the recorded divergence.

## Incorporation notes
- **Where it would live:** a drafts store module under `src/client/` beside `conversation.tsx` (a map of records keyed by agent/session, restored on mount), plus a new persistence layer — either a host-side slice exposed through the existing client bridge or an explicitly bounded in-memory session store — decided via an ADR before any code.
- **Constraints:** re-opening ADR-0018 U-B requires a human ruling (levels 1–2 of the repo's ruling order); persistence, if added, must respect account sensitivity (which accounts exist in dsh and how slots map is unresolved — not yet filed as a numbered deviation); drafts keyed per agent must survive the composer's `key={sessionId}` remount, i.e., state must move out of the component entirely; schema-version and corrupt-payload handling should mirror the reference's clear-on-mismatch approach without copying its code.
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** M — the store logic is modest, but the missing persistence layer makes this architecture-first work (ADR + layer + wiring), with the main risk being a storage decision taken without a ruling on U-B.
- **Key reference anchors:**
  - `frontend/src/recovered/features/conversation/workspace/draft-state.ts` — store declaration (name, schema version, client-persisted scope, account-sensitive flag), persistence adapter interface (read/write/clear per account slot), per-agent record shape (current draft, draft identity, recovery draft), store interface with restore-by-account-slot and reset entries, namespaced account-scoped key builder.
- Evidence below.

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/features/conversation/workspace/draft-state.ts` (store constant ~lines 9-14; persistence and record interfaces ~lines 26-48; account-slot key builder ~lines 61-64)
- Build: `src/client/conversation.tsx` (draft state at line 186; `key={sessionId}` remount at lines 446-451; U-B module comment at lines 376-381); intent doc `docs/adr/0018*` (U-B per-agent-drafts exclusion), `docs/adr/README.md`
