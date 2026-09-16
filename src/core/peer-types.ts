/**
 * Peer envelope schema (ticket 14 / design-14 §2).
 * New types only — no reference identifiers.
 */

/** How a peer message is addressed. */
export type PeerTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "broadcast" };

/** One peer message. Immutable after accept. */
export interface PeerEnvelope {
  /** Sender-assigned unique id. Primary dedupe key. Required. */
  readonly messageId: string;
  readonly fromAgentId: string;
  readonly fromName: string;
  readonly to: PeerTarget;
  /**
   * Conversation / thread slot (forward-compatibility). Opaque in MVP;
   * carried through ack, wake, and transcript so a later threaded hub
   * is not a breaking schema change.
   */
  readonly conversationId: string;
  readonly text: string;
  /** Reserved. MVP is text-first; empty array or omitted. */
  readonly imageRefs?: readonly string[];
  /**
   * 1:1 only. Ignored when `to.kind` is group/broadcast (AC + S9).
   * Never interrupts a user-owned dispatcher turn.
   */
  readonly priority: boolean;
  readonly createdAtMs: number;
}

/** Fire-and-forget accept result. Never carries the dispatcher's reply. */
export type PeerSendAck =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly acceptedAtMs: number;
      /**
       * False when the envelope asked for priority but policy refused it
       * (group/broadcast target). Sender is told priority did not interrupt.
       */
      readonly priorityHonored: boolean;
      readonly reason?: "group-target" | "broadcast-target";
    }
  | {
      readonly ok: false;
      readonly messageId: string;
      readonly reason:
        | "invalid-envelope"
        | "unknown-target"
        | "inbox-full"
        | "message-id-reuse";
      readonly detail: string;
    };

/**
 * One peer message carried by a wake. Distinct from the envelope:
 * `priority` is the *effective* priority used for lane placement.
 */
export interface PeerNotice {
  readonly messageId: string;
  readonly fromAgentId: string;
  readonly fromName: string;
  readonly to: PeerTarget;
  readonly conversationId: string;
  readonly text: string;
  readonly priority: boolean;
  readonly createdAtMs: number;
}

/**
 * Effective priority after the target check (design-14 §3.2).
 * Group/broadcast always land in the normal lane.
 */
export function effectivePeerPriority(envelope: PeerEnvelope): boolean {
  return envelope.priority && envelope.to.kind === "agent";
}

/** Stable label for ack/copy (not a wire id). */
export function peerTargetLabel(to: PeerTarget): string {
  switch (to.kind) {
    case "agent":
      return `agent ${to.agentId}`;
    case "group":
      return `group ${to.groupId}`;
    case "broadcast":
      return "broadcast";
  }
}

/** Map an accepted envelope onto a wake notice. */
export function toPeerNotice(
  envelope: PeerEnvelope,
  priority: boolean,
): PeerNotice {
  return {
    messageId: envelope.messageId,
    fromAgentId: envelope.fromAgentId,
    fromName: envelope.fromName,
    to: envelope.to,
    conversationId: envelope.conversationId,
    text: envelope.text,
    priority,
    createdAtMs: envelope.createdAtMs,
  };
}

/**
 * Payload identity for idempotent re-accept (design-14 §5).
 * `createdAtMs` is deliberately excluded — a retry may re-stamp it.
 */
export function samePeerPayload(
  a: PeerEnvelope,
  b: PeerEnvelope,
): boolean {
  return (
    a.messageId === b.messageId &&
    a.fromAgentId === b.fromAgentId &&
    a.fromName === b.fromName &&
    a.conversationId === b.conversationId &&
    a.text === b.text &&
    a.priority === b.priority &&
    targetsEqual(a.to, b.to) &&
    imageRefsEqual(a.imageRefs, b.imageRefs)
  );
}

function targetsEqual(a: PeerTarget, b: PeerTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "agent" && b.kind === "agent") {
    return a.agentId === b.agentId;
  }
  if (a.kind === "group" && b.kind === "group") {
    return a.groupId === b.groupId;
  }
  return a.kind === "broadcast" && b.kind === "broadcast";
}

function imageRefsEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
