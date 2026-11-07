/**
 * Wrapper shell per-session mirror feed (ticket 94, live-found 2026-09-19).
 *
 * The shell store's read side (`DispatcherShellStore.applySessionMirror`,
 * `shell-store.ts:497`) was DEFINED AND UNIT-PINNED but never called: the
 * composition's one settings watch fed only the roster store and the approval
 * relay feed, and `mountShellPage` received `{store, onSeen, approvalsFeed}`
 * — no mirror source. Live consequence: `state.mirrors` stayed empty forever,
 * so every session row rendered `data-dispatcher="false"` with the
 * `状态不可用` chip, the right pane hosted no roster panel, and
 * `data-presence` never populated (tickets 27/28/69-L2 dead on the surface).
 *
 * This hub is the reader, and it is the same shape as the approval relay feed
 * (`approval-feed.ts:100-132`): one accepted channel value, fanned out to the
 * per-mount shell stores, with a last-truth replay so a mount created after a
 * publish does not wait for a change that may never come. It has no live
 * channel on dsh 0.2.1 — the client settings-scope service the read rode is
 * gone — and offline tests feed it the real projection directly.
 *
 * What it reads — and what it deliberately does NOT:
 * - ONLY the per-session family `roster.<sessionId>`
 *   (`src/adapter/roster-channel.ts:64-80`, ADR-0019's keying table). The
 *   legacy whole-snapshot key `roster` is the shipped single-dispatcher
 *   panel's read side; it is NOT fed here, because it is never cleared (only
 *   `roster.<sessionId>` is written `null` on deactivation,
 *   `roster-channel.ts:162-170`) — replaying it would resurrect a
 *   deactivated session's dispatcher flag from a stale snapshot. The
 *   per-session family is the authority; both are written in the SAME
 *   document write, so nothing is lost.
 * - An unrelated / corrupt / absent document leaves every store untouched:
 *   the hub only calls the store's own honest verbs
 *   (`applySessionMirror` handles `null` → cleared and junk → unavailable),
 *   and never fabricates a mirror from a document it cannot vouch for.
 *
 * Pure data: no React, no DOM, no Cordis — asserted directly by offline tests
 * (S8).
 */
import { sessionOfRosterKey } from "../adapter/roster-channel.js";
import type { DispatcherShellStore } from "./shell-store.js";

/**
 * Extract the per-session mirror entries from one settings-channel document
 * value. Returns `null` when the value is not an object at all (nothing to
 * read); an object with no `roster.`-prefixed key yields an empty list — a
 * real "no mirrors" that the caller applies (it clears nothing by itself,
 * because the store only moves on keys it is told about).
 *
 * Values are passed through RAW: the store's `applySessionMirror` parses and
 * classifies (`null` → cleared, junk → unavailable), so the honesty rules
 * live in exactly one place.
 */
export function sessionMirrorsFromChannelValue(
  value: unknown,
): readonly { readonly sessionId: string; readonly value: unknown }[] | null {
  if (typeof value !== "object" || value === null) return null;
  const mirrors: { sessionId: string; value: unknown }[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const sessionId = sessionOfRosterKey(key);
    if (sessionId === null || sessionId.length === 0) continue;
    mirrors.push({ sessionId, value: entry });
  }
  return mirrors;
}

/**
 * The one-channel fan-out hub for the shell stores. `applyChannelValue` takes
 * one accepted channel value; each wrapper mount attaches its own
 * `DispatcherShellStore` and gets the current mirrors immediately (replay),
 * then every later publish. The disposer detaches exactly that store
 * (unsubscribes on unload — the sessions-feed-binding pattern).
 */
export interface ShellMirrorFeed {
  /**
   * Attach one shell store: it replays the last-known mirrors at once (a
   * mount registering after a publish must not wait for a change that may
   * never come) and receives every later publish. Returns the detach
   * disposer.
   */
  attach(store: DispatcherShellStore): () => void;
  /** Feed one channel value (the roster store's own verb name). */
  applyChannelValue(value: unknown): void;
}

export function createShellMirrorFeed(): ShellMirrorFeed {
  const stores = new Set<DispatcherShellStore>();
  /**
   * Last-known mirror entries by session id, in first-seen order. Replaying
   * is unconditional once a document has been accepted: unlike the approval
   * feed, "no mirror key for this session" is itself meaningful truth (the
   * session is not one of ours), so the hub replays the exact key set it
   * last saw — never an invented empty set for a session the document never
   * mentioned.
   */
  let lastMirrors: readonly {
    readonly sessionId: string;
    readonly value: unknown;
  }[] = [];
  let hasTruth = false;
  /**
   * Counts accepted publications. A synchronous store subscriber may reenter
   * this hub during fanout; the nested publication is newer truth and has
   * already been fanned out to every attached store, so the suspended outer
   * publication must stop rather than write its stale entries over it.
   */
  let publication = 0;

  return {
    attach(store) {
      stores.add(store);
      if (hasTruth) {
        for (const mirror of lastMirrors) {
          store.applySessionMirror(mirror.sessionId, mirror.value);
        }
      }
      return () => {
        stores.delete(store);
      };
    },
    applyChannelValue(value) {
      const mirrors = sessionMirrorsFromChannelValue(value);
      if (mirrors === null) return;
      hasTruth = true;
      lastMirrors = mirrors;
      const accepted = ++publication;
      for (const store of [...stores]) {
        for (const mirror of mirrors) {
          if (accepted !== publication) return;
          store.applySessionMirror(mirror.sessionId, mirror.value);
        }
      }
    },
  };
}
