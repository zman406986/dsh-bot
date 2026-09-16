/**
 * Roster panel state store + view model (tickets 21 + 27).
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
 * `unavailable` is a VIEW outcome, not a state: channel-missing/invalid/
 * stale snapshots all render the design-16 §6 "Worker status is unavailable
 * right now." copy — never a spinner that hangs. `waiting` renders the
 * design-17 §4.2 loading copy instead: the feed is alive, the first
 * snapshot just has not landed yet.
 */
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_STALE_WINDOW_MS,
  isRosterSnapshotStale,
  parseRosterSnapshot,
  type RosterSnapshot,
  type RosterSnapshotBlocked,
} from "../core/roster-snapshot.js";
import { isTerminalStatus, type WorkerStatus } from "../core/types.js";
import type { AccessClass } from "../core/access-types.js";

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

/**
 * One rendered roster row (ticket 27 presence view model). Everything here
 * derives from the snapshot row; the component only localizes phrases.
 */
export interface RosterRowView {
  readonly workerId: string;
  readonly title: string;
  /** Core FSM vocabulary, verbatim (design-16 §6 "as-is"). */
  readonly statusLabel: string;
  /** Dot/ring visual state the six FSM statuses map onto (CSS hook). */
  readonly visual: RosterStatusVisual;
  /** Ledger linkage metadata — muted, never a task board (design-17 §4.9). */
  readonly todoId: string | null;
  /** Structured blocked reason from the snapshot (names only). */
  readonly blocked: RosterSnapshotBlocked | null;
  /**
   * Highest-precedence attention marker: blocked outranks landed, landed
   * outranks finished (design-17 §4.1). `null` = nothing needs attention.
   */
  readonly marker:
    | { readonly kind: "blocked"; readonly blocked: RosterSnapshotBlocked }
    | { readonly kind: "landed" }
    | null;
  /** Terminal row: rendered muted (precedence bottom). */
  readonly finished: boolean;
  /** Elapsed since start against the render clock, compact ("3m 5s"). */
  readonly elapsedText: string;
  readonly toolCallCount: number;
}

/** Panel view outcome: what the component should render. */
export type RosterPanelView =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
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
 * Dot/ring visual states (design-17 §4.1): working = running/steering
 * (animated ring), starting = spawned, done/failed/stopped = the terminal
 * trio. A presentation mapping only — the verbatim label still renders.
 */
export type RosterStatusVisual =
  | "working"
  | "starting"
  | "done"
  | "failed"
  | "stopped";

export function rosterStatusVisual(status: WorkerStatus): RosterStatusVisual {
  switch (status) {
    case "running":
    case "steering":
      return "working";
    case "spawned":
      return "starting";
    case "completed":
      return "done";
    case "error":
      return "failed";
    case "aborted":
      return "stopped";
  }
}

/**
 * Replace `{key}` placeholders in a locale template with values. An
 * unknown placeholder stays verbatim so a copy typo degrades visibly
 * instead of silently vanishing.
 */
export function formatTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-z]+)\}/g, (match, key: string) =>
    key in values ? (values[key] as string) : match,
  );
}

/**
 * Compact locale-neutral elapsed text: `42s`, `3m 5s`, `2h 5m`, `1d 3h`.
 * Negative inputs (clock skew) clamp to `0s`.
 */
export function formatRosterElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Pure view model for the panel (ticket 27). Waiting means the channel is
 * alive but nothing has been mirrored yet — loading copy. Everything else
 * that is not a fresh snapshot degrades to `unavailable` (channel missing,
 * corrupt feed, or stale beyond the window).
 */
export function describeRosterPanel(
  state: RosterPanelState,
  nowMs: number,
  windowMs: number = ROSTER_STALE_WINDOW_MS,
): RosterPanelView {
  if (state.kind === "waiting") return { kind: "loading" };
  if (state.kind !== "snapshot") return { kind: "unavailable" };
  if (isRosterSnapshotStale(state.snapshot, nowMs, windowMs)) {
    return { kind: "unavailable" };
  }
  if (state.snapshot.workers.length === 0) return { kind: "empty" };
  return {
    kind: "rows",
    rows: state.snapshot.workers.map((worker) => {
      const finished = isTerminalStatus(worker.status);
      const landed = finished && !worker.delivered;
      return {
        workerId: worker.workerId,
        title: worker.title.length > 0 ? worker.title : worker.workerId,
        statusLabel: rosterStatusLabel(worker.status),
        visual: rosterStatusVisual(worker.status),
        todoId: worker.todoId,
        blocked: worker.blocked,
        marker:
          worker.blocked !== null
            ? { kind: "blocked", blocked: worker.blocked }
            : landed
              ? { kind: "landed" }
              : null,
        finished,
        elapsedText: formatRosterElapsed(nowMs - worker.startedAtMs),
        toolCallCount: worker.toolCallCount,
      };
    }),
  };
}

/**
 * Localize the blocked waiting phrase for an access class. Unknown classes
 * fall back to the generic `other` phrase (the parser admits only known
 * classes, so this guards copy drift, not wire corruption).
 */
export function rosterBlockedKey(accessClass: AccessClass): string {
  return `roster.blocked.${accessClass}`;
}
