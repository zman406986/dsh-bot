/**
 * Ticket 285: the display form of a model-authored value.
 *
 * Both the resolver's process warning and the tool-result notes/ack are
 * model-facing surfaces. A long value, a newline, or a quote must not bloat
 * the tool result or forge lines there, so every surface builds its display
 * text through this one helper. The bound matches the plan's log-safe slice
 * (§3.4) and is deliberately shared: two different truncations would let the
 * warning and the notice describe the same input differently.
 *
 * This module lives in core because both layers need it: the core tool layer
 * builds `ModelFallbackNotice.requested` and the note copy, while the adapter
 * resolver (model-option.ts) writes the warning. Keeping it dependency-free
 * preserves the resolver's pure, offline-testable shape.
 */

/** Longest display-safe slice of the model-authored value (plan §3.4). */
export const MODEL_OPTION_VALUE_MAX_CHARS = 120;

/** Control characters, including line separators, become spaces. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Replace control characters with spaces and truncate the display value. */
export function sanitizeModelOptionValue(raw: string): string {
  const replaced = raw.replace(CONTROL_CHARS, " ");
  return Array.from(replaced)
    .slice(0, MODEL_OPTION_VALUE_MAX_CHARS)
    .join("");
}
