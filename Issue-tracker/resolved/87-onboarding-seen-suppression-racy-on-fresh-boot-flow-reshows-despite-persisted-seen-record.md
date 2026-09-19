# 87 — Onboarding seen-flag suppression is RACY on fresh boot: the persisted `onboarding.seen: true` record is written, stored, and served correctly, but a fresh page sometimes RE-SHOWS the first-run flow anyway

**Status:** resolved
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

- [x] (offline) a fake models the losing order and the fixed wiring passes; no AC requires
      a live LLM.
- [x] (live, ZERO LLM calls) on a real profile boot with `onboarding.seen: true` persisted,
      THREE consecutive fresh page loads all suppress the flow; deleting the record and
      reloading shows it again (round-trip both directions). *(Ticked 2026-09-19 — live pass 5,
      Session A: both halves ran and passed; see the closing comment. Shape note: the "delete"
      was a set to `{seen:false}` — not-seen under the fail-open parse, the same observable as a
      removed record; the literal `onboarding: null` clear was also exercised the same session.)*

## Notes

- Found by live pass 4 during the 68 AC 5 walk; no product files changed during the pass.
- The pass README's operational notes (driver serialization) do NOT touch this: the
  re-show was observed on a clean single-driver reload before any driver restart.

## Comments

### 2026-09-19 — mechanism pinned against the installed 0.1.5-rc.1 client; FIXED offline (commit `5da8a54`); live AC pending

**Mechanism (cited, candidate (a) confirmed; (b)/(c) ruled out).** The shared describe
mirror (`dsh-client-ui-settings/lib/client.js`, `SettingsDescribeMirror`) starts `idle`
with `view: undefined`; on a fresh page our bind is what starts the read
(`SettingsScopeBinder.bind` → `ctx.effect(() => this.mirror.ensure(), …)`), and the bound
scope's controller derives `loading` / `value: undefined` until the RPC lands
(`SettingsScopeController.derive`: `mirrored.view === void 0` → no update). The pre-fix
glue fed that pre-arrival snapshot to the onboarding store as a plain `undefined`
document (`index.ts` `readSnapshot` → `applyDocument(snapshot.value)`), so the pane's
render decision took the fail-open default and rendered THE FLOW during the whole
describe window — a capture (or a human) looking inside it sees the flow re-show on a
reload whose record stands; the watch DOES re-deliver on arrival (pass 2's roster
delivery re-verified in the mirror/derive path), so the pane self-heals — which is why
two later loads suppressed. Candidate (b) (client normalization drops extra-schema keys)
is refuted by the same read: `decode()` returns `view.value` verbatim when schema
validation passes — and loads 2–3 suppressed, so it passed. Candidate (c) (document
shape) refuted identically.

**Fix shape (reactive + buffered; commit `5da8a54`).**
- `src/client/onboarding.ts` — the box gains `buffering`; a new `applySnapshot(status,
  document)` feeds ONE scope snapshot: `loading` / value-less `ready` (the shipped
  pre-acceptance state) sets buffering and touches nothing; a delivered document feeds
  the seen input AND clears buffering (the arrival itself re-evaluates the decision —
  the "nobody re-evaluates" clause is pinned by a subscribe-ordering test); `unavailable`
  is a SETTLED unreadable read: explicit fail-open reset, no buffering. The view model
  gains a `pending` kind, rendered by the pane (`onboarding-pane.tsx`) as the SAME calm
  no-selection copy (`data-onboarding="pending"` — the live probe handle), never the
  flow, never a fake suppression.
- `src/client/index.ts` — `readSnapshot` routes status+value through `applySnapshot`.
- Fail-open preserved: no channel ever bound → buffering never set → the flow shows
  (the existing scope-less degrade test passes unchanged); a document landing WITHOUT a
  seen record shows the flow after the settle; mirror-suppression still beats an
  in-flight read (durable proof needs no document).

