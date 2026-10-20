/**
 * Peer envelope schema (ticket 14 / design-14 §2; C14 sort ticket 70 §3).
 * New types only — no reference identifiers.
 */

/**
 * How a peer message is addressed. Post-C14 (ADR-0018 exception 7, ticket 70
 * §3) the tier is point-to-point only: the shipped `group` / `broadcast`
 * shapes are RETIRED — the reference's broadcast is the user-to-all-agents
 * cue, not a peer-tier send, and group rooms are excluded outright. The
 * discriminant stays on the shape so a later in-scope widening is not a
 * breaking schema change; today `kind` is always `"agent"`.
 */
export type PeerTarget = { readonly kind: "agent"; readonly agentId: string };

/**
 * Declared status words a worker may attach to a mid-task reply
 * (ticket 122 / ADR-0028). A closed set on purpose: the status is metadata
 * the dispatcher can act on, not free prose, and it must never read as a
 * completion signal — `done` is deliberately absent.
 */
export type WorkerReplyStatus = "progress" | "blocked" | "note";

/** Runtime membership check for the status enum (host-edge validation). */
export function isWorkerReplyStatus(
  value: unknown,
): value is WorkerReplyStatus {
  return value === "progress" || value === "blocked" || value === "note";
}

/**
 * Structured provenance for a worker's mid-task reply (ticket 122 /
 * ADR-0028 decision 5). It rides the peer envelope so the dispatcher never
 * parses message text to learn where a message came from: `kind` is the
 * declared discriminant, `workerId` is the sending worker, and `status` is
 * the optional status word. Absent on a dispatcher-to-dispatcher peer
 * message — absence IS the "ordinary peer" case.
 *
 * The worker tool sets this field from core truth; there is no tool argument
 * for it, so a model cannot claim another worker's identity.
 */
export interface WorkerReplyOrigin {
  readonly kind: "worker-reply";
  readonly workerId: string;
  readonly status?: WorkerReplyStatus;
}

/** One peer message. Immutable after accept. */
export interface PeerEnvelope {
  /** Sender-assigned unique id. Primary dedupe key. Required. */
  readonly messageId: string;
  readonly fromAgentId: string;
  readonly fromName: string;
  readonly to: PeerTarget;
  /**
   * Conversation / thread slot (forward-compatibility). C14 sort (ticket 70
   * §3): FENCED — kept in the schema, default-minted by the outbound tool,
   * never surfaced as a threading concept (U-B excludes threads/replies);
   * carried opaquely so a later in-scope hub would not be a breaking change.
   */
  readonly conversationId: string;
  readonly text: string;
  /** Reserved. MVP is text-first; empty array or omitted. */
  readonly imageRefs?: readonly string[];
  /**
   * The tier's one optional semantics (S9): the 1:1 lane choice. Inherently
   * 1:1 after the C14 retirement — group/broadcast targets no longer exist.
   * Never interrupts a user-owned dispatcher turn.
   */
  readonly priority: boolean;
  readonly createdAtMs: number;
  /**
   * Structured provenance (ticket 122). Present only on a worker's mid-task
   * reply; absent on a dispatcher-to-dispatcher peer message. Never derived
   * from `text` — the rendering may show a label, but this field is the
   * authority.
   */
  readonly origin?: WorkerReplyOrigin;
}

/**
 * Fire-and-forget accept result. Never carries the dispatcher's reply.
 * Ticket 70 §3: the ok branch reduces to `{ok, messageId, acceptedAtMs}` —
 * `priorityHonored` + the `group-target`/`broadcast-target` reasons retired
 * with the shapes they reported on (1:1 priority is always honored). The
 * failure reasons gain `self-target` (ticket 70 §2); `unknown-target` is
 * finally produced once the liveness knob is wired.
 */
export type PeerSendAck =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly acceptedAtMs: number;
    }
  | {
      readonly ok: false;
      readonly messageId: string;
      readonly reason:
        | "invalid-envelope"
        | "unknown-target"
        | "inbox-full"
        | "message-id-reuse"
        | "self-target";
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
  /** Structured provenance carried through from the envelope (ticket 122). */
  readonly origin?: WorkerReplyOrigin;
}

/**
 * Whether a notice is a worker's mid-task reply rather than an ordinary
 * dispatcher peer message. Structural check — never a text inspection.
 */
export function isWorkerReply(notice: PeerNotice): boolean {
  return notice.origin?.kind === "worker-reply";
}

/**
 * Sender label for a worker reply, rendered by the peer wake under its
 * "not from the user" heading. It is host-composed from the worker record
 * and the validated status word — the worker model supplies only the body
 * text, so it cannot fabricate this label. Presentation only: the
 * authoritative provenance is {@link WorkerReplyOrigin}.
 */
export function workerReplySenderLabel(
  workerTitle: string,
  status: WorkerReplyStatus | undefined,
): string {
  const title = workerTitle.length > 0 ? workerTitle : "worker";
  return status === undefined
    ? `worker reply — ${title}`
    : `worker reply (${status}) — ${title}`;
}

/**
 * Effective priority (design-14 §3.2, post-C14 ticket 70 §3). The target
 * check retired with the group/broadcast shapes: the flag IS the lane
 * choice on a 1:1 tier.
 */
export function effectivePeerPriority(envelope: PeerEnvelope): boolean {
  return envelope.priority;
}

/** Stable label for ack/copy (not a wire id). */
export function peerTargetLabel(to: PeerTarget): string {
  return `agent ${to.agentId}`;
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
    ...(envelope.origin !== undefined ? { origin: envelope.origin } : {}),
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
    imageRefsEqual(a.imageRefs, b.imageRefs) &&
    originsEqual(a.origin, b.origin)
  );
}

function originsEqual(
  a: WorkerReplyOrigin | undefined,
  b: WorkerReplyOrigin | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.kind === b.kind && a.workerId === b.workerId && a.status === b.status
  );
}

function targetsEqual(a: PeerTarget, b: PeerTarget): boolean {
  return a.kind === b.kind && a.agentId === b.agentId;
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
