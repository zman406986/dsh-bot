/**
 * Onboarding first-run flow — pure data + decisions (ticket 68, ADR-0018
 * in-scope area).
 *
 * The reference runs a guided first-run sequence; re-entry is suppressed once
 * the user has seen it or owns at least one agent, and probe failures fail
 * open so a transient read cannot strand first-run
 * (`docs/research/always-on-dispatcher-behavior.md:18`). Honesty note: the
 * reference onboarding is account/product-bound; ours is a lightweight flow
 * (`:87`).
 *
 * The BEAT TABLE below is the cited disposition of every reference beat
 * (never the reference tree; copy is ours per exception B9):
 *
 * | Reference beat (cite `always-on-dispatcher-behavior.md:18`) | Our disposition |
 * |---|---|
 * | Sign-in | **U-A gap** — no privacy/account gates (ADR-0018 exception 12); recorded, never invented |
 * | Animated "meet your agents" intro | **Honest counterpart** — static intro beat (no animation: the shell CSS discipline); adapted copy |
 * | Computer-readiness demo | **71-dependent capability gap** — the remote computer/desktop area is ticket 71's gate; recorded until it resolves |
 * | Background-jobs explainer | **Honest counterpart, narrowed** — our wake model is single-kind (ADR-0018 C15): only dispatched workers; the beat says exactly that |
 * | Tools beat | **Honest counterpart** — workers act through tools under the user's approvals; the dispatcher asks first |
 * | Creating the first agent | **Honest counterpart, user-driven only (U-G)** — first dispatcher session = create a chat and activate it; no runtime agent management |
 * | Hand-off into the shell | **Honest counterpart** — final beat hands off to the sidebar/panes of OUR shell frame |
 * | Re-entry suppression: seen OR owns ≥1 agent (`:18`) | Seen record in our settings namespace OR ≥1 dispatcher mirror key (`roster.<sessionId>`, tickets 76/79 keying) ⇒ suppressed |
 * | Probe failures fail open (`:18`) | A corrupt or unreadable suppression record ⇒ SHOW onboarding — never silently hide |
 *
 * Suppression design (A5: no second store): "≥1 dispatcher session" is read
 * from the shell store's per-session mirrors — a mirror that is not `cleared`
 * means the session is (or was, this document cycle) one of our dispatcher
 * sessions. The seen record had its own key in our settings namespace; dsh
 * 0.2.1 accepts only the plugin's declared volatile fields, so that record
 * has no channel and the flow falls back to the mirror input plus the
 * completion state.
 *
 * FAIL-OPEN is the load-bearing rule (the reference's own, adapted): the
 * suppression flag EXISTS to hide this flow, so a corrupt or unreadable
 * record must never hide it. Only a well-formed `{seen: true}` record
 * suppresses by itself. (This is the deliberate inverse of ticket 79's data
 * mirrors, which fail closed — a corrupt roster snapshot degrades presence
 * to "unavailable" instead of showing wrong data. Here the risk is stranding
 * first-run, not wrong data, so the failure direction flips.)
 *
 * THE READ RACE (ticket 87, live pass 4): a fresh page binds the scope while
 * the shared describe mirror is still mid-read (`loading`, value `undefined`)
 * — the record is persisted and served, but NOT YET DELIVERED. The store
 * therefore tracks `buffering`: a read IN FLIGHT holds the pane at a calm
 * `pending` view. That read no longer exists on 0.2.1, so a composition that
 * never feeds the store never buffers; the pure state is retained for a
 * future channel and remains pinned offline.
 *
 * Pure state machine + decisions: no React, no DOM, no Cordis. Offline tests
 * drive the suppression matrix, the record parsing, the beat walk, and the
 * pane view model (S8); the pane component lives in `onboarding-pane.tsx`
 * (build + typecheck territory), the composition wiring in `index.ts`.
 */
import type { ShellMirror } from "./shell-store.js";

/**
 * The well-formed seen record: `{ seen: true }` (plus optional bookkeeping
 * fields such as a timestamp). EXTRA fields are tolerated — forward
 * compatibility — but `seen` must be exactly the boolean `true`; anything
 * else is corruption and reads as "not seen" (fail-open).
 */
export function isOnboardingSeenRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as { seen?: unknown }).seen === true;
}

/**
 * The suppression decision (AC 2): suppressed when a well-formed seen record
 * stands OR at least one dispatcher session exists (a mirror that is not
 * `cleared` — a live snapshot, or a corrupt one whose KEY still proves the
 * session is ours). Every unreadable/corrupt input falls toward SHOW: an
 * undefined/absent record, a malformed record, or a document that never
 * carried the key all read as "not seen", and only non-cleared mirrors
 * count. A transient suppression read can never strand first-run.
 */