**RED→GREEN.** RED: reverting only the composition's two `applySnapshot` call sites to
the pre-fix `applyDocument` feed fails the end-to-end wiring test ("TICKET 87 wiring: a
loading bind buffers the pane…") for the live defect's exact cause — a `loading` bind
renders beats mid-read. The rendered repro (`client-shell-seat-composition.test.ts`,
react-dom+jsdom, ticket 88's harness) pins `pending` at boot-in-flight and `settled`
after the arrival, never through beats. The INVERSE HAZARD (transient stale seen=true)
is pinned: a later document without the record re-opens the flow.

**Gates:** `npm test` **1068 pass / 0 fail / 261 suites** (was 1058/259); `npm run
typecheck` clean (both configs); `npm run build:client` OK (161,221 bytes).

**Residual uncertainty (for the live lane).** (1) The describe window is bridged by
buffering, but a describe that NEVER settles (scope stuck `loading` — the mirror has no
error signal on its scope face) keeps the pane pending indefinitely; on localhost this
requires a permanently broken host connection (the sessions feed dies with it), and a
reconnect retriggers the mirror read via the owning plugin's invalidations. Recorded,
not timed-out — no invented probe-retry channel. (2) The pre-bind flash (shell renders
before the `settingsScope` service resolves) is narrower than the covered window and not
observable offline; if the live pass still catches a beats flash at capture time, that
ordering is the suspect. (3) The live AC above (three clean reloads + delete-round-trip)
is the gate that stays open.

### 2026-09-19 — live pass 5, Session A: live AC TICKED — three clean reloads + delete round-trip both ran and passed

Evidence root: `C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\evidence\A\`; shots under
`C:\Users\TZhen\Desktop\dsh-live-pass5-2026-09-19\shots\`. Real host boot
(`@deepseek-ai/dsh@0.1.5-rc.1`, throwaway `multitask` profile, port 8877), Playwright headless
chromium, **zero LLM turns**, clean teardown (`teardown-port-and-pids.txt`: no LISTENING line,
all five pids gone; stock `web` profile byte-identical — `web-profile-before.md5` /
`web-profile-after.md5`).

- **Three consecutive fresh loads — all suppressed.** `A4-01c-probe.json.out.json`,
  `A4-02c-probe.json.out.json`, `A4-03c-probe.json.out.json` each read
  `onboardingAttr:"settled"`, `beatAttrs:[]`, `hasStep1:false`, `hasSelectCopy:true`,
  `saveFailed:0` — the pass-4 racy re-show did NOT reproduce. The status tallies bracketing the
  A4 phase both read `log: []` (`status-after-A4-delete.json`, `status-final.json`).
- **Delete round-trip — the show direction ran.** Replaying the exact host RPC with `onboarding`
  set to `{seen:false}` (`A4-delete-set-false.json.in` / `.out.json`: HTTP 200, revision 4) and
  reloading (`A4-10-reload-after-delete.json.in`) re-showed the flow:
  `A4-11-probe-after-delete.json.out.json` → `data-onboarding="beats"`, `beatAttrs:["intro"]`,
  `hasStep1:true`, primary `下一步`; shot `shots/A4-01-reshow-after-delete.png`. The record was
  then restored to `{seen:true}` (`A4-14-restore-seen.json.out.json`, HTTP 200, revision 5;
  `settings-after-A4.yaml` carries the restored record at teardown).
- **Honest shape note on "delete":** the run used a set to `{seen:false}` — a shape the fail-open
  parse rejects as not-seen, i.e. the same observable as a removed record. The literal clear
  (`onboarding: null` via `settings/update`, revision 2, `A3-clear-seen.json.out.json`) was also
  exercised earlier the same session and likewise re-showed the flow
  (`A3-03-probe-beat1.json.out.json`).
- The fix comment's residual-uncertainty notes stand as recorded and were not contradicted: no
  beats flash was captured at any of the three reloads, and no stuck-`loading` pending state was
  observed.

The live AC box is ticked above; nothing else on this ticket was open.
