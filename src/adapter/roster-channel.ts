import { ROSTER_SETTINGS_KEY, type RosterSnapshot } from "../core/roster-snapshot.js";
import type { SettingsOwnerScopeLike } from "./settings-section.js";

/**
 * Host half of the roster data path (ticket 21, design-16 §4.2).
 *
 * The verified-or-fallback channel is the plugin's OWN settings namespace:
 * the owner scope that `settings.installSection` returns exposes `update`,
 * and the client watches the same namespace from the browser (settings-scope
 * inject idiom). This is a config channel doing telemetry duty — the
 * documented honest gap. Publishes are therefore best-effort by contract:
 *
 * - no scope yet (settings service absent) → skipped, snapshot kept for a
 *   catch-up write when the scope attaches;
 * - a throwing `update` → counted as a failure and swallowed, never
 *   propagated (telemetry must not break core/host flow);
 * - the snapshot rides under {@link ROSTER_SETTINGS_KEY} so an `update`
 *   merge leaves the user's `enabled`/timeout config keys intact.
 *
 * Residual integration risk (offline tests cannot verify live dsh merge
 * semantics): whether `update` performs a shallow merge or replaces the
 * document. Recorded in the ticket; if integration shows replacement, the
 * channel switches to a read-modify-write over `get()` without changing the
 * seam shape.
 *
 * Ticket 28 coalescing decision: **not added.** Coalescing was offered as an
 * option if settings-write churn showed up. It does not: every caller
 * publishes once per roster-affecting semantic transition (`onRosterChanged`
 * from spawn / status change / access park+resolve / delivery / reconcile /
 * drain), with no tick, poll, or per-keystroke path, and no settings write
 * can itself trigger another publish (the client's staleness recheck is
 * local render state, never a publish). Adding a per-tick timer here would
 * introduce a scheduling seam and defer updates for latency nobody pays
 * today, so writes stay synchronous and one-per-event. If a future producer
 * does burst, coalesce at that producer — not here, and never at the cost of
 * dropping the last snapshot ({@link SettingsRosterChannel.lastSnapshot}
 * retain semantics are unconditional either way).
 */
export interface RosterChannelStats {
  /** Whether a settings owner scope has attached. */
  readonly attached: boolean;
  /** Successful writes through the scope. */
  readonly writes: number;
  /** `update` calls that threw. */
  readonly failures: number;
  /** Publishes that had no writable scope (snapshot still retained). */
  readonly skipped: number;
}

export interface SettingsRosterChannel {
  /** Attach the owner scope; catch-up-writes the last retained snapshot. */
  attach(scope: SettingsOwnerScopeLike): void;
  /** Retain and best-effort write the snapshot. Never throws. */
  publish(snapshot: RosterSnapshot): void;
  /** Last retained snapshot (even when writes were skipped/failed). */
  readonly lastSnapshot: RosterSnapshot | null;
  /** Counters for tests and diagnostics. */
  readonly stats: RosterChannelStats;
}

export function createSettingsRosterChannel(): SettingsRosterChannel {
  let scope: SettingsOwnerScopeLike | null = null;
  let lastSnapshot: RosterSnapshot | null = null;
  const stats = { attached: false, writes: 0, failures: 0, skipped: 0 };

  function write(snapshot: RosterSnapshot): void {
    if (scope === null || typeof scope.update !== "function") {
      stats.skipped += 1;
      return;
    }
    try {
      scope.update({ [ROSTER_SETTINGS_KEY]: snapshot });
      stats.writes += 1;
    } catch {
      stats.failures += 1;
    }
  }

  return {
    attach(attached: SettingsOwnerScopeLike): void {
      scope = attached;
      stats.attached = true;
      // Catch-up: the scope can appear after transitions were projected
      // (settings is an optional inject that may resolve late).
      if (lastSnapshot !== null) write(lastSnapshot);
    },
    publish(snapshot: RosterSnapshot): void {
      lastSnapshot = snapshot;
      write(snapshot);
    },
    get lastSnapshot(): RosterSnapshot | null {
      return lastSnapshot;
    },
    stats,
  };
}
