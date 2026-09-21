/**
 * Wrapper shell store (ticket 77, ADR-0020 slice 1; per-session mirror
 * read-side ticket 79, ADR-0020 slice 3).
 *
 * The dispatcher-session model of the whole-UI shell: one row per dsh
 * session, keyed by session id (ADR-0018: each dispatcher gets its own
 * session; ADR-0020: the sidebar roster is that map, a single dispatcher
 * being a roster of one). Presence per dispatcher session is a summary
 * derived from OUR roster snapshot for THAT session with the SAME partition
 * rule the panel uses (`rosterSectionFor`) — one section semantic, never a
 * second one.
 *
 * Per-session keying (ticket 79, ADR-0019 keying table). The host mirrors
 * every dispatcher session's snapshot under its own settings key
 * `roster.<sessionId>` (and clears it with `null` on deactivation). The
 * store keeps a per-session MIRROR state and derives everything from it:
 *
 * - `snapshot` — a parsed snapshot arrived for that session: the session is
 *   one of OUR dispatcher sessions (flag true) and its presence counters,
 *   waiting marker, and last-entry excerpt come from that snapshot.
 *   Staleness is a VIEW outcome (`describeShellSidebar`'s optional render
 *   clock), exactly like the panel's — an aged snapshot degrades to the
 *   honest "presence unavailable" chip, never to stale numbers.
 * - `cleared` — the host wrote `null` (deactivation): the flag falls back to
 *   a plain session row. `null` is used because the owner scope has no
 *   field-delete verb; the client reads it as "not a dispatcher here".
 * - `unavailable` — a mirror key carried a value that failed
 *   `parseRosterSnapshot` (version skew / corruption): the session stays
 *   flagged (the key exists — it IS one of ours) but presence degrades to
 *   "unavailable" — never a wrong roster (design-17's fail-closed rule).
 *
 * The feed's optional `dispatcher` claim (`ShellSessionInput.dispatcher`)
 * remains for callers with independent knowledge (and the offline tests);
 * a mirror signal, when one exists, is the authority. Production feed rows
 * carry no such claim — the flag comes from the mirrors.
 *
 * Honest-degrade rules this store enforces so the component cannot lie:
 * - selection names only sessions the feed delivered; unknown ids are
 *   refused, never invented (the same discipline as the honest channel
 *   states in `roster-store.ts`);
 * - removing a selected session resets the selection — the shell never
 *   keeps pointing at a session that is gone;
 * - presence is attached only to the session the snapshot names
 *   (`dispatcherSessionId`); a session without a live snapshot renders
 *   "presence unavailable", not zeros.
 * - a mirror for a session the feed has not delivered yet is recorded but
 *   INERT (no row is invented); it applies the moment the feed delivers the
 *   row. Mirrors never create rows — the sessions feed is the row authority.
 *
 * Unread/attention honesty (ticket 79, kept from ticket 27): there is no
 * push seam and none is simulated. The needs-you counter IS the attention
 * marker — pull-only, visible when the user looks, never interrupting.
 *
 * Pure data + view model, no rendering: offline tests drive transitions
 * end to end (S8; the component factory in `shell.tsx` is covered by build
 * + typecheck, same as the panel).
 */
import type {
  RosterSnapshot,
  RosterSnapshotBlocked,
  RosterSnapshotRecentResult,
} from "../core/roster-snapshot.js";
import { ROSTER_STALE_WINDOW_MS, parseRosterSnapshot } from "../core/roster-snapshot.js";
import { isTerminalStatus } from "../core/types.js";
import { rosterSectionFor } from "./roster-store.js";

/** Presence counters for one dispatcher session (panel-section semantics). */
export interface ShellPresenceSummary {
  /** Non-terminal rows (spawned / running / steering). */
  readonly working: number;
  /** Blocked or terminal-and-undelivered rows — the user is on the hook. */
  readonly needsYou: number;
  /** Terminal and delivered rows. */
  readonly finished: number;
}

/**
 * The row's waiting marker — the sidebar's blocked chip data, with the
 * design-17 §4.1 precedence (a blocked ask outranks a landed-undelivered
 * result). `blocked` carries class + target (names only, never a secret).
 */
export type ShellWaitingMarker =
  | { readonly kind: "blocked"; readonly blocked: RosterSnapshotBlocked }
  | { readonly kind: "landed" }
  | null;

