# 78 — Wrapper shell mounting: `main`-page registration, then the root-frame election (ADR-0020 slice 2)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 77 (the shell skeleton)
**Related:** ADR-0020 (staging: `main` page first, `root` election last), `dsh-capsule-seams.md` Seam 4 (`ctx.layout.selectPanel`), 45/33 (live lane)

## What to do

- [ ] Staging mount: register the shell as a `main` keyed page (key ours by default; the only
      shipped key is `conversation`) and open it via `ctx.layout.selectPanel` from a sidebar/
      header affordance. Registration contract pinned offline over fakes (inject → register,
      one entry, id stability), matching the existing overlay/toolview test style.
- [ ] Cutover slice: register the shell into the `root` single slot (dynamic entry — lower
      priority than the shipped frame; abdication falls back to the shipped app, ADR-0020's
      failsafe). Same offline pinning style for the registration contract.
- [ ] Retire the capsule overlay entry at the cutover (the chip/panel vehicle, not the assets).

## Constraints

- The root election itself (frame swap, HMR fiber behavior, fallback-on-crash) is live-only:
  pin the contract offline, then mark the visual confirmation as awaiting the live lane
  (tickets 45/33) — do NOT tick it from offline work.
- No new toolchain; unload/HMR must reverse every registration.

## Comments

### 2026-09-19 — agent (tracker hygiene: cycle decoupled)

78 and 80 declared MUTUAL blocked-by edges (78←80 "cutover", 80←78 "staging mount") — a
dependency cycle. Decoupled per the ADR-0020 staging/cutover split this ticket itself encodes:

- 80 keeps `Blocked by: 78 staging mount` (a surface needs a page to render into — the
  ordering edge is recorded once, on 80).
- This ticket's `Blocked by` drops the 80 edge (now: 77 only). The ORDERING still holds and
  is recorded here instead: the **cutover slice** (the `root` election AC + retiring the
  capsule overlay entry) executes only AFTER ticket 80's conversation surface has landed in
  the shell — the election replaces the shipped UI, so it must not flip while the main
  surface is still the honest "not wired yet" placeholder. The staging-mount AC
  (`main` page registration) is NOT gated on 80 and may proceed independently.

(Note: the hygiene instruction phrased the retained edge as "78 blocked-by 76 only"; this
ticket's actual skeleton dependency is 77, and 76 (per-dispatcher tooling, resolved) is not
a dependency of mounting — the minimal edit keeps the ticket's own declared 77 edge and
drops only the 80 clause.)
