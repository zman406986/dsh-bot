/**
 * Capsule expansion store + collapsed-chip/activation-row view models
 * (tickets 38 + 39, ADR-0013).
 *
 * Pure and dependency-light, same discipline as `roster-store.ts`: no React,
 * no DOM, no Cordis — asserted directly by offline tests
 * (`test/client-capsule-chip.test.ts` and
 * `test/client-capsule-activation.test.ts`).
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
 *
 * Ticket 39 adds the expanded panel's activation row on the same discipline:
 * a pure view model over the same store truth, mapping every store kind to
 * exactly one composition —
 *
 * - `dormant` (`waiting`) — the unactivated chat's whole experience: the
 *   activation pitch with a single start affordance, roster sections hidden;
 * - `activated` (fresh snapshot, empty or not — a snapshot only exists once
 *   the host published one) — the active state line plus a stop INTENT
 *   affordance and the roster sections below;
 * - `unavailable` (stale / `invalid` / `channel-missing`) — the honest
 *   degraded copy and NO start/stop affordance: nothing actionable pretends
 *   the channel can carry an activation.
 *
 * ADR-0005/0009 discipline (ticket 31's no-stop guard): there is no
 * off-while-running, so the stop affordance is not a kill/deactivate
 * control. It is an INTENT — a payload ("stop") handed to an injected
 * callback; ticket 40 binds that callback to the same user-verbatim command
 * path as everything else. The view model structurally carries no direct
 * stop/deactivate authority (asserted in the guard tests), only the intent
 * payload and a label key. Likewise no "active since" timestamp: the
 * snapshot carries only `publishedAtMs`, which must never be presented as
 * activation time, and the adapter offers no honest `activatedAtMs` — the
 * timestamp is omitted entirely rather than faked.
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

/**
 * The activation row's intent payload (ticket 39): what the affordance asks
 * the injected callback to arrange. `"stop"` is a conversational stop
 * INTENT — never direct kill/deactivate authority (ticket 31's guard);
 * ticket 40 binds both payloads to the user-verbatim command path.
 */
export type CapsuleActivationIntent = "start" | "stop";

/** Injected callback seat for activation intents (factory injection). */
export type OnActivationIntent = (intent: CapsuleActivationIntent) => void;

/**
 * The factory's default seat: a no-op, so the capsule stays render-only
 * until ticket 40 binds the real transport.
 */
export function noopOnActivationIntent(_intent: CapsuleActivationIntent): void {
  // Render-only default: an unbound capsule asks the host for nothing.
}

/**
 * The activation row's single actionable control: the intent payload plus
 * its locale label. Deliberately NOTHING else — no handler, handle, or
 * command text — so the view model structurally cannot carry direct
 * stop/deactivate authority (ticket 31's guard, extended).
 */
export interface CapsuleActivationAffordance {
  readonly intent: CapsuleActivationIntent;
  readonly labelKey: string;
}

/**
 * Exactly one composition per store kind (ticket 39): `dormant` renders the
 * activation pitch and hides the roster sections, `activated` renders the
 * row plus the sections, `unavailable` renders the honest degraded copy with
 * no actionable affordance and no sections.
 */
export type CapsuleActivationComposition =
  | "dormant"
  | "activated"
  | "unavailable";

/** The expanded panel's activation row view model (ticket 39). */
export interface CapsuleActivationRowView {
  readonly composition: CapsuleActivationComposition;
  /**
   * Locale key for the row's state line — the `capsule.dot.*` vocabulary
   * reused, so row and chip never disagree about the session's state.
   */
  readonly stateKey: string;
  /**
   * The one affordance of the row, or `null` in the `unavailable`
   * composition: a degraded channel asks for nothing.
   */
  readonly affordance: CapsuleActivationAffordance | null;
}

/**
 * Pure activation-row view model over the panel state (ticket 39), with the
 * chip's exact truth rules: `waiting` is dormant (the pre-activation face),
 * a fresh snapshot is activated (empty included — a snapshot only exists
 * once the host published one), and stale/invalid/channel-missing is
 * unavailable. `windowMs` defaults to the shared stale window;
 * exactly-at-window counts as fresh, mirroring `isRosterSnapshotStale`.
 */
export function describeCapsuleActivationRow(
  state: RosterPanelState,
  nowMs: number,
  windowMs: number = ROSTER_STALE_WINDOW_MS,
): CapsuleActivationRowView {
  if (state.kind === "waiting") {
    return {
      composition: "dormant",
      stateKey: CAPSULE_DOT_KEYS.dormant,
      affordance: { intent: "start", labelKey: CAPSULE_ACTIVATION_START_KEY },
    };
  }
  if (
    state.kind !== "snapshot" ||
    isRosterSnapshotStale(state.snapshot, nowMs, windowMs)
  ) {
    return {
      composition: "unavailable",
      stateKey: CAPSULE_DOT_KEYS.error,
      affordance: null,
    };
  }
  return {
    composition: "activated",
    stateKey: CAPSULE_DOT_KEYS.active,
    affordance: { intent: "stop", labelKey: CAPSULE_ACTIVATION_STOP_KEY },
  };
}

/**
 * Forward the affordance's exact intent payload to the injected callback —
 * the whole click behavior of the activation row, kept a pure named
 * function so the "exact payload per affordance" contract is asserted
 * offline (the component's `onClick` is exactly this call).
 */
export function dispatchActivationIntent(
  affordance: CapsuleActivationAffordance,
  onActivationIntent: OnActivationIntent,
): void {
  onActivationIntent(affordance.intent);
}

/** Locale key for the dormant row's start affordance. */
export const CAPSULE_ACTIVATION_START_KEY = "capsule.activation.start";

/** Locale key for the active row's stop-intent affordance. */
export const CAPSULE_ACTIVATION_STOP_KEY = "capsule.activation.stop";

/** Locale key for the dormant composition's activation-pitch body line. */
export const CAPSULE_ACTIVATION_PITCH_KEY = "capsule.activation.pitch";
