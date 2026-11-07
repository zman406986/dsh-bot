# 192 — Settings refresh discards a pending save result

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P2 / medium
**Ship blocker:** no

## Requirement

A refresh of the same logical plugin entry/namespace while Apply is pending must preserve ownership of that save's outcome. An accepted, verified save must clear its submitted drafts; a refusal or rejection must retain the drafts and report failure. A genuine switch to another logical entry, detach, or unavailable gap must still invalidate the old continuation. The store already intends same-form refreshes to remain valid, but assumes the supplied wrapper is identical ([settings-card-store.ts:692–695](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L692-L695>)).

## Problem and confirmed source evidence

The shipped Plugins page creates a new plain form wrapper on each render, even though the logical controller is cached for the same entry. When a document refresh replaces the form snapshot and the card's attach effect runs before an outstanding mutation settles, the store treats that wrapper as a rebind. It increments its generation and preserves the staged drafts. The outstanding save then discards its true/false response or rejection because the generation and bound wrapper no longer match.

- **Live card path.** [index.ts:278–283](<C:/Users/TZ/Desktop/dsh-bot/src/client/index.ts#L278-L283>) registers the card into the config slot defined at [settings-card-store.ts:56](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L56>). The installed [plugin-manager client.js:6917–6927](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js#L6917-L6927>) subscribes to configurations and creates a fresh object containing the controller snapshot and a mutation closure. [client.js:7279](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js#L7279>) hands it to RowDetail, which forwards it to the page config slot at [client.js:5870–5873](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js#L5870-L5873>). The item path receives the same wrapper shape at [client.js:7336](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js#L7336>). The underlying controller remains cached by entry ID at [settings client.js:1294–1300](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1294-L1300>).
- **Ordinary refresh during the await.** [settings client.js:1165–1170](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1165-L1170>) awaits the remote mutation. Document updates and connection resets call mirror.load() at [client.js:1488–1493](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1488-L1493>); successful loads publish a new view at [client.js:1453–1457](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1453-L1457>). Mirror notifications derive the form snapshot at [client.js:1116–1119](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1116-L1119>) and [client.js:1209–1231](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1209-L1231>). Host writes call describe at [dsh-settings index.js:536](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js#L536>), whose changed-document detection emits the update event at [index.js:428–435](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js#L428-L435>). Accepted write responses can also replace the mirror via [settings client.js:1413–1425](<C:/Users/TZ/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js#L1413-L1425>).
- **Refresh invalidates the local save.** [settings-card.tsx:270–273](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card.tsx#L270-L273>) calls store.attach(form) when form.state changes. [settings-card-store.ts:687–702](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L687-L702>) preserves generation only for the exact same wrapper object. Save captures the generation at [settings-card-store.ts:745](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L745>); [settings-card-store.ts:756–762](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L756-L762>) returns before handling either boolean outcome after a rebind, and [settings-card-store.ts:786–787](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L786-L787>) suppresses rejection feedback under the same condition.
- **Later refreshes cannot reconcile this result.** Save clears pending verification before awaiting ([settings-card-store.ts:747–756](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L747-L756>)), and the ignored success handler never reaches draft clearing or deferred verification ([settings-card-store.ts:771–785](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L771-L785>)). Later attaches find no pending result to reconcile ([settings-card-store.ts:635–650](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L635-L650>)). Retained drafts override refreshed field values ([settings-card-store.ts:385–387](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L385-L387>)) and keep the card dirty ([settings-card-store.ts:615–617](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L615-L617>)).
- **Saving releases.** [settings-card-store.ts:793–798](<C:/Users/TZ/Desktop/dsh-bot/src/client/settings-card-store.ts#L793-L798>) clears the outstanding owner's saving flag and publishes after a generation change. The pending spinner ends when the mutation settles.

## Source-derived triggering sequence

1. Open the served plugin config page, stage a valid setting change, and press Apply. The remote mutation remains pending.
2. Another window writes the same namespace, causing a normal document-updated refresh, or a reconnect refresh loads a changed snapshot. The logical entry stays the same. Allow the refreshed page's attach effect to run before the outstanding mutation settles.
3. The page supplies a new wrapper with the refreshed state. Attach advances the store generation while retaining the staged drafts.
4. Settle the outstanding mutation with true, false, or rejection. Its outcome handler is discarded; finally releases saving. A later refresh still has no deferred verification record for that save.

This sequence is inferred from source and was not executed.

## Impact and severity

P2 / medium, ship blocker no. This requires a refresh to attach during an in-flight save. An accepted save can leave already-submitted drafts dirty, obscuring whether Apply succeeded and inviting a redundant retry. A refused or rejected save retains the drafts but omits its failure feedback. Later refreshes do not repair that outcome bookkeeping. The evidence establishes a settings feedback and reconciliation defect for this ordering; it does not establish failure of saves outside this ordering.

## Validation limits

Source inspection only, including the exact installed dependency paths linked above. No browser/runtime reproduction, mutation request, build, or tests were run. The existing [client-settings-card.test.ts:787–823](<C:/Users/TZ/Desktop/dsh-bot/test/client-settings-card.test.ts#L787-L823>) refreshes a stable form object with a state getter and reattaches that same object. It misses the shipped fresh-wrapper contract and does not validate this ordering. Acceptance checks below are work for implementation, not checks performed during filing.

## Deduplication

Before creation on 2026-11-07, checked number 192 across open, deferred, resolved, and cancelled; it was unused. Rechecked exact root-cause terms across all four statuses and the latest open ticket titles, including 180, 190, 191, and the 200+ range (200 was present). No exact-root duplicate was found. [Ticket 47](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/47-plugin-settings-card-registration.md#L1>) concerns missing card registration, and [ticket 114](<C:/Users/TZ/Desktop/dsh-bot/Issue-tracker/resolved/114-upgrade-dsh-0-2-x-and-revert-ui-to-native-posture.md#L1>) concerns the host upgrade and native UI posture; neither records this pending-save wrapper invalidation.

## Acceptance criteria

- [ ] Model the shipped contract: the same logical entry/controller supplies a new plain wrapper and a new state snapshot while its mutation promise is pending; the refresh effect runs before settlement.
- [ ] For an accepted save, preserve outcome handling and clear the submitted drafts once fresh state verifies them. If fresh state is delayed, retain deferred verification so a later same-entry refresh reconciles it; a genuine read-back mismatch reports failure with the relevant drafts.
- [ ] For false or rejection after the same-entry refresh, retain the drafts and show save failure.
- [ ] Release saving for each outcome so Apply becomes available again.
- [ ] Preserve invalidation after detach, an unavailable gap, or a genuine change of logical entry: an old continuation cannot clear another entry's drafts or set its failure.

## Comments

### 2026-11-07 — Filed from independently confirmed source audit

Recorded the fresh-wrapper/same-logical-entry race and its bounded P2 impact. Evidence and all-status deduplication were rechecked at filing. No runtime reproduction or tests were executed. Ticket creation is the only change from this task; the runtime-owned issue index was not regenerated.

## Resolution - 2026-11-08

Binding is an epoch bumped only by unbind, so a fresh wrapper is a same-entry refresh and the save outcome and draft survive; detach/unavailable is the entry-switch signal because props carry no entry key; commit `e806901`; unit test 34/34; the live Plugins-page check stays staged for the owner.
