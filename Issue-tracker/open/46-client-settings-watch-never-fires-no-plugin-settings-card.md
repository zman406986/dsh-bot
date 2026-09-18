# 46 — Client watch `ctx.inject(["settings"])` never fires live: capsule never flips client-side, footer flag stays `unknown`, and no plugin settings card is registered

**Status:** open
**Labels:** ready-for-agent
**Blocked by:** none (root cause confirmed 2026-09-18 — see below)
**Related:** 35 (capsule epic), 44/45 (same live re-pass #2, 2026-09-18), 34 (client module materialization), 33 (live close-out), 47 (the settings-card half, split out at triage)

## Symptom (live, cited)

Live re-pass #2, activated `multitask` session: the client-side watch

- `ctx.inject(["settings"])` — `src/client/index.ts:128`

never fires in the browser. Consequences observed:

- The capsule never flips client-side (epic 35 composition stays dormant on the client half even with a roster document present in the namespace).
- The footer flag stays `data-flag="unknown"`.
- No settings card is registered: shipped plugins register explicit `settings.plugin.item` client entries (reference shape: `dsh-client-ui-settings-plugins/lib/client.js:1795-1810`); this plugin registers none, so the Settings 插件配置 section never renders.

Evidence dir: `C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\` (screenshots under `shots\`; see also ticket 44's re-pass #2 comment).

## Root cause 1 (CONFIRMED, cited) — the watch waits on a service name that does not exist client-side

The watch is not mis-timed and its lifecycle is fine: it waits forever on a
**service that is never provided under that name in the browser runtime**.

- What our client half does (`src/client/index.ts:128`): `ctx.inject(["settings"], (child) => child.settings.watch(LOCALE_NAMESPACE, cb))`.
- What cordis does with that (`node_modules/@deepseek-ai/cordis/src/registry.ts:300-302`):
  `inject(deps, cb)` IS `plugin({ inject: deps, apply: cb })` — the callback runs
  only once every named service resolves. `"settings"` never resolves client-side,
  so **the body never executes**: no watch, no dispose, no `channel-missing`, no
  error. The store stays at its initial `waiting` forever, which is exactly the
  observed symptom (capsule dormant, footer `data-flag="unknown"`).
- What the browser actually provides (`$DSHPKG/dsh-client-ui-settings/lib/types/client/index.d.ts:2-3`):
  *"Provides `ctx.settingsScope`, the settings-namespace scope service every
  preference row binds its durable section through"* —
  `declare module '@deepseek-ai/cordis' { interface Context { settingsScope: SettingsScopeBinder } }`
  (`settings-scope.d.ts:88-92`). There is **no** client service named `settings`.
- The per-namespace access shape is different too, so this is not just a rename:
  `SettingsScopeBinder.bind<T>(spec)` → `SettingsScope<T>` with
  `getSnapshot(): SettingsScopeSnapshot<T>` and `subscribe(listener): () => void`
  (`settings-scope.d.ts:139`, `settings-contract.d.ts:50-58`). There is **no**
  `watch(namespace, cb)` anywhere in the contract. `bind` is bound to the
  *caller's* fiber (`settings-scope.d.ts:130-138`), and the snapshot carries
  `status: 'loading' | 'ready' | 'unavailable'` + `value` (`settings-contract.d.ts:6-32`).
- Shipped idiom, for contrast (`$DSHPKG/dsh-client-ui-settings-plugins/lib/client.js:1689-1696, 1707`):
  `const inject = ["slots","locale","remote","remote.credentials","remote.session","settingsScope"]`
  then `ctx.settingsScope.bind({ namespace })`. Two independent shipped plugins use
  `settingsScope`; none uses `settings`.

**Corroboration from our own tree:** the wrong name was already refuted by
research we hold. `docs/research/dsh-capsule-seams.md:57` (ticket 36, verified
against this same installed bundle) says the flag source is `ctx.settingsScope`
— the implementation was written against the *host* idiom
(`ctx.inject(["settings"], …)` is correct **host-side**, e.g.
`src/adapter/settings-section.ts:97` and `dsh-agent-default-model`), and the
client half copied it. ADR-0014 §"Why the smallest set holds here" also states
the wrong name and must be corrected with it.

**Consequence of the fix:** the same watch payload feeds both stores, so the fix
lands in one place (`src/client/index.ts`) and covers all three symptoms at once
(dormant capsule, `unknown` footer flag, never-flipping composition).

## Root cause 2 (CONFIRMED, cited) — no card is registered, so no section can render

Independent of the watch: the Settings 插件配置 tab renders the **intersection of
two ledgers** — the namespaces the Host serves and the cards registered into
`settings.plugin.item`. *"A served namespace no card claims renders nothing"*
(`$DSHPKG/dsh-client-ui-settings-plugins/lib/types/client/tab-store.d.ts:1-11`).
The slot is `kind: 'keyed'` with the settings namespace as the key
(`slot-contract.d.ts:16-25`), declared at runtime by the tab, and shipped cards
register explicitly, one `slots.register` per namespace
(`lib/client.js:1785-1810`). Our plugin registers **no** `settings.plugin.item`
entry, so the section can never appear — the host-half `installSection` alone
was never going to be enough.

This is a separate surface with its own design (fields, write path, honesty
rules), so it is split out per the epic-35 granularity rule:
**ticket 47**. Fixing the watch here does not produce a card, and vice versa.

## Acceptance criteria

Watch half (this ticket):

- [x] Root cause confirmed with a cited mechanism (file/line) for the dead watch.
- [ ] (offline, gate) `npm test`, `npm run typecheck`, `npm run build:client` green
      including a regression pin that fails if the watch goes back to a
      non-existent service name or to a `watch(namespace, cb)` shape.
- [ ] (live, ZERO LLM calls) the watch fires in an activated session: the capsule
      flips client-side and the footer flag reads a real value (no `unknown`).

Card half: **moved to ticket 47** (filed 2026-09-18) — the offline pin and the
live "a settings card renders in 插件配置" assertion live there.

## Comments

### 2026-09-18 — triaged + watch half FIXED offline (AC 1–2 green); live AC 3 pending; card half split to ticket 47

**Triage.** Root cause 1 confirmed with citations (above): the watch waited on a
service name that does not exist client-side. The hypothesis "subscribes before
the namespace document exists, or the injected key does not match" was
half-right — the *key* indeed does not match, and it matters more than timing:
with a wrong name cordis never runs the callback at all, so no timing change
could have helped. Root cause 2 confirmed as the two-ledger rule of the plugins
tab, split out to **ticket 47** (filed this date) with its own ACs — it is a
separate surface with its own design, per the epic-35 granularity rule.

**What changed (three files, no host-half or prompt changes):**

- `src/client/context.ts` — the settings seam types now describe the SHIPPED
  contract: `ClientSettingsScopeBinderLike.bind({namespace})` →
  `ClientSettingsScopeLike.{getSnapshot, subscribe}` with
  `ClientSettingsScopeSnapshotLike.{status, value}`. The old
  `watch(namespace, onChange)` member is gone (it never existed in the product),
  and the block comment records both the citations and why the host name is the
  wrong one to copy.
- `src/client/index.ts` — the data path is now
  `ctx.inject(["settingsScope"], …)` → `binder.bind({namespace: LOCALE_NAMESPACE})`
  → `subscribe(readSnapshot)` **plus one immediate `readSnapshot()`**. Mapping to
  the existing store vocabulary: `status: "unavailable"` → `channel-missing`
  (namespace not exposed / process-local), `loading` or a value-less `ready` →
  stay `waiting` (feed alive, no section accepted), anything else →
  `applyChannelValue(value)` on BOTH stores (roster + footer — one channel, two
  honest readers, unchanged). The immediate read is load-bearing: `subscribe`
  only fires on replacements, so a scope bound after the first accepted section
  would otherwise wait forever for a write that may never come — the same class
  of silent stall this ticket is about.
- `test/client-roster-panel.test.ts` — the fake client ctx now models the real
  contract (binder + snapshot + subscriber set; a `watch(ns, cb)` call would
  throw, so the old shape cannot pass on a fake that never existed live).

**New pins (+5 tests, 706 → 711):**
1. the inject names the shipped service — `[["settingsScope"]]`, asserted never
   to include `settings` (this is the pin that bites);
2. the scope is bound on `multitask-dispatcher`, not a guessed namespace;
3. an already-`ready` snapshot is read at bind time with no notify;
4. `loading` → stays `waiting`; a value-less `ready` → still `waiting`; then a
   real section → snapshot;
5. `unavailable` → `channel-missing` → panel `unavailable`.
Plus the rewritten teardown test (unsubscribe on fiber teardown, one fresh bind
after re-apply) and a rewritten "no service ever appears" test asserting the
honest `waiting` face — the previous version passed a hand-built state object and
asserted nothing about the wiring, which is part of why this defect survived 706
green tests.

**Verified RED before GREEN:** reverting only the service name in `index.ts` to
`"settings"` fails **7** tests in `test/client-roster-panel.test.ts` (34 pass / 7
fail), including the named pin and the end-to-end "watch payload becomes rows"
path; restoring it returns the file to green. The pin therefore fails for the
live defect's exact cause, not for a proxy.

**Gates:** `npm test` **711 pass / 0 fail / 186 suites** (was 706/186);
`npm run typecheck` clean (both `tsconfig.json` and `tsconfig.client.json`);
`npm run build:client` OK. The built bundle now carries the corrected contract —
`client/index.js` contains `ctx.inject(["settingsScope"], …)` and no `"settings"`
service name or `watch(...)` call survives in it.

**Corrections to our own records (this defect was researched right and coded
wrong):** `docs/research/dsh-capsule-seams.md:57` already named
`ctx.settingsScope` on 2026-09-18 (ticket 36); ADR-0014's "why the smallest set
holds here" bullet stated the wrong `ctx.inject(["settings"], …)`. The ADR bullet
is annotated with a dated correction; the research note keeps its verdict and
gains a note that the implementation had diverged from it.

**Not done here:** the live AC 3 (a real activated session where the capsule
flips and the footer flag reads a real value) — it belongs to the next live
re-pass, per the pass split the repo has used throughout. The card AC moved to
ticket 47. No ticket file moved; ticket 46 stays open on its one live AC.
