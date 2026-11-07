/**
 * Per-tool call row styling (ticket 169; regenerated for the readable-status
 * anatomy).
 *
 * The row is three stacked levels, and the layout is structural so a lost
 * rule cannot collapse it:
 *
 * 1. `__primary` — one sentence, its own block;
 * 2. `__facts` — at most two facts joined by the shared ` · ` separator,
 *    again their own block;
 * 3. `__details` — a native `<details>` with a `<dl>`; the only place full
 *    ids and raw values live.
 *
 * `check_workers` rows are a fourth structure inside the same body: one
 * `<li>` per worker, title first, one status word, facts, optional activity
 * on its own line, and the short ref last.
 *
 * Colours use the host's shared token layer (`--dsw-alias-*`), so the row is
 * theme-correct with no service bind and no private palette. Only
 * `label-tertiary` is used (the muted role the roster panel already uses).
 * Live-tested pins and the theme-token rules live in
 * `test/client-toolviews.test.ts` and `test/client-theme-tokens.test.ts`.
 */

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const TOOLVIEW_CLASS = "multitask-dispatcher-toolview";

/**
 * Row styles. Every colour is a host `--dsw-alias-*` token; no raw colour
 * literal, no token fallback, no animation.
 */
export const TOOLVIEW_CSS = `
.${TOOLVIEW_CLASS}{display:flex;flex-direction:column;gap:3px;min-width:0}
.${TOOLVIEW_CLASS}__body{display:flex;flex-direction:column;gap:3px;min-width:0}
.${TOOLVIEW_CLASS}__primary{font-weight:500;min-width:0;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__facts{min-width:0;opacity:.75;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__rows{display:flex;flex-direction:column;gap:4px;margin:2px 0 0;padding:0;list-style:none;min-width:0}
.${TOOLVIEW_CLASS}__row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0}
.${TOOLVIEW_CLASS}__row-title{font-weight:500;min-width:0;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__row-status{flex:none;color:var(--dsw-alias-label-tertiary)}
.${TOOLVIEW_CLASS}__row-facts{min-width:0;opacity:.75;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__row-activity{flex-basis:100%;min-width:0;opacity:.7;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__row-ref{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__details{font-size:11px;opacity:.75;min-width:0}
.${TOOLVIEW_CLASS}__details > summary{cursor:pointer;color:var(--dsw-alias-label-tertiary)}
.${TOOLVIEW_CLASS}__details dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;margin:3px 0 0}
.${TOOLVIEW_CLASS}__details dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.${TOOLVIEW_CLASS}__details dd{margin:0;min-width:0;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__degraded{opacity:.6}
`;
