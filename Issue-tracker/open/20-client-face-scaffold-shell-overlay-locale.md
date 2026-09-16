# 20 — Client-face scaffold: web bundle, shell.overlay hello-world, locale namespace

**Blocked by:** None — can start immediately (independent of #19).
**Status:** open

## Problem

Every visual surface the dispatcher could claim (roster overlay, steer dock, per-worker toolviews) lives on dsh's *client face* — but this repo is a host-only plugin: `package.json` exports only the Node entry and declares no `dsh.client` record. Design 16 (§4.2, §2 table) needs the client scaffold before any surface ticket can build on it.

## What to do

- [ ] Add the client declaration to `package.json` per the seam contract (`docs/research/dsh-plugin-ui-patterns.md` Finding 4): `dsh.client: {platform: "web"}` plus `exports["./client"]` pointing at a built browser bundle. Keep the host `.` export untouched.
- [ ] Add a minimal build path for the client bundle (bundler of choice; output must register via the module loader idiom: `window.__ModuleLoader__.load({id, factory})` — Finding 4). The host `tsc` build stays as is; do not couple the two builds.
- [ ] Client `apply(ctx)` registers a **hello-world** entry into `shell.overlay` (list slot — additive, order-sorted, click-through by default; Finding 5 / `registry.d.ts:16-38`) via the universal idiom: `ctx.slots.inject(<parent>, () => ctx.slots.register({id, order}, Comp))`. Entry id `multitask-dispatcher-` prefixed (design §5).
- [ ] Register a locale namespace: `ctx.locale.register("multitask-dispatcher", {en, zh})` (Finding 6) and declare it on slot entries so the kit's `t` seat binds.
- [ ] Keep the scaffold inert: the hello-world renders only a labeled placeholder panel (new clean-room copy, e.g. "Dispatcher") and registers **nothing else** — no shipped slot keys, never `root`, no shadowing elections (design §5 "never registered" list).
- [ ] Tests: pure logic only under `node --test` (e.g. the slot registration options object builder, locale dictionary shape). Component rendering is covered by build success + typecheck — no DOM test harness in v1. All existing tests stay green offline (S8).
- [ ] Document in the ticket comments what the integration verification requires (load into a live dsh web UI per Finding 4's boot graph) — that live check is explicitly out of scope here (offline repo), but the scaffold must be shaped for it.

## Constraints

- Offline tests only (S8); no network, no LLM, no running dsh.
- Clean-room: all panel copy, ids, and code new; never open the `reference material-NOT LICENSE SAFE DONT COPY-grok bot/` tree.
- Registration must be fiber-scoped/reversible (every `ctx.slots.register`/`ctx.locale.register` inside the client plugin's `apply` effects) so unload/HMR reverses it (Findings 1/2/5 lifecycle).
- Do not claim `main`, `sidebar.right.pane.tab`, or `conversation.approval.detail` in this scaffold (design §2 rejected list / §5).