export function isOnboardingSuppressed(
  seenValue: unknown,
  mirrors: ReadonlyMap<string, ShellMirror>,
): boolean {
  if (isOnboardingSeenRecord(seenValue)) return true;
  for (const mirror of mirrors.values()) {
    if (mirror.kind !== "cleared") return true;
  }
  return false;
}

/** One beat: an id (stable, test/telemetry-free) plus its two copy keys. */
export interface OnboardingBeat {
  readonly id: string;
  /** Locale key of the beat's heading (`shell.onboard.*`, en+zh). */
  readonly titleKey: string;
  /** Locale key of the beat's one-paragraph body. */
  readonly bodyKey: string;
}

/**
 * The beat walk — the honest-counterpart rows of the module-header table in
 * shell order (the U-A gap rows and the 71-dependent demo have no beat: a
 * gap is recorded, never staged as a pane). Five beats, no sub-steps, no
 * branching: the minimum that maps the reference's sequence (intro →
 * background-jobs → tools → first agent → hand-off) onto dsh.
 */
export const ONBOARDING_BEATS: readonly OnboardingBeat[] = [
  {
    id: "intro",
    titleKey: "shell.onboard.intro.title",
    bodyKey: "shell.onboard.intro.body",
  },
  {
    id: "background",
    titleKey: "shell.onboard.background.title",
    bodyKey: "shell.onboard.background.body",
  },
  {
    id: "tools",
    titleKey: "shell.onboard.tools.title",
    bodyKey: "shell.onboard.tools.body",
  },
  {
    id: "first",
    titleKey: "shell.onboard.first.title",
    bodyKey: "shell.onboard.first.body",
  },
  {
    id: "handoff",
    titleKey: "shell.onboard.handoff.title",
    bodyKey: "shell.onboard.handoff.body",
  },
];

/**
 * The pane's phase: walking the beats, or finished (flag write handed off).
 */
export type OnboardingPhase = "beats" | "done";

/** The store's immutable state; `version` fences `useSyncExternalStore`. */
export interface OnboardingBox {
  /**
   * The raw seen-record value as last delivered from the namespace document
   * (`undefined` = no readable record — fail-open input).
   */
  readonly seenValue: unknown;
  /**
   * The bound scope reported its namespace document MID-READ (`loading`, or a
   * value-less `ready` — the shipped controller's pre-acceptance state): the
   * suppression input is not deliverable YET, so the pane buffers at the calm
   * pending view instead of rendering the flow from the fail-open default
   * (ticket 87's reload-#1 re-show). False is the resting state: a runtime
   * that never reports in-flight (no settings channel) never buffers — the
   * flow shows, the original fail-open pin. Reactively cleared when the
   * document lands or the namespace reads as unreadable.
   */
  readonly buffering: boolean;
  /** Index into {@link ONBOARDING_BEATS} while `phase` is `"beats"`. */
  readonly beatIndex: number;
  readonly phase: OnboardingPhase;
  /**
   * The seen write did not land (no write path, or it threw): the pane shows
   * the honest notice and the flow will show again next launch — fail-open,
   * never a fake "saved".
   */
  readonly saveFailed: boolean;
  readonly version: number;
}

/**
 * The onboarding UI store: the suppression INPUT (a seen record fed by
 * whatever channel owns it), the beat walk, and the save outcome. The
 * dispatcher mirrors come from the shell store at decision time (the pane
 * reads both stores), so this store never copies them.
 */
export interface OnboardingStore {
  /** Stable getter for `useSyncExternalStore`. */
  getBox(): OnboardingBox;
  /** Subscribe to box replacements; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void;
  /**
   * Feed the seen record value as its owning channel delivered it (or
   * `undefined` when it is unreadable — an explicit fail-open reset).
   * Publishes only when the value actually changes.
   */
  applySeenValue(value: unknown): void;
  /**
   * Feed one read result — status and seen record together. `loading`
   * (or a value-less `ready`) sets `buffering` — the pane's read is in
   * flight; a delivered value feeds it and clears `buffering`; an
   * `unavailable` read is SETTLED unreadable: fail-open reset, no buffering.
   */
  applySnapshot(
    status: "loading" | "ready" | "unavailable",
    value: unknown,
  ): void;
  /** Advance one beat; a no-op at (or past) the last beat. */
  advance(): void;
  /** Finish the flow (Done or Skip): phase `"done"`. */
  complete(): void;
  /** Record that the seen write did not land (honest notice, fail-open). */
  markSaveFailed(): void;
}

