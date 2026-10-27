/**
 * Session-kind projection (ticket 123): the durable host-side marker the
 * client reads as `projectionValues.sessionKind` to draw a dispatcher glyph.
 *
 * ## Why this seam
 *
 * dsh 0.2.1's session-projection registry (`ctx.sessionProjections`) drives
 * every registered unit eagerly over committed session events and publishes
 * a client-visible wire value per key
 * (`dsh-session-projection/lib/types/index.d.ts:24-30` for the service,
 * `:38-82` for `ProjectionDefinition`, `:150-160` for the two `register`
 * overloads). Registration is an effect on the calling fiber, so the key
 * disappears on unload, and the persisted projection cache checkpoints the
 * unit's plain-JSON state — which is what makes the mark survive a restart.
 *
 * ## What marks a dispatcher (mechanism: fold the host's own command log)
 *
 * `/dsh-bot` is the ONLY activation path today
 * (`src/adapter/activation-command.ts`, wired in `src/plugin.ts`). The host
 * command runtime appends a durable, declared pair to the INVOKING session's
 * log before and after the handler runs:
 *
 * - `command/run` with `{ commandId, name: "dsh-bot", args, source }`
 *   — appended at `dsh-commands/lib/index.js:334`, declared at
 *   `dsh-commands/lib/types/types.d.ts:101`;
 * - `command/done` with `{ commandId, kind: "success" | "error" }` — appended
 *   at `dsh-commands/lib/index.js:341`, declared at
 *   `dsh-commands/lib/types/types.d.ts:113`.
 *
 * So the marker already exists: no new event kind is invented, nothing is
 * appended by us (`appendPluginRecord` is gated to dsh's experimental
 * packages and is not needed here), and the activation that sets it is
 * per-session by construction — the event lands in that session's own log
 * (ADR-0019 keying).
 *
 * Rename durability (ADR-0030, 2026-10-21): the command was renamed from
 * `/dispatcher-start` to `/dsh-bot`. Logs persisted before the rename hold
 * the literal name `dispatcher-start`, so the fold below matches BOTH the
 * current name and that legacy name — a restart replay of an old log must
 * still mark the session as a dispatcher.
 *
 * Stop withdrawal durability (ADR-0030, ticket 129): the `/dispatcher-stop`
 * command is withdrawn — deactivation is now implicit only (host `agent/disposed`
 * teardown or plugin unload, neither of which writes a command settlement).
 * The fold below still matches the legacy literal `dispatcher-stop` so a
 * restart replay of a log persisted before the withdrawal keeps clearing the
 * mark on its recorded stop settlements; no new stop event can be produced.
 *
 * A refused start (`not-top-level`) and a thrown handler settle
 * `kind: "error"` and leave the prior state untouched — the fold never
 * fabricates a kind.
 *
 * Fail-closed: a `command/run` alone (host crash before settlement) does NOT
 * mark the session. We only mark when the paired `command/done` says the
 * handler succeeded.
 *
 * ## What the client sees
 *
 * Key {@link SESSION_KIND_PROJECTION_KEY} (`"sessionKind"`), wire value
 * `"dispatcher"`, or `null` for any session that is not a dispatcher
 * (workers are identified separately by `origin === "subagent"`; normal is
 * the null case). The list snapshot carries it under `projectionValues`
 * (`dsh-api-session-controller/lib/types/client/sessions/manager.js:701-709`;
 * the stock read is `dsh-client-ui-workspace/lib/client.js:1453`).
 *
 * ## Durability semantics
 *
 * The mark means "this session was established as a dispatcher and has not
 * been deactivated". A dsh restart clears the live activation but
 * writes nothing, so the fold still reports the session as a dispatcher;
 * a legacy `/dispatcher-stop` settlement in a persisted log (the command is
 * withdrawn since ADR-0030 / ticket 129 — deactivation is implicit now) still
 * clears it on replay. That is the agreed shape of "durable across restart"
 * for this indicator.
 *
 * All functions are synchronous and the state is plain JSON, as the unit
 * contract requires (projection-cache persistence precondition).
 */

import {
  DISPATCHER_START_COMMAND,
  LEGACY_DISPATCHER_START_COMMAND,
} from "./activation-command.js";

/** The projection key the client reads from `projectionValues`. */
export const SESSION_KIND_PROJECTION_KEY = "sessionKind";

