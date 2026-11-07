# 280 — Dormant conversation pane hides load-older when ready items are empty

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3 / low
**Ship blocker:** NO

**Scope: DORMANT/UNMOUNTED retained source. This is a conditional component defect, not an ordinary live incident.**

The default composition has `mounts = []` and no live roster/mirror producer ([src/client/index.ts:214–232](../../src/client/index.ts#L214-L232)). [ADR-0024:13–18](../../docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md#L13-L18) keeps the native-dsh posture and retained, unmounted shell machinery. This ticket imposes no requirement to reactivate that surface. No supported public extension path or live extension behavior is established by this filing.

## Problem and conditional impact

If the retained conversation pane is mounted and receives a ready transcript with `items: []` and `hasMore: true`, it renders the empty notice before reaching the branch containing the existing load-older button. The pane therefore offers no way to request older history through that control until another display update supplies nonempty items.

The source contract keeps display items and continuation independent: no displayable items in the current window does not mean that older history is exhausted. The defect is the pane's branch ordering. The existing callback and scoped request path already exist; this ticket does not claim a transport failure.

This trigger is conditional. No assertion is made that the current host actually emits such an empty display page, that the retained pane is mounted in a live product flow, or that a public extension is supported.

## Source contract and exact evidence

1. **Continuation is independent of display items.** [src/client/conversation-store.ts:175–179](../../src/client/conversation-store.ts#L175-L179) defines separate `items` and `hasMore` fields and states that older history remaining is the reason to offer scoped `loadOlder()`. The historical contract in [resolved #80:48–53](../resolved/80-wrapper-conversation-surface-composer.md#L48-L53) calls `hasMore` the continuation flag; [#80:95–98](../resolved/80-wrapper-conversation-surface-composer.md#L95-L98) records the pane's load-older affordance when that flag is set. These are retained-source contracts, not a renewed live-surface commitment.
2. **Reduction can retain continuation without display items.** [src/client/conversation-store.ts:338–342](../../src/client/conversation-store.ts#L338-L342) accepts an array window and starts with no items. [The same reducer:494–514](../../src/client/conversation-store.ts#L494-L514) handles turn bookkeeping without adding display rows, skips log/derived-only events, and returns `hasMore: window.hasMore === true` independently of `items`. This is source support for the conditional state, not evidence of an actual host page.
3. **A readable reduction becomes ready even when items are empty.** [src/client/conversation-store.ts:576–586](../../src/client/conversation-store.ts#L576-L586) applies any non-null reduction as `{ kind: "ready", transcript }` without requiring nonempty items or resetting continuation.
4. **The ready empty branch hides pagination.** [src/client/conversation.tsx:399–416](../../src/client/conversation.tsx#L399-L416) selects the empty notice when `state.transcript.items.length === 0`. Only the alternative nonempty branch reaches the `state.transcript.hasMore` button. At line 412 that button already invokes `actions.onLoadOlder(sessionId)`.
5. **The existing request route is session-scoped.** [src/client/index.ts:594–612](../../src/client/index.ts#L594-L612) binds `onLoadOlder` to `requestOlder(sessionsOf(), sessionId)`. [src/client/conversation-feed.ts:359–380](../../src/client/conversation-feed.ts#L359-L380) documents continuation while `hasMore` remains true and resolves the scoped conversation face before calling `face.loadOlder()` as a method. The issue is that the empty branch exposes no button to reach this route.

## Conditional trace — source reasoning only

1. Assume a mounted retained pane receives a well-formed window whose reduction has zero display items while `hasMore` remains true. An empty array or entries consisting only of nondisplay bookkeeping are source-level cases; neither is asserted to be an actual host page.
2. The store applies the non-null reduction as ready.
3. The view selects its empty-items branch and renders the empty notice. It never reaches the sibling branch containing the load-older control.
4. The user of that hypothetical mounted pane cannot invoke its existing older-history control until a later display update makes the transcript nonempty.

This trace was not executed. Its conclusion is limited to the inspected branch and source contract.

## Validation performed and limits

Read-only source inspection independently rechecked the supplied finding 8971 and the exact anchors above on 2026-11-07. The type, reducer, ready-state application, rendering branch, action binding, and scoped helper agree on the conditional defect.

No reducer or component invocation, executable probe, runtime/API inspection, tests, typecheck, build, browser session, or live extension validation was performed. Current-host production of the trigger state and live reachability remain unverified. Severity is P3/low and this is not a ship blocker because the affected pane remains dormant under the default composition.

## Duplicate check and related history

The final pre-filing recheck covered `280-` filename prefixes in all four status directories and tracker root, plus numbered headings and root-cause searches across all four statuses and tracker-root Markdown. Searches included `hasMore`, `loadOlder`, the empty-state key, pane/transcript names, the conversation source filename, and empty/pagination terms. No existing #280 or ticket for this branch-ordering defect was found.

| Status | #280 prefix before filing | Root-cause result |
|---|---|---|
| open | Free | No duplicate found |
| deferred | Free | No duplicate found |
| resolved | Free | Historical contracts and distinct fixes only |
| cancelled | Free | No duplicate found |

Tracker-root files were included in the search and contained no duplicate or #280 allocation. Relevant historical records were checked as follows:

- [Resolved #80:48–53, 95–98](../resolved/80-wrapper-conversation-surface-composer.md#L48-L53) establishes continuation and the original affordance; it does not record this empty-items branch defect.
- [Resolved #88:92–119](../resolved/88-shell-conversation-seat-crashes-react-300-on-session-selection-entry-abdicates-whole-shell-lost-until-reload.md#L92-L119) fixes hook ownership when shell seats were called as functions. Its cause and remedy differ from suppressing pagination on ready empty items.
- [Resolved #92:86–88, 117–125](../resolved/92-composer-send-dead-service-property-read-on-scope-ctx-throws.md#L86-L88) concerns scoped service access and the older-history request route. The current issue occurs before its corrected callback can be invoked.
- [Resolved #94:19–39](../resolved/94-shell-store-mirror-reader-never-fed.md#L19-L39) concerns the historical mirror reader/producer wiring, not the transcript view's empty branch. Its old live-surface history does not override the current dormant posture.

## Minimum acceptance criteria

- [ ] Within the retained component, ready `items: []` with `hasMore: true` shows the existing load-older control alongside the empty notice; activating it invokes the existing `onLoadOlder(sessionId)` action for that pane's session.
- [ ] Ready `items: []` with `hasMore: false` keeps the empty notice without a load-older control.
- [ ] Preserve ADR-0024's native-dsh posture and the default unmounted composition. Satisfying this ticket does not reactivate, register, or feed the retired surface and does not introduce a public extension commitment.

## Comments

### 2026-11-07 — ticket-writing pass

Filed the one reserved #280 ticket after independent source confirmation and the final four-status prefix/root-cause duplicate recheck. Scope remains DORMANT/UNMOUNTED retained source. Only this new ticket was written by this pass; no implementation, executed probe, tests, build, or browser work was performed. Existing tickets and other source/test/config/documentation files were not edited or renamed. The [generated open index](../open-issue-index.md) was not written; its maintenance belongs to the runtime.

## Resolution - 2026-11-08

commit baa6977; the more button is lifted above the empty/nonempty choice so empty+hasMore shows load-older and empty+no-history does not; test/client-shell-resilience.test.ts 13/13.