export function createOnboardingStore(): OnboardingStore {
  let seenValue: unknown = undefined;
  let buffering = false;
  let beatIndex = 0;
  let phase: OnboardingPhase = "beats";
  let saveFailed = false;
  let version = 0;
  let box: OnboardingBox = {
    seenValue,
    buffering,
    beatIndex,
    phase,
    saveFailed,
    version,
  };
  const listeners = new Set<() => void>();

  /**
   * Replace the box only when a tracked input actually changed — the store's
   * no-churn rule (stable snapshots), now over both the seen value and the
   * buffering flag.
   */
  function publish(changed: boolean): void {
    if (!changed) return;
    version += 1;
    box = { seenValue, buffering, beatIndex, phase, saveFailed, version };
    for (const listener of [...listeners]) listener();
  }

  return {
    getBox() {
      return box;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySeenValue(value: unknown) {
      if (Object.is(value, seenValue)) return; // stable snapshots: no emit churn
      seenValue = value;
      publish(true);
    },
    applySnapshot(status, value) {
      if (status === "unavailable") {
        // A SETTLED unreadable read: the explicit fail-open reset (show),
        // and the read is over — buffering ends either way.
        const seenChanged = !Object.is(seenValue, undefined);
        seenValue = undefined;
        const bufferingChanged = buffering;
        buffering = false;
        publish(seenChanged || bufferingChanged);
        return;
      }
      if (status === "loading" || value === undefined) {
        // The value has not been delivered yet (a value-less `ready` is the
        // pre-acceptance state): the read is IN FLIGHT — buffer the pane.
        // Inputs stay untouched: nothing was delivered.
        if (!buffering) {
          buffering = true;
          publish(true);
        }
        return;
      }
      // A delivered value: feed it and re-evaluate (the reactive half of
      // ticket 87 — the arrival itself closes or opens the flow), and the
      // read is over.
      const seenChanged = !Object.is(value, seenValue);
      seenValue = value;
      const bufferingChanged = buffering;
      buffering = false;
      publish(seenChanged || bufferingChanged);
    },
    advance() {
      if (phase !== "beats") return;
      const last = ONBOARDING_BEATS.length - 1;
      const next = Math.min(beatIndex + 1, last);
      if (next === beatIndex) return; // at the last beat: no churn
      beatIndex = next;
      publish(true);
    },
    complete() {
      if (phase === "done") return; // no-op re-complete: no emit
      phase = "done";
      publish(true);
    },
    markSaveFailed() {
      if (saveFailed) return;
      saveFailed = true;
      publish(true);
    },
  };
}

/** The pane's render states (pure; the component maps one to seats). */
export type OnboardingPaneView =
  | {
      /** Suppressed, or the flow completed: the settled no-selection state. */
      readonly kind: "settled";
      /**
       * The Done/Skip hand-off's seen write did not land: the settled state
       * carries the one honest save-failed line (retry-less, U-A). Never
       * set for a merely suppressed pane — nothing failed there.
       */
      readonly saveFailed: boolean;
    }
  | {
      /**
       * The suppression read is IN FLIGHT (ticket 87): the pane renders the
       * shell's calm no-selection state and decides only when the document
       * lands or the read settles unreadable — never the flow from the
       * fail-open default mid-read.
       */
      readonly kind: "pending";
    }
  | {
      readonly kind: "beats";
      readonly beatId: string;
      readonly titleKey: string;
      readonly bodyKey: string;
      /** The current beat is the last: the primary button is Get-started. */
      readonly isLast: boolean;
      readonly stepCurrent: number;
      readonly stepTotal: number;
      /** Index of the active progress dot. */
      readonly activeDot: number;
    };

/**
 * The pane's render decision (pure): suppression first, then the flow's own
 * phase. The settled state renders the shell's own no-selection copy (one
 * vocabulary) plus, when the seen write failed, the save-failed line. A read
 * still in flight (ticket 87) renders pending — the calm shell state — so the
 * fail-open default never flashes the flow on a reload whose record stands.
 */
export function describeOnboardingPane(
  box: Pick<
    OnboardingBox,
    "seenValue" | "buffering" | "beatIndex" | "phase" | "saveFailed"
  >,
  mirrors: ReadonlyMap<string, ShellMirror>,
): OnboardingPaneView {
  if (isOnboardingSuppressed(box.seenValue, mirrors) || box.phase === "done") {
    return {
      kind: "settled",
      saveFailed: box.phase === "done" && box.saveFailed,
    };
  }
  if (box.buffering) {
    return { kind: "pending" };
  }
  const index = Math.min(box.beatIndex, ONBOARDING_BEATS.length - 1);
  const beat = ONBOARDING_BEATS[index]!;
  return {
    kind: "beats",
    beatId: beat.id,
    titleKey: beat.titleKey,
    bodyKey: beat.bodyKey,
    isLast: index >= ONBOARDING_BEATS.length - 1,
    stepCurrent: index + 1,
    stepTotal: ONBOARDING_BEATS.length,
    activeDot: index,
  };
}