/**
 * Persisted-cache invalidation version. Bump whenever the state fields or
 * fold semantics change (`ProjectionDefinition.stateVersion`).
 *
 * v2 (ticket 140, 2026-10-28): `init` consults the adapter's dispatcher-mark
 * mirror, so a spawned dispatcher child projects `"dispatcher"` from the
 * moment its session is created. A v1 row was folded without that source and
 * would durably cache the wrong kind for such a child, so the contract's
 * invalidation rule applies: discard v1 rows and refold the log.
 */
export const SESSION_KIND_PROJECTION_STATE_VERSION = 2;

/** The one wire value this unit publishes. */
export const DISPATCHER_SESSION_KIND = "dispatcher";

/** Client-visible marker value: `"dispatcher"`, or null for everything else. */
export type DispatcherSessionKind = typeof DISPATCHER_SESSION_KIND;

/**
 * Persisted-log name of the stop command before ADR-0030 / ticket 129
 * withdrew it (2026-10-21). No longer a live command — the fold matches this
 * literal only so replaying an old log still clears the mark.
 */
export const LEGACY_DISPATCHER_STOP_COMMAND = "dispatcher-stop";

/**
 * Host fold state. Plain JSON on purpose (the projection cache persists it).
 * `pending*` hold commandIds seen in `command/run` and not yet settled by
 * `command/done`; they let concurrent command transactions pair correctly.
 */
export interface SessionKindProjectionState {
  readonly active: boolean;
  readonly pendingStarts: readonly string[];
  readonly pendingStops: readonly string[];
}

/** The minimal structural event view the fold reads (never throws on junk). */
export interface SessionProjectionEventLike {
  readonly type: string;
  readonly data?: unknown;
}

/** Structural stand-in for the host's `ZodType` — only `parse` is used. */
export interface SessionProjectionSchemaLike<T> {
  parse(value: unknown): T;
}

/**
 * Structural `ProjectionDefinition` view (`dsh-session-projection/lib/types/index.d.ts:38-82`).
 * Kept local: this repo imports no host packages
 * (`docs/agents-rulebook.md` / adapter convention), and the registry only
 * calls these members.
 */
export interface SessionProjectionDefinitionLike<S> {
  readonly key: string;
  readonly stateSchema: SessionProjectionSchemaLike<S>;
  init(header: unknown, inheritedEventCount: number): S;
  apply(state: S, event: SessionProjectionEventLike): S;
  readonly wire: {
    readonly viewSchema: SessionProjectionSchemaLike<unknown>;
    view(state: S): unknown;
  };
  readonly stateVersion: number;
}

/**
 * Structural `ctx.sessionProjections` view: the `register` overload with a
 * wire view, plus the synchronous state read added by ticket 147.
 *
 * `stateOf(session, key)` materializes every registered unit at the session's
 * current log cursor and returns this unit's state, or `undefined` when the
 * key is not registered (`dsh-session-projection/lib/index.js:126-131`). It is
 * fully synchronous — that is why the resumed-dispatcher check rides it
 * instead of the asynchronous marker-store read.
 *
 * Optional member so stub registries in tests stay minimal; a registry
 * without it simply cannot answer the ticket-147 check.
 */
export interface SessionProjectionsRegistryLike {
  register(definition: SessionProjectionDefinitionLike<SessionKindProjectionState>): () => void;
  stateOf?(
    session: unknown,
    key: string,
  ): SessionKindProjectionState | undefined;
}

/** The child context `ctx.inject` hands back once the service is available. */
export interface SessionProjectionChildLike {
  readonly sessionProjections?: SessionProjectionsRegistryLike;
}

/**
 * Context surface used to register the unit. `inject` is the optional-route
 * the host documents for contributors
 * (`dsh-session-projection/lib/types/index.d.ts:125-140`: "Contributors may
 * preserve optional registration through `ctx.inject(['sessionProjections'],
 * ...)`"); the direct property is the stub-test fallback.
 */
export interface SessionProjectionHostLike extends SessionProjectionChildLike {
  inject?(
    services: readonly string[],
    callback: (child: SessionProjectionChildLike) => void,
  ): unknown;
}

/** Frozen empty state — shared, never mutated (every transition copies). */
export const INITIAL_SESSION_KIND_STATE: SessionKindProjectionState =
  Object.freeze({
    active: false,
    pendingStarts: Object.freeze([]) as readonly string[],
    pendingStops: Object.freeze([]) as readonly string[],
  });