/** One sidebar row: a dsh session the shell knows about. */
export interface ShellSessionRow {
  readonly sessionId: string;
  readonly title: string;
  /** True when this session is one of OUR dispatcher sessions. */
  readonly dispatcher: boolean;
  /**
   * Presence counters, or `null` when no live snapshot for this session has
   * arrived (honest "unavailable" — never fabricated zeros).
   */
  readonly presence: ShellPresenceSummary | null;
  /**
   * Highest-precedence waiting marker from the session's snapshot
   * (blocked ask > landed-undelivered), or `null`.
   */
  readonly waiting: ShellWaitingMarker;
  /**
   * The snapshot's `recentResult` excerpt — the hover preview's "last
   * entry" tier (wire truth, never localized), or `null`.
   */
  readonly recentResult: RosterSnapshotRecentResult | null;
}

/**
 * Per-session mirror state (see module comment). Absent from the map means
 * "no mirror signal for this session at all".
 */
export type ShellMirror =
  | { readonly kind: "snapshot"; readonly snapshot: RosterSnapshot }
  | { readonly kind: "cleared" }
  | { readonly kind: "unavailable" };

/** Shell selection: no session, or exactly one known session id. */
export type ShellSelection =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly sessionId: string };

/** The store's immutable state; `order` is the feed's insertion order. */
export interface ShellState {
  readonly rows: ReadonlyMap<string, ShellSessionRow>;
  readonly order: readonly string[];
  readonly selection: ShellSelection;
  /** Per-session roster mirrors, keyed by dispatcher session id. */
  readonly mirrors: ReadonlyMap<string, ShellMirror>;
}

/** Minimal feed row shape `upsertSessions` accepts (dispatcher optional). */
export interface ShellSessionInput {
  readonly sessionId: string;
  readonly title: string;
  readonly dispatcher?: boolean;
}

/**
 * Summarize a roster snapshot into presence counters, using the panel's own
 * partition rule so the sidebar chips and the panel sections can never
 * disagree about where a worker stands.
 */
export function describePresence(
  snapshot: RosterSnapshot,
): ShellPresenceSummary {
  const counters = { working: 0, needsYou: 0, finished: 0 };
  for (const worker of snapshot.workers) {
    const section = rosterSectionFor(
      worker.status,
      worker.blocked,
      worker.delivered,
    );
    if (section === "active") counters.working += 1;
    else if (section === "needs-you") counters.needsYou += 1;
    else counters.finished += 1;
  }
  return counters;
}

/**
 * The waiting marker for a snapshot: the FIRST blocked row wins (roster
 * order is the deterministic tie-break), else the landed-undelivered marker,
 * else nothing — blocked outranks landed (design-17 §4.1), the same
 * precedence the panel's per-row markers follow.
 */
export function describeWaiting(
  snapshot: RosterSnapshot,
): ShellWaitingMarker {
  for (const worker of snapshot.workers) {
    if (worker.blocked !== null) {
      return { kind: "blocked", blocked: worker.blocked };
    }
  }
  if (
    snapshot.workers.some(
      (worker) => isTerminalStatus(worker.status) && !worker.delivered,
    )
  ) {
    return { kind: "landed" };
  }
  return null;
}

/**
 * The ONE staleness predicate for mirror snapshots — the sidebar's `view()`
 * and the launcher capsule's counts (ticket 107, ADR-0022) share it, so the
 * sidebar chips and the capsule can never disagree about what counts as
 * live. A mirror snapshot older than {@link ROSTER_STALE_WINDOW_MS} is not
 * live presence (the channel has no heartbeat, so a silent gap means
 * "unconfirmed" — the panel's rule, one stale rule total). Without a render
 * clock nothing is declared stale.
 */
function mirrorSnapshotStale(
  mirror: ShellMirror,
  nowMs: number | undefined,
): boolean {
  return (
    nowMs !== undefined &&
    mirror.kind === "snapshot" &&
    nowMs - mirror.snapshot.publishedAtMs > ROSTER_STALE_WINDOW_MS
  );
}

