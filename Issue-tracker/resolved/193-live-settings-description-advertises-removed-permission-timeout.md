# 193 — Live settings description advertises removed permission timeout

**Status:** resolved
**Labels:** ready-for-agent
**Severity:** P3 / low
**Ship blocker:** NO

## Problem and requirement

The live settings card still says it configures the wait for unanswered permission requests, although the worker access-ask feature and its timeout were intentionally removed. Both language faces retain this claim. The description must summarize the settings that actually exist without advertising a worker permission-request timeout.

## Confirmed source evidence

- [English description:276–277](<../../src/client/overlay.ts#L276-L277>): “The dispatcher's feature flag and how long an unanswered permission request waits.”
- [Chinese description:587–588](<../../src/client/overlay.ts#L587-L588>): “调度器的功能开关，以及未获答复的权限请求可等待的时长。”
- [Description key:87](<../../src/client/settings-card-store.ts#L87>) maps to `settings.card.description`. The [summary:283–284](<../../src/client/settings-card.tsx#L283-L284>) and [available configuration page header:303–305](<../../src/client/settings-card.tsx#L303-L305>) both render its translation. The header renders before the expanded-body branch at [314–315](<../../src/client/settings-card.tsx#L314-L315>).
- This is a composed entry: the [client apply entry:157–163](<../../src/client/index.ts#L157-L163>) calls `applyClientModule`, which [registers the locale dictionary:207–212](<../../src/client/index.ts#L207-L212>) and [registers this component:278–284](<../../src/client/index.ts#L278-L284>) into the [`plugins.row.config` slot:56,77–82](<../../src/client/settings-card-store.ts#L56>). This establishes source reachability when the host serves the plugin configuration row.
- [Config:87–167](<../../src/plugin.ts#L87-L167>) and [SETTINGS_CARD_FIELDS:240–291](<../../src/client/settings-card-store.ts#L240-L291>) expose ten fields: `enabled`, `wakeCoalesceWindowMs`, `inboxEnabled`, `racoonsEnabled`, `racoonsRecordOnly`, `racoonsStorageRoot`, `racoonsContextWindowTokens`, `inboxDir`, `inboxRescanIntervalMs`, and `microcompactEnabled`. These cover the dispatcher flag, wake coalescing, inbox, optional RACOONS settings, and microcompaction; neither list contains a permission-request timeout.
- [ADR-0033:6](<../../docs/adr/0033-worker-access-ask-removed.md#L6>) removes the worker ask channel, and [its consequence:37](<../../docs/adr/0033-worker-access-ask-removed.md#L37>) explicitly removes `accessRequestTimeoutMs` from Config and its settings row. [Resolved 174:48–54](<../resolved/174-remove-worker-access-ask-feature.md#L48-L54>) records that removal scope; [its closure:93–96](<../resolved/174-remove-worker-access-ask-feature.md#L93-L96>) records shipment. The stale description conflicts with that accepted removal, not with a missing implementation requirement.

## Triggering sequence (source-derived, not executed)

1. In an English or Chinese client where the host serves this plugin's configuration row, open the Plugins settings surface.
2. The row's summary renders the obsolete description through the shared translation key.
3. Open the configuration page with an available form. Its header repeats the same description; expanding the card exposes the current fields above and no permission-request timeout control.

## Impact

Users are told they can configure a permission-request wait that the plugin no longer offers and may search for a nonexistent control. This is a low-severity copy mismatch and is not a ship blocker. No visual, layout, settings-save, or runtime malfunction is alleged.

## Validation limits and duplicate check

- Verified by source reads and focused searches only. No runtime reproduction, browser/UI probe, screenshot, tests, builds, or configuration changes were performed. Source reachability does not establish which bundle is currently loaded in a running deployment.
- Searched all four status folders (open, deferred, resolved, cancelled) for the exact description key/text, settings-description/timeout wording, and the removed timeout field. The current open set includes the new 180, 190, 191 and 200 tickets. No existing ticket tracks this surviving live description.
- [Open 180:29–34](<180-correct-retired-worker-access-surface-docs.md#L29-L34>) concerns retired-access claims in [the surfaces guide](<../../docs/surfaces.md>) and explicitly limits its fix to documentation; it does not cover runtime locale copy. [Open 183:38–42](<183-post-oct28-adapted-copy-quality-review.md#L38-L42>) requests a bounded copy-quality review and separate concrete follow-ups. [Resolved 47:142–148](<../resolved/47-plugin-settings-card-registration.md#L142-L148>) records the original description while the timeout existed; resolved 174 removes the feature. These are related history/scopes, not duplicate tracking of this residue.
- Immediately before creation, checked the 193 filename prefix across all four status folders and searched ticket headings for number 193; it was unused. No existing ticket is renamed or overwritten; the generated issue index is left to the runtime's final pass.

## Acceptance criteria

- [ ] Update both EN and ZH values of `settings.card.description` to accurately summarize current configurable settings, without promising permission-request waiting, a permission timeout, or the removed worker ask feature. The description need not enumerate every field.
- [ ] Confirm from the shared-key wiring that both the settings-row summary and the available configuration page header use the corrected description in each language.
- [ ] Keep the fix limited to the two description values. Preserve the existing settings fields and behavior and ADR-0033's removal; do not add a timeout control or restore the access-ask feature.

## Comments

2026-11-07 — Independently confirmed the exact current EN/ZH strings, both render sites, the client registration path, the current Config/card field lists, and the removal decision. Filed this single source-proven copy issue only; no runtime reproduction or tests.

## Resolution - 2026-11-08

Fixed in `4f23838`: the settings card EN/ZH description no longer promises a permission-request wait; `test/client-face-scaffold.test.ts` passes 11/11.
