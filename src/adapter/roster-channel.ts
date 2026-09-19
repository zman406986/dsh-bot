import { ROSTER_SETTINGS_KEY, type RosterSnapshot } from "../core/roster-snapshot.js";
import type { SettingsOwnerScopeLike } from "./settings-section.js";

/**
 * Host half of the roster data path (ticket 21, design-16 §4.2).
 *
 * The verified-or-fallback channel is the plugin's OWN settings namespace:
 * the owner scope the host's `settings.register(ns, schema, {base})` returns
 * exposes `update` (`@deepseek-ai/dsh-settings/lib/index.js:298-314`), and
 * the client watches the same namespace from the browser (settings-scope
 * inject idiom). Ticket 93 correction: the scope comes from `register`, NOT
 * from `installSection` — that call returns void on the live host
 * (`dsh-settings/lib/index.js:327-343`, `types/index.d.ts:228`), which is why
 * this channel never attached and no `roster.*` key ever reached the document.
 * This is a config channel doing telemetry duty — the documented honest gap.
 * Publishes are therefore best-effort by contract:
 *
 * - no scope yet (settings service absent) → skipped, snapshot kept for a
 *   catch-up write when the scope attaches;
 * - a throwing `update`, OR a rejected one — the host's `update(patch)`
 *   returns `Promise<void>` (`dsh-settings/lib/types/index.d.ts:105-108`),
 *   with only the not-registered / disposed / read-only / non-plain-object
 *   refusals thrown synchronously (`dsh-settings/lib/index.js:443-455`) and
 *   validation + persist failures arriving as rejections — counted as a
 *   failure and contained, never propagated (telemetry must not break
 *   core/host flow, and an unhandled rejection must never crash the host);
 * - the snapshot rides under {@link ROSTER_SETTINGS_KEY} so an `update`
 *   merge leaves the user's `enabled`/timeout config keys intact.
 *
 * Ticket 79 (ADR-0019 keying table, "snapshots keyed per session under the
 * plugin namespace"): each publish ALSO rides under the per-session mirror
 * key `roster.<dispatcherSessionId>`, and {@link SettingsRosterChannel.clearSession}
 * / `clearAllSessions` write `null` there on deactivation / unload — the
 * wrapper sidebar's dispatcher flag and per-session presence read those
 * keys. The legacy key stays for the shipped single-dispatcher panel.
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
  /** `update` calls that threw synchronously. */
  readonly failures: number;
  /**
   * Async write rejections (the host's `update` returns `Promise<void>`):
   * counted separately so a rejected write is visible and never unhandled.
   */
  readonly asyncFailures: number;
  /** Publishes that had no writable scope (snapshot still retained). */
  readonly skipped: number;
}

/**
 * Key under the plugin's settings-namespace document that carries the
 * PER-SESSION mirror (ticket 79, ADR-0019 keying table): `roster.<sessionId>`.
 * The session id is everything after the prefix, so ids containing dots stay
 * unambiguous (the remainder is taken whole). `null` is the documented
 * "no dispatcher here anymore" value written by {@link SettingsRosterChannel.clearSession}.
 */
export const ROSTER_SESSION_KEY_PREFIX = "roster.";

/** The per-session mirror key for one dispatcher session. */
export function rosterSessionKey(sessionId: string): string {
  return `${ROSTER_SESSION_KEY_PREFIX}${sessionId}`;
}

/**
 * The session id a per-session mirror key names, or `null` when the key is
 * not a session mirror (the legacy whole-snapshot key `roster` does not match
 * the dotted prefix, so the two families never collide).
 */
export function sessionOfRosterKey(key: string): string | null {
  return key.startsWith(ROSTER_SESSION_KEY_PREFIX)
    ? key.slice(ROSTER_SESSION_KEY_PREFIX.length)
    : null;
}

