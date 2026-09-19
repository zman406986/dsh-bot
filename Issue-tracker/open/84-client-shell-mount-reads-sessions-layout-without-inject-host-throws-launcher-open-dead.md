# 84 — Client shell mount reads `ctx.sessions`/`ctx.layout` without declaring the injects: the host throws `cannot get property … without inject`, so the launcher chip can never open the shell page live

**Status:** open
**Labels:** needs-triage
**Blocked by:** none
**Related:** 78 (the staging mount this breaks), 46 (the runtime-inject idiom that DOES work), 79/80 (the feed bindings that die with it)

## Symptom (live, cited)

Live pass 2, 2026-09-19 (`C:\Users\TZhen\Desktop\dsh-live-pass2-2026-09-19\`, outside the
repo), throwaway `multitask` profile boot, host 0.1.5-rc.1, commit `c56e69d` tree, client
bundle 157,823 bytes:

- The launcher chip (`multitask-dispatcher-shell-launcher__chip`, 调度台) renders — top 44 px,
  below the capsule chip (top 10 px), per the staging spec (`shots/04-chips-capsule-launcher.png`).
- Clicking it does NOTHING visible: no `[data-shell="dispatcher"]` element appears, the stock
  empty state stays (`shots/05-shell-main-page.png`), and the chip is unchanged (per design it
  does not decorate failures).
- The driver's page-error log records exactly two unhandled errors for the whole session:
  `pageerror: cannot get property "sessions" without inject` and
  `pageerror: cannot get property "layout" without inject`.

## Root cause (cited)

`package.json` `dsh.client.inject` declares only
`["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]`. The client
context getter THROWS on any service property that is not declared for the module — the
host's own message is the first quote above. Three read sites in the shell work therefore
throw against the real host while passing offline (the offline fakes return `undefined`
instead of throwing):

1. `src/client/index.ts` launcher wiring — `openShellPage(ctx.layout, SHELL_PAGE_KEY)` reads
   `ctx.layout` at click time. The comment calls it "an optional structural face read lazily";
   on the real host the read itself throws, so `openShellPage`'s honest `no-layout` outcome is
   unreachable and the click dies as an unhandled pageerror
   (`src/client/shell-mount.ts` `openShellPage` never runs).
2. `src/client/index.ts` `mountShellPage` — the sessions feed binding effect reads
   `ctx.sessions` (`if (ctx.sessions === undefined) …`), and the conversation window binding
   reads it again. Both effects threw at registration time (the `sessions` pageerror), so even
   a successfully opened page would have a dead sidebar and conversation pane.
3. Service owners (for the fix): `@deepseek-ai/dsh-client-ui-session` declares the
   `sessions` service; `@deepseek-ai/dsh-client-ui-layout` declares `layout` (grep of the
   shipped `lib/client.js` on 0.1.5-rc.1).

The settings watch works ONLY because ticket 46 used a different idiom: a runtime
`ctx.inject(["settingsScope"], cb)` whose child read is inside the injected scope. `layout`
and `sessions` have no such wrapper.

## Requirements (fix direction; final call belongs to the implementer)

1. Make the `layout` and `sessions` reads survive the real context semantics: either declare
   both services in `dsh.client.inject` (they are optional faces of always-shipped host
   packages, so the inject list stays materializable), or reach them through the same runtime
   `ctx.inject([...])` wrapper the settings watch uses. A property read that throws must not
   be described as "optional" in comments unless the mechanism actually tolerates absence.
2. Decide per-service: `sessions` is load-bearing for 79/80's projections (declare or wrap);
   `layout` is genuinely optional (the chip must reach its honest `no-layout` outcome when
   absent — not throw).
3. Offline fakes must model the throw-on-uninjected semantics so a regression fails without a
   live host (the same lesson as tickets 44 and 46: the fakes taught us a contract the host
   does not have).
4. No changes to the shell stores, registration contracts, or the cutover plan.

## Acceptance criteria

- [x] (offline, gate) fakes throw on uninjected service reads; the mount path passes with the
      declared/wrapped injects; `npm test`, `npm run typecheck`, `npm run build:client` green.
- [ ] (live, ZERO LLM calls) clicking the launcher chip opens the shell `main` page
      (`[data-shell="dispatcher"]` present, sidebar + seat render), zero pageerrors, on a
      real profile boot.

## Notes

- Found in the same pass that proved the chip itself renders and stacks correctly (ticket 78
  comment, 2026-09-19) — the registration contracts are fine; only the service access dies.
- Filed by the live-pass agent per the no-hot-patch rule; no product files were changed
  during the pass.

## Comments

- **2026-09-19 (agent, fix landed `154e7c7`)** — offline AC ticked; the live AC stays open
  for live pass 3 (zero LLM calls). Mechanism CORRECTION vs the ticket's root-cause text,
  established by reading the installed 0.1.5-rc.1 tree read-only:
  - The enforcement is pure vendored-cordis: the context proxy get trap builds
    `cannot get property "${prop}" without inject` (`@deepseek-ai/cordis/src/reflect.ts:144`),
    enforces it on every plugin-fiber read (`reflect.ts:152` — only non-runtime contexts read
    leniently), and resolves DECLARED services through the fiber's inject snapshot
    (`reflect.ts:159`; `fiber.ts:614/647` — `store = {...this._store}`, filled only for
    `Object.keys(this.inject)`). The declaration is the module's EXPORTED `inject` array:
    `registry.ts:330` builds the fiber with `Inject.resolve(plugin.inject)`. Shipped idiom:
    `dsh-client-ui-session/lib/client.js:314` exports `inject = ["sessions", "slots"]` — the
    provider itself declares the service it reads property-style.
  - `dsh.client.inject` in package.json is a PACKAGE list used ONLY for bundle-arrival
    graph ordering (`dsh-client-modules/lib/index.js:145-153`; `lib/client.js:265-268` —
    `arriveGraphRow`); it does NOT authorize service reads, so it was left unchanged.
  - `ctx.inject([...], cb)` works undeclared because it is a mixin accessor over the
    context's OWN `registry` property (`reflect.ts:221`; own props at `context.ts:74-83`) —
    the same reason ticket 46's settings watch works live.
- **2026-09-19 (agent, fix landed `154e7c7`)** — What changed, per service:
  - DECLARED in the exported inject (hard, always-shipped, load-bearing): `sessions`,
    `remote`, `conversation` (providers: ui-session; api-gateway `lib/client.js:1420`
    `super(ctx, "remote")`; ui-conversation `lib/client.js:2857`
    `super(ctx, "conversation")`). The `ctx.sessions === undefined` guards in
    `mountShellPage` remain as offline-fake tolerance; on the host the read cannot throw.
  - WRAPPER (genuinely optional — a hard inject would hold the module PENDING and kill the
    honest `no-layout` outcome): `layout` is now watched via `ctx.inject(["layout"], cb)`
    (the settings-watch idiom) into a `createShellLauncherLayout` cell
    (`src/client/shell-mount.ts`); the click reads the cell, absence degrades to
    `no-layout`, the wrapper's disposer drops the face on unload. `settingsScope` stays
    wrapper-only as before.
  - Fakes: scaffold + coexistence client fakes now throw on undeclared service reads
    (`cannot get property "X" without inject`), and new tests prove apply() over that guard
    touches no undeclared face — including with a layout fake sitting on the context
    (shell-mount guard test). Runtime-inject request pins updated to
    `[["settingsScope"], ["layout"]]` (roster-panel / settings-card / onboarding).
  - Gates: `npm test` 1014 pass / 0 fail (~122 s), `npm run typecheck` green,
    `npm run build:client` green (client/index.js 157,596 bytes).
- **2026-09-19 (live pass 3, `C:\Users\TZhen\Desktop\dsh-live-pass3-2026-09-19\`)** — this
  ticket's fix is CONFIRMED live in the narrow sense: the session's only page error is the
  root-slot registration throw (ticket 85); **zero `cannot get property … without inject`
  errors** — the declared `sessions`/`remote`/`conversation` reads and the wrapped
  `layout` watch all passed the real host's context semantics, and the module factory ran
  to the registration step. The live AC (launcher click opens the shell page, zero
  pageerrors) still FAILS: the 78 cutover's no-priority `root` registration aborts the
  whole loader entry before any chip or page exists (fail-loud screen, no composer, no
  stock app). Stays `open/` on 85; this ticket's own mechanism needs no further work.
