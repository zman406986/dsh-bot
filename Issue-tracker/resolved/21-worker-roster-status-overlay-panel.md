# 21 — Worker roster/status overlay panel + data plumbing

**Blocked by:** 19 (activation lifecycle — the panel shows the activated dispatcher's roster), 20 (client-face scaffold).
**Status:** resolved

## Problem

The dispatcher has no status surface: the user cannot see the worker roster without asking the model. Design 16 (§4.2) specs a `shell.overlay` list entry fed by a verified-or-fallback data channel. The honest gap: the Phase-1 research verified *registration* seams, not a client↔host telemetry channel — this ticket must resolve the data path **before** building the panel.

## What to do

- [x] **Verify the data channel first.** Known-good fallback: mirror a compact roster snapshot into the plugin's existing settings namespace (`src/adapter/settings-section.ts` — `installSection`'s owner scope exposes `get`/`watch`, research Finding 1) and read it client-side via the settings-scope inject idiom (Finding 7, worked example 3: `dsh-client-ui-agent-preset`). If integration reveals a better host→client channel, use it and record the choice. **Do not build panel UI against an unverified channel.**
- [x] Host side: on activation (#19) and on every roster-affecting core transition (spawn, FSM change, settle, todo reconcile), publish a snapshot: worker id, title, status (core FSM vocabulary `pending`/`running`/`completed`/`error`), todo link. Keep it a projection — no new source of truth (PRD persistence rule: no second store).
- [x] Client side: replace #20's hello-world with `RosterPanel` registered into `shell.overlay` (`id: "multitask-dispatcher-roster"`, low `order`, click-through default). Render title, empty state, stale/unavailable state, and status labels using copy from design §6 via the `multitask-dispatcher` locale namespace.
- [x] Panel degrades honestly: snapshot stale or channel missing → "Worker status is unavailable right now." (design §6) — never a spinner that hangs.
- [x] Pure-logic tests under `node --test`: snapshot projection from core state (FakeDshHost), stale detection, label mapping. Component rendering: build success + typecheck only (S8, no DOM harness).
- [x] If the client face proves blocked at integration, ship the documented host-only fallback instead (status stays conversational: wake turns + `check_workers`) and record the deferral here — do not force the overlay. *(Not triggered — the client face shipped.)*

## Constraints

- Offline tests only (S8): FakeDshHost / fake seams; no network, no LLM, no running dsh.
- The panel is presentation only — it never spawns/steers/stops anything; all authority stays with the bound parent agent via the core (design §3.4).
- Clean-room: all panel copy new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- No notifications/toast: the panel shows state only while open (research hard limits) — do not spec push.

## Comments

### 2026-09-17 — agent team (ticket 21 implementation)

**Landed** (commit `591f234` "Add worker roster overlay surface (ticket 21)"):

- **Data path — the design's prescribed fallback, not a deviation.** Host: `src/adapter/roster-channel.ts` mirrors the snapshot under the `roster` key of our own settings namespace via the `installSection` owner scope's `update` (settings-section now returns/exposes the scope through an optional `onScope` hook — backwards compatible, feature-flag fakes untouched). Client: `src/client/roster-store.ts` + `applyClientModule` watch the same namespace with the settings-scope inject idiom. Publishes are best-effort by contract: no scope yet → skipped (catch-up write on attach); throwing `update` → counted, never propagated. No push channel invented.
- **Snapshot contract:** `src/core/roster-snapshot.ts` (dependency-free so the client bundle inlines it): `projectRosterSnapshot`, defensive `parseRosterSnapshot` (v1 `schemaVersion` gate — mismatch/unknown status → `null` → unavailable), `isRosterSnapshotStale` (60 s window, no-heartbeat honesty).
- **Core observer (option `onRosterChanged`):** `src/core/multitask.ts` notifies after spawn, every accepted FSM transition (turn/steer/abort/settle), durability restore (restored-only), and reconcile/drain. Swallowed errors — telemetry never breaks core flow; gated in `src/plugin.ts` to the activated dispatcher session, immediate publish on activation, none on deactivation (staleness degrades the panel, design-16 §3.6).
- **Client face:** hello placeholder replaced by `RosterPanel` (`id: "multitask-dispatcher-roster"`, order −10, `shell.overlay`, locale `multitask-dispatcher`), view model `describeRosterPanel` (unavailable/empty/rows), zh+en clean-room copy per design §6. React component covered by build + typecheck only (S8).
- **Vocabulary note:** design §6 prose lists `pending/running/completed/error`, but the shipped core FSM vocabulary is `spawned/running/steering/completed/error/aborted`; per "reuse the core FSM vocabulary as-is" the panel renders the core's actual words verbatim (no second display vocabulary).

**Tests:** 342 → 373 passing, 0 failing (+31: `test/roster-snapshot.test.ts`, `test/client-roster-panel.test.ts`, scaffold test updated hello→roster). `npm run typecheck` clean on both configs; `npm run build:client` green (bundle gitignored as in #20). HMR reversal, dup-free re-apply, and watch-fires→rows all covered offline.

**Deferred gaps / decisions:**
1. **Live-channel verification stays open (integration).** Offline S8 proves the contract through fake seams only; whether real dsh-settings `update` shallow-merges (preserving `enabled`) vs replaces the namespace document is unverifiable without a running dsh. The channel's seam shape admits a read-modify-write swap without API change. Until verified, a settings write during an active roster could theoretically drop the `roster` key → panel degrades to "unavailable" (honest, not wrong-data).
2. **ADR-0010 not written.** Design §9.2's conditional: the data path resolved to the pre-designed, documented settings-watch fallback — nothing non-obvious to record. This comment is the decision record; ticket 16's file owns the ADR plan.
3. No heartbeat: a quiet-but-healthy roster (no transitions > 60 s) shows "unavailable" until the next publish — accepted per the no-push hard limit; revisit only if a verified push/heartbeat seam appears.

### 2026-09-18 — verifier: AC satisfied vacuously (conditional host-only fallback, not triggered)

AC satisfied vacuously per this ticket's own conditional wording: "**If** the client face proves
blocked at integration, ship the documented host-only fallback instead." The condition is
demonstrably unmet — the client face shipped, it was never blocked. Evidence (independently
re-verified): commit `591f234` landed the client face (`src/client/panel.tsx`
`createRosterPanel`/`describeRosterPanel`, `src/client/overlay.ts` `shell.overlay` registration,
`src/client/roster-store.ts`, host channel `src/adapter/roster-channel.ts`); `npm run typecheck`
and the offline suite are green at HEAD (515 pass / 0 fail, 146 suites), and `npm run
build:client` produces the bundle registering the dispatcher module. The host-only conversational
fallback was therefore never needed and no deferral needed recording.