export interface SettingsRosterChannel {
  /** Attach the owner scope; catch-up-writes the last retained snapshot. */
  attach(scope: SettingsOwnerScopeLike): void;
  /**
   * Retain and best-effort write the snapshot: under the legacy `roster` key
   * (the shipped single-dispatcher panel's read-side, unchanged) AND under the
   * session mirror key `roster.<sessionId>` (ticket 79 — the wrapper sidebar's
   * per-session read-side, ADR-0019's "snapshots keyed per session under the
   * plugin namespace"). Never throws.
   */
  publish(snapshot: RosterSnapshot): void;
  /**
   * Best-effort clear one session's mirror (ticket 79): writes `null` under
   * `roster.<sessionId>` so the client read-side drops the dispatcher flag
   * instead of showing a deactivated session as live. Called on that
   * session's deactivation; `null` is used because the owner scope exposes
   * no field-delete verb (`update` merges).
   */
  clearSession(sessionId: string): void;
  /**
   * Clear every session mirror this process wrote (ticket 79 — plugin
   * unload/HMR): no stale dispatcher flag outlives the plugin that set it.
   */
  clearAllSessions(): void;
  /** Last retained snapshot (even when writes were skipped/failed). */
  readonly lastSnapshot: RosterSnapshot | null;
  /** Counters for tests and diagnostics. */
  readonly stats: RosterChannelStats;
}

export function createSettingsRosterChannel(): SettingsRosterChannel {
  let scope: SettingsOwnerScopeLike | null = null;
  let lastSnapshot: RosterSnapshot | null = null;
  const writtenSessions = new Set<string>();
  const stats = {
    attached: false,
    writes: 0,
    failures: 0,
    asyncFailures: 0,
    skipped: 0,
  };

  /**
   * One best-effort write. The host's `Scope.update(patch)` is ASYNC
   * (`dsh-settings/lib/types/index.d.ts:105-108`): only a few refusals throw
   * synchronously (`dsh-settings/lib/index.js:443-455`); validation and
   * persist failures arrive as a rejected promise. Both are contained here —
   * an unhandled rejection from a telemetry write must never reach the host
   * process, and the counters must tell the truth about which happened.
   */
  function write(document: Record<string, unknown>): boolean {
    if (scope === null || typeof scope.update !== "function") {
      stats.skipped += 1;
      return false;
    }
    let result: unknown;
    try {
      result = scope.update(document);
    } catch {
      stats.failures += 1;
      return false;
    }
    stats.writes += 1;
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).then(undefined, () => {
        stats.asyncFailures += 1;
      });
    }
    return true;
  }

  /**
   * One publish = one merged write carrying BOTH mirror families: the legacy
   * `roster` key (existing panel read-side; last-write-wins across sessions,
   * unchanged) and `roster.<sessionId>` (the per-session mirror the wrapper
   * sidebar reads). One `update` per transition preserves the channel's
   * one-write-per-transition discipline (ticket 28's coalescing decision) —
   * there is no churn to coalesce, only two fields in the same document
   * write.
   */
  function publishDocument(snapshot: RosterSnapshot): void {
    writtenSessions.add(snapshot.dispatcherSessionId);
    write({
      [ROSTER_SETTINGS_KEY]: snapshot,
      [rosterSessionKey(snapshot.dispatcherSessionId)]: snapshot,
    });
  }

  return {
    attach(attached: SettingsOwnerScopeLike): void {
      scope = attached;
      stats.attached = true;
      // Catch-up: the scope can appear after transitions were projected
      // (settings is an optional inject that may resolve late).
      if (lastSnapshot !== null) publishDocument(lastSnapshot);
    },
    publish(snapshot: RosterSnapshot) {
      lastSnapshot = snapshot;
      publishDocument(snapshot);
    },
    clearSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      write({ [rosterSessionKey(sessionId)]: null });
    },
    clearAllSessions() {
      for (const sessionId of [...writtenSessions]) {
        write({ [rosterSessionKey(sessionId)]: null });
      }
    },
    get lastSnapshot(): RosterSnapshot | null {
      return lastSnapshot;
    },
    stats,
  };
}
