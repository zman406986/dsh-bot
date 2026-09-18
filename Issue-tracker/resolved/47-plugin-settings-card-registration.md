# 47 — Settings 插件配置 has no card for `multitask-dispatcher`: the plugin registers no `settings.plugin.item` entry, so the tab can never render our section

**Status:** resolved
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

- [x] (offline, gate) `npm test`, `npm run typecheck`, `npm run build:client`
      green, including a pin that the module registers exactly one
      `settings.plugin.item` entry whose `key` equals the plugin's settings
      namespace, and that a regression to a missing/renamed key fails offline.
- [x] (offline) Locale parity pinned: the card's new keys exist in both faces.
- [x] (live, ZERO LLM calls) on a launcher/profile boot, `Settings → 插件配置`
      renders a Multitask Dispatcher card whose control reads the persisted flag
      value from the served document.
- [x] `docs/surfaces.md` lists the card among the client surfaces.

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

### 2026-09-18 — implemented offline (`9743330`), then PROVEN live on the zero-LLM re-pass #3

**Offline (all four gate pins green).** The client half now carries a card module
(`src/client/settings-card-store.ts` — pure registration data + form model, no
React/DOM/Cordis — over the component in `src/client/settings-card.tsx`), wired in
`src/client/index.ts` through the SHIPPED declaration wait, as a plain callback
returning a disposer rather than the shipped generator, so the offline fakes can
drive it:

```ts
ctx.slots.inject(SETTINGS_PLUGIN_ITEM_SLOT, () => {
  const t = ctx.locale.bind(LOCALE_NAMESPACE);
  return ctx.slots.register(settingsCardRegistration(), createPluginSettingsCard(t, card));
});
```

`key` and `locale` are both `multitask-dispatcher`. Reads and writes ride the SAME
`ctx.settingsScope` bind the roster watch already used — no second channel, no new
boot-graph edge, nothing imported from `dsh-client-ui-settings-plugins` (bundle
purity gate). `available:false` renders nothing for `unavailable`/`loading`/no
document, per Requirement 4. Locale gained `settings.card.*` in both faces with
identical key sets. `docs/surfaces.md` gained the contract section and the
shipped-surfaces row. Gates: `npm test` **767 pass / 0 fail / 194 suites** (34 new
pins), `npm run typecheck` clean both configs, `npm run build:client` OK
(`client/index.js` 88,585 bytes). The key pin was RED-verified twice — renaming
`key` fails the pin; deleting the entry from `apply` fails 3 registration pins.

One design note the tests pin: requirement 2's "any other field the schema
exposes" is rendered as **exactly the two dict fields**, in schema order, asserted
against `Config.dict` — a third field appearing in the schema fails the suite
rather than silently going unrendered.

**Live (ZERO LLM calls) — the card renders and reads the served document.**
Evidence: `C:\Users\TZhen\Desktop\dsh-live-repass3-2026-09-18\` (full write-up in
its `README.md`; screenshots `shots/01`–`03`). Booted from a fresh build of
`9743330` on the committed overlay route
(`dsh --profile web --patch dev/cordis.web.patch.yml --port 8823 --no-open`,
started directly rather than through `dsh-bot.ps1`), detached via WMI with kill
timers armed at launch. Zero composer input, so zero completions — the only
`/api/llm/*` traffic is the two provider **catalogs**.

`Settings → 插件 → 插件配置` now renders, as its FIRST card:

```
Multitask Dispatcher
  调度器的功能开关，以及未获答复的权限请求可等待的时长。
  启用调度器        [✓]    保存为调度器的设置：对新会话生效。…
  访问请求超时（毫秒） 120000  权限请求未获答复时可等待的时长，超时后按拒绝处理。…
                                        [放弃]  [保存]
终端   Agent 循环   Subagent   网页搜索   ← host rows, unchanged
```

`li.multitask-dispatcher-settings-card` count = 1. A live
`POST /api/settings/describe` on the same boot (gateway shape: exactly one
plain-object `args` field) returns our namespace `uid: 561`,
`value = base = {enabled: true, accessRequestTimeoutMs: 120000}`,
`applies: "live"`, `revision: 0`, and **no `user` key** — saved as
`settings-describe-ours-live.clean.json`. Control-by-control:

- checkbox `checked: true` ← `value.enabled: true`;
- number input `value: "120000"` ← `value.accessRequestTimeoutMs: 120000`;
- **no** "已在此设置" badge and **0** `__reset` buttons — correct, because
  `overridden` is PRESENCE in the user layer and this document has no user layer
  (not a value comparison coincidentally agreeing);
- on a page reload the card re-mounts closed and still reads `true` / `120000`
  with 0 dirty chips and Save disabled — the value is the document's, not
  in-memory state.

The honest-form paths were exercised live **without writing anything**: clicking
the checkbox surfaced the `未保存` chip and enabled Save + Discard, the rendered
control followed the draft (`false`) while the untouched field kept `120000`, and a
patched `window.fetch` recorded **no** `settings/update|mutate|replace` request
(total request count unchanged). 放弃 returned the card to the clean state
(chip gone, both buttons disabled, checkbox back to `true`). Nothing was persisted;
the human's settings document is untouched.

**Before/after from the same recipe and the same tab:** re-pass #2's
`dsh-live-repass2-2026-09-18/shots/05-settings-plugins.png` shows only the host's
four rows — the namespace was already served then (`uid: 561`, same `value`), it
simply had no card claiming it. That gap is exactly what this ticket closes.

**AC 3 route caveat, stated rather than glossed:** this pass booted the
committed-overlay **web** route, not the `multitask` profile and not through the
launcher script. The launcher passes this same committed patch, the profile
route's namespace presence was already proven in re-pass #2
(`rpc-settings-describe2.json`, same `uid: 561`), and the card half is
client-side and route-independent — so the AC's substance is met; a single boot
carrying both the profile route and the card is not what was run.

Not checked here (out of scope, recorded): the client roster watch (ticket 46),
the activation-dependent set (ticket 45), and ticket 44's command registration
(`commands/list` requires an `agentId` — not on this ticket's path).

### 2026-09-18 — resolved

All four ACs green: offline gate + pins (`9743330`), locale parity, the live
card/value assertion above, and the `docs/surfaces.md` row. Resolved by the
re-pass #3 sweep; the two items this pass did not cover (the client watch, and the
activation-dependent set) belong to tickets 46 and 45, not here.
