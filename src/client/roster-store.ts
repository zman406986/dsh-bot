/**
 * Roster panel state store + view model (ticket 21).
 *
 * Pure and dependency-light (only the snapshot contract): no React, no DOM,
 * no Cordis — asserted directly by offline tests. The React panel in
 * `panel.tsx` subscribes through the tiny store seam so the data path
 * (settings-watch fallback) and the rendering stay decoupled.
 *
 * State machine:
 * - `channel-missing` — no settings inject/watch available at all;
 * - `waiting` — channel alive, no roster snapshot observed yet (e.g. the
 *   host has not activated/published, or the document still lacks the key);
 * - `invalid` — a payload carried a `roster` key that failed defensive
 *   parsing (version skew or corruption);
 * - `snapshot` — the current parsed snapshot; staleness is evaluated at
 *   view time against the render clock.
 *
 * `unavailable` is a VIEW outcome, not a state: waiting/channel-missing/
 * invalid/stale snapshots all render the design-16 §6 "Worker status is
 * unavailable right now." copy — never a spinner that hangs.
 */
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_STALE_WINDOW_MS,
  isRosterSnapshotStale,
  parseRosterSnapshot,
  type RosterSnapshot,
} from "../core/roster-snapshot.js";
import type { WorkerStatus } from "../core/types.js";

/** How often the mounted panel re-evaluates staleness without a push. */
export const ROSTER_STALE_RECHECK_MS = 10_000;

/** Panel state kept by the store. */
export type RosterPanelState =
  | { readonly kind: "channel-missing" }
  | { readonly kind: "waiting" }
  | { readonly kind: "invalid" }
  | { readonly kind: "snapshot"; readonly snapshot: RosterSnapshot };

/**
 * Box handed to React's `useSyncExternalStore`: identity changes only when
 * the state changes or `refresh()` forces a staleness re-render.
 */
export interface RosterStoreBox {
  readonly state: RosterPanelState;
  readonly version: number;
}

export interface RosterStore {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): RosterStoreBox;
  /** Replace the semantic state and notify listeners. */
  set(next: RosterPanelState): void;
  /**
   * Apply one payload from the settings watch. Object payloads without the
   * roster key are unrelated settings writes and leave the state untouched;
   * a present-but-invalid roster key marks the feed `invalid`.
   */
  applyChannelValue(value: unknown): void;
  /** Force a re-render tick (staleness re-evaluation) without new data. */
  refresh(): void;
  /** Subscribe; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
}

export function createRosterStore(): RosterStore {
  let state: RosterPanelState = { kind: "waiting" };
  let version = 0;
  let box: RosterStoreBox = { state, version };
  const listeners = new Set<() => void>();

  function emit(next: RosterPanelState): void {
    state = next;
    version += 1;
    box = { state, version };
    for (const listener of [...listeners]) {
      listener();
    }
  }

  return {
    getBox() {
      return box;
    },
    set(next: RosterPanelState) {
      emit(next);
    },
    applyChannelValue(value: unknown) {
      if (typeof value !== "object" || value === null) {
        // Broken document shape — treat like a corrupt feed.
        emit({ kind: "invalid" });
        return;
      }
      const roster = (value as Record<string, unknown>)[ROSTER_SETTINGS_KEY];
      if (roster === undefined) {
        // Unrelated settings write (flag flip, timeout change): keep the
        // current view; staleness governs any later degrade.
        return;
      }
      const snapshot = parseRosterSnapshot(roster);
      emit(
        snapshot === null
          ? { kind: "invalid" }
          : { kind: "snapshot", snapshot },
      );
    },
    refresh() {
      emit(state);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One rendered roster row. */
export interface RosterRowView {
  readonly workerId: string;
  readonly title: string;
  /** Core FSM vocabulary, verbatim (design-16 §6 "as-is"). */
  readonly statusLabel: string;
  readonly todoId: string | null;
}

/** Panel view outcome: what the component should render. */
export type RosterPanelView =
  | { readonly kind: "unavailable" }
  | { readonly kind: "empty" }
  | { readonly kind: "rows"; readonly rows: readonly RosterRowView[] };

/**
 * Status label mapping. The identity function IS the contract: the panel
 * never invents a display vocabulary; the core FSM word renders verbatim.
 */
export function rosterStatusLabel(status: WorkerStatus): string {
  return status;
}

/**
 * Pure view model for the panel. Everything that is not a fresh snapshot
 * degrades to `unavailable` (channel missing, still waiting, corrupt feed,
 * or stale beyond the window).
 */
export function describeRosterPanel(
  state: RosterPanelState,
  nowMs: number,
  windowMs: number = ROSTER_STALE_WINDOW_MS,
): RosterPanelView {
  if (state.kind !== "snapshot") return { kind: "unavailable" };
  if (isRosterSnapshotStale(state.snapshot, nowMs, windowMs)) {
    return { kind: "unavailable" };
  }
  if (state.snapshot.workers.length === 0) return { kind: "empty" };
  return {
    kind: "rows",
    rows: state.snapshot.workers.map((worker) => ({
      workerId: worker.workerId,
      title: worker.title.length > 0 ? worker.title : worker.workerId,
      statusLabel: rosterStatusLabel(worker.status),
      todoId: worker.todoId,
    })),
  };
}
