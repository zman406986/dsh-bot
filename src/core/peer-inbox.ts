/**
 * Plugin-owned peer inbox (ticket 14 / design-14 §3, §5; C14 sort ticket 70).
 * Dedupe index + delivered flags + cap. Lanes live on the wake bus;
 * this module is the accept/delivery authority. The `unknown-target` and
 * `self-target` refusals are NOT produced here — they are the multitask
 * `sendPeer` liveness/self fences (ticket 70 §2); the inbox stay pure of
 * host knowledge (absent knob = current behavior).
 */

import {
  effectivePeerPriority,
  samePeerPayload,
  type PeerEnvelope,
  type PeerSendAck,
  type PeerTarget,
} from "./peer-types.js";

/** Default undelivered cap per dispatcher session. */
export const DEFAULT_PEER_INBOX_CAP = 64;

export interface PeerInboxOptions {
  /** Max undelivered envelopes per session. Default 64. */
  readonly maxPendingPerSession?: number;
}

/** Accept result: ack for the sender + whether a new row was appended. */
export interface PeerSendResult {
  readonly ack: PeerSendAck;
  /** True only when this call appended a new undelivered row. */
  readonly appended: boolean;
}

export interface PeerInbox {
  /**
   * Synchronous fire-and-forget accept. Never awaits delivery.
   * Idempotent on identical re-send; refused on payload mismatch.
   */
  send(sessionId: string, envelope: PeerEnvelope): PeerSendResult;
  /** Undelivered envelopes for a session, in accept order. */
  listPending(sessionId: string): readonly PeerEnvelope[];
  /** Undelivered count for a session (cap applies to this number). */
  pendingCount(sessionId: string): number;
  /**
   * Mark one accepted message delivered. False when unknown or already
   * delivered. Re-queue never calls this.
   */
  markDelivered(sessionId: string, messageId: string): boolean;
  /** Whether the message id is known (delivered or not) for this session. */
  has(sessionId: string, messageId: string): boolean;
}

interface PeerRow {
  readonly key: string;
  readonly envelope: PeerEnvelope;
  readonly acceptedAtMs: number;
  delivered: boolean;
}

function indexKey(envelope: PeerEnvelope): string {
  // Sender-scoped so two peers may reuse a messageId without collision.
  return `${envelope.fromAgentId}\u0000${envelope.messageId}`;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function validateEnvelope(
  envelope: PeerEnvelope,
): { ok: true } | { ok: false; detail: string } {
  if (!isPresent(envelope.messageId)) {
    return { ok: false, detail: "messageId is required" };
  }
  if (!isPresent(envelope.fromAgentId)) {
    return { ok: false, detail: "fromAgentId is required" };
  }
  if (!isPresent(envelope.fromName)) {
    return { ok: false, detail: "fromName is required" };
  }
  if (!isPresent(envelope.conversationId)) {
    return { ok: false, detail: "conversationId is required" };
  }
  if (typeof envelope.text !== "string" || envelope.text.length === 0) {
    return { ok: false, detail: "text is required" };
  }
  if (typeof envelope.priority !== "boolean") {
    return { ok: false, detail: "priority must be a boolean" };
  }
  // Runtime guard for untrusted host-edge input; PeerTarget is already typed.
  // C14 sort (ticket 70 §3): only the 1:1 shape is admitted — the retired
  // group/broadcast kinds refuse here as invalid-envelope.
  const to = envelope.to as Partial<PeerTarget> | null | undefined;
  if (to == null || typeof to !== "object" || to.kind !== "agent") {
    return { ok: false, detail: `unknown target kind "${String(to?.kind)}"` };
  }
  if (!isPresent((to as { agentId?: unknown }).agentId)) {
    return { ok: false, detail: "to.agentId is required" };
  }
  return { ok: true };
}

interface SessionInboxState {
  /** indexKey → row. Keeps delivered history so late duplicates are refused. */
  readonly rows: Map<string, PeerRow>;
}

export function createPeerInbox(options?: PeerInboxOptions): PeerInbox {
  const maxPending =
    options?.maxPendingPerSession ?? DEFAULT_PEER_INBOX_CAP;
  const sessions = new Map<string, SessionInboxState>();

  function ensure(sessionId: string): SessionInboxState {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { rows: new Map() };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function countUndelivered(state: SessionInboxState): number {
    let count = 0;
    for (const row of state.rows.values()) {
      if (!row.delivered) count += 1;
    }
    return count;
  }

  return {
    send(sessionId: string, envelope: PeerEnvelope): PeerSendResult {
      const validation = validateEnvelope(envelope);
      if (!validation.ok) {
        return {
          ack: {
            ok: false,
            messageId: String(envelope.messageId ?? ""),
            reason: "invalid-envelope",
            detail: validation.detail,
          },
          appended: false,
        };
      }

      const state = ensure(sessionId);
      const key = indexKey(envelope);
      const existing = state.rows.get(key);
      if (existing !== undefined) {
        if (!samePeerPayload(existing.envelope, envelope)) {
          return {
            ack: {
              ok: false,
              messageId: envelope.messageId,
              reason: "message-id-reuse",
              detail: `messageId "${envelope.messageId}" was already accepted from this sender with a different payload`,
            },
            appended: false,
          };
        }
        // Idempotent re-accept: same ack shape, no second row.
        return {
          ack: {
            ok: true,
            messageId: envelope.messageId,
            acceptedAtMs: existing.acceptedAtMs,
          },
          appended: false,
        };
      }

      if (countUndelivered(state) >= maxPending) {
        return {
          ack: {
            ok: false,
            messageId: envelope.messageId,
            reason: "inbox-full",
            detail: `peer inbox is full (${maxPending} undelivered messages)`,
          },
          appended: false,
        };
      }

      const acceptedAtMs = Date.now();
      const row: PeerRow = {
        key,
        envelope,
        acceptedAtMs,
        delivered: false,
      };
      state.rows.set(key, row);
      return {
        ack: {
          ok: true,
          messageId: envelope.messageId,
          acceptedAtMs,
        },
        appended: true,
      };
    },

    listPending(sessionId: string): readonly PeerEnvelope[] {
      const state = sessions.get(sessionId);
      if (state === undefined) return [];
      const out: PeerEnvelope[] = [];
      for (const row of state.rows.values()) {
        if (!row.delivered) out.push(row.envelope);
      }
      return out;
    },

    pendingCount(sessionId: string): number {
      const state = sessions.get(sessionId);
      if (state === undefined) return 0;
      return countUndelivered(state);
    },

    markDelivered(sessionId: string, messageId: string): boolean {
      const state = sessions.get(sessionId);
      if (state === undefined) return false;
      for (const row of state.rows.values()) {
        if (row.envelope.messageId === messageId && !row.delivered) {
          row.delivered = true;
          return true;
        }
      }
      return false;
    },

    has(sessionId: string, messageId: string): boolean {
      const state = sessions.get(sessionId);
      if (state === undefined) return false;
      for (const row of state.rows.values()) {
        if (row.envelope.messageId === messageId) return true;
      }
      return false;
    },
  };
}

/** Re-export for callers that only need the accept-side helper. */
export { effectivePeerPriority };
