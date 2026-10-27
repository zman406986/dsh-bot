/**
 * Peer display label for the prompt-tail roster (ticket 155, ADR-0027
 * decisions 2–3).
 *
 * ADR-0027 names `subagent.label` as the durable human-readable label and
 * reads it from the session projection (`projectionValues.subagent.label`);
 * the display fallback is label → session title → session id. This module
 * supplies the FIRST step, on the same registry this plugin already reads for
 * its own `sessionKind` unit (`stateOf(session, key)`,
 * `dsh-session-projection/lib/types/index.d.ts:126-131` — synchronous,
 * materializing, `undefined` for an unregistered key):
 *
 * `subagent` — the subagent identity fold, state
 * `{ identity?: { mode, label?, seq } }`; `label` is required on
 * `continuable` children, which is every child this plugin spawns
 * (`dsh-subagent/lib/types/projection.d.ts:73-76`,
 * `dsh-subagent/lib/index.js:2732-2745`).
 *
 * The TITLE step is deliberately NOT taken (recorded in ticket 155): the
 * host's title projection is an auto-generated conversation title that keeps
 * changing, it is mounted for every session, and wiring it would rename
 * every user-started dispatcher's row — which the ticket's acceptance
 * forbids ("a peer with no label renders its id"). It would also add
 * unbounded text to a prompt tail whose label has no clamp.
 *
 * Nothing is stored here and nothing is polled: each call is one synchronous
 * registry read at prompt-assembly time, and any absence (no registry, key
 * not mounted, malformed state, a throw) answers null so the caller's
 * fallback chain continues instead of inventing a name. This is the
 * plugin-side half ADR-0027 assumed was reachable; the adapter holds no
 * plugin context, so `plugin.ts` resolves the registry through its guarded
 * `ctx.get("sessionProjections")` and passes this function down.
 */

import type { HostSessionProjectionsLike } from "./session-kind-projection.js";

/** Projection key carrying the subagent identity (host-owned). */
export const SUBAGENT_PROJECTION_KEY = "subagent";

/** Collapse whitespace and trim; empty → null (the roster's one-line rule). */
function oneLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}

/**
 * The durable `subagent.label` of one session, or null. Reads the host state
 * (`{ identity?: { label?: string } }`), not the wire view, so a child whose
 * descriptor failed to fold answers null like any other unreadable case.
 */
export function subagentLabelOf(
  registry: HostSessionProjectionsLike | undefined,
  session: unknown,
): string | null {
  if (registry === undefined || typeof registry.stateOf !== "function") {
    return null;
  }
  let state: unknown;
  try {
    state = registry.stateOf(session, SUBAGENT_PROJECTION_KEY);
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null) return null;
  const identity = (state as { identity?: unknown }).identity;
  if (typeof identity !== "object" || identity === null) return null;
  return oneLine((identity as { label?: unknown }).label);
}
