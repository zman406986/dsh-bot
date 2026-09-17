# 42 — Capsule footer provenance + tool-view link + offline composition close-out (epic 35 §4–5)

**Status:** open
**Labels:** ready-for-agent
**Epic:** 35
**Blocked by:** 38, 39, 40, 41 (all capsule sections exist; this finishes the
panel and closes the epic's offline scope).

## Context

Epic 35 §4–5: the five dispatcher tool-call views stay keyed in
`tool.call.toolview` (ticket 24) where the calls happen — the capsule at most
**links** to the latest; and the panel footer carries a profile/flag
provenance line plus a link into Settings, nothing editable inline in v1.
Honesty rules bind: every element renders from core state; an unverified
source degrades to omission with a recorded gap, never a fake.

**Tree rule:** same as ticket 38 (worktree branch until 33 merges).

## Requirements

- **Footer** — provenance line from verified sources only: flag state from the
  already-watched `multitask-dispatcher` settings namespace; profile identity
  only if ticket 36 found an honest client-visible source (else omit, gap
  recorded). Settings link only if ticket 36 verified the deep-link seam (else
  copy-only hint). Nothing editable inline.
- **Tool-view link** — ticket 24's `tool.call.toolview` registrations are
  untouched; the capsule adds at most a link affordance to the latest
  dispatcher tool view if ticket 36 verified a navigation path; otherwise no
  link (gap recorded). Never an embedded copy of a tool view inside the
  capsule.
- **Offline close-out (the epic's offline scope ends here):**
  - End-to-end fixture pass: dormant fixture → panel = activation pitch;
    activation flow (existing `test/activation-lifecycle.test.ts` truth) →
    activated composition with chip, activation row, sections, deliverables
    line, footer.
  - Locale validator green across the full enlarged dictionary (identical
    en/zh key sets).
  - No-stop guard final form: structural assertion over ALL capsule view
    models (chip, activation row, rows, deliverables, footer) — no direct
    stop/cancel/deactivate control field anywhere.
  - Update the surfaces README (ticket 32's) with the capsule: what it shows,
    its degrade states, and its honest gaps (36's degraded seams).
  - Clean-room habit: grep the changed tree for reconstruction identifiers
    (S7 discipline).
- `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client` green.

## Acceptance criteria

- [x] Footer renders flag provenance from the settings watch; profile line and
      Settings link per ticket 36's verdicts (or omitted with the gap recorded
      in the ticket comment).
- [x] Tool-view link per ticket 36's verdict (or absent, gap recorded);
      `src/client/toolviews.ts` registrations byte-unchanged.
- [x] Full-composition fixture test added (extend
      `test/client-capsule-chip.test.ts` or new
      `test/client-capsule-composition.test.ts`): dormant and activated
      end-to-end over the store + view models.
- [x] No-stop guard covers every capsule view model; surfaces README updated;
      identifier grep clean.
- [x] `npm test` 0-fail; `npm run typecheck` clean; `npm run build:client`
      green.

## Verification

Named method: `npm test` (new composition suite + full offline suite),
`npm run typecheck`, `npm run build:client`, identifier grep. The real-browser
Playwright assertion of the assembled capsule (dormant + activated) remains
ticket 33's launcher/browser pass — epic AC 1 — and is the last gate before
the epic resolves.

## Comments

### 2026-09-18 — agent (implementation, worktree `clone/always-on-dispatcher` @ `1e7c735`)

**Footer (per ticket 36's seam verdicts 4–5, `docs/research/dsh-capsule-seams.md`):**

- **Flag provenance** — a second tiny store (`CapsuleFooterStore` /
  `describeCapsuleFooter` in `capsule-store.ts`) fed by the SAME single
  `settings.watch(multitask-dispatcher, …)` payload that feeds the roster
  store (`index.ts` — one channel, two readers; never a second source). It
  reads the persisted `enabled` key (`FLAG_SETTINGS_KEY`, mirroring
  `src/plugin.ts` `Config.enabled` — the client must not import host code).
  Copy speaks of the SETTING ("Dispatcher setting: enabled/disabled … takes
  effect in new chats"), never the live session state (ADR-0005 frozen
  flag). Defensive degrade: non-object payload / unreadable key → segment
  omitted; a non-vouching write never unsets the last vouched value.
- **Profile line: omitted permanently in v1** — recorded gap: seam 5 found
  no client-visible profile identity source; `$host.home` is not a profile
  name and is not relabeled into one. Revisit only if a future dsh ready
  frame ships the profile name.
- **Settings link: copy-only hint** — recorded gap: seam 4 verdict DEGRADED
  (no open/navigation API; the onboarding `openSection` face was refused as
  a dishonest channel). The hint NAMES the path ("Settings → Multitask
  Dispatcher"); nothing navigates; not a button.
- Nothing in the footer is editable inline.

**Tool-view link: ABSENT, gap recorded.** The seam research verified no
navigation path from a root-scope overlay entry to a `tool.call.toolview`
cell (the views live in the conversation where the calls happen), so the
capsule adds no link, embeds no view, and navigates nothing.
`src/client/toolviews.ts` is byte-unchanged by `1e7c735` (`git diff
883ac0f..1e7c735 -- src/client/toolviews.ts` is empty).

**Offline close-out (the epic's offline scope ends here):**

- `test/client-capsule-composition.test.ts` (new): dormant end-to-end
  (config-only document → panel = activation pitch, start-only affordance,
  footer already provenanced); activated end-to-end (one published document
  with the mirrored snapshot → chip + activation row + three sections +
  deliverables line + footer all coherent from one store truth; delivery
  flip clears line + wake badge together; unrelated settings write
  re-provenances the footer without churning the feed); full matrix sweep
  (waiting / fresh / stale / invalid / channel-missing × collapsed /
  expanded — expansion is presentation-only; degraded kinds vouch for
  nothing).
- Locale validator green across the full enlarged dictionary (identical
  en/zh key sets — asserted both by `validateLocaleDictionary` and an exact
  sorted key-list updated in `client-face-scaffold.test.ts`).
- No-stop guard FINAL FORM: the capsule case in
  `test/restart-honesty.test.ts` now scans ALL capsule view models — chip,
  activation row, full panel rows, deliverables line, footer (both vouching
  and empty faces) — no stop/cancel/kill/deactivate control field anywhere;
  the literal "stop" may only appear as the intent payload VALUE.
- Surfaces README (`docs/surfaces.md`) gained a "The capsule" section:
  what it shows, its four states, and the honest gaps (Settings deep-link,
  profile identity, tool-view link) as decisions, not oversights; ship
  table and dormant-boot note updated.
- Clean-room grep over the changed tree: 0 hits for the reconstruction
  identifiers.

**Gates:** `npm test` 700/700 pass, 0 fail (185 suites); `npm run typecheck`
clean (both tsconfigs); `npm run build:client` green (`client/index.js`,
64658 bytes).

**Files:** `src/client/capsule-store.ts`, `src/client/capsule.tsx`,
`src/client/index.ts`, `src/client/overlay.ts`, `docs/surfaces.md`,
`test/client-capsule-composition.test.ts` (new),
`test/restart-honesty.test.ts`, `test/client-face-scaffold.test.ts`.

**Deferred to ticket 33 (not this ticket's scope):** the real-browser
Playwright assertion of the assembled capsule (dormant + activated) — the
epic's AC 1 and its last open gate. No deviations from the ticket; the only
interpretation note is that the footer renders in every expanded composition
(dormant included) since provenance is plugin-level, not activation-gated —
the flag segment itself degrades to omission until a document vouches.