/**
 * Frozen active state — the state a session whose id the dispatcher-mark
 * mirror already knows starts from (ticket 140). Shared, never mutated: the
 * fold copies on every transition, exactly like the initial state.
 */
export const ACTIVE_SESSION_KIND_STATE: SessionKindProjectionState =
  Object.freeze({
    active: true,
    pendingStarts: Object.freeze([]) as readonly string[],
    pendingStops: Object.freeze([]) as readonly string[],
  });

/**
 * Ticket 140: the session id carried by the header the registry hands
 * `init`. `header.id` is the host `SessionId` (`dsh-session/lib/types/
 * types.d.ts:66`) and equals the id the session row is listed under. Any
 * other shape answers null so the projection fails closed.
 */
export function sessionIdOfHeader(header: unknown): string | null {
  if (typeof header !== "object" || header === null) return null;
  const id = (header as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Ticket 140: the unit's `init` for a session whose dispatcher identity may
 * already be known from the adapter's in-memory dispatcher-mark mirror.
 *
 * A spawned dispatcher is a host subagent child: its own log carries no
 * `command/run` pair (nobody typed `/dsh-bot` in it), so the command fold
 * alone would report it as NOT a dispatcher — and the projection cache would
 * checkpoint that wrong kind durably. `spawnDispatcher` seeds the mirror with
 * the reserved child id BEFORE `startActivation`, so by the time the host
 * announces `session/created` the id is already known. The probe is a
 * late-bound accessor: the unit is registered before the host object exists
 * (`src/plugin.ts`), so this function must never capture a host instance.
 *
 * Fail-closed: no probe, an unreadable header, or a throwing probe all fall
 * back to the empty state — a cosmetic indicator must never break the create
 * path.
 */
export function initSessionKindProjection(
  header: unknown,
  isMarkedDispatcher?: (sessionId: string) => boolean,
): SessionKindProjectionState {
  if (isMarkedDispatcher === undefined) return INITIAL_SESSION_KIND_STATE;
  const sessionId = sessionIdOfHeader(header);
  if (sessionId === null) return INITIAL_SESSION_KIND_STATE;
  let marked = false;
  try {
    marked = isMarkedDispatcher(sessionId) === true;
  } catch {
    marked = false;
  }
  return marked ? ACTIVE_SESSION_KIND_STATE : INITIAL_SESSION_KIND_STATE;
}

/** Defensive event-data read: null for anything but a plain object. */
function eventDataOf(
  event: SessionProjectionEventLike,
): Record<string, unknown> | null {
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  return data as Record<string, unknown>;
}

/** Copy with the entry at `index` removed (the fold never mutates arrays). */
function removeAt(
  list: readonly string[],
  index: number,
): readonly string[] {
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * Pure transition. Returns the SAME state reference for every event this
 * unit does not own (the registry's documented no-work rule) and for a
 * duplicate command id.
 */
export function applySessionKindProjection(
  state: SessionKindProjectionState,
  event: SessionProjectionEventLike,
): SessionKindProjectionState {
  if (event.type === "command/run") {
    const data = eventDataOf(event);
    if (data === null) return state;
    const commandId = data["commandId"];
    const commandName = data["name"];
    if (
      typeof commandId !== "string" ||
      commandId.length === 0 ||
      typeof commandName !== "string"
    ) {
      return state;
    }
    // Both names mark a start: the current `dsh-bot` and the legacy
    // `dispatcher-start` held by logs persisted before the ADR-0030 rename
    // (2026-10-21). Restart replay of an old log must still mark the
    // session as a dispatcher — the settle step pairs by commandId either
    // way, so only this start-match needs the dual name.
    if (
      commandName === DISPATCHER_START_COMMAND ||
      commandName === LEGACY_DISPATCHER_START_COMMAND
    ) {
      if (state.pendingStarts.includes(commandId)) return state;
      return {
        ...state,
        pendingStarts: [...state.pendingStarts, commandId],
      };
    }
    // The stop command is withdrawn (ADR-0030, ticket 129) — the fold
    // matches only the legacy literal held by logs persisted before the
    // withdrawal, so a restart replay still clears the mark on its recorded
    // stop settlements. No new stop event can be produced.
    if (commandName === LEGACY_DISPATCHER_STOP_COMMAND) {
      if (state.pendingStops.includes(commandId)) return state;
      return {
        ...state,
        pendingStops: [...state.pendingStops, commandId],
      };
    }
    return state;
  }

  if (event.type === "command/done") {
    const data = eventDataOf(event);
    if (data === null) return state;
    const commandId = data["commandId"];
    const outcome = data["kind"];
    if (typeof commandId !== "string") return state;
    const startIndex = state.pendingStarts.indexOf(commandId);
    if (startIndex >= 0) {
      return {
        active: outcome === "success" ? true : state.active,
        pendingStarts: removeAt(state.pendingStarts, startIndex),
        pendingStops: state.pendingStops,
      };
    }
    const stopIndex = state.pendingStops.indexOf(commandId);
    if (stopIndex >= 0) {
      return {
        active: outcome === "success" ? false : state.active,
        pendingStarts: state.pendingStarts,
        pendingStops: removeAt(state.pendingStops, stopIndex),
      };
    }
    return state;
  }

  return state;
}

/** State → wire value. A string (not an object) is `Object.is`-stable by value. */
export function viewSessionKind(
  state: SessionKindProjectionState,
): DispatcherSessionKind | null {
  return state.active ? DISPATCHER_SESSION_KIND : null;
}

/** Persisted-state validation (cache rows are never authoritative). */
export function parseSessionKindProjectionState(
  value: unknown,
): SessionKindProjectionState {
  if (typeof value !== "object" || value === null) {
    throw new Error("sessionKind projection state must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["active"] !== "boolean") {
    throw new Error("sessionKind projection state.active must be a boolean");
  }
  const starts = record["pendingStarts"];
  const stops = record["pendingStops"];
  if (
    !Array.isArray(starts) ||
    !starts.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      "sessionKind projection state.pendingStarts must be an array of strings",
    );
  }
  if (
    !Array.isArray(stops) ||
    !stops.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      "sessionKind projection state.pendingStops must be an array of strings",
    );
  }
  return {
    active: record["active"],
    pendingStarts: [...(starts as string[])],
    pendingStops: [...(stops as string[])],
  };
}

/** Wire validation before the value leaves the host. */
export function parseDispatcherSessionKind(
  value: unknown,
): DispatcherSessionKind | null {
  if (value === null || value === DISPATCHER_SESSION_KIND) return value;
  throw new Error(
    `sessionKind wire value must be "${DISPATCHER_SESSION_KIND}" or null`,
  );
}

/**
 * Structural `ctx.sessionProjections` view as the RESUME path reads it
 * (ticket 147): just the synchronous state read. Kept separate from
 * {@link SessionProjectionsRegistryLike} so the registration side and the
 * read side can be stubbed independently.
 */
export interface HostSessionProjectionsLike {
  stateOf?(session: unknown, key: string): unknown;
}

/**
 * Context surface for the READ side (ticket 147). `get` is cordis's guarded
 * service read — the same route the microcompact pass uses for `tokenMeter`,
 * and the reason a live plugin context must not touch `ctx.sessionProjections`
 * directly: cordis throws for a property the context never injected, and this
 * service is optional by design. The direct property is the stub-test fallback.
 */
export interface SessionProjectionReadHostLike {
  get?(name: string): unknown;
  readonly sessionProjections?: HostSessionProjectionsLike;
}

/**
 * Ticket 147: resolve the host's projection registry without ever throwing.
 * `undefined` means "no registry" — the resumed-dispatcher check then does
 * nothing, which is the pre-147 behavior.
 */
export function resolveSessionProjections(
  ctx: SessionProjectionReadHostLike,
): HostSessionProjectionsLike | undefined {
  if (typeof ctx.get === "function") {
    try {
      const service = ctx.get("sessionProjections");
      if (typeof service === "object" && service !== null) {
        return service as HostSessionProjectionsLike;
      }
    } catch {
      // Absent (or not yet active): fall through to the direct stub property.
    }
  }
  try {
    return ctx.sessionProjections;
  } catch {
    // A live cordis context throws on an un-injected property read.
    return undefined;
  }
}

/**
 * Ticket 147: the durable dispatcher kind of one session, read from the
 * host's projection registry — `"dispatcher"` only when the projection says
 * so; `null` for anything else (no registry, key not registered, inactive,
 * unreadable).
 *
 * This is the resume seam's authority, and it is deliberately fail-CLOSED: a
 * registry without `stateOf`, a throw inside the fold, or any state that does
 * not answer `active: true` all read as "not a dispatcher", so a resumed
 * session is never activated on a guess. The durable fact itself comes from
 * the session's own command log, folded by
 * {@link applySessionKindProjection} — the same unit whose wire value draws
 * the client glyph, so the sidebar and the tool surface cannot disagree.
 *
 * `session` is the live host `Session` (its log is the fold source). The
 * structural view keeps this file free of host imports.
 */
export function sessionKindOf(
  registry: HostSessionProjectionsLike | undefined,
  session: unknown,
): DispatcherSessionKind | null {
  if (registry === undefined || typeof registry.stateOf !== "function") {
    return null;
  }
  let state: unknown;
  try {
    state = registry.stateOf(session, SESSION_KIND_PROJECTION_KEY);
  } catch {
    // A projection that cannot answer must never activate a session.
    return null;
  }
  if (typeof state !== "object" || state === null) return null;
  const active = (state as { active?: unknown }).active;
  return active === true ? DISPATCHER_SESSION_KIND : null;
}

/**
 * The unit this plugin contributes. Host-only readers never see it; the
 * client-visible half is the `wire` view.
 */
export const SESSION_KIND_PROJECTION_DEFINITION: SessionProjectionDefinitionLike<SessionKindProjectionState> =
  {
    key: SESSION_KIND_PROJECTION_KEY,
    stateSchema: { parse: parseSessionKindProjectionState },
    init: () => INITIAL_SESSION_KIND_STATE,
    apply: applySessionKindProjection,
    wire: {
      viewSchema: { parse: parseDispatcherSessionKind },
      view: viewSessionKind,
    },
    stateVersion: SESSION_KIND_PROJECTION_STATE_VERSION,
  };

/**
 * Ticket 140: the same unit with an `init` that also consults the
 * dispatcher-mark mirror, so a spawned dispatcher child projects
 * `"dispatcher"` from its session's creation. Everything else is shared with
 * {@link SESSION_KIND_PROJECTION_DEFINITION} by reference.
 *
 * `isMarkedDispatcher` is read at CALL time through the passed function, not
 * captured as a host object: the unit is registered before the host exists.
 *
 * @param isMarkedDispatcher the late-bound mirror probe; omitted means the
 *   command fold is the only source (the pre-140 shape).
 */
export function sessionKindProjectionDefinition(
  isMarkedDispatcher?: () => ((sessionId: string) => boolean) | undefined,
): SessionProjectionDefinitionLike<SessionKindProjectionState> {
  if (isMarkedDispatcher === undefined) {
    return SESSION_KIND_PROJECTION_DEFINITION;
  }
  return {
    ...SESSION_KIND_PROJECTION_DEFINITION,
    init: (header) =>
      initSessionKindProjection(header, isMarkedDispatcher()),
  };
}

/**
 * Register the unit through the host registry.
 *
 * Optional by design: a host without `sessionProjections` (older trees,
 * stub contexts) simply gets no key, and the client reads that absence as
 * "no dispatcher mark" — never an error. When `inject` is present (the live
 * host), the registration is made on the injected child so unloading this
 * plugin removes the key with it.
 *
 * @param isMarkedDispatcher ticket 140: a late-bound probe for the adapter's
 *   dispatcher-mark mirror. The plugin registers this unit BEFORE the host
 *   object exists, so the probe must be a thunk read at `init` time, never a
 *   captured host reference. Omitted: the command fold is the only source.
 * @returns the registry's own disposer, or null when no registry answered.
 *   Registration is already an effect on the calling/injected fiber; the
 *   disposer exists for explicit early removal (tests, HMR teardown).
 */
export function registerSessionKindProjection(
  ctx: SessionProjectionHostLike,
  isMarkedDispatcher?: () => ((sessionId: string) => boolean) | undefined,
): (() => void) | null {
  let dispose: (() => void) | null = null;
  const definition = sessionKindProjectionDefinition(isMarkedDispatcher);
  const registerOn = (host: SessionProjectionChildLike): void => {
    const registry = host.sessionProjections;
    if (registry === undefined || typeof registry.register !== "function") {
      return;
    }
    try {
      dispose = registry.register(definition);
    } catch (error) {
      // A cosmetic indicator must never break dispatcher activation: a host
      // that rejects the unit (e.g. a key/version conflict) leaves the client
      // reading capability absence, which renders no glyph.
      try {
        console.warn(
          "[multitask-dispatcher] sessionKind projection not registered:",
          error,
        );
      } catch {
        // A broken console must not break activation either.
      }
    }
  };
  if (typeof ctx.inject === "function") {
    ctx.inject(["sessionProjections"], registerOn);
    return dispose;
  }
  registerOn(ctx);
  return dispose;
}
