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

import type { DispatcherOrigin } from "../core/policy/prompts.js";
import {
  DISPATCHER_START_COMMAND,
  LEGACY_DISPATCHER_START_COMMAND,
} from "./activation-command.js";

/** The projection key the client reads from `projectionValues`. */
export const SESSION_KIND_PROJECTION_KEY = "sessionKind";

/**
 * Persisted-cache invalidation version (`ProjectionDefinition.stateVersion`).
 *
 * STAYS 1 (ticket 140 review fix, item 3). The contract's bump rule exists so
 * rows an older unit wrote are not forward-applied into garbage. Here they
 * cannot be:
 *
 * - the fold semantics are unchanged — `apply` still performs the same pure
 *   command-log fold; the mark source only ADDS a start signal the log cannot
 *   carry;
 * - the new fields are optional and additive; a row that lacks them parses as
 *   "resolved", which is correct for every row whose `active` came from the log
 *   alone (every user-started dispatcher row);
 * - a row written while the mark source could not answer carries
 *   `resolved: false` IN THE ROW, so the abstain is per-row state rather than a
 *   unit-wide version. `parse` restores it and every later event / wire read
 *   re-derives. That is the "only the rows whose derivation depends on the
 *   mirror" seam: exactly those rows retry, and no correct row is thrown away.
 *
 * Keeping 1 therefore fixes review item 3 by construction: a user-started
 * dispatcher's cached `active: true` survives the upgrade, so its sidebar glyph
 * never disappears. (A v2 row — stamped by the intermediate build of this
 * branch — is discarded by the same version guard, since v2's init-only
 * derivation is what this review corrected.)
 *
 * RECORDED RESIDUAL: a v1 row written for a SPAWNED child before this ticket
 * says `active: false` with no `resolved` marker, so it seeds that cell as a
 * settled "not a dispatcher" and that one child keeps no chip until its log is
 * refolded from `init` (cache loss / a full cold read). That is the exact
 * status quo ante — no spawned child carried a mark before this ticket — so it
 * is not a regression. See the ticket comment.
 */
export const SESSION_KIND_PROJECTION_STATE_VERSION = 1;

/** The wire value for a dispatcher the HUMAN started (chief of staff). */
export const DISPATCHER_SESSION_KIND = "dispatcher";

/**
 * Ticket 177: the wire value for a dispatcher ANOTHER dispatcher summoned
 * (team leader). A second value rather than a second projection key, for the
 * ADR-0031 reason that still holds: the identity is already durable here, so a
 * parallel channel would duplicate the fold, the cache row and the client read
 * path.
 *
 * The `dispatcher` stem is deliberate: an older client bundle compares
 * `=== "dispatcher"`, so it fails closed (draws nothing) on this value instead
 * of drawing the wrong class.
 */
export const TEAM_LEADER_SESSION_KIND = "dispatcher-team-leader";

