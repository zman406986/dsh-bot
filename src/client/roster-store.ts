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
 *
 * Sections (ticket 28, design-17 §4.2). The ready view is partitioned into
 * three sections so "what is happening / what needs me / what finished" is
 * glanceable:
 * - **Active** — `spawned`/`running`/`steering` with nothing owed;
 * - **Needs you** — blocked (a pending ask) or terminal-and-undelivered
 *   (landed: the result is ready but not yet delivered to the user);
 * - **Finished** — terminal and delivered, collapsed to a muted count line.
 *
 * **Needs you is our addition, and it is the honest pull-only stand-in for
 * push attention.** The reference routes "a worker wants you" through
 * push-like roster markers; no push seam exists here and no surface may
 * promise or simulate one (design-17 §4.8). So the panel cannot interrupt:
 * when the user *looks*, it must say at a glance which rows are waiting on
 * them. Precedence follows the design-17 §4.1 marker rule — blocked outranks
 * landed — so a row that is both renders in Needs-you as blocked, never as
 * "result ready".
 *
 * Nothing new is stored for any of this: the partition is a pure view-model
 * read of existing snapshot v2 fields (`status`, `blocked`, `delivered`);
 * sections are derived data, never a second source of truth (design-17 §5
 * conflict 8 — no new core state, no new seams).
 *
 * State vocabulary alignment (presentation only; the store's state machine
 * above is unchanged, design-17 §4.2): `waiting` → `roster.loading`, empty
 * snapshot → `roster.empty`, fresh snapshot → the three sections, and
 * `invalid` / stale / `channel-missing` → the single honest
 * `roster.unavailable` copy.
 */
import {
  ROSTER_SETTINGS_KEY,
  ROSTER_STALE_WINDOW_MS,
  isRosterSnapshotStale,
  parseRosterSnapshot,
  type RosterSnapshot,
  type RosterSnapshotBlocked,
  type RosterSnapshotWorker,
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

/** The three sections of the ready panel (ticket 28, design-17 §4.2). */
export type RosterSectionId = "active" | "needs-you" | "finished";

/** Section order is fixed: Active, Needs you, Finished. */
export const ROSTER_SECTION_IDS: readonly RosterSectionId[] = [
  "active",
  "needs-you",
  "finished",
];

/** Locale key for each section heading; identical key sets in both faces. */
export const ROSTER_SECTION_KEYS: Readonly<Record<RosterSectionId, string>> = {
  active: "roster.section.active",
  "needs-you": "roster.section.needs-you",
  finished: "roster.section.finished",
};

/** Locale key for the collapsed finished-count line ({count} finished). */
export const ROSTER_FINISHED_COUNT_KEY = "roster.finished.count";

/**
 * One rendered roster row (tickets 27 + 28). Everything here derives from
 * the snapshot row; the component only localizes phrases.
 */
export interface RosterRowView {
  readonly workerId: string;
  /**
   * Title or the generic kind-typed fallback (`worker w-3`) when the
   * snapshot carries an empty title (design-17 §4.2: "real title or generic
   * kind+id label").
   */
  readonly title: string;
  /**
   * Kind-typed generic label derived from the snapshot's `kind` field
   * (design-17 §4.2 / §5 conflict 6). v2 ships exactly one kind, so this is
   * `"worker"` today; {@link rosterKindLabel} is the trivial extension point
   * and forwards an unknown kind verbatim rather than hiding the row.
   */
  readonly kindLabel: string;
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
  /**
   * Which section this row belongs to. Derived once here so the partition
   * rule is asserted in tests rather than re-implemented in the component.
   */
  readonly section: RosterSectionId;
  /**
   * The collapsed presentation hides this row: it is terminal and delivered,
   * so it contributes to the finished count line instead of rendering as a
   * row. Never true outside the finished section.
   */
  readonly collapsed: boolean;
  /** Start time on the client clock, compact local "HH:MM". */
  readonly startText: string;
  /** Elapsed since start against the render clock, compact ("3m 5s"). */
  readonly elapsedText: string;
  readonly toolCallCount: number;
}

/** One section of the ready panel; always present, possibly with no rows. */
export interface RosterSectionView {
  readonly id: RosterSectionId;
  /** Locale key for the heading (`roster.section.*`). */
  readonly titleKey: string;
  /**
   * Every row in this section, in snapshot order. Collapsed rows are
   * included (the component hides them behind the count line so the design's
   * "collapses to a count line that expands" stays presentation-only).
   */
  readonly rows: readonly RosterRowView[];
  /**
   * Finished section only: how many terminal-delivered rows
   * {@link RosterRowView.collapsed} hides behind the muted count line
   * (`roster.finished.count`). `0` for the other sections.
   */
  readonly collapsedCount: number;
}

/**
 * Panel view outcome: what the component should render. The `rows` variant
 * always carries all three sections in {@link ROSTER_SECTION_IDS} order;
 * the panel skips empty ones, so the shape stays stable for tests.
 */
export type RosterPanelView =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "rows"; readonly sections: readonly RosterSectionView[] };