/**
 * The launcher capsule's presence counts (ticket 107, ADR-0022 — the
 * human's 2026-09-22 ruling revived the collapsed affordance's information
 * model): `dispatchers` is the number of live mirror snapshots (one
 * activated dispatcher session each), `workers` the sum of
 * {@link describePresence}'s working counters over those snapshots.
 *
 * The mirrors ARE the activation authority (ADR-0010 honesty: the mirror
 * feed is the truth, no invented push channel, no optimistic flips), so the
 * derivation reads the store's mirror map directly — a `cleared` mirror
 * (deactivation), an `unavailable` one (corrupt value), and a snapshot
 * older than the stale window (judged only when the caller supplies a
 * render clock, exactly like the sidebar's view) contribute nothing. Zero
 * mirrors derive zero — never a fabricated count.
 *
 * Pure: no clock reads, no store reads — the component passes
 * `store.getBox().state.mirrors` and `Date.now()`.
 */
export interface CapsuleCounts {
  readonly dispatchers: number;
  readonly workers: number;
}

export function describeCapsuleCounts(
  mirrors: ReadonlyMap<string, ShellMirror>,
  nowMs?: number,
): CapsuleCounts {
  let dispatchers = 0;
  let workers = 0;
  for (const mirror of mirrors.values()) {
    if (mirror.kind !== "snapshot" || mirrorSnapshotStale(mirror, nowMs)) {
      continue;
    }
    dispatchers += 1;
    workers += describePresence(mirror.snapshot).working;
  }
  return { dispatchers, workers };
}

/** One sidebar row view: the row plus whether it is the selection. */
export interface ShellRowView extends ShellSessionRow {
  readonly selected: boolean;
  /**
   * False when the row must render the honest "presence unavailable" chip
   * instead of its counters: no live snapshot, a corrupt one, or one older
   * than the stale window (only judgeable when the caller supplies a render
   * clock — without one nothing is declared stale).
   */
  readonly presenceAvailable: boolean;
}

/** The sidebar view model: empty, or ordered rows (dispatcher rows first). */
export type ShellSidebarView =
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly rows: readonly ShellRowView[] };

/**
 * Sidebar order: dispatcher rows first, then the rest, each group stable in
 * feed-insertion order. Documented here because stability is the contract
 * the tests pin — a re-render must never reshuffle the roster.
 *
 * `nowMs` (optional, the component passes `Date.now()`) turns staleness into
 * a view outcome: a mirror snapshot older than {@link ROSTER_STALE_WINDOW_MS}
 * renders "presence unavailable" — the channel has no heartbeat, so a silent
 * gap means "unconfirmed" (the panel's rule, one stale rule total).
 */
export function describeShellSidebar(
  state: ShellState,
  nowMs?: number,
): ShellSidebarView {
  if (state.order.length === 0) return { kind: "empty" };
  const rows: ShellRowView[] = [];
  for (const id of state.order) {
    const row = state.rows.get(id);
    if (row?.dispatcher === true) {
      rows.push(view(row, state, nowMs, isSelected(state, id)));
    }
  }
  for (const id of state.order) {
    const row = state.rows.get(id);
    if (row?.dispatcher === false) {
      rows.push(view(row, state, nowMs, isSelected(state, id)));
    }
  }
  return { kind: "ready", rows };
}

function view(
  row: ShellSessionRow,
  state: ShellState,
  nowMs: number | undefined,
  selected: boolean,
): ShellRowView {
  const mirror = state.mirrors.get(row.sessionId);
  // The shared staleness predicate (see mirrorSnapshotStale): the same
  // rule the capsule counts apply, so the two faces never disagree.
  const stale = mirror !== undefined && mirrorSnapshotStale(mirror, nowMs);
  return {
    ...row,
    selected,
    presenceAvailable: row.presence !== null && !stale,
  };
}

/**
 * The hover-preview view model (ticket 79): the reference precedence is
 * waiting reason > draft > last entry. Two of the three tiers exist in our
 * data model today:
 * - **waiting reason** — the row's waiting marker (a pending ask's class +
 *   target, or the landed-undelivered marker);
 * - **last entry** — the snapshot's `recentResult` excerpt (wire truth).
 * The **draft** tier is a recorded GAP: per-agent drafts are excluded
 * (ADR-0018 U-B), so no draft data exists per session and the tier is
 * skipped, never simulated.
 *
 * Returns `null` when no tier has data (or presence is not available — a
 * stale/corrupt feed must not keep previewing old content).
 */