/** Client-visible marker values; `null` means "not a dispatcher". */
export type DispatcherSessionKind =
  | typeof DISPATCHER_SESSION_KIND
  | typeof TEAM_LEADER_SESSION_KIND;

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
 *
 * `resolved` (ticket 140 review fix) says whether the non-log source — the
 * dispatcher-mark mirror — has answered for this session yet. `apply` folds
 * the LOG, so it cannot derive dispatcher identity for a spawned child (whose
 * log never carries `/dsh-bot`); when a cell is first built while the mirror is
 * cold (a resumed child at boot, an upgrade boot), `init` records
 * `resolved: false` — "not decided yet" — rather than a definitive "not a
 * dispatcher". Every later committed event re-consults the late-bound probe
 * ({@link applySessionKindProjection}'s third argument) and flips this flag
 * once the mirror answers, so the cached row never claims a final answer it
 * cannot support. Until then the wire value stays `null` (fail closed: an
 * unknown kind is never displayed as a mark).
 *
 * `sessionId` rides the state only for an UNRESOLVED cell — `apply` receives
 * no Session, so this is how the re-derivation names the id it asks about.
 * Once resolved the field is dropped; a resolved cell never needs it.
 */
export interface SessionKindProjectionState {
  readonly active: boolean;
  readonly pendingStarts: readonly string[];
  readonly pendingStops: readonly string[];
  /**
   * False until the mirror has answered for this session (see above).
   */
  readonly resolved?: boolean;
  /** The session an unresolved cell belongs to (see above). */
  readonly sessionId?: string;
  /**
   * Ticket 177: WHICH class of dispatcher this session is — `"user"` (the
   * chief of staff the human started) or `"spawned"` (the team leader another
   * dispatcher summoned). Absent means "not settled yet", and every reader
   * treats that as the user-started class, which is what every pre-175 row
   * could only have been.
   *
   * This is the durable half of the class split. It rides the state (and so
   * the host's checkpoint) instead of the mark row because the mark row is
   * implicitly spawned-only — see {@link settleFromAnswer} — while this state
   * is also what the CLIENT reads to choose a glyph.
   */
  readonly dispatcherClass?: DispatcherOrigin;
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

/** Frozen UNRESOLVED state (ticket 140 review fix): the mirror AND the
 * durable table could not answer yet, so the cell carries no kind claim and
 * remembers its session id for the next read/event's re-derivation. Shared,
 * never mutated. */
export const UNRESOLVED_SESSION_KIND_STATE: SessionKindProjectionState =
  Object.freeze({
    active: false,
    pendingStarts: Object.freeze([]) as readonly string[],
    pendingStops: Object.freeze([]) as readonly string[],
    resolved: false,
  });

/**
 * Ticket 140 review fix: the three answers the dispatcher-mark source can
 * give. `"unknown"` is NOT "no": it means the source has not loaded yet
 * (the durable store's open is async), so the projection must abstain instead
 * of caching a definitive "not a dispatcher".
 */
export type DispatcherMarkAnswer = "dispatcher" | "not-dispatcher" | "unknown";

/** Late-bound probe for the dispatcher-mark source. */
export type DispatcherMarkProbe = (sessionId: string) => DispatcherMarkAnswer;

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
 * Ticket 140 (review fix): apply one probe answer to a state. Resolved
 * answers settle the cell and drop the remembered id; `"unknown"` keeps the
 * cell unresolved for the next read.
 *
 * Ticket 177: a `"dispatcher"` answer from THIS source also settles the CLASS,
 * because the source is the `dispatcher_sessions` mark table and only a spawn
 * ever writes a row there (`writeDispatcherMark` has exactly one caller,
 * `spawnDispatcher`, and `parseDispatcherMark` rejects generation 1). So the
 * row's very existence is the durable "spawned" fact — no extra column is
 * needed, and none is invented. `"not-dispatcher"` leaves the class as the
 * fold settled it.
 */
function settleFromAnswer(
  state: SessionKindProjectionState,
  sessionId: string,
  answer: DispatcherMarkAnswer,
): SessionKindProjectionState {
  if (answer === "unknown") {
    return state.resolved === false && state.sessionId === sessionId
      ? state
      : {
          ...state,
          resolved: false,
          sessionId,
        };
  }
  const marked = answer === "dispatcher";
  return {
    active: marked ? true : state.active,
    pendingStarts: state.pendingStarts,
    pendingStops: state.pendingStops,
    ...(marked ? { dispatcherClass: "spawned" as const } : classOf(state)),
  };
}

/**
 * Ticket 177: the class fields of a state, as a spreadable object. Absent when
 * the class was never settled, so pre-175 rows and unmarked chats keep their
 * exact old shape instead of gaining a field that would read as a claim.
 */
function classOf(
  state: SessionKindProjectionState,
): { dispatcherClass?: DispatcherOrigin } {
  return state.dispatcherClass === undefined
    ? {}
    : { dispatcherClass: state.dispatcherClass };
}

/**
 * Ticket 140: the unit's `init` for a session whose dispatcher identity may
 * already be known from the adapter's dispatcher-mark source (the in-memory
 * mirror plus its durable table).
 *
 * A programmatically created session never runs `/dsh-bot`, so its log
 * carries no `command/run` + `command/done` pair at any depth: the command
 * fold alone would report it as NOT a dispatcher — and the projection cache
 * would checkpoint that wrong kind durably. `spawnDispatcher` seeds the
 * mirror with the reserved child id BEFORE `startActivation`, so by the time
 * the host announces `session/created` the id is already known. The probe is
 * a late-bound accessor: the unit is registered before the host object exists
 * (`src/plugin.ts`), so this function must never capture a host instance.
 *
 * Review fix: an `"unknown"` answer is NOT cached as "not a dispatcher". The
 * cell starts UNRESOLVED ({@link UNRESOLVED_SESSION_KIND_STATE}) and every
 * later event re-asks ({@link applySessionKindProjection}); until an answer
 * lands the wire value is `null`, so an unknown session renders no mark
 * rather than a wrong one.
 *
 * Fail-closed: an unreadable header or a throwing probe start from the empty
 * (or unresolved) state — a cosmetic indicator must never break the create
 * path. With NO probe at all, the command fold is the only authority, which
 * is the pre-140 shape and needs no later re-derivation.
 */
export function initSessionKindProjection(
  header: unknown,
  probe?: DispatcherMarkProbe,
): SessionKindProjectionState {
  const sessionId = sessionIdOfHeader(header);
  if (sessionId === null) return INITIAL_SESSION_KIND_STATE;
  if (probe === undefined) {
    // No source at all: the command fold is the only authority (pre-140).
    // That is a RESOLVED starting point — nothing else can ever settle it.
    return INITIAL_SESSION_KIND_STATE;
  }
  let answer: DispatcherMarkAnswer = "unknown";
  try {
    answer = probe(sessionId);
  } catch {
    answer = "unknown";
  }
  return settleFromAnswer(INITIAL_SESSION_KIND_STATE, sessionId, answer);
}

/**
 * Ticket 140 review fix: re-ask the dispatcher-mark source for a cell that
 * is still UNRESOLVED. Called from the fold on every committed event (the
 * only moment the unit is touched), and exposed for a direct settle after a
 * mirror warm-up. A resolved cell is returned unchanged (same reference).
 */
export function resolveSessionKindState(
  state: SessionKindProjectionState,
  probe?: DispatcherMarkProbe,
): SessionKindProjectionState {
  if (state.resolved !== false) return state;
  const sessionId = state.sessionId;
  if (sessionId === undefined || probe === undefined) return state;
  let answer: DispatcherMarkAnswer = "unknown";
  try {
    answer = probe(sessionId);
  } catch {
    answer = "unknown";
  }
  return settleFromAnswer(state, sessionId, answer);
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
 *
 * `probe` (ticket 140 review fix) is the late-bound dispatcher-mark source.
 * It is consulted ONLY while the state is unresolved, so the re-derivation
 * costs one lookup per event until the source answers, then nothing. Omitted
 * (stub callers, pre-140 shapes) keeps the pure command fold.
 */
export function applySessionKindProjection(
  state: SessionKindProjectionState,
  event: SessionProjectionEventLike,
  probe?: DispatcherMarkProbe,
): SessionKindProjectionState {
  state = resolveSessionKindState(state, probe);
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
      // Spread from `state` so an UNRESOLVED cell keeps its re-derivation
      // marker through a log transition (review fix).
      //
      // Ticket 177: a SUCCESSFUL `/dsh-bot` settlement is the user-started
      // class. The command is only ever run by the human in their own chat
      // (`src/adapter/activation-command.ts`), and a summoned dispatcher is
      // created programmatically, so its log carries no such pair. An explicit
      // "spawned" from the mark source wins over this: the mark is the more
      // specific fact, and a spawn never re-runs the command on the same id.
      const startedHere = outcome === "success";
      return {
        ...state,
        active: startedHere ? true : state.active,
        pendingStarts: removeAt(state.pendingStarts, startIndex),
        ...(startedHere && state.dispatcherClass !== "spawned"
          ? { dispatcherClass: "user" as const }
          : classOf(state)),
      };
    }
    const stopIndex = state.pendingStops.indexOf(commandId);
    if (stopIndex >= 0) {
      return {
        ...state,
        active: outcome === "success" ? false : state.active,
        pendingStops: removeAt(state.pendingStops, stopIndex),
      };
    }
    return state;
  }

  return state;
}

/**
 * State → wire value. A string (not an object) is `Object.is`-stable by value.
 *
 * Ticket 177: two dispatcher values. An ACTIVE cell whose class was never
 * settled (a checkpoint row written before this ticket) reads as the
 * user-started class — the only class a pre-175 row could describe.
 */
export function viewSessionKind(
  state: SessionKindProjectionState,
): DispatcherSessionKind | null {
  if (!state.active) return null;
  return state.dispatcherClass === "spawned"
    ? TEAM_LEADER_SESSION_KIND
    : DISPATCHER_SESSION_KIND;
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
  const resolved = record["resolved"];
  const sessionId = record["sessionId"];
  if (resolved !== undefined && typeof resolved !== "boolean") {
    throw new Error(
      "sessionKind projection state.resolved must be a boolean when present",
    );
  }
  if (sessionId !== undefined && typeof sessionId !== "string") {
    throw new Error(
      "sessionKind projection state.sessionId must be a string when present",
    );
  }
  const dispatcherClass = record["dispatcherClass"];
  if (
    dispatcherClass !== undefined &&
    dispatcherClass !== "user" &&
    dispatcherClass !== "spawned"
  ) {
    throw new Error(
      'sessionKind projection state.dispatcherClass must be "user" or "spawned" when present',
    );
  }
  return {
    active: record["active"],
    pendingStarts: [...(starts as string[])],
    pendingStops: [...(stops as string[])],
    ...(resolved !== undefined ? { resolved } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(dispatcherClass !== undefined ? { dispatcherClass } : {}),
  };
}

/** Wire validation before the value leaves the host. */
export function parseDispatcherSessionKind(
  value: unknown,
): DispatcherSessionKind | null {
  if (
    value === null ||
    value === DISPATCHER_SESSION_KIND ||
    value === TEAM_LEADER_SESSION_KIND
  ) {
    return value;
  }
  throw new Error(
    `sessionKind wire value must be "${DISPATCHER_SESSION_KIND}", ` +
      `"${TEAM_LEADER_SESSION_KIND}", or null`,
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
 *
 * Ticket 177: this answers the IDENTITY question ("is this a dispatcher at
 * all"), so BOTH classes return {@link DISPATCHER_SESSION_KIND}. The CLASS is
 * a separate read ({@link dispatcherClassOf}) on purpose: a caller that only
 * routes resumed sessions into the dispatcher activation path must not have to
 * learn a second value, and a client that does NOT know the second value must
 * still see a dispatcher (see the wire value's doc).
 */
export function sessionKindOf(
  registry: HostSessionProjectionsLike | undefined,
  session: unknown,
): typeof DISPATCHER_SESSION_KIND | null {
  const state = sessionKindStateOf(registry, session);
  return state !== undefined && state.active === true
    ? DISPATCHER_SESSION_KIND
    : null;
}

/** The raw projection state, or undefined when nothing could answer. */
function sessionKindStateOf(
  registry: HostSessionProjectionsLike | undefined,
  session: unknown,
): SessionKindProjectionState | undefined {
  if (registry === undefined || typeof registry.stateOf !== "function") {
    return undefined;
  }
  let state: unknown;
  try {
    state = registry.stateOf(session, SESSION_KIND_PROJECTION_KEY);
  } catch {
    // A projection that cannot answer must never activate a session.
    return undefined;
  }
  return typeof state === "object" && state !== null
    ? (state as SessionKindProjectionState)
    : undefined;
}

/**
 * Ticket 177: the durable CLASS of one dispatcher session, or null when the
 * session is not an active dispatcher.
 *
 * This is the seam that closes ticket 173's recorded limitation: a summoned
 * dispatcher is top-level (ADR-0032), so on a cold resume it reaches the
 * parentless branch, and before this accessor that branch had no way to ask
 * "which class was this?" — it activated every resumed dispatcher as `user`.
 *
 * Fail-closed in the same direction as {@link sessionKindOf}: no registry, no
 * key, a throw, or an inactive cell answers null, and the caller's default
 * (`"user"`) stands. A cell whose `dispatcherClass` was never settled is the
 * user-started class, which is what every pre-175 row could only have been.
 */
export function dispatcherClassOf(
  registry: HostSessionProjectionsLike | undefined,
  session: unknown,
): DispatcherOrigin | null {
  const state = sessionKindStateOf(registry, session);
  if (state === undefined || state.active !== true) return null;
  return state.dispatcherClass === "spawned" ? "spawned" : "user";
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
 * Ticket 140 (review fix): the same unit, with `init` AND `apply` consulting
 * the late-bound dispatcher-mark source, so a spawned dispatcher child
 * projects `"dispatcher"` from its session's creation — and a cell first
 * built while the source cannot answer stays UNRESOLVED instead of caching a
 * definitive "not a dispatcher". Everything else is shared with
 * {@link SESSION_KIND_PROJECTION_DEFINITION} by reference.
 *
 * The probe is read at CALL time through the thunk, not captured as a host
 * object: the unit is registered before the host exists (`src/plugin.ts`).
 *
 * @param probeOf the late-bound probe thunk; omitted means the command fold is
 *   the only source (the pre-140 shape).
 */
export function sessionKindProjectionDefinition(
  probeOf?: () => DispatcherMarkProbe | undefined,
): SessionProjectionDefinitionLike<SessionKindProjectionState> {
  if (probeOf === undefined) {
    return SESSION_KIND_PROJECTION_DEFINITION;
  }
  return {
    ...SESSION_KIND_PROJECTION_DEFINITION,
    init: (header) => initSessionKindProjection(header, probeOf()),
    apply: (state, event) =>
      applySessionKindProjection(state, event, probeOf()),
    wire: {
      ...SESSION_KIND_PROJECTION_DEFINITION.wire,
      // Review fix: a cell checkpointed while unresolved (no event since)
      // must still show its mark once the source can answer — the wire read
      // re-asks without mutating the state, so the stored row never claims a
      // final answer and the next event settles it for real.
      view: (state) => viewSessionKind(resolveSessionKindState(state, probeOf())),
    },
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
 * @param probeOf ticket 140 (review fix): a late-bound thunk for the
 *   dispatcher-mark source. The plugin registers this unit BEFORE the host
 *   object exists, so the probe must be read at call time, never captured.
 *   Omitted: the command fold is the only source.
 * @returns the registry's own disposer, or null when no registry answered.
 *   Registration is already an effect on the calling/injected fiber; the
 *   disposer exists for explicit early removal (tests, HMR teardown).
 */
export function registerSessionKindProjection(
  ctx: SessionProjectionHostLike,
  probeOf?: () => DispatcherMarkProbe | undefined,
): (() => void) | null {
  let dispose: (() => void) | null = null;
  const definition = sessionKindProjectionDefinition(probeOf);
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
