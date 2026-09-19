# 86 — Fake-vs-host client contract gaps (the 44/45/84/85 class): a hygiene pass aligning offline fakes with VERIFIED host contracts

**Status:** open
**Labels:** needs-triage
**Blocked by:** none
**Related:** 44, 45, 84, 85 (the four known instances), 33 (live close-out lane), 78 (the cutover that surfaced 85)

## Problem

Four tickets in a row share one root pattern: an offline fake modeled a host
seam GENTLER than the real host, so the 1,000+-test offline gate passed while
the live host aborted a user-visible flow. The offline gate cannot catch
fake-vs-host divergence — today the only detector is a live pass, and each
divergence so far was a boot- or activation-level failure.

## The four known instances

1. **44 (host half, commands):** the fake accepted a `ctx.effect`-registration
   shape the live host never registered — activated dispatcher commands were
   silently absent live. Fixed in-ticket; the fake was taught cordis's
   effect/unload semantics afterwards.
2. **45 (host half, tools):** fake-accepted tool schemas were rejected by the
   real provider — every activated turn failed live.
3. **84 (client half, service reads):** fakes let the composition read
   undeclared service faces bare; the live context proxy throws
   `cannot get property "X" without inject` wherever the read happens — the
   launcher click died live (pass 2). Fakes were taught the guard
   (commit `154e7c7`).
4. **85 (client half, slot registration):** the slots fakes accepted a
   no-priority `root` registration; the shipped single-slot register defaults
   an absent priority to 0 — the shipped AppFrame's own effective value — and
   THROWS on the collision, so the WHOLE loader entry aborted and the client
   showed the fail-loud screen (live pass 3, 2026-09-19). Fakes were taught
   the SlotCore collision rule (cell model: `?? 0` default, same-priority
   throw, ascending "lowest renders" election, per-entry dispose) in the 85
   fix.

## Pass-3 hazard note

Live pass 3 also demonstrated the failure AMPLIFIER: a client-side
registration throw does not degrade one widget — it aborts the entire loader
entry, the failsafe never engages (the entry dies pre-election), and the user
gets the host's "Failed to load plugins" screen instead of the stock app.
Fake-vs-host divergence in registration-adjacent code is therefore a
whole-surface hazard, not a cosmetic one.

## Proposal (the hygiene pass this ticket asks for — NOT executed yet)

A scoped pass that inventories the remaining offline fakes against VERIFIED
host contracts and aligns them, so the next contract divergence fails
offline:

- Enumerate every fake seam in `test/` (client slots/locale/guard, host
  commands/tools/settings/storage) and its verified host source (installed
  tree under `C:\Users\TZhen\.dsh\profiles\node_modules\@deepseek-ai\`, read
  only), noting which fakes still model a shape nobody has verified.
- Align the highest-risk ones first: seams where a host throw/abort kills a
  whole entry or activation (the 84/85 amplifier class) over seams whose
  divergence degrades one widget.
- Prefer teaching the existing fakes the host rule (as 84/85 did) over
  building a shared fake framework — keep per-file fakes, one divergence fix
  per seam.
- Record each alignment with the host citation (file + line) in the fake's
  header comment, so the next divergence is a diff against a cited contract.

## Acceptance criteria

- [ ] (offline) an inventory comment/table exists (in this ticket or its
      answer) listing every fake seam → host citation → aligned/not;
- [ ] (offline) each HIGH-risk divergence found by the inventory is either
      aligned in the same pass or spun into its own ready-for-agent ticket;
- [ ] `npm test`, `npm run typecheck`, `npm run build:client` green after the
      pass.

## Notes

- Filed by the ticket-85 agent (2026-09-19) as the small tracker add-on of the
  85 fix; the hygiene pass itself is deliberately NOT part of 85.
- The 85 fix already aligned the two slots fakes that drive the `root`
  contract (`test/client-shell-mount.test.ts`, `test/coexistence.test.ts`);
  the scaffold fake (`test/client-face-scaffold.test.ts`) still accepts
  no-priority single-slot registrations and is inventory item #1.

## Comments
