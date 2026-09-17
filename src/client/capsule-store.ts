/**
 * Capsule expansion store + collapsed-chip view model (ticket 38, ADR-0013).
 *
 * Pure and dependency-light, same discipline as `roster-store.ts`: no React,
 * no DOM, no Cordis — asserted directly by offline tests
 * (`test/client-capsule-chip.test.ts`).
 *
 * ADR-0013: the dispatcher capsule is ONE additive `shell.overlay` entry —
 * collapsed = a small chip (activation-state dot, worker count, wake badge),
 * expanded = the panel card. The host offers no expansion, geometry, or
 * anchoring API (verified seam 1, `docs/research/dsh-capsule-seams.md`), so
 * expansion is the entry's OWN state: a tiny second store next to the roster
 * store. Default **collapsed**; it survives re-renders (the component closure
 * holds the store) and resetting on a fiber reload (HMR) is fine — a fresh
 * fiber starts collapsed again.
 *
 * The chip view model is a pure function over the EXISTING panel state plus
 * freshness, in the style of `describeRosterPanel` — no new truth, no second
 * snapshot source (design-17 §5 conflict 8). The three dot states map from
 * store truth only:
 *
 * - `dormant` — no snapshot observed (`waiting`): the feed is alive, the
 *   dispatcher has not published anything yet. This is the pre-activation
 *   face of an honest chip, including "unavailable channel" before any
 *   activation: the store's initial state is `waiting`, and only a broken
 *   feed (`invalid`) or a missing settings service (`channel-missing`) can
 *   say otherwise.
 * - `active` — a fresh snapshot: the dispatcher is publishing right now.
 * - `error` — the degraded cases: a stale snapshot (was publishing, went
 *   quiet past the stale window), `invalid` (a corrupted feed), or
 *   `channel-missing` (no settings service at all). Each is only reachable
 *   once an activation was seen or the channel itself is broken — never
 *   confused with the quiet pre-activation `waiting`.
 *
 * Counts come from a fresh snapshot only. A stale feed vouches for nothing
 * (the panel degrades to "unavailable" wholesale), so a degraded chip never
 * carries a count that could be a fake — the wake badge especially (settled
 * workers with undelivered results) must never flicker on data the client
 * can no longer vouch for.
 */
import {
  ROSTER_STALE_WINDOW_MS,
  isRosterSnapshotStale,
  type RosterSnapshot,
} from "../core/roster-snapshot.js";
import { isTerminalStatus } from "../core/types.js";
import type { RosterPanelState } from "./roster-store.js";

/** The activation dot's exactly-three states (ticket 38). */
export type CapsuleChipDot = "dormant" | "active" | "error";

/** The collapsed chip's view model. */
export interface CapsuleChipView {
  /** The activation dot state (CSS hook + accessible label key). */
  readonly dot: CapsuleChipDot;
  /**
   * Snapshot worker total; `null` hides the count. Rendered only in
   * `active` — anything else has no fresh truth to count.
   */
  readonly workerCount: number | null;
  /**
   * Settled (terminal-status) workers with `delivered === false` — the wake
   * badge. `null` hides it (no fresh snapshot); `0` also renders nothing
   * (nothing is owed) but says "fresh snapshot, nobody is waiting", which a
   * `null` must never claim.
   */
  readonly wakeCount: number | null;
}

/**
 * Pure chip view model over the panel state (ticket 38). `windowMs` defaults
 * to the shared stale window; exactly-at-window counts as fresh, mirroring
 * `isRosterSnapshotStale`.
 */
export function describeCapsuleChip(
  state: RosterPanelState,
  nowMs: number,
  windowMs: number = ROSTER_STALE_WINDOW_MS,
): CapsuleChipView {
  if (state.kind === "waiting") {
    return { dot: "dormant", workerCount: null, wakeCount: null };
  }
  if (state.kind !== "snapshot") {
    // `channel-missing` / `invalid`: degraded, no counts.
    return { dot: "error", workerCount: null, wakeCount: null };
  }
  if (isRosterSnapshotStale(state.snapshot, nowMs, windowMs)) {
    // Was active, went quiet: vouch for nothing, not for old counts.
    return { dot: "error", workerCount: null, wakeCount: null };
  }
  return {
    dot: "active",
    workerCount: state.snapshot.workers.length,
    wakeCount: countSettledUndelivered(state.snapshot),
  };
}

/**
 * The wake-badge count: settled (terminal-status) workers whose results have
 * not been delivered to the user yet (S6: completed means delivered, so a
 * landed-undelivered row is exactly a worker waiting to wake the user).
 * Terminal statuses come from the core FSM, never a second list.
 */
function countSettledUndelivered(snapshot: RosterSnapshot): number {
  return snapshot.workers.filter(
    (worker) => isTerminalStatus(worker.status) && !worker.delivered,
  ).length;
}

/** Box handed to React's `useSyncExternalStore` for the expansion state. */
export interface CapsuleStoreBox {
  readonly expanded: boolean;
  readonly version: number;
}

export interface CapsuleStore {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): CapsuleStoreBox;
  /** Expand the capsule (idempotent: no change, no notify when already open). */
  expand(): void;
  /** Collapse the capsule (idempotent, same rule). */
  collapse(): void;
  /** Flip the expansion state. */
  toggle(): void;
  /** Subscribe; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
}

/**
 * The capsule's own expansion state (ADR-0013: the entry owns it). Box
 * identity changes only on a real transition so `useSyncExternalStore`
 * never re-renders on a no-op.
 */
export function createCapsuleStore(): CapsuleStore {
  let expanded = false;
  let version = 0;
  let box: CapsuleStoreBox = { expanded, version };
  const listeners = new Set<() => void>();

  function set(next: boolean): void {
    if (next === expanded) return;
    expanded = next;
    version += 1;
    box = { expanded, version };
    for (const listener of [...listeners]) {
      listener();
    }
  }

  return {
    getBox() {
      return box;
    },
    expand() {
      set(true);
    },
    collapse() {
      set(false);
    },
    toggle() {
      set(!expanded);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Locale key for the chip button's accessible label (expand affordance). */
export const CAPSULE_CHIP_OPEN_KEY = "capsule.chip.open";

/** Locale key for the worker-count text (`{count}` substituted). */
export const CAPSULE_CHIP_WORKERS_KEY = "capsule.chip.workers";

/** Locale key for the wake badge text (`{count}` substituted). */
export const CAPSULE_CHIP_WAKE_KEY = "capsule.chip.wake";

/** Locale key for the expanded card's collapse affordance. */
export const CAPSULE_COLLAPSE_KEY = "capsule.collapse";

/**
 * Locale key per dot state, for the dot's accessible label. Exported so the
 * mapping is asserted offline instead of only in JSX.
 */
export const CAPSULE_DOT_KEYS: Readonly<Record<CapsuleChipDot, string>> = {
  dormant: "capsule.dot.dormant",
  active: "capsule.dot.active",
  error: "capsule.dot.error",
};
