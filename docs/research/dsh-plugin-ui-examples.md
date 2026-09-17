# Research: how third-party dsh plugins build browser UI elements

- Question: How do real, shipped dsh plugins construct browser UI (sidebars, panels, cards, toggles)? What patterns should the dispatcher capsule UI adopt?
- Scope: three public plugin pages on deepseekplugin.com (fetched 2026-09-18). Host tree already read directly (`dsh-client-modules`, `dsh-client-ui-renderer`); this note adds the plugin-author perspective. **Clean-room caution: these are third-party codebases with mixed licenses (MIT / BSD-3-Clause / MIT-code+CC-BY-NC-SA-art, one page flagged "No license"). Pattern references only — never vendor or transliterate their source, names, or assets.**
- Method: WebFetch of the three plugin pages; cross-checked against `docs/research/dsh-plugin-ui-patterns.md` (host-tree findings) and the materialization code path in `@deepseek-ai/dsh-client-modules` (see ticket 34).

## Finding 1 — Better Sidebar: native slots + an extension service, not floating chrome

Source: https://deepseekplugin.com/plugins/omdsh-dev-dsh-better-sidebar (MIT, repo github.com/omdsh-dev/DSH-better-sidebar).

- Registers tabs into dsh's **native right sidebar** (`ctx.sidebarRightTabs` / tab-title slot `sidebar.right.pane.tab.title`); opens resources via `ctx.sidebarRight.openResource('dsh-resource://file/…')`. Earlier versions drew their own floating right panel — **removed in v0.19.0 in favor of native slots**. Lesson: prefer the shipped shell surface over free-floating chrome when a suitable slot exists.
- Exposes its own extension service (`ctx.betterSidebar.registerTab(...)`, `inject: ['betterSidebar']`) so OTHER plugins extend it — slots + a service, the Cordis dual-face idiom.
- Bottom-panel toggle button lives in the session-header **utilities slot** (`conversation.session.header.utilities`), not in the panel itself.
- Build shape: dual bundle (`lib/index.js` host + `lib/client.js` client), `dsh.client.inject` referenced as a real requirement, chunked lazy loading, `pnpm test:mount` — **a real headless-browser mount smoke test**. Responsive: <768px merges panels into the sidebar drawer.
  - **2026-09-18, confirmed at repo level** (ticket 36, `dsh-capsule-seams.md` mount-test section): shallow-cloned the public repo (pattern-only) — the mount lane is a shell script that boots a real dsh web instance with the plugin installed via the official channel and exports the URL via env; Playwright runs headless Chromium serially (1 worker, 0 retries) as a crash probe; e2e specs are filename-separated from the offline unit lane.

## Finding 2 — Visualize: the tool-call card surface

Source: https://deepseekplugin.com/plugins/nagi-ovo-dsh-visualize (BSD-3-Clause, repo github.com/Nagi-ovo/dsh-visualize).

- Adds no panels at all: the model calls a `visualize` tool and the web client renders an **interactive card inline in the conversation stream**, restored from the persisted tool result on replay (never from the fragment file).
- Sandboxing discipline: opaque-origin iframes, CSP blocking network/forms; theme follows the shell.
- Lesson for us: per-tool-call rendering is a first-class, replay-safe surface — our five dispatcher tool views (ticket 24) should follow the same "render from persisted state, not ephemeral" rule.

## Finding 3 — Deep Whale: install/toggle discipline and the client boot check

Source: https://deepseekplugin.com/plugins/small-tailqwq-dsh-deep-whale (MIT code, CC BY-NC-SA art; page flags "No license" + network access — treat as pattern-only).

- Each skin registers under its own id; toggling is done with `disabled:` rows in the profile patch layers — **config-layer toggles, no code switch**, hot-reloaded.
- Verifies client loading by checking the served page's outer HTML for `/plugins/<real-package-name>/client.js` — a concrete, scriptable **"is my client bundle actually being served and booted" check** (older dsh boots via `window.__DSH_BOOT__` JSON, newer via direct `<script src>`).
- Mutual-exclusion: two stacking decoration layers break the shell; the manager detects double-enable and atomically falls back. Lesson: additive slot entries (`shell.overlay`) are safe to stack; takeover surfaces are not.

## Finding 4 — Cross-cutting: materialization is the gate (connects to ticket 34)

All three plugins are installed into the profile's package tree (`dsh plugin add`), so their client bundles are served and booted by the normal composition. Our path-insert dev route loads the host face but (pre-ticket-34) has **no materialization edge** for the client module: our `dsh.client` record carries no `inject` and no `immediately: true`, and nothing else requires our package id, so the browser registers our factory and never runs it (`dsh-client-modules/lib/client.js` `arriveGraphRow` walks inject edges; bootstrap = `immediately` rows only). Any UI epic builds on this fix.

## Consequences

1. The dispatcher control surface should be an **additive `shell.overlay` capsule** (already our registered idiom, safe to stack, hot-reload friendly) — not a right-sidebar takeover.
2. Toggle-on/off belongs in config/activation state (`/dispatcher-start` model, ADR-0009), rendered honestly by the capsule — not a second switch layer.
3. Testing must include a real-browser mount check (Playwright) plus the served-page bundle-presence check from Finding 3.
4. Pattern references only; zero source borrowing from the three plugin repos (mixed licenses, one flagged).
