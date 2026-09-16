# 20 — Client-face scaffold: web bundle, shell.overlay hello-world, locale namespace

**Blocked by:** None — can start immediately (independent of #19).
**Status:** open

## Problem

Every visual surface the dispatcher could claim (roster overlay, steer dock, per-worker toolviews) lives on dsh's *client face* — but this repo is a host-only plugin: `package.json` exports only the Node entry and declares no `dsh.client` record. Design 16 (§4.2, §2 table) needs the client scaffold before any surface ticket can build on it.

## What to do

- [x] Add the client declaration to `package.json` per the seam contract (`docs/research/dsh-plugin-ui-patterns.md` Finding 4): `dsh.client: {platform: "web"}` plus `exports["./client"]` pointing at a built browser bundle. Keep the host `.` export untouched.
- [x] Add a minimal build path for the client bundle (bundler of choice; output must register via the module loader idiom: `window.__ModuleLoader__.load({id, factory})` — Finding 4). The host `tsc` build stays as is; do not couple the two builds.
- [x] Client `apply(ctx)` registers a **hello-world** entry into `shell.overlay` (list slot — additive, order-sorted, click-through by default; Finding 5 / `registry.d.ts:16-38`) via the universal idiom: `ctx.slots.inject(<parent>, () => ctx.slots.register({id, order}, Comp))`. Entry id `multitask-dispatcher-` prefixed (design §5).
- [x] Register a locale namespace: `ctx.locale.register("multitask-dispatcher", {en, zh})` (Finding 6) and declare it on slot entries so the kit's `t` seat binds.
- [x] Keep the scaffold inert: the hello-world renders only a labeled placeholder panel (new clean-room copy, e.g. "Dispatcher") and registers **nothing else** — no shipped slot keys, never `root`, no shadowing elections (design §5 "never registered" list).
- [x] Tests: pure logic only under `node --test` (e.g. the slot registration options object builder, locale dictionary shape). Component rendering is covered by build success + typecheck — no DOM test harness in v1. All existing tests stay green offline (S8).
- [x] Document in the ticket comments what the integration verification requires (load into a live dsh web UI per Finding 4's boot graph) — that live check is explicitly out of scope here (offline repo), but the scaffold must be shaped for it.

## Constraints

- Offline tests only (S8); no network, no LLM, no running dsh.
- Clean-room: all panel copy, ids, and code new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- Registration must be fiber-scoped/reversible (every `ctx.slots.register`/`ctx.locale.register` inside the client plugin's `apply` effects) so unload/HMR reverses it (Findings 1/2/5 lifecycle).
- Do not claim `main`, `sidebar.right.pane.tab`, or `conversation.approval.detail` in this scaffold (design §2 rejected list / §5).

## Comments

**2026-09-17 — agent team (ticket 20 implemented)**

What landed (commit of record: see git log "Scaffold client face module for dispatcher UI (ticket 20)"):

- `package.json`: `dsh.client: {platform: "web", external: ["react", "react/jsx-runtime"]}`, `exports["./client"] -> ./client/index.js`, `files` + `client`, new scripts `build:client` and a two-config `typecheck` (host + `tsconfig.client.json`). Host `.` export untouched.
- `src/client/` (browser module, clean-room): `index.ts` (client `apply` + `inject: ["slots", "locale"]`, shipped idiom), `overlay.ts` (pure `shell.overlay` options builder + `multitask-dispatcher` locale dictionary `{en, zh}` + shape validator), `panel.tsx` (zero-prop placeholder component bound to `ctx.locale.bind(ns)`; copy: "Dispatcher" / "Panel scaffold — no live worker status yet." + zh translations), `context.ts` (structural `ctx.slots`/`ctx.locale`/`ctx.effect` types), `wrapper.ts` (loader-shell template, id = package name).
- `scripts/build-client.ts`: esbuild → CJS (`--external:react*`, react is a platform static seed in `dsh-web-frontend`'s module table) wrapped in `window.__ModuleLoader__.load({id, factory})` exactly as shipped bundles emit. Output `client/index.js` (gitignored build artifact).
- Registration surface: exactly two reversible registrations — locale namespace `multitask-dispatcher`, and slot entry `multitask-dispatcher-hello` into `shell.overlay` (order 100 placeholder; ticket 21 owns real ordering). No `main`, no `sidebar.right.pane.tab`, no `conversation.approval.detail`, never `root`.
- Tests: `test/client-face-scaffold.test.ts` — 13 new tests; suite 342 passing / 0 fail (was 329). Typecheck clean for both configs; host `npm run build` and `npm run build:client` both verified.

Contracts were pinned against the installed dsh 0.1.5-rc.1 shipped source (same citation basis as the research doc; the forbidden reference tree was not opened): loader wrapper shape (`dsh-client-ui-agent-preset lib/client.js` head/tail), `ctx.effect(execute, label)` executes immediately and collects the returned disposer (`cordis lib/index.js:1168, 1141-1143`), `slots.inject/register` + `locale.bind` idiom, react seed table (`dsh-web-frontend dist/assets/index-*.js`).

Integration verification (explicitly out of scope here — needs a live dsh web UI per Finding 4's boot graph; note research Finding 0: the profile must first be re-created):
1. Plugin with the `dsh.client` record is scanned and its combo bundle served (`/plugins/??…`); factory registers without a "resolves from multiple active Loader sources" error.
2. The shipped `shell.overlay` declaration arrives → our inject callback fires → the hello panel renders (click-through, order-sorted).
3. Client HMR/fiber swap reverses locale ns + entry, then re-registers (offline fake covers the logic; live check confirms the vendored loader behaves the same).
4. Panel copy resolves through the kit `t` seat in both en and zh.

Handover notes / seam gaps:
- No client-side conflict surface to test offline: slot-list registration is additive, and the fail-loud rules live host-side (settings ns, command names) / loader-side (duplicate factory registration). The scaffold's single prefixed id makes conflicts unreachable by construction.
- React delivery is pinned to the verified static-seed table; if integration shows a different mechanism, only `dsh.client.external` + the esbuild externals list need adjusting.
- esbuild's postinstall was blocked by this environment's allow-scripts gate; the platform binary from optionalDependencies works — no action needed.
- `client/index.js` is a build output (gitignored); `exports["./client"]` resolves only after `npm run build:client`, same discipline as `lib/` for the host face.
