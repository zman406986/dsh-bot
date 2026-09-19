/**
 * The approval-cards relay feed (ticket 69, L1 offline half): wires the
 * relay's pending-ask truth into the wrapper's approval-cards stores over
 * the PROVEN roster channel — the settings-namespace mirror (tickets
 * 21/27/46) that the roster panel's own "Needs you" access list already
 * rides. One channel, one more honest reader: never a second feed.
 *
 * The wire side is the roster snapshot's v4 `pendingAsks` envelope field
 * (`src/core/roster-snapshot.ts`) — full pending-ask truth the host
 * re-publishes on every park/resolve transition (the core roster observer
 * fires from `resolveAccess`, the relay timeout, and the park itself), so a
 * card appears when the ask parks and LEAVES when the relay settles it.
 * Resolved/expired card states ride notices, which this channel does not
 * carry: a notice is a one-shot conversational event, and re-publishing a
 * notice history through a full-document config mirror would need new
 * host-side retention state. The store keeps its notice projection (pinned
 * by the store's own tests) as the documented extension point; until a
 * notice feed exists, "resolved" honestly means "left the pending list" —
 * the same settle shape the roster blocked marker has always had (L2).
 *
 * The hub fans the ONE settings-scope read (bound once in
 * `applyClientModule` — a second bind would be a second channel, which the
 * ticket-47 rule forbids) out to the per-mount approval stores, replaying
 * the last good pending set to a store that attaches after a publish.
 * Invalid / unrelated documents leave every store untouched — the roster
 * panel owns corruption and staleness presentation; this feed never
 * fabricates a "nothing waiting" from a document it cannot vouch for.
 *
 * Pure data: no React, no DOM, no Cordis — asserted directly by offline
 * tests (S8).
 */
import {
  ROSTER_SETTINGS_KEY,
  parseRosterSnapshot,
  type RosterSnapshot,
  type RosterSnapshotPendingAsk,
} from "../core/roster-snapshot.js";
import type { AccessTicket } from "../core/access-types.js";
import type { ApprovalCardsStore } from "./approval-cards.js";

/**
 * Convert one parsed v4 wire ask into the `AccessTicket`-shaped row the
 * cards store's projection joins on (`applyRelayTruth`'s input). Pure; the
 * credential NAME round-trips (never a value — access-types hard rule).
 */
export function accessTicketFromWireAsk(
  ask: RosterSnapshotPendingAsk,
): AccessTicket {
  return {
    workerId: ask.workerId,
    requestId: ask.requestId,
    body: {
      class: ask.class,
      target: ask.target,
      reason: ask.reason,
      ...(ask.credentialName.length > 0 && { credentialName: ask.credentialName }),
    },
    createdAtMs: ask.createdAtMs,
    parentSessionId: ask.parentSessionId,
    status: "pending",
  };
}

/**
 * Extract the pending asks from one settings-channel document value.
 * Returns `null` when the document carries no readable roster snapshot —
 * unrelated write, corrupt key, or version skew — and the caller keeps its
 * previous truth. An empty array is a REAL "nothing pending" and feeds
 * through.
 */
export function pendingAsksFromChannelValue(
  value: unknown,
): readonly AccessTicket[] | null {
  if (typeof value !== "object" || value === null) return null;
  const roster = (value as Record<string, unknown>)[ROSTER_SETTINGS_KEY];
  if (roster === undefined) return null;
  const snapshot: RosterSnapshot | null = parseRosterSnapshot(roster);
  if (snapshot === null) return null;
  return snapshot.pendingAsks.map(accessTicketFromWireAsk);
}

/**
 * The one-channel fan-out hub. `applyChannelValue` is fed from the single
 * settings-scope read in `applyClientModule`; each wrapper mount attaches
 * its own approvals store and gets the current truth immediately (replay),
 * then every later publish. The disposer detaches exactly that store
 * (unsubscribes on unload — the sessions-feed-binding pattern).
 */
export interface ApprovalRelayFeed {
  /**
   * Attach one store: it replays the last good pending set at once (a mount
   * registering after a publish must not wait for a change that may never
   * come) and receives every later publish. Returns the detach disposer.
   */
  attach(store: ApprovalCardsStore): () => void;
  /** Feed one channel value (the roster store's own verb name). */
  applyChannelValue(value: unknown): void;
}

export function createApprovalRelayFeed(): ApprovalRelayFeed {
  const stores = new Set<ApprovalCardsStore>();
  /** Last good pending set — the attach replay (empty before any feed). */
  let lastPending: readonly AccessTicket[] = [];
  /**
   * Whether a VALID document has ever arrived. Until it has, the hub has no
   * truth to replay: attaching before the first publish leaves the store
   * `unfed` — replaying an empty set there would fabricate "nothing
   * waiting" from zero evidence (the store's own honesty rule).
   */
  let hasTruth = false;

  return {
    attach(store) {
      stores.add(store);
      if (hasTruth) {
        store.applyRelayTruth(lastPending);
      }
      return () => {
        stores.delete(store);
      };
    },
    applyChannelValue(value) {
      const pending = pendingAsksFromChannelValue(value);
      if (pending === null) return;
      lastPending = pending;
      hasTruth = true;
      for (const store of [...stores]) {
        store.applyRelayTruth(pending);
      }
    },
  };
}
