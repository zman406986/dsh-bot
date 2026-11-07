# 265 — Pending microcompact survives plugin unload and appends after boundary-store disposal

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no — optional microcompact must be enabled, enough old tool results must qualify, and teardown must overlap the awaited boundary read.
**Related:** [resolved 124](<../resolved/124-microcompact-boundary-marker.md>), [resolved 172](<../resolved/172-test-suite-prune.md>), [open 196](<196-pending-worker-activation-survives-plugin-unload.md>), [ADR-0029](<../../docs/adr/0029-deterministic-microcompact-boundary-marker.md>)

## Problem and evidence

An in-flight microcompact pass can outlive plugin unload. It checks dispatcher eligibility before awaiting the existing compaction boundary, but the continuation does not recheck eligibility or registration lifetime. Unload can remove the listener and dispose the boundary store while that read is pending. When the read resumes, the pass still appends a `compaction/prune` event and a replacement `tool/result` to the retained parent Session; its subsequent boundary write fails against the disposed store, leaving no new compaction boundary.

The defect is shutdown coordination of an already-running pass. The append-first, marker-last ordering itself is accepted by [124's implementation record:126](<../resolved/124-microcompact-boundary-marker.md#L126>): a crash may leave a consistent surface with no marker. [ADR-0029:19](<../../docs/adr/0029-deterministic-microcompact-boundary-marker.md#L19>) establishes the boundary contract but does not prescribe cancellation versus draining on unload. Either strategy can fix this race.

The independently confirmed audit locates the gap at:

- [Initial eligibility check:364](<../../src/adapter/microcompact.ts#L364>) and [awaited boundary read:431](<../../src/adapter/microcompact.ts#L431>). The later [prune/replacement appends:451–490](<../../src/adapter/microcompact.ts#L451-L490>) have no lifetime recheck, and the [boundary write:527](<../../src/adapter/microcompact.ts#L527>) occurs after those appends. The [listener/disposer:562–591](<../../src/adapter/microcompact.ts#L562-L591>) unregisters the listener without invalidating or draining its in-flight pass.
- The matching compiled root library has the same [initial check:215](<../../lib/adapter/microcompact.js#L215>), [boundary await:286](<../../lib/adapter/microcompact.js#L286>), [late appends:304–337](<../../lib/adapter/microcompact.js#L304-L337>), [boundary write:373](<../../lib/adapter/microcompact.js#L373>), and [listener/disposer:401–422](<../../lib/adapter/microcompact.js#L401-L422>).
- [Plugin registration:1735–1756](<../../src/plugin.ts#L1735-L1756>) supplies `lifecycle.isDispatcherSession` as `shouldHandle`. [Unload:2168–2173](<../../src/plugin.ts#L2168-L2173>) clears lifecycle state, then disposes the host and marker store; it does not coordinate completion of the pending pass. The compiled plugin matches at [registration:1410–1424](<../../lib/plugin.js#L1410-L1424>) and [unload:1764–1769](<../../lib/plugin.js#L1764-L1769>).
- [Dispatcher activation:1655–1659](<../../src/plugin.ts#L1655-L1659>) does not wait for the durability rebuild. A pending storage-domain open during the boundary read is therefore reachable during ordinary activation, rather than requiring an impossible initialized-state assumption.

## Native Session lifetime evidence and limits

The independent static audit also checked that plugin-only unload leaves the parent Session writable. [Host disposal:4383–4419](<../../src/adapter/cordis-dsh-host.ts#L4383-L4419>) and [unbindParent:3323–3332](<../../src/adapter/cordis-dsh-host.ts#L3323-L3332>) remove adapter bindings, not the Session itself. [Parent deactivation:630–645](<../../src/adapter/parent-agent.ts#L630-L645>) and [930–938](<../../src/adapter/parent-agent.ts#L930-L938>), together with [plugin cleanup:1665–1678](<../../src/plugin.ts#L1665-L1678>), remove tools, class state, and waits without removing the retained parent Session from the native store.

The installed native [Session.append:1524–1545](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js#L1524-L1545>) and [publicationEntry:1576–1581](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js#L1576-L1581>) check store membership/publication, not plugin activation. That independently establishes why the retained native parent can accept a late append after plugin teardown. It is static native-lifetime proof, not a native plugin-unload reproduction.

The observed scope is post-unload context mutation plus a missing new boundary. Original raw tool outputs remain in the append log. This evidence does not prove double compaction, raw-output data loss, or an indefinite hang.

## Deterministic reproduction and prior observations

One supplied prior file-free audit probe used the real root compiled `registerMicrocompact` and `createStorageDomainDurability` with a structural Session double. Its only asynchronous gate was `host.storageDomain.open`; the boundary read/write path and microcompact implementation were real. This probe predates filing and was not executed again during ticket writing.

1. Create the real storage-domain durability adapter with `host.storageDomain.open` held by a manually controlled promise. Supply a structural parent Session that retains its append log and records every append's type and whether store disposal has occurred.
2. Register microcompact with `shouldHandle` initially true. Supply measured usage above its trigger and enough eligible old tool results to exceed the minimum saving while preserving the newest results. Count calls to the pre-step continuation `next`.
3. Invoke the captured `agent/pre-step` listener and start the pass without awaiting completion. Hold the storage-domain open while the pass awaits its boundary read.
4. Set `shouldHandle` false, call the registration's unregister/disposer, and call the durability store's `dispose()` before releasing the open gate. This models loss of dispatcher eligibility, listener teardown, and boundary-store disposal.
5. Release the gate and await the pre-step listener. Inspect the retained Session append log, reported outcome, continuation count, boundary rows, and domain closed state.

Observed output from that prior probe: exit 0, no stderr.

```text
appends: [
  { type: "compaction/prune", afterDispose: true },
  { type: "tool/result", afterDispose: true }
]
outcome: {
  compacted: false,
  reason: "threw",
  clearedCount: 0,
  freedTokens: 0,
  boundary: null
}
nextCalls: 1
boundaryRows: 0
closed: true
```

The outcome reports a failed pass after the two context-changing appends have already occurred. Listener removal and the changed eligibility predicate do not stop that continuation; the store is closed and no new boundary row is present. The structural Session double makes the append timing deterministic; the separate native-lifetime audit above establishes that ordinary plugin-only unload does not itself make the real parent Session unwritable.

## Impact and triage

Microcompact can mutate the dispatcher's effective context after the plugin has unloaded, when the store needed to persist that pass's boundary has already been disposed. The operation reports failure and resume has no new compaction boundary for those replacements. This is a P2/medium, non-blocking lifecycle race: optional microcompact must be enabled, the usage and old-result saving thresholds must be met, and unload/deactivation must overlap the awaited boundary read. A process crash is not required.

## Acceptance criteria

- [ ] Coordinate in-flight microcompact work with plugin unload/deactivation. Either invalidate a pending pass before it can make late appends, or drain it while its required Session and boundary store remain usable, before closing that store.
- [ ] A continuation released from an awaited boundary read cannot mutate context after teardown has broken boundary persistence. Removing the listener or changing `shouldHandle` alone must not leave an uncoordinated pending pass.
- [ ] With a cancellation strategy, releasing the held read after teardown produces no prune/replacement appends. With a drain strategy, teardown keeps the required resources available until the pass and its boundary write have completed, then closes them. Neither strategy requires a second disposal.
- [ ] Add a focused offline regression at the gated boundary-read seam: start an eligible pass, overlap deactivation/unload, release the gate, and verify the chosen abort-or-drain contract, boundary state, and normal pre-step continuation. Retain ordinary successful-pass and listener-removal behavior. This is a future implementation criterion; no regression test is added in this filing.

## Duplicate and filing checks

- Read the [tracker conventions](<../issue-tracker.md>), [agent conventions](<../../agent.md>), [domain vocabulary](<../../CONTEXT.md>), and [196's new-ticket format](<196-pending-worker-activation-survives-plugin-unload.md>) before writing.
- Fresh checks across `open`, `deferred`, `resolved`, and `cancelled` found no existing 265 prefix and no equivalent pending-microcompact teardown ticket. [124](<../resolved/124-microcompact-boundary-marker.md>) shipped the feature and explicitly accepts append-first/marker-last crash behavior. [172:133](<../resolved/172-test-suite-prune.md#L133>) preserves listener registration/removal pins, which do not establish in-flight coordination. [196](<196-pending-worker-activation-survives-plugin-unload.md>) concerns pending worker activation and late activation receipts, a different operation and lifecycle gap.
- The code citations and independent native-lifetime finding above are supplied prior audit evidence, including the final confirmation that activation need not wait for durability rebuild. Filing did not rerun source diagnosis or the probe, and did not perform a native unload reproduction.
- No agents, probes, tests, or builds were run for filing. Only this ticket was added; source, tests, configuration, product documentation, artifacts, and the generated tracker index were not edited.

## Comments

- 2026-11-07 — Filed from the independently confirmed audit as open / ready-for-agent, P2/medium, non-blocking. Scope is teardown coordination of a pending microcompact pass; cancellation and draining are both acceptable.

## Resolution - 2026-11-08

Teardown publishes a cancelled flag before unregistering, the pass skips at entry and after the boundary read, and the plugin feeds it from its teardown state; commit `8d884cc`; `test/adapter-microcompact.test.ts` 16/16.
