# 284 — DORMANT conversation reentry loses the current unsubscribe

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3 / low
**Ship blocker:** NO

## Dormant scope and evidence limits

**DORMANT / UNMOUNTED / UNFED retained internal binding helper.** This is a conditional source defect in the retained conversation binding, not an ordinary live incident or a supported public API promise. It creates no requirement to restore or reactivate the separate UI.

The [default composition:172–178](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L172-L178>) creates no shell mounts; [the retained feeds:214–227](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L214-L227>) have no live roster/mirror channel and leave `mounts` empty. The binding's only production-source call site is inside the retained [mount wiring:462–475](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L462-L475>). The [surface inventory:177–181](<C:/Users/TZ/Desktop/dsh-bot/docs/surfaces.md#L177-L181>) records the machinery as unmounted/unfed, consistent with [ADR-0024's accepted native posture:3](<C:/Users/TZ/Desktop/dsh-bot/docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md#L3>) and [retention decision:13–18](<C:/Users/TZ/Desktop/dsh-bot/docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md#L13-L18>).

**Evidence level: independently confirmed source-only reasoning.** The supplied independent confirmation 82fa was checked against the narrow ordering and ownership anchors below. The trigger assumes an internal consumer deliberately wires the retained helper and a synchronous selection-changing subscriber. No such ordinary live consumer or supported public extension path is established here. No runtime reproduction, executed probe, tests, build, or browser validation was performed.

## Problem and retained behavior

The helper applies a source's initial window before subscribing and saving its unsubscribe handle. Applying the window synchronously notifies conversation-store subscribers. If one subscriber moves selection from A to B at that point, nested follow-up attaches B and saves B's unsubscribe handle. The outer A attachment then resumes, subscribes A, and overwrites the shared handle with A's unsubscribe.

Both sources remain subscribed while selection is B. A later selection move or disposal can unsubscribe A only; B's handle has been lost. With externally owned borrowed sources, B can continue updating the conversation store after deselection or disposal.

This conflicts with the retained helper's documented [release/unsubscribe behavior:58–59,75–82](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L58-L82>) and the historical [selection-move contract in #80:87–94](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/80-wrapper-conversation-surface-composer.md#L87-L94>). Those internal behavior records do not renew a live UI or public API commitment.

## Exact source evidence

- [Borrow fallback:75–82](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L75-L82>) explicitly documents the read-only `binding(id)` path. [Its resolution:250–269](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L250-L269>) uses that fallback when no retained binding was acquired. The [structural sessions face:309–338](<C:/Users/TZ/Desktop/dsh-bot/src/client/context.ts#L309-L338>) makes `retain` optional and describes borrowed bindings as already retained elsewhere, without extending their lifetime. This allows the conditional trace to use externally owned A/B sources without assuming reference release will clean up their subscriptions.
- [Synchronous attachment:197–235](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L197-L235>) closes `sync` over its `sessionId` and source, calls `conversation.applyWindow(sessionId, snapshot)`, and invokes `sync()` at line 220 before `source.subscribe(sync)` at line 228. Only after that call returns do lines 232–235 assign the single shared `unsubscribeWindow`. No ownership/generation check intervenes after the initial sync.
- [Conversation notification:552–563](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-store.ts#L552-L563>) directly invokes a copied subscriber list before returning. [Window application:576–586](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-store.ts#L576-L586>) stores the transcript and calls that emitter. Exception isolation does not defer subscriber work or prevent selection reentry.
- [Selection notification:360–372](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L360-L372>) also invokes subscribers synchronously. [Selection:514–517](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L514-L517>) accepts a different known session and emits immediately. The binding [installs `shell.subscribe(follow)` at line 347 before its initial `follow()` at 348](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L347-L348>). The trace below nevertheless starts with a later selection move after setup has returned, so it does not rely on constructor-time notification ordering.
- [Follow:238–245](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L238-L245>) detaches and changes `current` before attaching the selected source through [lines 334–337](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L334-L337>). [Close/detach:149–175](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L149-L175>) can call only the handle currently stored in `unsubscribeWindow`. [Dispose:350–355](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L350-L355>) uses that same detach path.
- [Ready-continuation guards:297–323](<C:/Users/TZ/Desktop/dsh-bot/src/client/conversation-feed.ts#L297-L323>) check generation and selection on asynchronous settlement. They do not guard the synchronous initial-sync/subscribe/handle-assignment path above. The borrowed-source trace does not require an awaitable `ready`.

## Conditional trigger and source-derived trace

Assume a deliberate internal setup using the actual retained stores/helper, with known shell rows A and B, initially no selected session, and a sessions face whose read-only `binding(id)` returns externally owned readable sources. No `retain` or `ready` is needed. Each source has an ordinary subscription returning its own callable disposer, and remains available independently of this helper. Its readable initial window reaches `applyWindow`. No synchronous callback from `source.subscribe` is needed.

1. Finish binding setup while shell selection is empty. The helper has installed its shell-selection subscription and returned. Install a one-shot conversation-store subscriber that, on A's initial application, disarms itself before synchronously selecting known B.
2. After setup, move shell selection to A. The installed shell subscriber runs `follow(A)`, which enters `attachSource(A)` and its initial `sync()`. A has no window subscription or saved disposer yet.
3. A's `applyWindow` emits synchronously. The one-shot subscriber selects B; the shell emits synchronously and reenters `follow(B)`. Its detach cannot unsubscribe A because A has not subscribed yet.
4. Nested attachment of B applies B, subscribes B, and saves `unsubscribeB`. The disarmed subscriber does not select again. Nested calls return with `current === B`.
5. The outer A attachment resumes after its initial sync, subscribes A, and assigns `unsubscribeA` to the shared slot, overwriting `unsubscribeB`. A and B are now both subscribed, with only A's handle retained.
6. On a later selection move away from B, or on binding disposal, detach invokes `unsubscribeA` only. B's externally owned source still holds its listener. A later B publication can still call `applyWindow(B, ...)` after that move/disposal.

This is an unsubscribe-ownership defect. Each sync closure retains its correct session key; A publications still address A and B publications still address B. No cross-session misrouting or security-boundary claim is made.

## Impact and source-only validation

Under the explicit internal trigger, the helper retains unwanted source listeners and permits conversation-store updates outside the intended selection/binding lifetime. A can update after selection has already moved to B; B can continue after a subsequent move or disposal because its unsubscribe handle was overwritten. This conditional impact does not require timers, parallel execution, subscriber exceptions, or asynchronous ready settlement.

Validation consisted of reading the exact call ordering, both stores' synchronous notification paths, the borrowed-source ownership shape, teardown, default composition, and related tracker records on 2026-11-07. The call-stack trace was not executed. Current-host occurrence, any live consumer that performs the stated selection reentry, and runtime subscription counts remain unverified. The unmounted/unfed scope bounds severity to P3 / low and makes this a non-blocker.

## Duplicate check and related history

The final pre-filing check searched **open, deferred, resolved, and cancelled**, plus tracker-root Markdown, for number 284 and this root cause. Number 284 was unused in all four states and at tracker root. Searches covered the binding/source names, `attachSource`, `unsubscribeWindow`, unsubscribe, reentry/reentrancy, lost subscriptions, and current unsubscribe/subscription ownership. No same-root ticket was found.

- [#80:87–94](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/80-wrapper-conversation-surface-composer.md#L87-L94>) records apply-now/subscribe-live and unsubscribe-on-selection behavior; it does not record synchronous reentry overwriting the current disposer.
- [#92:86–88](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/92-composer-send-dead-service-property-read-on-scope-ctx-throws.md#L86-L88>) concerns the scoped `loadOlder` receiver/service-access path, a different operation and root.
- [#93:19–30](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/93-roster-channel-never-attaches-installsection-returns-void.md#L19-L30>) and [#94:19–39](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/94-shell-store-mirror-reader-never-fed.md#L19-L39>) concern the separate historical roster/mirror producer and reader wiring.
- [#280](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/280-dormant-conversation-empty-page-hides-pagination.md>), [#281](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/281-dormant-shell-clipboard-rejection-is-unhandled.md>), and [#282](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/282-dormant-shell-mirror-accepts-another-session-snapshot.md>) cover pagination rendering, clipboard rejection, and mirror identity respectively. [#283:18–24](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/283-dormant-mirror-fanout-overwrites-reentrant-clear.md#L18-L24>) is stale mirror fanout after a nested clear; it does not concern conversation-source subscription ownership.

## Minimum acceptance criteria

- [ ] After the post-setup, one-shot A-to-B reentry above returns, only B's source remains subscribed; the obsolete outer A attachment cannot replace ownership of B's unsubscribe handle.
- [ ] A subsequent detach or disposal removes all subscriptions created for A and B, so later publications from either externally owned source cannot update this conversation store through the binding.
- [ ] Preserve ordinary selection following and the existing asynchronous `ready` generation/selection guards.
- [ ] Keep the default shell unmounted and retained feeds unfed. Resolving this internal helper defect does not restore UI, register a surface/channel, or introduce a supported public API promise.

## Comments

### 2026-11-07 — ticket-writing pass

Filed one independently confirmed DORMANT source bug after narrow source-order verification and the final all-status/root-cause duplicate and number checks. Only this new ticket was written. No source, test, configuration, or documentation changes/fixes, executed probe, tests, build, or browser work were performed. Existing tickets 190–194 and other writers' tickets 280–283 were not edited; numbers 250–264 remain unused. The [generated open index](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/open-issue-index.md>) was not generated or edited; runtime owns it.

## Resolution - 2026-11-08

The generation is captured before sync; a reentrant selection drops the stale subscription and keeps the nested handle; commit `08f5bb6`; `test/client-conversation-feed.test.ts` 23/23.
