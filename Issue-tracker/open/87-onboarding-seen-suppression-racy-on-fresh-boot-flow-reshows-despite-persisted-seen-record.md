# 87 — Onboarding seen-flag suppression is RACY on fresh boot: the persisted `onboarding.seen: true` record is written, stored, and served correctly, but a fresh page sometimes RE-SHOWS the first-run flow anyway

**Status:** open
**Labels:** needs-triage
**Blocked by:** none
**Related:** 68 (the onboarding flow whose AC 5 this blocks), 46 (the `settingsScope` watch the read rides), 85 (the pass-4 boot this was found on)

## Symptom (live, cited)

Live pass 4, 2026-09-19 (`C:\Users\TZhen\Desktop\dsh-live-pass4-2026-09-19\`, outside the
repo), throwaway `multitask` profile, host 0.1.5-rc.1, HEAD `8d0d572`:

1. First boot of the fresh profile: flow shows (correct — nothing persisted yet). Walked
   Next×4 → 开始使用 → settled no-selection copy, NO save-failed line. The write landed:
   `~/.dsh/settings.yaml` gains `multitask-dispatcher.onboarding.seen: true`
   (`host-settings-after.yaml`) and `/api/settings/describe` serves
   `value = {onboarding:{seen:true}, enabled, accessRequestTimeoutMs}`
   (`rpc-settings-describe-ours.json`).
2. **Reload #1: the flow RE-SHOWED at 第 1 步，共 5 步** (`onboarding-reshowed-after-reload.json`)
   — the suppression read failed on a fresh page despite the well-formed persisted record.
3. Two later fresh loads (new driver page, post-restart): flow SUPPRESSED (correct).

Net: intermittent — same persisted state, different outcomes across boots. Because the
failure is a SHOW (fail-open direction), nothing strands; but "seen" cannot be trusted, and
68 AC 5's "gone afterward; seen flag survives a reload" clause is red.

## What is already ruled out (live evidence)

- The WRITE path: silent success (no `markSaveFailed` — the honest save-failed line never
  showed), and the record persists to disk and round-trips through describe.
- Host-side pruning of the SERVED document: describe returns the raw document including
  `onboarding` — not a schema-dict filter at the serve boundary (the client-side
  `settingsScope` snapshot normalization is NOT yet ruled out — see Requirements).
- Pass-2 evidence that the SAME watch delivers extra-schema keys live (the roster mirror
  `roster.*` keys drove the footer flag in pass 2), which argues against simple
  dict-filtering and toward a timing/race or scope-binding-order cause.

## Requirements (fix direction; final call belongs to the implementer)

1. Reproduce offline BEFORE coding: the fakes must model the losing order (pane render
   decision taken before the settings snapshot delivery, or a snapshot that never
   re-delivers) so the fix is provable without a live host — the 44/45/84/85 lesson again.
2. Candidate mechanisms to check against the installed 0.1.5-rc.1 client, cited:
   (a) `scope.getSnapshot()` at bind time returns `loading` (value `undefined`) and the
   subscribe never fires because the host accepted the section before the bind (the
   `index.ts` read-once guard assumes a `ready` snapshot carries the value — verify what a
   `loading`→`ready` transition emits); (b) the client snapshot normalization drops
   extra-schema keys (would contradict pass 2's roster delivery — re-verify that
   observation); (c) `onboardingSeenFromDocument` reading a document shape the scope
   delivers differently from describe's.
3. Whatever the mechanism, the suppression decision must be stable across reloads with a
   persisted well-formed record; fail-open stays the rule for corrupt/absent records only.

## Acceptance criteria

- [ ] (offline) a fake models the losing order and the fixed wiring passes; no AC requires
      a live LLM.
- [ ] (live, ZERO LLM calls) on a real profile boot with `onboarding.seen: true` persisted,
      THREE consecutive fresh page loads all suppress the flow; deleting the record and
      reloading shows it again (round-trip both directions).

## Notes

- Found by live pass 4 during the 68 AC 5 walk; no product files changed during the pass.
- The pass README's operational notes (driver serialization) do NOT touch this: the
  re-show was observed on a clean single-driver reload before any driver restart.
