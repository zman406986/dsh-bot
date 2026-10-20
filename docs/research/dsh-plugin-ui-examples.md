# Research: how third-party dsh plugins build browser UI elements

- Question: How do real, shipped dsh plugins construct browser UI (sidebars, panels, cards, toggles)? What patterns should the dispatcher capsule UI adopt?
- Scope: three public plugin pages on deepseekplugin.com (fetched 2026-09-18). Host tree already read directly (`dsh-client-modules`, `dsh-client-ui-renderer`); this note adds the plugin-author perspective. **Clean-room caution: these are third-party codebases with mixed licenses (MIT / BSD-3-Clause / MIT-code+CC-BY-NC-SA-art, one page flagged "No license"). Pattern references only — never vendor or transliterate their source, names, or assets.**
- Method: WebFetch of the three plugin pages; cross-checked against `docs/research/dsh-plugin-ui-patterns.md` (host-tree findings) and the materialization code path in `@deepseek-ai/dsh-client-modules` (see ticket 34).

## Finding 1 — Better Sidebar: native slots plus an extension service, not its own floating UI

Source: https://deepseekplugin.com/plugins/omdsh-dev-dsh-better-sidebar (MIT, repo github.com/omdsh-dev/DSH-better-sidebar).

- Registers tabs into dsh's **native right sidebar** (`ctx.sidebarRightTabs` / tab-title slot `sidebar.right.pane.tab.title`); opens resources via `ctx.sidebarRight.openResource('dsh-resource://file/…')`. Earlier versions drew their own floating right panel — **removed in v0.19.0 in favor of native slots**. Lesson: prefer the built-in surface the dsh shell already provides over drawing your own floating UI when a suitable slot exists.
- Exposes its own extension service (`ctx.betterSidebar.registerTab(...)`, `inject: ['betterSidebar']`) so OTHER plugins extend it — slots plus a service, which is the standard Cordis pattern for a plugin that both fills slots and offers its own service.
- Bottom-panel toggle button lives in the session-header **utilities slot** (`conversation.session.header.utilities`), not in the panel itself.
- Build shape: two bundles (`lib/index.js` host + `lib/client.js` client), `dsh.client.inject` referenced as a real requirement, chunked lazy loading, `pnpm test:mount` — **a real headless-browser test that the UI mounts**. Responsive: <768px merges panels into the sidebar drawer.
  - **2026-09-18, confirmed at repo level** (ticket 36, `dsh-capsule-seams.md` mount-test section): shallow-cloned the public repo (pattern-only) — the mount test is a shell script that starts a real dsh web instance with the plugin installed through the official channel and exports the URL through an environment variable; Playwright runs headless Chromium serially (1 worker, 0 retries) as a check that the UI does not crash; end-to-end specs live in files separate from the offline unit tests.

## Finding 2 — Visualize: the tool-call card surface

Source: https://deepseekplugin.com/plugins/nagi-ovo-dsh-visualize (BSD-3-Clause, repo github.com/Nagi-ovo/dsh-visualize).

- Adds no panels at all: the model calls a `visualize` tool and the web client renders an **interactive card inline in the conversation stream**, restored from the persisted tool result on replay (never from the fragment file).
- Sandboxing discipline: iframes with an opaque origin, Content-Security-Policy blocking network requests and forms; the theme follows the shell.
- Lesson for us: rendering per tool call is a first-class surface that survives replay — our five dispatcher tool views (ticket 24) should follow the same rule: render from saved state, not from state that disappears on reload.

## Finding 3 — Deep Whale: install/toggle discipline and the client boot check

Source: https://deepseekplugin.com/plugins/small-tailqwq-dsh-deep-whale (MIT code, CC BY-NC-SA art; page flags "No license" + network access — treat as pattern-only).

- Each skin registers under its own id; toggling is done with `disabled:` rows in the profile patch layers — **the toggle is config, not code**, and changes take effect on hot reload.
- Verifies client loading by checking the served page's outer HTML for `/plugins/<real-package-name>/client.js` — a concrete, scriptable **"is my client bundle actually being served and started" check** (older dsh starts via `window.__DSH_BOOT__` JSON, newer via a direct `<script src>`).
- Mutual exclusion: two stacking decoration layers break the shell; the manager detects double-enable and falls back atomically. Lesson: extra entries added to a slot (`shell.overlay`) are safe to stack; surfaces that take over a region of the shell are not.

## Finding 4 — Cross-cutting: the client module must be materialized (connects to ticket 34)

All three plugins are installed into the profile's package tree (`dsh plugin add`), so their client bundles are served and started by the normal composition. Our path-insert dev route loads the host side, but (before ticket 34) it has **no way to get the client module materialized**: our `dsh.client` record carries no `inject` and no `immediately: true`, and nothing else requires our package id, so the browser registers our factory and never runs it (`dsh-client-modules/lib/client.js` `arriveGraphRow` follows `inject` edges; startup only runs `immediately` rows). Any UI epic builds on this fix.

## Consequences

1. The dispatcher control surface should be an **additional `shell.overlay` capsule** (already our registered pattern, safe to stack, hot-reload friendly) — not a takeover of the right sidebar.
2. Toggle-on/off belongs in config and activation state (`/dispatcher-start` model, ADR-0009), rendered truthfully by the capsule — not a second independent switch.
3. Testing must include a real-browser mount check (Playwright) plus the served-page bundle-presence check from Finding 3.
4. Use these as pattern references only; borrow no source from the three plugin repos (mixed licenses, one flagged).
