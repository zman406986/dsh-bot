/**
 * Shared approval-surface styling (ticket 81).
 *
 * The namespaced class prefix and the CSS block are all that survived the
 * ticket-174 / ADR-0033 removal of the worker access-ask feature: the
 * worker-dispatch card still renders inside this shell's visual contract
 * (namespaced classes, every colour a host `--dsw-alias-*` token,
 * opacity-based hierarchy, no animation, no text colour beyond the state
 * tokens). Keeping the block in one place means the two dispatch-card
 * surfaces cannot drift apart.
 */

/** Class prefix — ours, namespaced, no shipped kit classes. */
export const APPROVAL_CARD_CLASS = "multitask-dispatcher-approval";

/**
 * Card styles (ticket 81). Tokens referenced — all already evidenced by our
 * shipped surfaces: `border-l3` (hairlines, the dispatch card),
 * `label-tertiary` (muted field labels), `interactive-bg-hover`.
 */
export const APPROVAL_CARD_CSS = `
.${APPROVAL_CARD_CLASS}__field{display:flex;gap:6px;min-width:0}
.${APPROVAL_CARD_CLASS}__field-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.${APPROVAL_CARD_CLASS}__field-value{overflow-wrap:anywhere}
.${APPROVAL_CARD_CLASS}__dispatch{display:flex;flex-direction:column;gap:2px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;font-size:12px;min-width:0}
.${APPROVAL_CARD_CLASS}__dispatch-title{font-weight:600;overflow-wrap:anywhere}
`;
