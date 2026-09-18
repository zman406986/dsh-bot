# 78 — Wrapper shell mounting: `main`-page registration, then the root-frame election (ADR-0020 slice 2)

**Status:** open
**Labels:** needs-triage
**Blocked by:** 77 (the shell skeleton), 80 (conversation surface must exist before the cutover — the election replaces the shipped UI)
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
