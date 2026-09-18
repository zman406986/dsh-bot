# 47 — Settings 插件配置 has no card for `multitask-dispatcher`: the plugin registers no `settings.plugin.item` entry, so the tab can never render our section

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none
**Related:** 46 (the watch half of the same live re-pass #2 finding — split out at triage 2026-09-18), 35 (capsule epic; the footer's copy-only Settings hint is the surface-level placeholder for this gap), 42 (footer close-out, recorded "no deep-link" but assumed the section itself rendered), 33 (live close-out)

## Symptom (live, cited)

Live re-pass #2, activated `multitask` session: `Settings → 插件配置` renders only
终端 / Agent 循环 / Subagent / 网页搜索 (`dsh-live-repass2-2026-09-18/shots/05`).
Our namespace IS served by the Host — `/api/settings/describe` carries
`multitask-dispatcher` with our exact schema dict and
`value = base = {enabled:true, accessRequestTimeoutMs:120000}`, applied "live"
(`rpc-settings-describe2.json`) — yet no card appears, and ticket 44's re-pass
comment correctly diagnosed the missing piece as a client-side registration.

## Root cause (CONFIRMED, cited)

The plugins tab renders the **intersection of two ledgers**: the namespaces the
Host serves, and the cards registered into the `settings.plugin.item` slot.
*"A served namespace no card claims renders nothing — another surface owns it,
or this deployment ships no browser half for it"* — and the render dispatch is
`renderSlot("settings.plugin.item", {}, { entryKey: ns })` per served namespace
(`$DSHPKG/dsh-client-ui-settings-plugins/lib/types/client/tab-store.d.ts:1-11`;
`lib/client.js:402-416`). The slot is `kind: 'keyed'`, keyed by the settings
namespace the card edits (`lib/types/client/slot-contract.d.ts:16-25`), and is
declared at runtime by the tab itself (`lib/client.js:1773-1784`).

Our client half registers **no** `settings.plugin.item` entry — `src/client/index.ts`
registers only the locale namespace, the settings bind, the `shell.overlay`
capsule, and the five `tool.call.toolview` entries. So the section cannot appear
regardless of the host half: `installSection` alone was never sufficient
(`src/adapter/settings-section.ts` is correct and stays untouched).

This is independent of ticket 46's dead watch: ticket 46's fix gives the capsule
its data; this ticket gives the Settings surface its card.

## Requirements (shipped idiom, verified)

1. Register one keyed entry through the declaration wait the shipped cards use
   (`lib/client.js:1785-1810`):

   ```ts
   ctx.slots.inject("settings.plugin.item", function* () {
     yield ctx.slots.register(
       { name: "settings.plugin.item", key: LOCALE_NAMESPACE, locale: LOCALE_NAMESPACE,
         inject: () => card.inject() },
       SettingsCard,
     );
   });
   ```

   `key` is our namespace (`multitask-dispatcher`) — the pairing the tab needs;
   `locale` is our own dictionary namespace so the kit's `t` seat binds. No new
   boot-graph edge is required (`settings.plugin.item` is reached by declaration
   wait, and writes ride the scope binder — see 3).
2. The card renders our schema's fields honestly: the feature flag, phrased as
   the SETTING (ADR-0005 — a persisted change lands in new chats, never a live
   toggle of the running session) and any other field the schema exposes. Field
   labels/help are new copy in the `multitask-dispatcher` namespace (en + zh,
   identical key sets — `validateLocaleDictionary` must stay green).
3. Reads/writes go through the SAME `ctx.settingsScope` bind the roster watch
   uses (ticket 46's corrected contract): `bind({namespace})` →
   `getSnapshot()`/`subscribe()` for reads, `set(field, value)` for a queued
   write with the namespace's revision fence
   (`settings-contract.d.ts:50-85`). Never a second channel, never a direct
   `remote.settings` call from a new seam.
4. No card if the namespace is not served: the card must render nothing
   actionable when its scope reports `status: "unavailable"` — honest degrade,
   not an error surface and not a dead control.

## Acceptance criteria

- [ ] (offline, gate) `npm test`, `npm run typecheck`, `npm run build:client`
      green, including a pin that the module registers exactly one
      `settings.plugin.item` entry whose `key` equals the plugin's settings
      namespace, and that a regression to a missing/renamed key fails offline.
- [ ] (offline) Locale parity pinned: the card's new keys exist in both faces.
- [ ] (live, ZERO LLM calls) on a launcher/profile boot, `Settings → 插件配置`
      renders a Multitask Dispatcher card whose control reads the persisted flag
      value from the served document.
- [ ] `docs/surfaces.md` lists the card among the client surfaces.

## Notes

- Do NOT import from `@deepseek-ai/dsh-client-ui-settings-plugins`: the client
  bundle purity gate forbids cross-plugin value imports and directs collaboration
  through cordis services (that package's own `client.js` states the rule). The
  card is our own component over the `settingsScope` service.
- That package's `card-form`/`CardShell` helpers are NOT a dependency we declare;
  building a minimal own card is the smaller, cleaner step. If a later pass wants
  the shipped form primitives, that is a separate decision with its own ADR.
- Ticket 42's footer hint ("Change it in Settings → Multitask Dispatcher") was
  written as copy-only because no deep-link seam exists (capsule-seams verdict 4).
  Once this card exists the hint becomes *accurate*; the missing deep-link stays a
  recorded gap — do not invent a navigation channel here.

## Comments