export function describeRowPreview(
  row: Pick<ShellSessionRow, "waiting" | "recentResult">,
  presenceAvailable: boolean,
):
  | {
      readonly kind: "waiting";
      readonly waiting: Exclude<ShellWaitingMarker, null>;
    }
  | { readonly kind: "excerpt"; readonly text: string }
  | null {
  if (!presenceAvailable) return null;
  if (row.waiting !== null) return { kind: "waiting", waiting: row.waiting };
  if (row.recentResult !== null) {
    return { kind: "excerpt", text: row.recentResult.text };
  }
  return null;
}

/**
 * The pane view (pure; the component maps it to seats). The main surface is
 * the conversation pane for the selected session (ticket 80; the component
 * renders the honest waiting/unavailable/empty states when no readable
 * window has arrived); the right pane hosts the EXISTING roster panel
 * component for the selected session (ADR-0020: hosted, not rebuilt).
 */
export interface ShellPaneView {
  readonly main:
    | { readonly kind: "no-selection" }
    | { readonly kind: "conversation"; readonly sessionId: string };
  readonly right:
    | { readonly kind: "none" }
    | { readonly kind: "hosted-roster"; readonly sessionId: string };
}

export function describeShellPanes(state: ShellState): ShellPaneView {
  if (state.selection.kind === "none") {
    return { main: { kind: "no-selection" }, right: { kind: "none" } };
  }
  const sessionId = state.selection.sessionId;
  return {
    main: { kind: "conversation", sessionId },
    right: { kind: "hosted-roster", sessionId },
  };
}

/**
 * The sidebar's ADD affordance view model (ticket 101, ADR-0021 decision 3):
 * the sessions the user could activate as a NEW dispatcher session, as a
 * pure decision over the store state. "Add" activates an EXISTING dsh chat —
 * there is no client-side "create chat" seam, so when no candidate exists
 * the honest guidance is "create the chat in dsh first" (never a faked
 * creation).
 *
 * Candidates are the feed-delivered rows the mirror authority does NOT flag
 * as dispatchers (`row.dispatcher === false`, the same mirror-derived flag
 * the sidebar renders). HONESTY LIMITATION (recorded here and on ticket
 * 101): mirror presence is the signal, and a mirror lags its activation by
 * at least one settings write + read — a chat activated moments ago can
 * still appear here. Activating it again is harmless: the host command
 * answers with its already-active copy and nothing changes. The inverse
 * never happens (a deactivated session's mirror is cleared before it could
 * be flagged active), so a candidate is always genuinely not-flagged.
 */
export type ShellAddPickerView =
  | {
      /** At least one not-flagged session exists — the picker lists them. */
      readonly kind: "ready";
      readonly candidates: readonly ShellSessionRow[];
    }
  | {
      /** No candidate exists — the honest "create the chat in dsh" guidance. */
      readonly kind: "empty";
    };

export function describeAddPicker(state: ShellState): ShellAddPickerView {
  const candidates: ShellSessionRow[] = [];
  for (const id of state.order) {
    const row = state.rows.get(id);
    if (row !== undefined && row.dispatcher === false) {
      candidates.push(row);
    }
  }
  return candidates.length === 0
    ? { kind: "empty" }
    : { kind: "ready", candidates };
}

/**
 * The delete affordance's two-step confirmation state (ticket 101): a
 * destructive-ish action (the dispatcher binding goes away) must not fire
 * on a single click, but the codebase has no modal/toast seam and the shell
 * adds none — the armed-window pattern is the whole confirmation: the first
 * press ARMS the row, a second press within {@link SHELL_DELETE_CONFIRM_MS}
 * CONFIRMS, and past the window (or after arming a different row — one arm
 * slot total) the state re-arms. Pure and clock-explicit so offline tests
 * drive the exact transitions (S8; the component only supplies `Date.now`).
 */
export const SHELL_DELETE_CONFIRM_MS = 4_000;

export interface ShellDeleteArmState {
  /** The row whose delete affordance is armed, or null when idle. */
  readonly armedSessionId: string | null;
  /** When the arm happened (client clock). */
  readonly armedAtMs: number;
}

/** The idle (nothing armed) state. */
export const SHELL_DELETE_IDLE: ShellDeleteArmState = {
  armedSessionId: null,
  armedAtMs: 0,
};

/** What one press of a delete affordance means. */
export type ShellDeletePressAction = "arm" | "confirm";

