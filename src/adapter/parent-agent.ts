import type { Multitask } from "../core/multitask.js";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
  buildPeerRosterSnapshot,
} from "../core/policy/assembler.js";
import { textBlocks } from "./content-blocks.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "./cordis-dsh-host.js";
import {
  activationNoticeMessage,
  WAKE_SOURCE_KIND,
  wakeUserMessage,
} from "./wake-copy.js";
import {
  ACTIVATION_NOTICE_SUMMARY,
  DISPATCHER_START_SUCCESS,
} from "./activation-command.js";
import type { DispatcherOrigin, PolicyLanguage } from "../core/policy/prompts.js";

/**
 * Top-level dispatcher: no parent lineage, delegation depth 0.
 * Accepts the first session-started agent when header is inaccessible.
 */
export function isTopLevel(agent: AgentLike): boolean {
  const header = agent.session?.header;
  if (header == null) return true;
  const parent = header.parentSession;
  const depth = header.delegationDepth ?? 0;
  return (parent === null || parent === undefined) && depth === 0;
}

/** Structural system/plugin context message for `Agent.inject`. */
export interface PluginContextMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: ReturnType<typeof textBlocks>;
  readonly source: {
    readonly kind: string;
  };
}

let injectSeq = 0;

function pluginContextMessage(text: string): PluginContextMessage {
  injectSeq += 1;
  return {
    id: `multitask-policy-${Date.now()}-${injectSeq}`,
    role: "user",
    content: textBlocks(text),
    source: {
      // Format v4 rejects the retired `kind: "plugin"` wrapper; this is the
      // producer-owned kind the v3→v4 migration assigns to this plugin.
      kind: WAKE_SOURCE_KIND,
    },
  };
}

/** Best-effort context inject; no-op when the agent has no inject. */
function tryInject(agent: AgentLike, text: string): void {
  if (typeof agent.inject !== "function") return;
  if (text.length === 0) return;
  try {
    // A live driver may return a rejected promise rather than throw
    // synchronously; dsh treats an unhandled rejection as fatal, so both
    // failure shapes are owned here.
    void Promise.resolve(agent.inject(pluginContextMessage(text))).catch(() => {
      // Injection is best-effort; never break activation on it.
    });
  } catch {
    // Injection is best-effort; never break activation on it.
  }
}

/** Structural view of one committed session-log event. */
interface TranscriptEventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly data?: unknown;
}

/**
 * The event type the host commits for an injected `user` message
 * (`dsh-agent-loop` pre-step). Only a COMMITTED user message proves the policy
 * is in context; a queued inject does not.
 */
const COMMITTED_USER_MESSAGE_EVENT = "user/message";

/** A synchronous `sessionQuery` listing seam, when the adapter exposes one. */
interface SessionQueryLike {
  listEvents(sessionId: string): unknown;
}

/**
 * Read the supported session-log listing service (`ctx.get("sessionQuery")`),
 * guarded — the same two-step rule the plugin uses for every optional host
 * service. A live cordis context THROWS at property access for a service it
 * never injected, and the query service itself may throw while its store is
 * closed; both mean "cannot establish", never a policy-less dispatcher.
 */
function readSessionQuery(ctx: AdapterContext): SessionQueryLike | undefined {
  if (typeof ctx.get !== "function") return undefined;
  try {
    const service = ctx.get("sessionQuery");
    if (typeof service !== "object" || service === null) return undefined;
    const candidate = service as Partial<SessionQueryLike>;
    if (typeof candidate.listEvents !== "function") return undefined;
    return service as SessionQueryLike;
  } catch {
    return undefined;
  }
}

/** Join a committed message's text blocks; empty when unreadable. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null
        ? (block as { readonly text?: unknown }).text
        : undefined,
    )
    .filter((part): part is string => typeof part === "string")
    .join("");
}

/** Whether one event is a committed user message from THIS producer. */
function isCommittedProducerMessage(event: TranscriptEventLike): boolean {
  if (event.type !== COMMITTED_USER_MESSAGE_EVENT) return false;
  const data = event.data;
  if (typeof data !== "object" || data === null) return false;
  const record = data as {
    readonly role?: unknown;
    readonly source?: { readonly kind?: unknown } | null;
  };
  if (record.role !== "user") return false;
  if (typeof record.source !== "object" || record.source === null) {
    return false;
  }
  return record.source.kind === WAKE_SOURCE_KIND;
}

/**
 * Whether a compaction/shadowing event after `seq` could have removed the
 * policy node at `seq` from the LIVE context.
 *
 * Conservative by construction: any `compaction/*` event after the match, any
 * `shadowedSeqs` entry for it, any shadow range covering it, or any later
 * `surfaceOp` replacement of its span makes the match unprovable. Positions
 * come from the listing's numeric seqs when every event has one; otherwise
 * the listing's array order is the established position. A listing that
 * cannot be read at all makes the caller inject again rather than risk a
 * dispatcher without its policy.
 */