/**
 * Locale key for a view's non-row state copy, or `null` when the view
 * renders sections (design-17 §4.2 vocabulary alignment, presentation only):
 * `waiting` → loading, empty snapshot → empty, and `invalid` / stale /
 * `channel-missing` → the single unavailable copy. Exported so the mapping
 * is asserted offline instead of only in JSX.
 */
export function rosterViewCopyKey(view: RosterPanelView): string | null {
  switch (view.kind) {
    case "unavailable":
      return "roster.unavailable";
    case "loading":
      return "roster.loading";
    case "empty":
      return "roster.empty";
    case "rows":
      return null;
  }
}

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
 * Kind-typed generic label from the snapshot's `kind` field (design-17 §4.2 /
 * §5 conflict 6). v2 admits exactly one producer kind, `"worker"`; the map
 * is the trivial extension point for a future kind and an unknown kind
 * forwards verbatim (the row still renders rather than vanishing).
 */
export function rosterKindLabel(kind: RosterSnapshotWorker["kind"]): string {
  const labels: Readonly<Record<string, string>> = { worker: "worker" };
  return labels[kind] ?? kind;
}

/**
 * The generic title used when the snapshot carries no title: kind + id
 * (`worker w-3`), never a blank row and never a second display vocabulary
 * for the kind (design-17 §4.2).
 */
export function rosterGenericTitle(
  kind: RosterSnapshotWorker["kind"],
  workerId: string,
): string {
  return `${rosterKindLabel(kind)} ${workerId}`;
}

/**
 * Start time on the client clock, compact local `HH:MM` (`09:07`). Locale
 * neutral on purpose — the panel's other time text (`formatRosterElapsed`)
 * is too, and no date library is a dependency here.
 */
export function formatRosterStartTime(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Section assignment (ticket 28, design-17 §4.2) — a pure read of the two
 * existing snapshot fields, with the design's marker precedence:
 *
 * 1. **blocked** (a pending ask) → Needs you, whatever the status;
 * 2. else **terminal and undelivered** (landed) → Needs you;
 * 3. else **terminal and delivered** → Finished (collapsed by default);
 * 4. else (`spawned` / `running` / `steering`) → Active.
 *
 * Blocked outranking landed is the whole point of step 1: a row that is both
 * renders as blocked, never as "result ready". Terminal statuses come from
 * the core FSM (`isTerminalStatus`), not a second list kept here.
 */
export function rosterSectionFor(
  status: WorkerStatus,
  blocked: RosterSnapshotBlocked | null,
  delivered: boolean,
): RosterSectionId {
  if (blocked !== null) return "needs-you";
  if (isTerminalStatus(status)) return delivered ? "finished" : "needs-you";
  return "active";
}

/**
 * Pure view model for the panel (tickets 27 + 28). Waiting means the channel
 * is alive but nothing has been mirrored yet — loading copy. Everything else
 * that is not a fresh snapshot degrades to `unavailable` (channel missing,
 * corrupt feed, or stale beyond the window). A fresh snapshot partitions
 * into the three sections described in the module comment.
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

  const rows = state.snapshot.workers.map((worker): RosterRowView => {
    const finished = isTerminalStatus(worker.status);
    const landed = finished && !worker.delivered;
    const section = rosterSectionFor(
      worker.status,
      worker.blocked,
      worker.delivered,
    );
    return {
      workerId: worker.workerId,
      title:
        worker.title.length > 0
          ? worker.title
          : rosterGenericTitle(worker.kind, worker.workerId),
      kindLabel: rosterKindLabel(worker.kind),
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
      section,
      // Only delivered terminal rows collapse; landed rows must stay visible
      // (they are the pull-surface proof of the S6 delivery rule).
      collapsed: section === "finished",
      startText: formatRosterStartTime(worker.startedAtMs),
      elapsedText: formatRosterElapsed(nowMs - worker.startedAtMs),
      toolCallCount: worker.toolCallCount,
    };
  });

  return {
    kind: "rows",
    sections: ROSTER_SECTION_IDS.map((id): RosterSectionView => {
      const inSection = rows.filter((row) => row.section === id);
      return {
        id,
        titleKey: ROSTER_SECTION_KEYS[id],
        rows: inSection,
        collapsedCount: inSection.filter((row) => row.collapsed).length,
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
