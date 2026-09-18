# 46 — Client watch `ctx.inject(["settings"])` never fires live: capsule never flips client-side, footer flag stays `unknown`, and no plugin settings card is registered

**Status:** open
**Labels:** needs-triage
**Blocked by:** none (diagnosis pending — root cause NOT yet confirmed)
**Related:** 35 (capsule epic), 44/45 (same live re-pass #2, 2026-09-18), 34 (client module materialization), 33 (live close-out)

## Symptom (live, cited)

Live re-pass #2, activated `multitask` session: the client-side watch

- `ctx.inject(["settings"])` — `src/client/index.ts:128`

never fires in the browser. Consequences observed:

- The capsule never flips client-side (epic 35 composition stays dormant on the client half even with a roster document present in the namespace).
- The footer flag stays `data-flag="unknown"`.
- No settings card is registered: shipped plugins register explicit `settings.plugin.item` client entries (reference shape: `dsh-client-ui-settings-plugins/lib/client.js:1795-1810`); this plugin registers none, so the Settings 插件配置 section never renders.

Evidence dir: `C:\Users\TZhen\Desktop\dsh-live-repass2-2026-09-18\` (screenshots under `shots\`; see also ticket 44's re-pass #2 comment).

## Hypothesis (unconfirmed)

One or both of:

1. The client watch is wired against the wrong channel/lifecycle — e.g. `ctx.inject(["settings"])` at `src/client/index.ts:128` subscribes before the namespace/settings document exists, or the injected key does not match what the host publishes, so the callback never re-runs when the roster lands.
2. The plugin ships no `settings.plugin.item` client registration at all (shipped cards are explicit per-namespace client registrations), which is a separate, independent gap from the watch not firing — fixing the watch alone would not produce a settings card.

## Acceptance criteria (placeholder — pending diagnosis)

- [ ] Root cause confirmed with a cited mechanism (file/line) for the dead watch.
- [ ] (live) `ctx.inject(["settings"])` fires in an activated session; capsule flips client-side; footer flag no longer `unknown`.
- [ ] (live) A settings card renders in the Settings 插件配置 section.
- [ ] Offline regression pin for whatever mechanism the diagnosis lands (watch lifecycle and/or client registration).

## Comments
