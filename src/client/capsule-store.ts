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
 *
 * Ticket 41 adds the expanded panel's deliverables line on the same
 * discipline: a pure view model over the snapshot's existing truth — the
 * count of settled-undelivered workers (the chip's wake math, shared) plus
 * the v3 snapshot's bounded `recentResult` excerpt. Count 0 or any degraded
 * state hides the line entirely; a landed row without an honest excerpt
 * (a post-restart restore — markers carry no report text) renders the line
 * count-only, never an invented text. The excerpt's expand/collapse is the
 * entry's OWN state too: `deliverablesOpen` rides the capsule store's box.
 *
 * Ticket 42 adds the expanded card's footer on the same discipline, with
 * epic 35 §5's honesty rules applied to the two degraded seams
 * (`docs/research/dsh-capsule-seams.md` verdicts 4–5):
 *
 * - **Flag provenance** comes from the SAME watched settings namespace the
 *   roster rides in on — a second tiny store (`CapsuleFooterStore`) fed by
 *   the identical watch payload, so the footer never opens a second channel.
 *   The persisted `enabled` value (ADR-0005) is exactly what the setting
 *   says, not the running session's frozen flag — the copy speaks of the
 *   setting. Before any document arrives (or if the key is unreadable) the
 *   segment is omitted entirely: degrade to omission, never a guess.
 * - **Profile identity** is omitted permanently in v1: no client-visible
 *   source exists (seam 5), and `$host.home` is not a profile name —
 *   relabeling it would be an invented fact. Recorded gap, not a TODO.
 * - **Settings link** degrades to a copy-only hint naming the path
 *   (seam 4: no deep-link/navigation API exists); no button, no channel.
 */
import {
  ROSTER_STALE_WINDOW_MS,
  isRosterSnapshotStale,
  type RosterSnapshot,
  type RosterSnapshotRecentResult,
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
  /** Ticket 41: whether the deliverables line's excerpt is expanded. */
  readonly deliverablesOpen: boolean;
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
  /** Flip the deliverables excerpt's expand/collapse state (ticket 41). */
  toggleDeliverables(): void;
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
  let deliverablesOpen = false;
  let version = 0;
  let box: CapsuleStoreBox = { expanded, deliverablesOpen, version };
  const listeners = new Set<() => void>();

  function notify(): void {
    version += 1;
    box = { expanded, deliverablesOpen, version };
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function set(next: boolean): void {
    if (next === expanded) return;
    expanded = next;
    notify();
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
    toggleDeliverables() {
      deliverablesOpen = !deliverablesOpen;
      notify();
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

/** Locale key for the deliverables line's label (ticket 41). */
export const CAPSULE_DELIVERABLES_LABEL_KEY = "capsule.deliverables.label";

/** Locale key for the deliverables count phrasing (`{count}` substituted). */
export const CAPSULE_DELIVERABLES_COUNT_KEY = "capsule.deliverables.count";

/** Locale key for the excerpt's expand affordance (ticket 41). */
export const CAPSULE_DELIVERABLES_EXPAND_KEY = "capsule.deliverables.expand";

/** Locale key for the excerpt's collapse affordance (ticket 41). */
export const CAPSULE_DELIVERABLES_COLLAPSE_KEY = "capsule.deliverables.collapse";

/**
 * The settings-document key carrying the feature flag (ticket 42). Same
 * on-disk key the host schema persists (`src/plugin.ts` `Config.enabled`)
 * inside the plugin namespace; mirrored here because the client must not
 * import host code. ADR-0005: the value is the persisted default — the
 * running session froze its own copy at apply, so footer copy never calls
 * it the live session state.
 */
export const FLAG_SETTINGS_KEY = "enabled";

/** Locale key for the footer's flag-provenance line, flag on (ticket 42). */
export const CAPSULE_FOOTER_FLAG_ON_KEY = "capsule.footer.flag.on";

/** Locale key for the footer's flag-provenance line, flag off (ticket 42). */
export const CAPSULE_FOOTER_FLAG_OFF_KEY = "capsule.footer.flag.off";

/**
 * Locale key for the footer's Settings hint (ticket 42). Degraded seam 4:
 * no Settings deep-link exists, so this is copy-only — the path is named,
 * nothing navigates.
 */
export const CAPSULE_FOOTER_SETTINGS_HINT_KEY = "capsule.footer.settings-hint";

/**
 * The expanded card's footer view model (ticket 42). `flagEnabled` is the
 * persisted flag value from the watched settings document, or `null` when
 * nothing vouches yet (no document seen, non-object payload, unreadable
 * key) — `null` omits the segment entirely (honest omission).
 */
export interface CapsuleFooterView {
  readonly flagEnabled: boolean | null;
}

/**
 * Pure footer view model over one watched settings document (ticket 42).
 * Defensive like every parser here: any deviation degrades to `null`
 * (omission), never a guessed flag state.
 */
export function describeCapsuleFooter(channelValue: unknown): CapsuleFooterView {
  if (typeof channelValue !== "object" || channelValue === null) {
    return { flagEnabled: null };
  }
  const enabled = (channelValue as Record<string, unknown>)[FLAG_SETTINGS_KEY];
  return { flagEnabled: typeof enabled === "boolean" ? enabled : null };
}

/** Box handed to React's `useSyncExternalStore` for the footer. */
export interface CapsuleFooterBox {
  readonly flagEnabled: boolean | null;
  readonly version: number;
}

export interface CapsuleFooterStore {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): CapsuleFooterBox;
  /**
   * Feed one payload from the SAME settings watch that feeds the roster
   * store (never a second channel). A vouching boolean updates the box;
   * anything else leaves the last vouched value standing — a persisted
   * setting does not turn into a guess just because one write skipped it.
   */
  applyChannelValue(value: unknown): void;
  /** Subscribe; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
}

/**
 * The footer's own store (ticket 42). Box identity changes only when the
 * vouched value actually flips, so `useSyncExternalStore` never re-renders
 * on unrelated settings writes.
 */
export function createCapsuleFooterStore(): CapsuleFooterStore {
  let flagEnabled: boolean | null = null;
  let version = 0;
  let box: CapsuleFooterBox = { flagEnabled, version };
  const listeners = new Set<() => void>();

  return {
    getBox() {
      return box;
    },
    applyChannelValue(value: unknown) {
      const view = describeCapsuleFooter(value);
      if (view.flagEnabled === null || view.flagEnabled === flagEnabled) return;
      flagEnabled = view.flagEnabled;
      version += 1;
      box = { flagEnabled, version };
      for (const listener of [...listeners]) {
        listener();
      }
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
 * The expanded panel's deliverables line view model (ticket 41): the count
 * of settled-but-undelivered workers — exactly the chip's wake math, never
 * a second tally — plus the snapshot's bounded most-recent excerpt. The
 * chip's truth rules apply whole: only a FRESH snapshot vouches, so a
 * degraded or stale feed yields `visible: false` and `count: null` (never a
 * count the feed can no longer back). `visible` is false at count 0 — the
 * line hides entirely when nothing is owed — and the excerpt rides along
 * only while the line is visible; a landed row with no honest text (a
 * post-restart restore) renders count-only with `excerpt: null`.
 */
export interface CapsuleDeliverablesView {
  /** Whether the line renders at all (fresh snapshot and count > 0). */
  readonly visible: boolean;
  /** Settled-undelivered count; `null` when no fresh snapshot vouches. */
  readonly count: number | null;
  /** The snapshot's most-recent excerpt, or `null` when none is owed/held. */
  readonly excerpt: RosterSnapshotRecentResult | null;
}

/**
 * Pure deliverables-line view model over the panel state (ticket 41).
 * `windowMs` defaults to the shared stale window; exactly-at-window counts
 * as fresh, mirroring `isRosterSnapshotStale`.
 */
export function describeCapsuleDeliverables(
  state: RosterPanelState,
  nowMs: number,
  windowMs: number = ROSTER_STALE_WINDOW_MS,
): CapsuleDeliverablesView {
  if (
    state.kind !== "snapshot" ||
    isRosterSnapshotStale(state.snapshot, nowMs, windowMs)
  ) {
    return { visible: false, count: null, excerpt: null };
  }
  const count = countSettledUndelivered(state.snapshot);
  return {
    visible: count > 0,
    count,
    excerpt: count > 0 ? state.snapshot.recentResult ?? null : null,
  };
}
