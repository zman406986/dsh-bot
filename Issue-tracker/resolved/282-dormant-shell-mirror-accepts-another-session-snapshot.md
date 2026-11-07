# 282 — Dormant shell mirror accepts another session's snapshot

**Status:** resolved
**Labels:** needs-triage
**Severity:** P3 / low
**Ship blocker:** NO
**Scope:** DORMANT / UNMOUNTED retained store API; conditional extension use only.
**Related:** [79](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/79-wrapper-sidebar-dispatcher-roster-and-presence.md>), [94](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/94-shell-store-mirror-reader-never-fed.md>), [104](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/104-stale-dispatcher-mirror-after-restart.md>), [114](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md>), [ADR-0024](<C:/Users/TZ/Desktop/dsh-bot/docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md>).

## Summary and current reachability

The retained `DispatcherShellStore.applySessionMirror(sessionId, value: unknown)` API validates the key and the snapshot's shape independently, but never checks that `sessionId === snapshot.dispatcherSessionId`. A valid v5 snapshot naming B can therefore be cached under A and supply A's dispatcher flag, presence counters, waiting marker, and recent-result excerpt. This contradicts the store's own explicit session-attachment invariant, not merely an assumed producer promise.

This is a **static, conditional API defect**, not an ordinary live incident. The shell and its roster/config watch are not composed: [index.ts:39–42](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L39-L42>) and [index.ts:214–227](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L214-L227>) explicitly retain the machinery with no live channel and no default mounts. [roster-channel.ts:2–8](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/roster-channel.ts#L2-L8>) preserves key grammar only and states that the settings-document channel is gone. No production writer delivering a mismatched pair has been demonstrated. This ticket does not claim a current stock-sidebar failure, production data leak, or current end-to-end reachability; it does not authorize any UI reactivation or replacement transport.

## Source contract and exact evidence

1. **The invariant belongs to the store.** [shell-store.ts:37–48](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L37-L48>) introduces “Honest-degrade rules this store enforces so the component cannot lie” and states: “presence is attached only to the session the snapshot names (`dispatcherSessionId`)”. It also promises that mirrors received before a session row are inert until the feed supplies that row; mirrors never create rows.
2. **The public boundary accepts raw values without a type escape.** [shell-store.ts:314–320](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L314-L320>) documents raw per-session mirror values and exposes `applySessionMirror(sessionId: string, value: unknown): void`; [shell-store.ts:349](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L349>) exports `createDispatcherShellStore`. A plain object passed through this API needs no `any`, assertion, forged branded value, or private-state mutation.
3. **Shape validation is not key/value identity validation.** [shell-store.ts:497–509](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L497-L509>) rejects junk key IDs, handles null/undefined clears, calls `parseRosterSnapshot(value)`, then applies every successfully parsed snapshot to the caller's `sessionId`. There is no comparison with the parsed `dispatcherSessionId`. [roster-snapshot.ts:230–288](<C:/Users/TZ/Desktop/dsh-bot/src/core/roster-snapshot.ts#L230-L288>) validates the v5 payload and checks that its dispatcher ID is a string; it has no expected-session/key parameter and cannot establish the relation between these two inputs. The root cause is the missing relational guard at the store ingress, not a request to broaden the generic parser's contract.
4. **The wrong association becomes render-facing state.** [shell-store.ts:527–548](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L527-L548>) executes `mirrors.set(sessionId, mirror)` and updates that same row. A snapshot sets its dispatcher flag through [shell-store.ts:386–390](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L386-L390>); [shell-store.ts:330–339](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L330-L339>) derives counters and waiting from the snapshot and copies its `recentResult`. If A has no row yet, the wrong snapshot is still cached, and [shell-store.ts:410–432](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L410-L432>) consumes it when A is upserted. The fresh-view gate checks age, not identity ([shell-store.ts:216–231](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L216-L231>)).
5. **The retained feed deliberately leaves honesty validation here.** [shell-mirror-feed.ts:48–60](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L48-L60>) says values pass through RAW so the store's honesty rules live “in exactly one place”; its key extraction maps `roster.A` to A using [roster-channel.ts:24–28](<C:/Users/TZ/Desktop/dsh-bot/src/adapter/roster-channel.ts#L24-L28>). [shell-mirror-feed.ts:100–119](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-mirror-feed.ts#L100-L119>) forwards the unchanged key-derived ID and raw value during replay and later delivery. It does not guarantee that the embedded ID matches. A producer that normally emits matching pairs does not remove the store's explicit invariant or the responsibility of its raw-value API.

## Conditional trigger and source-derived result

Condition: a caller directly uses the retained factory/API, or a future separately authorized extension feeds it a parser-valid, fresh snapshot for B under key/session A. The following is an **unexecuted API-call sketch**, not a runtime reproduction, probe, or test:

```ts
const nowMs = 1_000;
const bSnapshot = {
  schemaVersion: 5,
  dispatcherSessionId: "B",
  publishedAtMs: nowMs,
  workers: [{
    kind: "worker",
    workerId: "b-result",
    title: "B result",
    status: "completed",
    todoId: "b-todo",
    startedAtMs: 900,
    toolCallCount: 1,
    delivered: false,
  }],
  recentResult: {
    workerId: "b-result",
    title: "B result",
    text: "B result excerpt",
  },
};
const store = createDispatcherShellStore();
store.upsertSessions([{ sessionId: "A", title: "A" }]);
store.applySessionMirror("A", bSnapshot);
```

The object satisfies the current parser's v5 shape without any type escape. Static tracing gives `state.mirrors.get("A")` a snapshot naming B, and A's row becomes `dispatcher: true`, `presence: { working: 0, needsYou: 1, finished: 0 }`, `waiting: { kind: "landed" }`, and B's `recentResult`. The counter and waiting derivations are explicit in [shell-store.ts:138–165](<C:/Users/TZ/Desktop/dsh-bot/src/client/shell-store.ts#L138-L165>). At view clock `nowMs` the snapshot is fresh, so staleness does not mask the identity error. A's row ID and title stay A; B's presence is misattributed, not relocated to a B row.

Calling `applySessionMirror("A", bSnapshot)` **before** A's upsert has the same delayed consequence: no row is invented immediately, but the cached B snapshot seeds A when its row arrives. The feed equivalent would be an explicitly supplied document `{ "roster.A": bSnapshot }`; no such current production document/writer is demonstrated here.

## Conditional impact and severity

If this retained API is used with a mismatched pair, A can be falsely flagged as a dispatcher and display another session's activity/result metadata as its own, violating per-session presence isolation. The latent-before-row variant survives feed ordering and must not be fixed only in the current-row update path. This is misattribution in retained client state; the evidence does not establish cross-session command execution, persistent data damage, a live incident, or a current production confidentiality breach.

**P3 / low; ship blocker: NO.** Exposure is dormant/unmounted and conditional on direct API use or a future extension. The correct ownership is a local store invariant; neither trusting a future producer nor reviving the removed channel is a substitute for enforcing it.

## Deduplication and scope boundaries

- ID 282 was free under **open, deferred, resolved, and cancelled** before filing. All four states were searched for the primary store symbols (`applySessionMirror`, `createDispatcherShellStore`, `shell-mirror-feed`), validator symbols (`parseRosterSnapshot`, `dispatcherSessionId`), and mirror/snapshot session-mismatch or identity descriptions. No existing ticket owns this missing key-to-snapshot identity check; the primary finding and supplied independent confirmation are root-cause nonduplicates.
- [94:19–39](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/94-shell-store-mirror-reader-never-fed.md#L19-L39>) concerns an unfed reader/composition, not accepting B's valid snapshot under A after a call reaches the API.
- [104:85–125](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/104-stale-dispatcher-mirror-after-restart.md#L85-L125>) concerns a stale post-restart mirror/flag and records removal of the old channel. This trigger uses a fresh, shape-valid snapshot whose identity is wrong for its key; it neither reopens the stale live scenario nor disputes the intended flag semantics.
- [114:45–60](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md#L45-L60>) and [ADR-0024:13–18](<C:/Users/TZ/Desktop/dsh-bot/docs/adr/0024-native-dsh-posture-restored-by-human-ruling.md#L13-L18>) own native posture and retained unmounted machinery, not this relational guard. [79:35–39](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/79-wrapper-sidebar-dispatcher-roster-and-presence.md#L35-L39>) supplies the existing fail-closed/unavailable policy, not a duplicate identity-mismatch repair.
- Original tickets 190–194 remain unchanged; 250–264 remain unused by this work; 280/281 belong to other writers and are not used or edited. Only this new issue is written. The generated tracker index is runtime-owned and is not regenerated or edited. No source, tests, configuration, product documentation, or other ticket is changed; no new candidates or review expansion are included.

## Minimal acceptance criteria

- [ ] For nonempty A and a parser-valid snapshot naming B (B !== A), `applySessionMirror("A", snapshotB)` never installs B's snapshot/presence under A, either in A's mirror entry or its existing row. Enforce the relation at the retained store API boundary, not only in a producer or UI.
- [ ] The same invariant holds if the mismatch arrives before A's row: it cannot be cached as an accepted B snapshot under A and later seed A on upsert; mirrors still never invent rows.
- [ ] Refusing a mismatch or degrading A to the existing unavailable state is acceptable. An unavailable A may keep the key-derived `dispatcher: true` flag, but has `presence: null`, `waiting: null`, and `recentResult: null`; B's fields must not survive as A's presence/preview. Do not redefine the existing key-based flag policy to address this bug.
- [ ] Matching-ID snapshots and null/undefined clear behavior remain unchanged. No UI remount/reactivation, transport restoration, or broader parser redesign is required by this ticket.

## Verification limits

Source-only verification: reread the exact store, feed, parser, key-grammar, and dormant-composition anchors above and compared the nearest tracker records. The request records independent source confirmation by reviewer `86db`; this filing pass separately traced the same missing relation through parse, cache, row projection, and delayed upsert. The sketch and outcomes above are source deductions, **not observed runtime output**.

No runtime/API probes, harnesses, tests, typechecks, builds, browser sessions, host starts, or production-writer experiments were executed for this ticket. No implementation or test/config/doc fixes are included. These limits are intentional for a ticket-writing-only task; no live reproduction or production exposure is claimed.

## Comments

- 2026-11-07 — Filed as one independently source-confirmed dormant API bug after narrow anchor verification and all-four-state ID/root-cause deduplication. P3 / low, not a ship blocker; retained/unmounted machinery only. Source ownership is the store's explicit session-attachment invariant, not a producer promise. No runtime probes, tests, builds, browser work, implementation, UI reactivation, or generated-index write performed.

## Resolution - 2026-11-08

A snapshot whose `dispatcherSessionId` differs from the key degrades to unavailable and creates no entry; commit `46c4ff0`; `test/client-shell-store-mirror.test.ts` 3/3.
