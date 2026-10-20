/**
 * Key grammar for the roster mirror family (ticket 79, ADR-0019 keying).
 *
 * The settings-document channel that wrote these keys is gone: 0.2.1's
 * settings service rejects undeclared keys (`Config field "roster" is not
 * volatile`) and has no scope-registration API. The client read-sides that
 * parse `roster.<sessionId>` still exist in the tree under ADR-0024, so the
 * key grammar stays here as plain string functions with no channel behind it.
 */

/** Key prefix carrying the per-session roster mirror. */
export const ROSTER_SESSION_KEY_PREFIX = "roster.";

/** The per-session mirror key for one dispatcher session. */
export function rosterSessionKey(sessionId: string): string {
  return `${ROSTER_SESSION_KEY_PREFIX}${sessionId}`;
}

/**
 * The session id a per-session mirror key names, or `null` when the key is
 * not a session mirror (the legacy whole-snapshot key `roster` does not match
 * the dotted prefix, so the two families never collide).
 */
export function sessionOfRosterKey(key: string): string | null {
  return key.startsWith(ROSTER_SESSION_KEY_PREFIX)
    ? key.slice(ROSTER_SESSION_KEY_PREFIX.length)
    : null;
}