export function shellDeletePress(
  state: ShellDeleteArmState,
  sessionId: string,
  nowMs: number,
  windowMs: number = SHELL_DELETE_CONFIRM_MS,
): {
  readonly state: ShellDeleteArmState;
  readonly action: ShellDeletePressAction;
} {
  const elapsed = nowMs - state.armedAtMs;
  if (
    state.armedSessionId === sessionId &&
    elapsed >= 0 &&
    elapsed <= windowMs
  ) {
    // Second press inside the window: confirmed. The host command's own
    // result copy is the surface — nothing here claims success.
    return { state: SHELL_DELETE_IDLE, action: "confirm" };
  }
  return {
    state: { armedSessionId: sessionId, armedAtMs: nowMs },
    action: "arm",
  };
}

/** The store face the component binds through `useSyncExternalStore`. */
export interface ShellStoreBox {
  readonly state: ShellState;
  readonly version: number;
}

export interface DispatcherShellStore {
  subscribe(listener: () => void): () => void;
  getBox(): ShellStoreBox;
  /** Feed upsert: new ids append, known ids update in place. */
  upsertSessions(rows: readonly ShellSessionInput[]): void;
  /** Feed removals; dropping the selected session resets the selection. */
  removeSessions(sessionIds: readonly string[]): void;
  /**
   * Apply one parsed snapshot from OUR roster feed (keyed by its
   * `dispatcherSessionId`). Recorded even when the feed has not delivered
   * the row yet (mirrors never invent rows); applied to the row the moment
   * it exists.
   */
  applyPresence(snapshot: RosterSnapshot): void;
  /**
   * Apply one RAW per-session mirror value from the settings document
   * (ticket 79): a parsed snapshot, or `null` for the host's deactivation
   * clear. A non-null value that fails `parseRosterSnapshot` marks the
   * session `unavailable` (flagged, honest-empty presence). Junk session
   * ids are refused.
   */
  applySessionMirror(sessionId: string, value: unknown): void;
  /** Honest degrade: a session's presence is known to be unavailable. */
  markPresenceUnavailable(sessionId: string): void;
  /** Select a KNOWN session; unknown ids are refused (state unchanged). */
  select(sessionId: string): void;
}

const EMPTY_PRESENCE: ShellPresenceSummary | null = null;

/** Render-facing presence fields derived from one parsed snapshot. */
function presenceFields(snapshot: RosterSnapshot): {
  presence: ShellPresenceSummary;
  waiting: ShellWaitingMarker;
  recentResult: RosterSnapshotRecentResult | null;
} {
  return {
    presence: describePresence(snapshot),
    waiting: describeWaiting(snapshot),
    recentResult: snapshot.recentResult,
  };
}

/** The cleared/unavailable render fields: honest absence, never zeros. */
const NO_PRESENCE_FIELDS = {
  presence: EMPTY_PRESENCE,
  waiting: null,
  recentResult: null,
} as const;

