/**
 * The half-window prune trigger (ISSUE-022 chunk 6; ADR-0009 §Amendment
 * 2026-10-24 — the threshold-triggered auto pass fires at one-half of the
 * context window).
 *
 * The threshold is relative to the window, so nothing here waits on a measured
 * token count: the host (or a test) states the window once, and the trigger
 * compares the session's usage reading against half of it.
 *
 * WHICH reading is the mount's decision (ISSUE-092): dsh feeds the host's own
 * billed prompt for the last accounted request, one step stale, and falls back
 * to the local whole-request estimate only before the first usage row. The
 * local estimate counted message text only, so on live runs it read ~0.56 of
 * the host meter and a 200 000 bar never armed.
 *
 * The re-arm policy (CRITIC-022 P1-1, provisional 2026-10-24, PM-ruled):
 *
 *   (a) after ANY pass completes — manual `/prune` or auto-fired — the latch
 *       re-arms; a pass that throws re-arms too, so one failure never disables
 *       auto-prune for the rest of the session;
 *   (b) an observation fires when usage is at or above half the window AND
 *       either usage has been below half since the last fire (a crossing), or
 *       it has grown by at least half a window since the last fire
 *       (the growth-delta re-fire: the same content is never pruned twice);
 *   (c) a native dsh compaction is an external reset: it re-arms the latch as
 *       if a pass had completed, so a session the host compacted is pruned by
 *       the next crossing instead of waiting out a growth delta that the
 *       compaction already invalidated (the ISSUE-022 DoD backstop).
 *
 * The old rule re-armed only below the line, so a single pass (or one throw)
 * left the session above half and the latch closed for good.
 *
 * Pure and session-local: it holds numbers, takes numbers, returns a boolean.
 * The mount owns where the estimate comes from and what a firing schedules;
 * this module owns WHEN.
 */

/**
 * The window as the mount resolves it: absent or null is the disabled state;
 * anything else must be a positive safe integer. One validator, so the config
 * resolver and this class cannot disagree (CRITIC-022 P3 #16).
 */
export function resolveContextWindowTokens(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('racoons: contextWindowTokens must be null or a positive safe integer');
  }
  return value;
}

/**
 * One session's crossing latch. `windowTokens` null means the feature is off
 * (no window configured, so the mount stays record-only — ADR-0008's rollout
 * order); every observation then answers false and nothing is armed.
 */
export class PruneWindowTrigger {
  private readonly windowTokens: number | null;
  /** The usage at the last fire (or completed pass); null when none is known. */
  private lastFireUsage: number | null = null;
  /** True once usage was observed below the line since that baseline. */
  private belowSinceFire = false;

  constructor(windowTokens: number | null) {
    this.windowTokens = resolveContextWindowTokens(windowTokens);
  }

  /** True when the feature is armed by a configured window. */
  get enabled(): boolean {
    return this.windowTokens !== null;
  }

  /** The token count a crossing is measured against, or null when disabled. */
  get threshold(): number | null {
    return this.windowTokens === null ? null : this.windowTokens / 2;
  }

  /**
   * Records one observation and answers whether THIS observation fires.
   *
   * Below the line, the observation only marks the excursion (a later crossing
   * fires). At or above it, a fire needs either that excursion, no baseline at
   * all (the session's first crossing), or half a window of growth since the
   * baseline. A fire moves the baseline to this observation.
   */
  observe(estimatedTokens: number): boolean {
    const window = this.windowTokens;
    if (window === null) return false;
    if (estimatedTokens < window / 2) {
      this.belowSinceFire = true;
      return false;
    }
    const grew = this.lastFireUsage !== null
      && estimatedTokens >= this.lastFireUsage + window / 2;
    if (!this.belowSinceFire && this.lastFireUsage !== null && !grew) return false;
    this.belowSinceFire = false;
    this.lastFireUsage = estimatedTokens;
    return true;
  }

  /**
   * One pass completed — manual or auto, applied or refused. The latch re-arms:
   * `usage` is the pass's own pre-pass estimate, so the next fire needs half a
   * window of growth beyond it, or a below-half excursion. `null` keeps the
   * last known baseline (a throw with no reading), or the threshold when there
   * is none, so a failed pass cannot turn into a tight retry loop.
   */
  notePassCompleted(usage: number | null): void {
    const threshold = this.threshold;
    if (threshold === null) return;
    if (usage === null) {
      if (this.lastFireUsage === null) this.lastFireUsage = threshold;
      return;
    }
    this.lastFireUsage = usage;
    this.belowSinceFire = usage < threshold;
  }

  /**
   * A native dsh compaction ended (`compaction/end`). The host rewrote the
   * surface on its own, so the old baseline no longer describes this session:
   * re-arm as after a pass, and let the next observation decide. This is the
   * ISSUE-022 DoD backstop — native compaction is observed, never suppressed
   * by this module.
   */
  noteNativeCompaction(): void {
    if (this.threshold === null) return;
    this.lastFireUsage = null;
    this.belowSinceFire = false;
  }
}
