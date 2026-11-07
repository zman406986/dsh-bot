/**
 * Peer display label for the prompt-tail roster (ticket 155, ADR-0027
 * decisions 2–3).
 *
 * ADR-0027 names `subagent.label` as the durable human-readable label and
 * reads it from the session projection (`projectionValues.subagent.label`);
 * the display fallback is label → session title → session id. This module
 * supplies the FIRST step, on the same registry this plugin already reads for
 * its own `sessionKind` unit.
 *
 * `subagent` — the subagent identity fold, state
 * `{ identity?: { mode, label?, seq } }`; `label` is required on
 * `continuable` children, which is every child this plugin spawns
 * (`dsh-subagent/lib/types/projection.d.ts:73-76`,
 * `dsh-subagent/lib/index.js:2732-2745`).
 *
 * Read face (dsh 0.2.2 migration): this plugin does NOT own the `subagent`
 * key, so it cannot hold that registration's handle. The non-deprecated
 * complete read for a key you do not register is
 * `registry.snapshot(session, ["subagent"])`, which serves the unit's WIRE
 * view (`SubagentIdentityProjection | null`, the identity itself rather than
 * the raw `{ identity }` state). Older hosts without `snapshot` fall back to
 * the now-deprecated `registry.stateOf(session, key)`; both the member read
 * and the call are guarded, and both shapes are accepted.
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
 * not mounted, malformed state, an unknown identity mode, a throw) answers
 * null so the caller's fallback chain continues instead of inventing a name.
 * This is the plugin-side half ADR-0027 assumed was reachable; the adapter
 * holds no plugin context, so `plugin.ts` resolves the registry through its
 * guarded `ctx.get("sessionProjections")` and passes this function down.
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
 * One identity's label. The wire view and the raw state both carry the mode
 * enum `one-shot | continuable`; an unknown value is a schema this reader
 * does not understand, so it answers null instead of letting a future field
 * masquerade as a label.
 */
function labelOfIdentity(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const identity = value as Record<string, unknown>;
  const mode = identity["mode"];
  if (mode !== "one-shot" && mode !== "continuable") return null;
  return oneLine(identity["label"]);
}

/**
 * Accept BOTH shapes the two read faces can return:
 * - `snapshot` serves the wire view — the identity itself;
 * - the older `stateOf` serves the raw fold state — `{ identity }`.
 */
function labelOfProjectionValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const nested = record["identity"];
  if (typeof nested === "object" && nested !== null) {
    return labelOfIdentity(nested);
  }
  return labelOfIdentity(record);
}

/**
 * The `subagent` value out of a snapshot, or undefined when this registry
 * has no `snapshot` face at all (older host). A snapshot that exists but
 * omits the key means the unit is not mounted → null from the caller.
 */
function snapshotValueOf(
  registry: HostSessionProjectionsLike,
  session: unknown,
): { readonly mounted: boolean; readonly value: unknown } | undefined {
  let read: unknown;
  try {
    read = registry.snapshot;
  } catch {
    return undefined;
  }
  if (typeof read !== "function") return undefined;
  let snapshot: unknown;
  try {
    snapshot = (read as (session: unknown, keys?: readonly string[]) => unknown)
      .call(registry, session, [SUBAGENT_PROJECTION_KEY]);
  } catch {
    // A throwing complete read must not make the roster throw. Answer
    // unreadable rather than retrying the deprecated overload.
    return { mounted: false, value: undefined };
  }
  if (typeof snapshot !== "object" || snapshot === null) {
    return { mounted: false, value: undefined };
  }
  const values = (snapshot as { values?: unknown }).values;
  if (typeof values !== "object" || values === null) {
    return { mounted: false, value: undefined };
  }
  const record = values as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, SUBAGENT_PROJECTION_KEY)) {
    return { mounted: false, value: undefined };
  }
  return { mounted: true, value: record[SUBAGENT_PROJECTION_KEY] };
}

/**
 * Guarded deprecated read for hosts older than the handle/snapshot API.
 * Both the member read and the call are guarded — a live cordis context
 * throws on a member it never injected.
 */
function registryStateOf(
  registry: HostSessionProjectionsLike,
  session: unknown,
  key: string,
): unknown {
  let read: unknown;
  try {
    read = registry.stateOf;
  } catch {
    return undefined;
  }
  if (typeof read !== "function") return undefined;
  try {
    return (read as (session: unknown, key: string) => unknown).call(
      registry,
      session,
      key,
    );
  } catch {
    return undefined;
  }
}

/**
 * The durable `subagent.label` of one session, or null. Reads the wire view
 * when the host serves one (`snapshot`), else the raw state through the
 * deprecated overload; a malformed or unreadable answer is null like any
 * other absence.
 */
export function subagentLabelOf(
  registry: HostSessionProjectionsLike | undefined,
  session: unknown,
): string | null {
  if (
    registry === undefined ||
    (typeof registry !== "object" && typeof registry !== "function")
  ) {
    return null;
  }
  const snapshot = snapshotValueOf(registry, session);
  if (snapshot !== undefined) {
    return snapshot.mounted ? labelOfProjectionValue(snapshot.value) : null;
  }
  return labelOfProjectionValue(
    registryStateOf(registry, session, SUBAGENT_PROJECTION_KEY),
  );
}