function policyNodeSurvives(
  positions: readonly { readonly event: TranscriptEventLike; readonly seq: number }[],
  seq: number,
): boolean {
  for (const { event, seq: eventSeq } of positions) {
    const data =
      typeof event.data === "object" && event.data !== null
        ? (event.data as Record<string, unknown>)
        : undefined;
    const type = typeof event.type === "string" ? event.type : "";
    if (type.startsWith("compaction/")) {
      // A compaction at or before the match cannot have removed it; one that
      // happens after may have.
      if (eventSeq > seq) return false;
    }
    if (data === undefined) continue;
    const shadowedSeqs = data["shadowedSeqs"];
    if (
      Array.isArray(shadowedSeqs) &&
      shadowedSeqs.some((shadowed) => shadowed === seq)
    ) {
      return false;
    }
    const shadowedRange = data["shadowedRange"];
    if (typeof shadowedRange === "object" && shadowedRange !== null) {
      const range = shadowedRange as {
        readonly start?: unknown;
        readonly end?: unknown;
      };
      if (
        typeof range.start === "number" &&
        typeof range.end === "number" &&
        seq >= range.start &&
        seq <= range.end
      ) {
        return false;
      }
    }
    const surfaceOp = data["surfaceOp"];
    if (typeof surfaceOp === "object" && surfaceOp !== null) {
      const op = surfaceOp as {
        readonly op?: unknown;
        readonly startSeq?: unknown;
        readonly endSeq?: unknown;
      };
      if (
        op.op === "replace" &&
        typeof op.startSeq === "number" &&
        typeof op.endSeq === "number" &&
        seq >= op.startSeq &&
        seq <= op.endSeq &&
        eventSeq > seq
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Read one session's committed events, preferring the supported listing.
 *
 * 1. `ctx.get("sessionQuery").listEvents(sessionId)` — the non-deprecated
 *    exact-read service.
 * 2. `session.snapshotEvents()` — deprecated, and consulted ONLY as a
 *    last-resort local read when the service is absent. It keeps a stub/older
 *    host from re-injecting on every re-activation and is still subjected to
 *    every conservative check below.
 * 3. Neither readable → undefined, which the caller treats as "cannot
 *    establish" and therefore injects.
 *
 * A promise from either source is not decidable at this synchronous point;
 * activation must stay synchronous, so it fails open (inject) rather than
 * blocking on a read.
 */
function readTranscriptEvents(
  ctx: AdapterContext,
  agent: AgentLike,
): readonly unknown[] | undefined {
  const query = readSessionQuery(ctx);
  if (query !== undefined) {
    let listed: unknown;
    try {
      listed = query.listEvents(String(agent.session.id));
    } catch {
      return undefined;
    }
    if (
      listed !== null &&
      typeof listed === "object" &&
      typeof (listed as { then?: unknown }).then !== "function" &&
      Array.isArray(listed)
    ) {
      return listed;
    }
    return undefined;
  }
  const session = agent.session as unknown as {
    snapshotEvents?: () => unknown;
  };
  if (typeof session.snapshotEvents !== "function") return undefined;
  try {
    const listed = session.snapshotEvents();
    return Array.isArray(listed) ? listed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this session's LIVE context already carries the exact session-policy
 * text.
 *
 * WHY: the session policy is injected once per ACTIVATION, but a session can
 * be activated again — a re-announcement after disposal (ticket 163 defect 3)
 * or a restart resume. `agent.inject` queues context, which the loop commits
 * as a `user/message` in the session log, so the previous activation's copy is
 * still in the transcript. Injecting again on every re-activation doubles the
 * block in context each time; this check makes the inject idempotent.
 *
 * CONSERVATIVE (second-round audit): the old probe scanned every persisted
 * event body for the text, including compacted/shadowed copies and assistant
 * echoes, and could skip a needed inject when the live context no longer
 * carried the policy. A skip now requires ALL of:
 * - a COMMITTED `user/message`;
 * - from this producer (`WAKE_SOURCE_KIND`), so an assistant echo or another
 *   plugin's copy does not count;
 * - an exact text match; and
 * - the event's seq, with no later compaction/shadowing/replacement covering
 *   it.
 * Anything else injects again — never leave a dispatcher without its policy.
 *
 * Source: the supported `ctx.get("sessionQuery")` listing is preferred. The
 * deprecated `Session.snapshotEvents()` is only a last-resort local read when
 * that service is absent, and it gets the SAME conservative checks (its array
 * order establishes the compaction position). When neither source can answer
 * synchronously, this fails OPEN and re-injects; the recorded cost is a
 * duplicate policy block on such a host after a re-activation. That is
 * preferred to a missing policy, and it disappears once the supported service
 * is present.
 */
function transcriptCarriesPolicy(
  ctx: AdapterContext,
  agent: AgentLike,
  policy: string,
): boolean {
  const listed = readTranscriptEvents(ctx, agent);
  if (listed === undefined) return false;
  const events = listed.filter(
    (event): event is TranscriptEventLike =>
      typeof event === "object" && event !== null,
  );
  if (events.length === 0) return false;
  // Ordering: use the committed seq when the listing carries one for EVERY
  // event. A listing without seqs (the deprecated snapshot, a structural stub)
  // still has an order — array position — and compaction is detected by the
  // events in that same order, so it is enough to establish invalidation.
  const allHaveSeq = events.every(
    (event) =>
      typeof event.seq === "number" && Number.isFinite(event.seq),
  );
  const positions = events.map((event, index) => ({
    event,
    seq: allHaveSeq ? (event.seq as number) : index,
  }));
  for (const { event, seq } of positions) {
    if (!isCommittedProducerMessage(event)) continue;
    const data = event.data as { readonly content?: unknown };
    if (!messageText(data.content).includes(policy)) continue;
    if (policyNodeSurvives(positions, seq)) return true;
  }
  return false;
}

/** Structural view of the host's live session surface (ticket 296). */
interface SessionSurfaceLike {
  readonly nodes?: unknown;
}

/** The two synchronous reads a surface probe needs from a session. */
interface SurfaceSessionLike {
  readonly surface?: SessionSurfaceLike | null;
  readonly eventAt?: (seq: never) => unknown;
}

/** Answer from the live-surface probe; `unknown` means "cannot read it". */
type SurfacePolicyState = "present" | "absent" | "unknown";

/**
 * Whether the exact session-policy bytes sit on this session's LIVE surface
 * (ticket 296).
 *
 * WHY: the policy is one user-role message injected at activation. Host
 * compaction replaces the whole non-system range with a summary checkpoint
 * (`dsh-compaction-basic/lib/index.js` line 415), so the system head survives
 * while our message is shadowed, and a compacted dispatcher runs policy-less
 * for the rest of the session. `transcriptCarriesPolicy` above cannot answer
 * this: it asks "did anything after the node invalidate it?" and a compaction
 * makes that permanently false, so a per-turn reuse would inject every turn
 * forever.
 *
 * This probe asks the only question that matters: is a committed
 * `user/message` carrying exactly these bytes a CURRENT surface node?
 * `surface.nodes` already excludes every shadowed node, so no seq arithmetic
 * and no compaction history is involved. A readable surface with no such node
 * is `"absent"`; a missing/throwing seam is `"unknown"` and leaves the caller's
 * existing fallback in charge.
 *
 * Read-only by construction: `eventAt` is a read, and this function never
 * appends or injects.
 */
function policyOnLiveSurface(
  agent: AgentLike,
  policy: string,
): SurfacePolicyState {
  const session = agent.session as unknown as SurfaceSessionLike;
  const surface = session.surface;
  if (surface === undefined || surface === null) return "unknown";
  const nodes = surface.nodes;
  if (!Array.isArray(nodes)) return "unknown";
  if (typeof session.eventAt !== "function") return "unknown";
  for (const node of nodes) {
    let event: unknown;
    try {
      event = session.eventAt(node as never);
    } catch {
      return "unknown";
    }
    if (typeof event !== "object" || event === null) return "unknown";
    if (!isCommittedProducerMessage(event as TranscriptEventLike)) continue;
    const data = (event as TranscriptEventLike).data as {
      readonly content?: unknown;
    };
    // Exact bytes, not a substring: a checkpoint summary that quotes the
    // policy is not the policy, and only our own inject produces this text.
    if (messageText(data.content) === policy) return "present";
  }
  return "absent";
}

/** Read one session reference from a two-arg `session/event` payload. */
function sessionIdOfRef(ref: unknown): string | null {
  if (typeof ref === "object" && ref !== null) {
    const id = (ref as { readonly id?: unknown }).id;
    if (id !== undefined && id !== null) return String(id);
  }
  if (typeof ref === "string" && ref.length > 0) return ref;
  return null;
}

/**
 * Best-effort *waking* delivery (ticket 57, register D-4).
 *
 * The difference from `tryInject` is the host primitive, not the payload:
 * `Agent.followup` is `send(input, "next-turn", wakeup=true)`, and a wake
 * submitted while the agent is idle always opens its turn boundary. `inject`
 * is `send(input, "next-step", wakeup=false)` — it queues context into a turn
 * that may never come. Verified against the installed host in the ticket-52
 * pass (`docs/research/dsh-loop-capability-map.md`, stage 7).
 *
 * Use this whenever the message MUST be acted on without the user happening
 * to send something next: activation-time recovery, and the settle wake. Use
 * `tryInject` when a turn is already open and extra model calls are waste.
 */
function tryWake(agent: AgentLike, text: string): void {
  if (text.length === 0) return;
  try {
    // `followup` is typed void, but a live driver can return a rejected
    // promise; leaving that unowned would surface as an unhandled rejection
    // (fatal in dsh) for a wake that is documented as best-effort.
    void Promise.resolve(agent.followup(wakeUserMessage(text))).catch(() => {
      // Waking is best-effort; never break activation on it.
    });
  } catch {
    // Waking is best-effort; never break activation on it.
  }
}

/**
 * Ticket 295: put the activation confirmation on the session's VISIBLE
 * surface — model-free, turn-free.
 *
 * `agent.followup` would print the same text but spends a model turn (see
 * {@link tryWake}); `session.append("user/message", …, { surfaceOp: "append" })`
 * adds the message to the surface and the next request's context without an
 * inbox entry and without waking the driver (`dsh-session/lib/index.js:1524-1535`,
 * `:442-445`; ADR-0032:56 records the property). The chat then renders a
 * `form: "notice"` row whose summary is the collapsed one-liner and whose body
 * is the full confirmation — which the command card could never show
 * (`dsh-client-ui-chat/lib/client.js:8489` collapses any text without a
 * newline).
 *
 * Best-effort by construction: a session without the seam keeps the pre-295
 * behavior (the command card only) rather than faking a wake.
 */
function tryActivationNotice(agent: AgentLike): void {
  const append = agent.session.append;
  if (typeof append !== "function") return;
  try {
    const event = append.call(
      agent.session,
      "user/message",
      activationNoticeMessage(DISPATCHER_START_SUCCESS, ACTIVATION_NOTICE_SUMMARY),
      { surfaceOp: "append" },
    );
    // A structural stub may answer with a promise; own it so a rejection can
    // never surface as fatal (the append is best-effort).
    void Promise.resolve(event).catch(() => {
      // Visible confirmation is best-effort; never break activation on it.
    });
  } catch {
    // Visible confirmation is best-effort; never break activation on it.
  }
}

/**
 * Result of an activation attempt (ticket 19). Activation is explicit,
 * once per session, and refused with a reason the command handler maps
 * to user-facing copy. ADR-0019: multiple dispatchers are real — a second
 * chat's activation succeeds (no `already-active-elsewhere` refusal exists
 * anymore); only re-activating an ALREADY active chat and child chats
 * refuse.
 *
 * ONE outcome type for every dispatcher session. The spawned path used to
 * carry its own union (a `SpawnedActivationOutcome` alias, with no
 * `not-top-level` arm) because a summoned child could never pass the
 * top-level gate; since the summon is a top-level session parallel to its
 * summoner, it passes the same gate and earns the same answers as any other
 * chat — the alias is gone, not just deprecated.
 */
export type ActivationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not-top-level" | "already-active-here" | "unbound";
    };

/**
 * What the CALLER knows and the top-level gate cannot see. Omitted entirely
 * for a user chat, which is why that path stays byte-identical.
 */
export interface DispatcherActivationOptions {
  /**
   * Ticket 141: whose dispatcher this session is. `user` (the default) is the
   * `/dsh-bot` chat. Ticket 175 / ADR-0034: this is the session's POLICY
   * CLASS, and it now reaches every model-facing block (the session section,
   * the standing rules, the wake steps) and is recorded per session for the
   * life of the activation. It never moves the top-level gate.
   */
  readonly origin?: DispatcherOrigin;
  /**
   * Ticket 141: the spawn generation — 1 for a user-started dispatcher (the
   * default), the spawner's + 1 for a summoned one, which the caller passes
   * explicitly. Stored so
   * {@link BindDispatcherLifecycleResult.dispatcherGeneration} can answer it.
   */
  readonly generation?: number;
  /**
   * Ticket 155: the human label the spawn carried (`DispatcherSpawnOptions.title`),
   * kept as this peer's roster label for the life of the activation. A
   * summoned session is top-level, so it has no `subagent` descriptor and no
   * `subagent.label` to read; without this it would render its raw session id
   * in every peer roster. Absent for a user chat, whose row keeps rendering
   * its session id exactly as ticket 155 decided.
   */
  readonly title?: string;
}

export interface BindDispatcherLifecycleResult {
  /**
   * Activate this chat as a dispatcher (ADR-0009): bind its parent,
   * inject policy once. Idempotent-refusing per session — never re-binds a
   * chat that is already the dispatcher. ADR-0019: activating a DIFFERENT
   * chat succeeds; each dispatcher session owns its own surface and state.
   *
   * ONE entry point for every dispatcher session, user-started and summoned
   * alike. A summoned dispatcher is now a top-level session parallel to its
   * summoner, so the top-level gate admits it for the same reason it admits a
   * user chat — hence no second, gate-free path exists (the pre-2026-10-28
   * spawn-time activation hook, then called `activateSpawnedDispatcher`,
   * existed only to dodge that gate; it is `activateSummonedDispatcher` now
   * and goes through the gate). What the
   * caller must still tell it is what the gate cannot see: `options.origin`,
   * `options.generation` and `options.title`. Omit `options` entirely for a
   * user chat and the behaviour is byte-identical to before.
   */
  activate(
    agent: AgentLike,
    options?: DispatcherActivationOptions,
  ): ActivationOutcome;
  /**
   * Best-effort one-shot **waking** delivery into ONE activated dispatcher
   * chat (ticket 57, register D-4): opens a recovery turn rather than
   * waiting for one. Used at activation for that session's restart-honesty
   * notice. No-op when the session is not an activated dispatcher.
   *
   * Named for activation, not boot: activation is our only trigger today
   * (ADR-0009). If ADR-0016 is signed into a boot hook, that hook calls this
   * same primitive — the trigger model is a separate decision (item U-1).
   */
  wakeNotice(sessionId: string, text: string): void;
  /**
   * The most recently activated dispatcher session id, or null while
   * dormant. ADR-0019 map-of-one compatibility accessor: with a single
   * dispatcher this is the dispatcher session; with several, prefer
   * {@link isDispatcherSession} / {@link dispatcherSessionIds} — this slot
   * carries no authority.
   */
  dispatcherSessionId(): string | null;
  /** Whether this session is an activated dispatcher (ADR-0019). */
  isDispatcherSession(sessionId: string): boolean;
  /**
   * Activation generation for a session (ticket 90, F2): a counter bumped on
   * every activation and returned only while THAT activation is live — null
   * once the session is deactivated. A caller that captured the value at
   * activation can tell "my activation" from "a later activation of the same
   * session id", which {@link isDispatcherSession} (set membership) cannot:
   * after a deactivate → re-activate, membership is true again and a chain
   * from the previous activation would act for the new one.
   */
  activationGeneration(sessionId: string): number | null;
  /**
   * Spawn generation of an activated session (ticket 141): 1 for a
   * user-started dispatcher, N+1 for a dispatcher spawned by a generation-N
   * dispatcher. Null once the session is deactivated, like
   * {@link activationGeneration} — a caller that needs the durable number for
   * a dormant child reads the mark row instead.
   *
   * This is NOT {@link activationGeneration}: that one counts activations of
   * one session id, this one is the depth of the dispatcher tree.
   */
  dispatcherGeneration(sessionId: string): number | null;
  /**
   * The policy class of an activated session (ticket 175 / ADR-0034), or
   * null once the session is deactivated — gated on `sessions` membership
   * exactly like {@link activationGeneration} and
   * {@link dispatcherGeneration}.
   *
   * Null means "not a live activation", never a guessed class: callers that
   * need today's behaviour for a dormant session pass `"user"` themselves,
   * which is the same default a forgotten argument produces.
   */
  dispatcherOrigin(sessionId: string): DispatcherOrigin | null;
  /** Every activated dispatcher session id (ADR-0019). */
  dispatcherSessionIds(): readonly string[];
  /**
   * Deactivate ONE activated dispatcher session (ticket 101, ADR-0021
   * decision 3 — the UI's delete affordance rides this). This is the SAME
   * path the host `agent/disposed` handler runs — the internal
   * `deactivateSession` sequence, never a fork: drop the session from the
   * registry, `host.unbindParent(sessionId)`, fire `onDeactivated` (the
   * plugin unregisters that session's tool surface, clears its access-policy
   * rows, abandons its prompts, and clears its roster mirror). From any
   * observer's perspective a command-path deactivation is indistinguishable
   * from a host-side dispose of that session — the restart-honesty and
   * durable-roster invariants hold unchanged. A no-op for a session that is
   * not an activated dispatcher (the caller gates on
   * {@link isDispatcherSession} first so the refusal copy is honest).
   */
  deactivate(sessionId: string): void;
  /** Tear down listeners and every activation, if any. */
  unbind(): void;
}

export interface BindDispatcherLifecycleOptions {
  /**
   * Session-start flag (ADR-0005). Read once when the dispatcher binds.
   * OFF → no policy inject. Defaults to true.
   */
  readonly policyEnabled?: boolean;
  /**
   * Ticket 153: which face the model-facing policy copy ships in. Read once
   * from the host locale preference at apply (`resolveHostPolicyLanguage`);
   * omitted means EN, the byte-stable face every pre-153 caller produced.
   */
  readonly policyLanguage?: PolicyLanguage;
  /**
   * Fired after a successful activation (parent bound + policy injected).
   * The plugin registers that session's dispatcher tool surface here.
   */
  readonly onActivated?: (sessionId: string) => void;
  /**
   * Fired when ONE activation ends (ADR-0019): that dispatcher session
   * disposed, or the lifecycle is unbound (unload/HMR — fired per session).
   * The plugin unregisters that session's tool surface, clears that
   * session's access-policy rows, and abandons that session's prompts here.
   */
  readonly onDeactivated?: (sessionId: string) => void;
  /**
   * Ticket 155: the durable human-readable label of ONE peer session, or
   * null when none is readable. ADR-0027 decision 2 names `subagent.label` as
   * the label and decision 3 reads it from the session projection
   * (`projectionValues.subagent.label`); the registry is reached through the
   * plugin's guarded `ctx.get("sessionProjections")`, so the read is handed
   * in rather than performed here (the adapter holds no plugin context).
   *
   * `session` is the live host session of the peer (the `AgentLike.session`
   * this lifecycle already holds) — the registry read needs the Session, not
   * its id.
   *
   * The roster's fallback is label → title → session id, and this seam
   * supplies only the first step: an absent, throwing, or unreadable answer
   * simply leaves the label empty and the row falls back — never a guess.
   * Only SPAWNED children carry a descriptor, so a user-started dispatcher
   * answers null and renders its id, exactly as before.
   */
  readonly peerLabelOf?: (session: unknown) => string | null;
}

/**
 * Activation lifecycle for dispatcher parent agents (ticket 19, ADR-0009;
 * generalized per session by ADR-0019).
 *
 * Nothing is captured on load or on `agent/session-start` — the plugin boots
 * dormant and stock. An explicit command handler calls {@link activate} in
 * the chat the user chose; that binds the live Agent as THAT session's
 * dispatcher parent and injects the session policy once. Multiple chats may
 * each be dispatchers; `agent/disposed` deactivates only the disposed
 * session and `unbind` reverses every activation. The passive
 * `agent/status` listener wires, per session:
 * - wakeBus session turn bounds (dispatcher running/idle)
 * - worker FSM first turn (child running → multitask.noteTurnStarted)
 * - step-boundary (child idle → host.emitStepBoundary)
 * - per-turn reminder on dispatcher turn start (T11)
 *
 * Distinct id spaces — do not conflate:
 * | Call | Id |
 * |---|---|
 * | multitask.noteTurnStarted | workerId |
 * | wakeBus.noteTurnStarted/Ended | dispatcherSessionId |
 */
export function bindDispatcherLifecycle(
  ctx: AdapterContext,
  host: CordisDshHost,
  multitask: Multitask,
  options?: BindDispatcherLifecycleOptions,
): BindDispatcherLifecycleResult {
  const policyEnabled = options?.policyEnabled ?? true;
  const policyLanguage: PolicyLanguage = options?.policyLanguage ?? "en";
  const onActivated = options?.onActivated;
  const onDeactivated = options?.onDeactivated;
  const peerLabelOf = options?.peerLabelOf;
  /**
   * Activated dispatcher sessions: insertion-ordered sessionId → live agent.
   * The LAST entry is the most recently activated session (the map-of-one
   * compatibility slot).
   */
  const sessions = new Map<string, AgentLike>();
  /**
   * Activation generation per session (ticket 90, F2): monotonic, never
   * reused, stamped at activation. The entry survives deactivation so the
   * value stays comparable; liveness is `sessions` membership, and
   * {@link BindDispatcherLifecycleResult.activationGeneration} reports null
   * for a session that is not an activated dispatcher.
   */
  const generations = new Map<string, number>();
  /**
   * Spawn generation per session (ticket 141) — a DIFFERENT number from the
   * activation counter above, and deliberately a separate map: that one is
   * "which activation of this session id is live" (ticket 90), this one is
   * "how deep in the dispatcher tree this session sits" (1 = user-started,
   * +1 per spawn). Reusing the counter would renumber a cold-resumed child.
   *
   * It is stored here only so {@link BindDispatcherLifecycleResult.dispatcherGeneration}
   * can report the live value; the durable source of truth is the mark row.
   */
  const spawnGenerations = new Map<string, number>();
  /**
   * Peer labels this lifecycle OWNS rather than reads (ticket 155, extended):
   * the `title` a dispatcher spawn carried. A summoned session is top-level,
   * so it has no `subagent` descriptor and `peerLabelOf` answers null for it —
   * without this entry its roster row would render the raw session id, which
   * is the regression ticket 155 fixed. The read seam above stays the first
   * source (it is what a user-started dispatcher's row has always used); this
   * map is consulted before falling back to the id.
   */
  const spawnTitles = new Map<string, string>();
  /**
   * Policy class per session (ticket 175 / ADR-0034 decision 1): which class
   * this activation runs — `user` (the human's chief of staff) or `spawned`
   * (a team leader another dispatcher summoned).
   *
   * A separate map from its three neighbours, deliberately: `generations` is
   * the activation counter (which activation of this session id is live),
   * `spawnGenerations` is the tree depth, `spawnTitles` is the roster label,
   * and this one is the policy class. They share a key and nothing else.
   *
   * Set at activation from the caller-supplied `origin`, and deleted at
   * deactivation so a later activation of the same session id cannot inherit
   * a stale class (ADR-0034 Consequences).
   */
  const origins = new Map<string, DispatcherOrigin>();
  let activationSeq = 0;
  let unbound = false;
  const disposers: Array<() => void> = [];
  /**
   * Sessions with a policy copy QUEUED but not yet committed — by activation
   * or by a `compaction/end` boundary (ticket 296). The running edge fires
   * before the step claims queued input, so the surface probe cannot see a
   * queued copy; without this mark the first turn after either path would
   * queue a second identical block. Cleared at turn end and whenever the
   * probe sees the policy present.
   */
  const policyInjectInFlight = new Set<string>();

  /**
   * The exact policy bytes for ONE activated session (ticket 296).
   *
   * Deliberately the same call activation makes — enabled, the stored class,
   * the stored spawn generation, the activation-wide language — so the
   * surface probe's exact-text match cannot drift from the injected text.
   * Callers only reach it for a session already in `sessions`.
   */
  function policyBytes(sessionId: string): string {
    return assembleSessionPolicy(
      true,
      origins.get(sessionId) ?? "user",
      spawnGenerations.get(sessionId) ?? 1,
      policyLanguage,
    );
  }

  function deactivateSession(sessionId: string): void {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    policyInjectInFlight.delete(sessionId);
    // Ticket 155: `spawnTitles` is NOT dropped here — the title is a property
    // of the session ID, exactly like `generations`, so a peer that is
    // deactivated and later re-activated keeps the label its peers render.
    // (Only `origins` belongs to one activation: ADR-0034 decision 1.)
    origins.delete(sessionId);
    // Defect fix (a disposed dispatcher stayed busy): an activation also ends
    // any turn it owned. `cancelTurn`, not `noteTurnEnded`: the latter flushes
    // pending work and can open a wake turn into the session being destroyed
    // (for a marked dispatcher, even a cold resume). Teardown must not
    // address the session it is tearing down.
    multitask.wakeBus.cancelTurn(sessionId);
    host.unbindParent(sessionId);
    onDeactivated?.(sessionId);
  }

  /**
   * Live peer rows for the prompt tail (ticket 121; ticket 155 adds the
   * label and the current tool). Eligible peers are the OTHER activated
   * dispatchers: workers are leaves and already reachable through the ledger
   * and `check_workers`, and a session never lists itself.
   *
   * Sources, each one an existing read — nothing new is polled:
   * - `label` — the plugin's `subagent.label` read (ADR-0027 decision 2) via
   *   `peerLabelOf`. Unreadable or absent stays null and the renderer falls
   *   back to the session id, exactly as before.
   * - `currentTool`/`currentTarget` — the host's per-dispatcher `tool/call`
   *   observation (`peerToolActivity`), keyed by session id and cleared at
   *   `turn/end`. The WORKER ring is never consulted: it is keyed by worker
   *   id, and passing a session id would read a different agent's ring.
   *
   * Absence renders nothing on both counts, so an unchanged roster stays
   * byte-identical.
   */
  function peerRosterFor(selfSessionId: string) {
    const candidates = [...sessions.entries()]
      .filter(([sessionId]) => sessionId !== selfSessionId)
      .map(([sessionId, peerAgent]) => {
        const tool = host.peerToolActivity(sessionId);
        return {
          sessionId,
          label: readPeerLabel(peerAgent.session) ?? spawnTitles.get(sessionId) ?? null,
          busy: multitask.wakeBus.isBusy(sessionId),
          queuedWake: multitask.wakeBus.peek(sessionId) !== undefined,
          currentTool: tool?.tool ?? null,
          currentTarget: tool?.target ?? null,
        };
      });
    return buildPeerRosterSnapshot(selfSessionId, candidates);
  }

  /** Best-effort label read: an absent seam or a throwing answer is null. */
  function readPeerLabel(session: unknown): string | null {
    if (peerLabelOf === undefined) return null;
    try {
      return peerLabelOf(session);
    } catch {
      // A label is prompt garnish; a broken read must never break the turn.
      return null;
    }
  }

  disposers.push(
    ctx.on("agent/disposed", (payload: never) => {
      const { agent } = payload as { agent: AgentLike };
      // Identity match, then deactivate exactly that session — a sibling
      // dispatcher's activation is untouched.
      for (const [sessionId, bound] of sessions) {
        if (bound === agent) {
          deactivateSession(sessionId);
          return;
        }
      }
    }),
  );

  disposers.push(
    ctx.on("agent/status", (payload: never) => {
      const { agent, status } = payload as {
        agent: AgentLike;
        status: "idle" | "running";
      };
      const agentSessionId = String(agent.session.id);

      // Dispatcher mid-turn hold so settles queue instead of flushing (T06).
      const boundAgent = sessions.get(agentSessionId);
      if (boundAgent !== undefined) {
        if (status === "running") {
          multitask.wakeBus.noteTurnStarted(agentSessionId);
          // Ticket 296: the policy is ONE user-role message, and host
          // compaction shadows the whole non-system range — the system head
          // survives but our message does not. Probe the LIVE surface and put
          // the exact same bytes back when it is gone. Injected BEFORE the
          // reminder so the reminder stays the newest tail (ticket 121).
          if (policyEnabled) {
            const policy = policyBytes(agentSessionId);
            const state = policyOnLiveSurface(boundAgent, policy);
            if (state === "present") {
              // The queued copy (if any) is now committed; a later boundary
              // may queue again.
              policyInjectInFlight.delete(agentSessionId);
            } else if (state === "absent") {
              // A copy already queued by activation or a compaction boundary
              // is claimed by THIS step's inbox drain (after the running
              // event), so it is not absent from context for long. Queueing a
              // second copy here would put two identical blocks in one step;
              // the turn-end clear leaves the next turn to judge the surface.
              if (!policyInjectInFlight.has(agentSessionId)) {
                tryInject(boundAgent, policy);
                policyInjectInFlight.add(agentSessionId);
              }
            }
          }
          // Per-turn reminder: re-inject ledger + standing rules (T11), then
          // the peer roster as the TAIL section (ticket 121). Tail placement is
          // load-bearing: everything above it stays byte-stable so the cached
          // prompt prefix survives.
          if (policyEnabled) {
            tryInject(
              boundAgent,
              assembleTurnReminder(
                multitask.listTodos(agentSessionId),
                peerRosterFor(agentSessionId),
                policyLanguage,
                // Ticket 175: the reminder carries the class's standing
                // rules. A session the map somehow lacks falls back to
                // `user`, which is the same default every pre-175
                // activation produced.
                origins.get(agentSessionId) ?? "user",
              ),
            );
          }
        }
        if (status === "idle") {
          // Ticket 58 (register D-5): decide the delivery redrive BEFORE the
          // bus is told the turn ended. Ordering matters twice over — the
          // pass only counts an attempt if the result is still undelivered
          // (so a turn that delivered costs nothing), and while the bus is
          // still busy the redrive becomes a pending flag, so the turn-end
          // flush delivers it exactly once alongside anything else waiting.
          if (policyEnabled) {
            multitask.redriveUndelivered(agentSessionId);
          }
          // Ticket 296: a closed turn settles any boundary queued during it;
          // the next turn's probe decides from the committed surface.
          policyInjectInFlight.delete(agentSessionId);
          multitask.wakeBus.noteTurnEnded(agentSessionId);
        }
        return;
      }

      // Worker paths — only our spawned children.
      const workerId = host.workerIdOf(agentSessionId);
      if (workerId === undefined) return;
      if (status === "running") {
        // First real activity: spawned → running on the core FSM.
        multitask.noteTurnStarted(workerId);
      }
      if (status === "idle") {
        // Steer delivery point: core pops a parked last-wins steer.
        host.emitStepBoundary(workerId);
      }
    }),
  );

  // Ticket 296: a host compaction closes with `compaction/end` AFTER the
  // replacement user message has entered the surface (`dsh-compaction` types:
  // "the actual surface replacement is performed by the immediately following
  // `user/message` event"). This is the earliest honest moment to put the
  // policy back inside the SAME turn. The listener is deliberately narrow:
  // a bound dispatcher session only, so the worker branch above and every
  // worker transcript stay untouched.
  disposers.push(
    ctx.on("session/event", (...args: never[]) => {
      const [sessionRef, rawEvent] = args as unknown as [unknown, unknown];
      if (typeof rawEvent !== "object" || rawEvent === null) return;
      if ((rawEvent as { readonly type?: unknown }).type !== "compaction/end") {
        return;
      }
      if (!policyEnabled) return;
      const sessionId = sessionIdOfRef(sessionRef);
      if (sessionId === null) return;
      const agent = sessions.get(sessionId);
      if (agent === undefined) return;
      const policy = policyBytes(sessionId);
      // A failed compaction leaves the surface unchanged; the probe then sees
      // the policy and this boundary injects nothing.
      if (policyOnLiveSurface(agent, policy) === "present") {
        policyInjectInFlight.delete(sessionId);
        return;
      }
      // A copy is already queued (activation or an earlier boundary in this
      // same turn). Two boundaries in one turn must not queue two blocks.
      if (policyInjectInFlight.has(sessionId)) return;
      policyInjectInFlight.add(sessionId);
      tryInject(agent, policy);
    }),
  );

  /**
   * The one activation sequence every entry point shares — TICKET 118:
   * extracted verbatim from `activate` so the spawned path cannot drift from
   * the command path.
   *
   * Ticket 175 / ADR-0034: `origin` is the session's POLICY CLASS, and it is
   * stored here so every later composition point can ask which class this
   * activation is — the per-turn reminder (`assembleTurnReminder`) and every
   * wake composition read it back through
   * {@link BindDispatcherLifecycleResult.dispatcherOrigin}. Until ticket 175
   * it reached the session policy section once and was then dropped.
   *
   * `generation` is stored so
   * {@link BindDispatcherLifecycleResult.dispatcherGeneration} can answer it,
   * and it reaches the policy text only.
   *
   * `title` (ticket 155) is the spawn's `DispatcherSpawnOptions.title`, kept
   * here as this peer's roster label. Nothing reads it at activation time; it
   * is the label every OTHER dispatcher's roster renders for this session.
   */
  function bindActivation(
    agent: AgentLike,
    sessionId: string,
    origin: DispatcherOrigin,
    generation: number,
    title?: string,
  ): void {
    // ADR-0019: another chat being a dispatcher is not a refusal — each
    // session activates independently.
    sessions.set(sessionId, agent);
    // Ticket 175: the class belongs to THIS activation and is dropped with it.
    origins.set(sessionId, origin);
    // Ticket 155: a summoned session has no `subagent.label`, so its spawn
    // title is the label its peers read. Omitted for a user chat.
    if (title !== undefined && title.length > 0) {
      spawnTitles.set(sessionId, title);
    }
    // Ticket 90 (F2): stamp THIS activation before anything observes it
    // (`onActivated` starts the rebuild chain that captures the value).
    activationSeq += 1;
    generations.set(sessionId, activationSeq);
    // Ticket 141: a separate number from the one above — see the map's doc.
    spawnGenerations.set(sessionId, generation);
    host.bindParent(agent, sessionId);
    // ADR-0005: policy is fixed for this session's lifetime.
    //
    // Defect fix (duplicate policy on re-activation): skip the inject when the
    // persisted transcript already carries this exact section — the previous
    // activation queued it, and it is still in context. Everything that cannot
    // prove that injects, so a dispatcher never comes back policy-less.
    if (policyEnabled) {
      const policy = assembleSessionPolicy(
        true,
        origin,
        generation,
        policyLanguage,
      );
      // Ticket 296: the LIVE surface is the authority when it is readable —
      // a committed producer message is in context, a compaction-shadowed one
      // is not. The transcript probe stays the fallback for a host/stub whose
      // surface cannot be read, so the pre-296 dedupe is unchanged there.
      const state = policyOnLiveSurface(agent, policy);
      if (
        state === "absent" ||
        (state === "unknown" && !transcriptCarriesPolicy(ctx, agent, policy))
      ) {
        tryInject(agent, policy);
        // The loop claims queued input at the NEXT step (after this
        // activation's own status edge, if any). The per-turn probe must not
        // queue a second copy before that claim; turn end clears the mark.
        policyInjectInFlight.add(sessionId);
      }
    }
    // Ticket 295: the command card collapses to one clipped line (the chat
    // only renders a command body when its text contains a newline), so the
    // SAME confirmation also lands as a visible surface notice. This is the
    // binding path: every refusal returns above, and a worker session never
    // reaches this function at all.
    tryActivationNotice(agent);
    onActivated?.(sessionId);
  }

  /**
   * The ONE activation path: gate, per-session idempotency, then bind. Every
   * entry point below is a thin caller of this — a summoned dispatcher is
   * admitted here exactly as a user chat is, which is the whole collapse.
   */
  function activateSession(
    agent: AgentLike,
    options?: DispatcherActivationOptions,
  ): ActivationOutcome {
    // HMR/unload safety: a torn-down lifecycle never re-binds.
    if (unbound) {
      return { ok: false, reason: "unbound" };
    }
    // Fail-open preserved: an inaccessible session header still counts as
    // top-level (documented isTopLevel behavior). A summoned dispatcher is a
    // top-level session now, so this same gate admits it — there is no
    // gate-free branch left to take.
    if (!isTopLevel(agent)) {
      return { ok: false, reason: "not-top-level" };
    }
    const sessionId = String(agent.session.id);
    if (sessions.has(sessionId)) {
      return { ok: false, reason: "already-active-here" };
    }
    // Defaults keep the user path byte-identical: generation 1, `user`
    // class, no spawn title. A summoned dispatcher's class and generation
    // come from its caller — the spawn path passes `origin: "spawned"`
    // explicitly, and the cold-resume hook passes the class the durable
    // projection reports. Neither one implies the other.
    const origin = options?.origin ?? "user";
    bindActivation(
      agent,
      sessionId,
      origin,
      options?.generation ?? 1,
      options?.title,
    );
    return { ok: true };
  }

  return {
    activate(
      agent: AgentLike,
      options?: DispatcherActivationOptions,
    ): ActivationOutcome {
      return activateSession(agent, options);
    },

    wakeNotice(sessionId: string, text: string): void {
      // Ticket 57 (D-4): the recovery notice must OPEN the turn it lands in.
      // `inject` only queues, so before this fix the notice sat in context
      // until the user happened to speak next — the chain stalled after a
      // restart. Waking is what the reference does on boot.
      const agent = sessions.get(sessionId);
      if (agent === undefined) return;
      tryWake(agent, text);
    },

    dispatcherSessionId(): string | null {
      // Insertion order: the last entry is the most recent activation.
      const ids = [...sessions.keys()];
      return ids.length === 0 ? null : (ids.at(-1) ?? null);
    },

    isDispatcherSession(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    activationGeneration(sessionId: string): number | null {
      if (!sessions.has(sessionId)) return null;
      return generations.get(sessionId) ?? null;
    },

    dispatcherGeneration(sessionId: string): number | null {
      // Gated on liveness exactly like `activationGeneration`: a dormant
      // session's number comes from its durable mark row, not from here.
      if (!sessions.has(sessionId)) return null;
      return spawnGenerations.get(sessionId) ?? null;
    },

    dispatcherOrigin(sessionId: string): DispatcherOrigin | null {
      // Same liveness gate as the two accessors above. A dormant session
      // answers null rather than guessing: its durable class is the caller's
      // read (the mark row / the kind projection), not this map's.
      if (!sessions.has(sessionId)) return null;
      return origins.get(sessionId) ?? null;
    },

    dispatcherSessionIds(): readonly string[] {
      return [...sessions.keys()];
    },

    deactivate(sessionId: string): void {
      deactivateSession(sessionId);
    },

    unbind(): void {
      for (const sessionId of [...sessions.keys()]) {
        deactivateSession(sessionId);
      }
      unbound = true;
      for (const dispose of disposers) {
        dispose();
      }
      disposers.length = 0;
    },
  };
}
