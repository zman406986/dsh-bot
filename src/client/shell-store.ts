/**
 * Wrapper shell store (ticket 77, ADR-0020 slice 1).
 *
 * The dispatcher-session model of the whole-UI shell: one row per dsh
 * session, keyed by session id (ADR-0018: each dispatcher gets its own
 * session; ADR-0020: the sidebar roster is that map, a single dispatcher
 * being a roster of one). Presence per dispatcher session is a summary
 * derived from our roster snapshot with the SAME partition rule the panel
 * uses (`rosterSectionFor`) — one section semantic, never a second one.
 *
 * Honest-degrade rules this store enforces so the component cannot lie:
 * - selection names only sessions the feed delivered; unknown ids are
 *   refused, never invented (the same discipline as the honest channel
 *   states in `roster-store.ts`);
 * - removing a selected session resets the selection — the shell never
 *   keeps pointing at a session that is gone;
 * - presence is attached only to the session the snapshot names
 *   (`dispatcherSessionId`); until ticket 76's session-keyed mirror lands,
 *   a row without a snapshot renders "presence unavailable", not zeros.
 *
 * Pure data + view model, no rendering: offline tests drive transitions
 * end to end (S8; the component factory in `shell.tsx` is covered by build
 * + typecheck, same as the panel).
 */
import type {
  RosterSnapshot,
  RosterSnapshotWorker,
} from "../core/roster-snapshot.js";
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

/** One sidebar row: a dsh session the shell knows about. */
export interface ShellSessionRow {
  readonly sessionId: string;
  readonly title: string;
  /** True when this session is one of OUR dispatcher sessions. */
  readonly dispatcher: boolean;
  /**
   * Presence summary, or `null` when no snapshot for this session has
   * arrived (honest "unavailable" — never fabricated zeros).
   */
  readonly presence: ShellPresenceSummary | null;
}

/** Shell selection: no session, or exactly one known session id. */
export type ShellSelection =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly sessionId: string };

/** The store's immutable state; `order` is the feed's insertion order. */
export interface ShellState {
  readonly rows: ReadonlyMap<string, ShellSessionRow>;
  readonly order: readonly string[];
  readonly selection: ShellSelection;
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
  for (const worker of snapshot.workers as readonly RosterSnapshotWorker[]) {
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

/** One sidebar row view: the row plus whether it is the selection. */
export interface ShellRowView extends ShellSessionRow {
  readonly selected: boolean;
}

/** The sidebar view model: empty, or ordered rows (dispatcher rows first). */
export type ShellSidebarView =
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly rows: readonly ShellRowView[] };

/**
 * Sidebar order: dispatcher rows first, then the rest, each group stable in
 * feed-insertion order. Documented here because stability is the contract
 * the tests pin — a re-render must never reshuffle the roster.
 */
export function describeShellSidebar(state: ShellState): ShellSidebarView {
  if (state.order.length === 0) return { kind: "empty" };
  const rows: ShellRowView[] = [];
  for (const id of state.order) {
    const row = state.rows.get(id);
    if (row?.dispatcher === true) {
      rows.push({ ...row, selected: isSelected(state, id) });
    }
  }
  for (const id of state.order) {
    const row = state.rows.get(id);
    if (row?.dispatcher === false) {
      rows.push({ ...row, selected: isSelected(state, id) });
    }
  }
  return { kind: "ready", rows };
}

function isSelected(state: ShellState, sessionId: string): boolean {
  return (
    state.selection.kind === "session" &&
    state.selection.sessionId === sessionId
  );
}

/**
 * The pane view (pure; the component maps it to seats). The main surface is
 * an honest placeholder until ticket 80 wires the conversation surface; the
 * right pane hosts the EXISTING roster panel component for the selected
 * session (ADR-0020: hosted, not rebuilt).
 */
export interface ShellPaneView {
  readonly main:
    | { readonly kind: "no-selection" }
    | { readonly kind: "conversation-pending"; readonly sessionId: string };
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
    main: { kind: "conversation-pending", sessionId },
    right: { kind: "hosted-roster", sessionId },
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
  /** Attach presence from OUR roster snapshot (keyed by its session). */
  applyPresence(snapshot: RosterSnapshot): void;
  /** Honest degrade: a session's presence is known to be unavailable. */
  markPresenceUnavailable(sessionId: string): void;
  /** Select a KNOWN session; unknown ids are refused (state unchanged). */
  select(sessionId: string): void;
}

const EMPTY_PRESENCE: ShellPresenceSummary | null = null;

export function createDispatcherShellStore(): DispatcherShellStore {
  let state: ShellState = {
    rows: new Map<string, ShellSessionRow>(),
    order: [],
    selection: { kind: "none" },
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
          next.set(input.sessionId, {
            sessionId: input.sessionId,
            title: input.title,
            dispatcher: input.dispatcher === true,
            presence: EMPTY_PRESENCE,
          });
          order = [...order, input.sessionId];
        } else {
          const title = input.title;
          // `dispatcher` is tri-state on update: an omitted field means "the
          // feed does not say", so it never clobbers the known flag.
          const dispatcher = input.dispatcher === undefined
            ? existing.dispatcher
            : input.dispatcher === true;
          if (existing.title === title && existing.dispatcher === dispatcher) {
            continue;
          }
          if (next === null) next = new Map(state.rows);
          next.set(input.sessionId, { ...existing, title, dispatcher });
        }
      }
      if (next !== null) emit({ rows: next, order, selection: state.selection });
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
      emit({ rows, order: kept, selection });
    },
    applyPresence(snapshot) {
      if (
        typeof snapshot.dispatcherSessionId !== "string" ||
        !state.rows.has(snapshot.dispatcherSessionId)
      ) {
        return; // presence for an unknown session is refused, never attached
      }
      withRow(snapshot.dispatcherSessionId, (row) => ({
        ...row,
        presence: describePresence(snapshot),
      }));
    },
    markPresenceUnavailable(sessionId) {
      withRow(sessionId, (row) => ({ ...row, presence: null }));
    },
    select(sessionId) {
      if (!state.rows.has(sessionId)) return; // unknown id: refused
      if (isSelected(state, sessionId)) return; // no-op re-select: no emit
      emit({ ...state, selection: { kind: "session", sessionId } });
    },
  };
}
