/**
 * Per-tool call row styling (ticket 169).
 *
 * Ticket 24's renderer (`toolview-panel.tsx`) built `__field`, `__field-label`
 * and `__field-value` class names from the very first day, but no stylesheet
 * anywhere defined them: no `<style>` element was rendered with the row and
 * no CSS constant existed. Every field span therefore stayed an inline box,
 * and a row reading four things rendered as one unbroken string —
 * `Worker063f41a2…TitleAdd stale-build…Outcomeok` (ticket 169's owner paste).
 *
 * The fix is structural, in three independent layers, so a single lost rule
 * cannot put the collapse back:
 *
 * 1. **Block layout.** The row is a flex column and each field is a flex row,
 *    so label and value are separate boxes even with every declaration below
 *    removed (a flex child is a block-level box, not an inline run).
 * 2. **A gap.** `gap` puts space between label and value, and between fields.
 * 3. **A separator element** (`__sep`, the row renders it between fields). It
 *    is real markup, so it survives any stylesheet loss entirely.
 *
 * Colours use the host's shared token layer (`--dsw-alias-*`, defined on
 * `body` by the shipped theme stylesheet — research Finding 6 / ticket 49), so
 * the row is theme-correct with no service bind and no private palette. The
 * label tone is `label-tertiary`, the same muted role the roster panel and the
 * approval card already use for field labels; the separator dot uses
 * `label-caption`, the shipped tool row's own separator colour.
 *
 * Live-tested by-eye pins and the theme-token rules live in
 * `test/client-toolviews.test.ts` (rendered markup) and
 * `test/client-theme-tokens.test.ts`.
 */

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const TOOLVIEW_CLASS = "multitask-dispatcher-toolview";

/**
 * Row styles (ticket 169). Every colour is a host `--dsw-alias-*` token; no
 * raw colour literal, no token fallback, no animation.
 */
export const TOOLVIEW_CSS = `
.${TOOLVIEW_CLASS}{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0}
.${TOOLVIEW_CLASS}__field{display:flex;align-items:baseline;gap:6px;min-width:0}
.${TOOLVIEW_CLASS}__field-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.${TOOLVIEW_CLASS}__field-value{min-width:0;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__sep{flex:none;width:2px;height:2px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.${TOOLVIEW_CLASS}__rows{flex-basis:100%;display:flex;flex-direction:column;gap:3px;margin:2px 0 0;padding:0;list-style:none;min-width:0}
.${TOOLVIEW_CLASS}__row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0}
.${TOOLVIEW_CLASS}__row-id{flex:none;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__row-title{min-width:0;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__row-status{flex:none;color:var(--dsw-alias-label-tertiary)}
.${TOOLVIEW_CLASS}__row-activity{min-width:0;opacity:.75;overflow-wrap:anywhere}
.${TOOLVIEW_CLASS}__degraded{opacity:.6}
`;
