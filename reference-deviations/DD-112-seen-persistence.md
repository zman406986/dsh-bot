# DD-112 — Onboarding "seen" persistence mechanism vs plugin-namespace record
- **Area:** onboarding (A13)
- **Type:** behavior-delta (equivalent direction, different mechanism)
- **Date:** 2026-09-23

## What the reference does

The desktop app keeps first-run state as two optional scalar fields on the
main-process settings document: a boolean onboarding-seen flag and an
account-scope companion string (the reference tree's `source/shared/node/settings/sand-settings-store.ts:25`).
The store exposes typed get/set/clear accessors for the pair
(`sand-settings-store.ts:108-110`), and re-scoping the settings to a different
account re-evaluates whether the seen flag carries over or is dropped
(an account-rescope action, `sand-settings-store.ts:134`) — the seen mark is partly
account-dimensioned. The renderer never touches the file directly: it goes
through an async bridge surface with seen get/set calls (plus a skip
event) in the desktop bridge contract
(the reference tree's `frontend/src/recovered/contracts/desktop-bridge.ts:420-424`). At
agent-creation time a separate probe re-checks suppression — seen OR an
agent already exists — under a ~10s timeout that lets the flow show when the check fails (per the
earlier survey: `model.ts`, the account-onboarded check).

## What the current build does

The build has no accounts and no second store (A5): the seen record is a
well-formed `{ seen: true }` object stored under the single key
`ONBOARDING_SETTINGS_KEY = "onboarding"` inside the plugin's own settings
namespace, delivered over the single `ctx.settingsScope` binding that also feeds
the roster watch and the settings card
(`src/client/onboarding.ts:75`, header 27-34). Suppression is a two-input
pure decision: a well-formed seen record, OR at least one non-`cleared`
dispatcher-session mirror (a `roster.<sessionId>` key standing in the
document — the key layout from tickets 76/79) as the stand-in for "owns an agent"
(`isOnboardingSuppressed`, `onboarding.ts:116-125`). Every malformed or
unreadable input falls toward SHOW: only `seen === true` suppresses by
itself (`onboarding.ts:83-88`), and a write that never lands surfaces an
honest save-failed notice instead of a fake success
(`writeOnboardingSeenRecord`, `onboarding.ts:421-434`). On top of the base
rule that unreadable state shows the flow, the store tracks a build-only `buffering`/`pending` state:
while the scope reports a read in flight (`loading`, or the shipped
controller's value-less `ready`), the pane holds the calm no-selection view
rather than briefly flashing the flow from that default, re-evaluating
reactively when the document lands or the namespace settles unreadable
(header 44-55, `applySnapshot` 287-317, view decision 380-408).

## The deviation

Same behavioral direction (once seen or already owning an agent, the
first-run flow stays suppressed; both sides show the flow when state is unreadable),
different mechanism on all three axes:

1. **Storage and channel.** Reference: a boolean (plus scope string) on a
   host settings document behind an async main-process bridge. Build: an
   object record inside the plugin's own namespace on the single shared
   settings scope — no host store, no bridge pair.
2. **Shape.** Reference stores a scalar; the build stores a record whose
   `seen` field must be exactly `true` (extra fields tolerated,
   forward-compatible) so corruption is distinguishable from absence.
3. **Secondary input.** Reference's creation-time probe ORs a live agent
   count under a 10s timeout that lets the flow show on failure; the build's second input is static
   and document-derived — any non-cleared roster mirror counts (a corrupt
   mirror whose key still proves ownership suppresses), with no timeout and
   no probe call.
4. **Timing.** The build adds a buffering/pending state the reference
   (per the earlier survey) lacks, so the default cannot flash the flow
   during a mid-read window. There is no account dimension on either side
   of the build — the reference's account-rescope carry-over/drop logic
   has no counterpart because no accounts exist (a recorded U-A gap — no privacy or account gates — not a
   silent omission).

## Verdict: ADAPT

Both sides fall back to showing the flow — the reference's probe timeout and the build's
corrupt-record rule agree that a bad read can never strand or hide
first-run — so the difference is the mechanism, not the direction: host settings store +
bridge accessors versus the plugin's own namespace record plus a
roster-mirror secondary input. ADR-0018's A5 (no second store) and the
rule of a single binding make the build's choice of storage the correct one for dsh;
importing the reference's host-store/bridge plumbing would violate it, and
the account-scope logic has no domain to act on. This is a correct
re-implementation on different storage, but ADAPT rather than
DO-NOT-INCORPORATE because two reference ideas are worth taking: the
creation-time probe as a second, independent suppression check (the build
currently decides only from the same document the pane reads), and
documenting the buffering state as the deliberate addition it is. If the
team judges the single-document decision sufficient for a dispatcher
without accounts, downgrade to DO-NOT-INCORPORATE; nothing here needs a
human ruling.

## Incorporation notes
- **Where it would live:** a creation-time suppression probe beside the
  dispatcher's session-creation path (mirroring `isOnboardingSuppressed`
  from `src/client/onboarding.ts`); the buffering state is already in the
  store and needs only documentation in the ADR-0018 area notes.
- **Constraints:** keep A5 (no second store — the probe must read the same
  namespace and binding, not open a channel); keep the show-on-bad-read rule as the
  governing direction (only a well-formed `{seen:true}` suppresses); no timeout-based
  probe unless a real read can hang (the scope delivers snapshots — a hung
  read is a runtime bug, not a probe concern); no account dimension until
  accounts exist (U-A gap — no privacy or account gates — stays recorded, not invented).
- **License note:** ADR-0018 B9 — re-derive independently; no verbatim copying from the reference tree.
- **Effort/risk:** S — a probe function reusing existing pure decision
  code; risk is low, the main care point is not introducing a second store
  or a silent-failure path.
- **Key reference anchors:** the reference tree's `source/shared/node/settings/sand-settings-store.ts:25,108-110,134`; the reference tree's `frontend/src/recovered/contracts/desktop-bridge.ts:420-424`; `model.ts` (the account-onboarded check — a 10s probe that lets the flow show on failure, per the earlier survey).

## Evidence
- Reference: `reference material-NOT LICENSE SAFE DONT COPY-grok bot/source/shared/node/settings/sand-settings-store.ts` (lines 25, 61-62, 108-110, 134 — verified); `reference material-NOT LICENSE SAFE DONT COPY-grok bot/frontend/src/recovered/contracts/desktop-bridge.ts` (lines 420-424 — verified); `model.ts` (the account-onboarded check; cited from the earlier survey, not re-opened).
- Build: `src/client/onboarding.ts` (lines 27-34, 44-55, 75, 83-88, 116-125, 287-317, 380-408, 421-434 — verified).
