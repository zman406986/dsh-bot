# 283 — DORMANT mirror fanout overwrites a reentrant clear

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3 / low
**Ship blocker:** NO

## Dormant scope and evidence limits

**DORMANT: retained source, unmounted shell, unfed mirror hub.** This is a conditional ordering defect in retained machinery, not an ordinary live incident. The [feed header:16–18](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L16-L18>) documents that its live channel was removed. The [default composition:214–232](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L214-L232>) retains the hub without a live channel and initializes `mounts` to an empty array. [ADR-0024:13–18](<C:/Users/TZ/Desktop/dsh-bot/docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md#L13-L18>) withdraws the separate UI and keeps shell machinery unmounted. No live producer is identified or claimed.

**Evidence level: independently confirmed source-only reasoning.** The supplied independent confirmation was checked against the narrow source anchors below. No runtime reproduction or runtime verification is claimed; no tests, builds, or browser actions were run for this filing. The trigger requires an explicit extension subscriber that synchronously reenters the retained hub. Filing or accepting this ticket does not authorize UI reactivation or restoration of a channel.

## Contract

The [hub contract:65–81](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L65-L81>) describes one accepted channel value fanned out to attached stores, immediate replay to a later attachment, and a per-store detach disposer. The [cache and replay:87–109](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L87-L109>) represent last-known mirror truth. A newer accepted clear for session `s` must therefore leave attached stores and later replay consistent: an older suspended fanout must not overwrite that clear in a remaining store while the cache has already advanced.

## Source evidence

- [Extraction:52–62](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L52-L62>) accepts an object, extracts `roster.s` as session `s`, and forwards its raw value. Both `{ 'roster.s': {} }` and `{ 'roster.s': null }` are accepted documents for this path.
- [Cache then fanout:112–120](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L112-L120>) assigns `lastMirrors = mirrors` before iterating a copied store list and the invocation's local `mirrors`. There is no generation check, publication queue, or reentry guard. A nested publish can replace the cache and finish while the outer invocation retains its older local entries and resumes fanout.
- [Mirror classification:497–509](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L497-L509>) maps `null` to `cleared` and a non-null invalid snapshot to `unavailable`. The [parser:230–242](<C:/Users/TZ/Desktop/dsh-bot/src/core/roster-snapshot.ts#L230-L242>) rejects `{}` because its schema version and required fields are absent.
- [Synchronous notification:360–372](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L360-L372>) updates the store and directly calls subscribers before returning. [Public subscribe:396–398](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L396-L398>) permits an extension listener to initiate the nested call. Exception isolation does not serialize or defer listener work.
- [Mirror write and emit:527–548](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L527-L548>) record and emit every mirror application, including when no session row exists; there is no mirror equality deduplication that suppresses the stated notification.

## Conditional trigger and source-derived trace

Assume an extension deliberately connects the retained feed and installs the listener below. Ordinary current composition does not establish this setup.

1. Create a feed and stores A and B. Attach A, then B, so the outer store iteration visits A first. No preexisting session rows or valid snapshot fixtures are required.
2. Subscribe to A with a one-shot listener: when A's mirror for `s` first becomes `unavailable`, disarm the listener before synchronously calling `feed.applyChannelValue({ 'roster.s': null })`. Disarming before the nested call prevents further recursion.
3. Make the outer call `feed.applyChannelValue({ 'roster.s': {} })`. It caches the outer entry, applies it to A, and synchronously notifies A's listener.
4. The listener's inner call accepts the newer clear, replaces the replay cache with `null` for `s`, and clears A and B. The inner call returns.
5. The outer invocation resumes with its older local `mirrors` array and writes `{}` to B. B becomes `unavailable` again; A and the replay cache remain cleared.
6. Attach a new store C after the outer call returns. Replay reads the inner call's newer cache, so C receives `cleared`.

| Location after both calls return | Source-derived state for session `s` |
|---|---|
| A | `cleared` |
| B | `unavailable` from the stale outer fanout |
| Replay cache | Newer `null` clear |
| Late attachment C | `cleared` from that cache |

Both calls use the same key `roster.s` and the same session `s`. This is a same-session consistency defect; no cross-session security claim is made.

## Impact and source-only reasoning

The retained feed can leave one attached store disagreeing with another attached store and with its own last-truth replay after accepting the newer clear. The final disagreement persists after both synchronous calls return, until another applicable update occurs. If session rows were supplied in that explicit extension setup, the [mirror flag rule:386–389](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L386-L389>) would also make B's `unavailable` mirror imply dispatcher presence while A's clear implies absence. That is a conditional consequence of the retained store rule, not an observed live UI symptom.

The cause is the outer invocation continuing stale fanout after nested publication has advanced accepted truth. It does not depend on timers, concurrent threads, a valid roster snapshot, a second session, or a failing subscriber. The current unmounted, unfed posture bounds its severity to P3 / low and makes it a non-blocker.

## Deduplication

Immediately before creation on 2026-11-07, explicitly searched **open, deferred, resolved, and cancelled** for number 283 and the root terms `shell-mirror-feed`, `createShellMirrorFeed`, `sessionMirrorsFromChannelValue`, reentry/reentrancy, fanout/fan-out, newer clear, outer publish, and stale fanout. Number 283 was unused in all four statuses, and no same-root duplicate was found.

[94:44–58](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/94-shell-store-mirror-reader-never-fed.md#L44-L58>) introduced fanout/replay wiring; its [honest-state criteria:79–90](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/94-shell-store-mirror-reader-never-fed.md#L79-L90>) cover sequential clear/corrupt/replay/detach behavior, not a newer reentrant clear being overwritten by an older fanout. [104's retirement record:83–103](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/104-stale-dispatcher-mirror-after-restart.md#L83-L103>) closes the historical restart symptom because its live mechanism was removed. [114's native-posture record:45–57](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md#L45-L57>) and ADR-0024 constrain UI posture; they do not describe this ordering root. [172:200](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/172-test-suite-prune.md#L200>) also records that this channel has no publisher. Other search hits concern historical panel/audit records, peer fanout directories, or dispatcher user-message callbacks. None records this same-session nested clear/cache/store divergence. Retirement remains a constraint, not a duplicate or permission to reactivate the UI.

## Minimum acceptance

- [ ] In the explicit A-then-B, one-shot reentry scenario above, once the newer clear is accepted and both calls return, A, B, the replay cache, and a late attachment C consistently retain the clear for `s`.
- [ ] No remaining stale outer fanout overwrites the accepted newer clear in an attached store.
- [ ] Preserve ordinary sequential publication, last-truth replay for later attachments, raw-value classification, and per-store detach behavior.
- [ ] Keep the shell unmounted and the mirror feed unfed in the default composition. Do not reactivate UI, restore the retired settings channel, or add a live producer to resolve this retained-source defect.

## Comments

- 2026-11-07 — Filed as one independently confirmed DORMANT source bug after narrow anchor verification and a final explicit duplicate/number check across all four statuses. Confirmation is source-only; no runtime result is asserted. This filing changes only this ticket; no source, test, configuration, documentation, or generated index work is part of it.

## Resolution - 2026-11-08

A publication counter stops a superseded outer fanout from overwriting a newer clear; commit `1b208fa`; `test/client-shell-mirror-feed.test.ts` 2/2.