export function createDispatcherShellStore(): DispatcherShellStore {
  let state: ShellState = {
    rows: new Map<string, ShellSessionRow>(),
    order: [],
    selection: { kind: "none" },
    mirrors: new Map<string, ShellMirror>(),
  };
  let version = 0;
  let box: ShellStoreBox = { state, version };
  const listeners = new Set<() => void>();

  function emit(next: ShellState): void {
    state = next;
    version += 1;
    box = { state, version };
    for (const listener of [...listeners]) listener();
  }

  function withRow(
    sessionId: string,
    update: (row: ShellSessionRow) => ShellSessionRow,
  ): void {
    const row = state.rows.get(sessionId);
    if (row === undefined) return;
    const rows = new Map(state.rows);
    rows.set(sessionId, update(row));
    emit({ ...state, rows });
  }

  /** The flag a session's mirror signal dictates (module-comment rule). */
  function mirrorFlag(mirror: ShellMirror | undefined): boolean | undefined {
    if (mirror === undefined) return undefined;
    return mirror.kind !== "cleared";
  }

  return {
    getBox() {
      return box;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    upsertSessions(inputs) {
      let next: Map<string, ShellSessionRow> | null = null;
      let order = state.order;
      for (const input of inputs) {
        if (
          typeof input.sessionId !== "string" ||
          input.sessionId.length === 0
        ) {
          continue; // junk feed row: refused, not normalized into a lie
        }
        const existing = (next ?? state.rows).get(input.sessionId);
        if (existing === undefined) {
          if (next === null) next = new Map(state.rows);
          // A mirror signal, when one exists, outranks the feed's optional
          // claim (module comment): snapshot/unavailable flag true, cleared
          // flags false; no mirror means the claim stands.
          const mirrorEntry = state.mirrors.get(input.sessionId);
          const seeded =
            mirrorEntry !== undefined
              ? mirrorEntry.kind !== "cleared"
              : input.dispatcher === true;
          const fields =
            mirrorEntry?.kind === "snapshot"
              ? presenceFields(mirrorEntry.snapshot)
              : NO_PRESENCE_FIELDS;
          next.set(input.sessionId, {
            sessionId: input.sessionId,
            title: input.title,
            dispatcher: seeded,
            presence: fields.presence,
            waiting: fields.waiting,
            recentResult: fields.recentResult,
          });
          order = [...order, input.sessionId];
        } else {
          const title = input.title;
          // `dispatcher` is tri-state on update: an omitted field means "the
          // feed does not say", so it never clobbers the known flag — and a
          // mirror signal, when present, is the authority either way.
          const claimed =
            input.dispatcher === undefined
              ? existing.dispatcher
              : input.dispatcher === true;
          const dispatcher =
            mirrorFlag(state.mirrors.get(input.sessionId)) ?? claimed;
          if (
            existing.title === title &&
            existing.dispatcher === dispatcher
          ) {
            continue;
          }
          if (next === null) next = new Map(state.rows);
          next.set(input.sessionId, { ...existing, title, dispatcher });
        }
      }
      if (next !== null)
        emit({
          rows: next,
          order,
          selection: state.selection,
          mirrors: state.mirrors,
        });
    },
    removeSessions(sessionIds) {
      const drop = new Set(sessionIds);
      const kept = state.order.filter((id) => !drop.has(id));
      if (kept.length === state.order.length) return;
      const rows = new Map(state.rows);
      for (const id of drop) rows.delete(id);
      const selection =
        state.selection.kind === "session" && drop.has(state.selection.sessionId)
          ? ({ kind: "none" } as const)
          : state.selection;
      emit({ rows, order: kept, selection, mirrors: state.mirrors });
    },
    applyPresence(snapshot) {
      if (
        typeof snapshot.dispatcherSessionId !== "string" ||
        snapshot.dispatcherSessionId.length === 0
      ) {
        return; // junk snapshot id: refused
      }
      applyMirror(snapshot.dispatcherSessionId, {
        kind: "snapshot",
        snapshot,
      });
    },
    applySessionMirror(sessionId, value) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (value === null || value === undefined) {
        applyMirror(sessionId, { kind: "cleared" });
        return;
      }
      const snapshot = parseRosterSnapshot(value);
      applyMirror(
        sessionId,
        snapshot === null
          ? { kind: "unavailable" }
          : { kind: "snapshot", snapshot },
      );
    },
    markPresenceUnavailable(sessionId) {
      withRow(sessionId, (row) => ({ ...row, ...NO_PRESENCE_FIELDS }));
    },
    select(sessionId) {
      if (!state.rows.has(sessionId)) return; // unknown id: refused
      if (isSelected(state, sessionId)) return; // no-op re-select: no emit
      emit({ ...state, selection: { kind: "session", sessionId } });
    },
  };

  /**
   * One mirror transition: store the mirror state, then re-derive the
   * affected row's flag + presence fields. The mirror is recorded even when
   * the row does not exist yet (feed lag) — mirrors never invent rows; the
   * row picks the mirror up at upsert time.
   */
  function applyMirror(sessionId: string, mirror: ShellMirror): void {
    const mirrors = new Map(state.mirrors);
    mirrors.set(sessionId, mirror);
    const row = state.rows.get(sessionId);
    if (row === undefined) {
      emit({ ...state, mirrors });
      return;
    }
    const flag = mirrorFlag(mirror);
    const fields =
      mirror.kind === "snapshot"
        ? presenceFields(mirror.snapshot)
        : NO_PRESENCE_FIELDS;
    const rows = new Map(state.rows);
    rows.set(sessionId, {
      ...row,
      ...(flag !== undefined ? { dispatcher: flag } : {}),
      presence: fields.presence,
      waiting: fields.waiting,
      recentResult: fields.recentResult,
    });
    emit({ ...state, mirrors, rows });
  }
}

function isSelected(state: ShellState, sessionId: string): boolean {
  return (
    state.selection.kind === "session" &&
    state.selection.sessionId === sessionId
  );
}
