import type { Multitask } from "../core/multitask.js";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
  buildPeerRosterSnapshot,
} from "../core/policy/assembler.js";
import { textBlocks } from "./content-blocks.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "./cordis-dsh-host.js";
import { WAKE_SOURCE_KIND, wakeUserMessage } from "./wake-copy.js";
import type { DispatcherOrigin } from "../core/policy/prompts.js";

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
    agent.inject(pluginContextMessage(text));
  } catch {
    // Injection is best-effort; never break activation on it.
  }
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
    agent.followup(wakeUserMessage(text));
  } catch {
    // Waking is best-effort; never break activation on it.
  }
}

/**
 * Result of an activation attempt (ticket 19). Activation is explicit,
 * once per session, and refused with a reason the command handler maps
 * to user-facing copy. ADR-0019: multiple dispatchers are real — a second
 * chat's activation succeeds (no `already-active-elsewhere` refusal exists
 * anymore); only re-activating an ALREADY active chat and child chats
 * refuse.
 */
export type ActivationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not-top-level" | "already-active-here" | "unbound";
    };

/**
 * Result of {@link BindDispatcherLifecycleResult.activateSpawnedDispatcher}
 * (ticket 118, ADR-0025 mitosis). Deliberately NOT {@link ActivationOutcome}:
 * there is no `not-top-level` arm, because a spawned dispatcher is a subagent
 * by construction and the top-level gate is exactly what must not apply to it.
 *
 * `session-mismatch` is a wiring guard, not a cap: the passed session id must
 * be the child agent's own session id, or every per-session map (parent
 * binding, tool disposers, wake state) would key the wrong session.
 */
export type SpawnedActivationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "already-active-here" | "unbound" | "session-mismatch";
    };

export interface BindDispatcherLifecycleResult {
  /**
   * Activate this chat as a dispatcher (ADR-0009): bind its parent,
   * inject policy once. Idempotent-refusing per session — never re-binds a
   * chat that is already the dispatcher. ADR-0019: activating a DIFFERENT
   * chat succeeds; each dispatcher session owns its own surface and state.
   */
  activate(agent: AgentLike): ActivationOutcome;
  /**
   * Ticket 118 / ADR-0025 mitosis: activate a SPAWNED child as a dispatcher.
   *
   * The top-level gate is the only REFUSAL that differs from {@link activate}:
   * a spawned dispatcher is a subagent (`origin: 'subagent'`, depth ≥ 1) by
   * construction, so `not-top-level` would refuse every mitosis child. The
   * origin also selects the spawned policy wording (ticket 141) — the child is
   * told what it is instead of being told it is the user's assistant. Every
   * other step is the same sequence — parent bind, policy inject, lifecycle
   * registration, `onActivated` (which registers that session's scoped tool
   * surface and starts the durability rebuild).
   *
   * `activate()` itself stays unchanged for user chats (ADR-0009: a child
   * chat can never be turned into a dispatcher by a command).
   *
   * Idempotent-refusing per session, like `activate`. `session-mismatch`
   * guards the keying: `sessionId` must equal `String(agent.session.id)`.
   */
  activateSpawnedDispatcher(
    agent: AgentLike,
    sessionId: string,
    generation?: number,
  ): SpawnedActivationOutcome;
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
  let activationSeq = 0;
  let unbound = false;
  const disposers: Array<() => void> = [];

  function deactivateSession(sessionId: string): void {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
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
          label: readPeerLabel(peerAgent.session),
          busy: multitask.wakeBus.isBusy(sessionId),
          pendingApproval: multitask.listPendingAccess(sessionId).length > 0,
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

  /**
   * The one activation sequence both entry points share — TICKET 118:
   * extracted verbatim from `activate` so the spawned path cannot drift from
   * the command path. The ONLY thing the caller decides is the gate.
   *
   * Ticket 141: `origin` is the second thing the caller decides, and it only
   * reaches the policy text. `user` is the command path (`activate`);
   * `spawned` is this dispatcher's child (`activateSpawnedDispatcher`), which
   * has no user in its chat and no user-facing delivery, so its policy must
   * not claim either. Nothing else branches on it.
   *
   * `generation` is the third: the spawn generation the caller resolved (1 for
   * a user chat, the mark's value + 1 for a spawn). It is stored so
   * {@link BindDispatcherLifecycleResult.dispatcherGeneration} can answer it,
   * and it reaches the spawned policy text only.
   */
  function bindActivation(
    agent: AgentLike,
    sessionId: string,
    origin: DispatcherOrigin,
    generation: number,
  ): void {
    // ADR-0019: another chat being a dispatcher is not a refusal — each
    // session activates independently.
    sessions.set(sessionId, agent);
    // Ticket 90 (F2): stamp THIS activation before anything observes it
    // (`onActivated` starts the rebuild chain that captures the value).
    activationSeq += 1;
    generations.set(sessionId, activationSeq);
    // Ticket 141: a separate number from the one above — see the map's doc.
    spawnGenerations.set(sessionId, generation);
    host.bindParent(agent, sessionId);
    // ADR-0005: policy is fixed for this session's lifetime.
    if (policyEnabled) {
      tryInject(agent, assembleSessionPolicy(true, origin, generation));
    }
    onActivated?.(sessionId);
  }

  return {
    activate(agent: AgentLike): ActivationOutcome {
      // HMR/unload safety: a torn-down lifecycle never re-binds.
      if (unbound) {
        return { ok: false, reason: "unbound" };
      }
      // Fail-open preserved: an inaccessible session header still counts as
      // top-level (documented isTopLevel behavior).
      if (!isTopLevel(agent)) {
        return { ok: false, reason: "not-top-level" };
      }
      const sessionId = String(agent.session.id);
      if (sessions.has(sessionId)) {
        return { ok: false, reason: "already-active-here" };
      }
      bindActivation(agent, sessionId, "user", 1);
      return { ok: true };
    },

    /**
     * Ticket 118 / ADR-0025: the spawned-dispatcher path. Identical to
     * {@link activate} minus the top-level gate — the child is a subagent by
     * construction. `session-mismatch` is a keying guard, not a refusal
     * category a caller can earn by using the feature correctly.
     *
     * Ticket 141: `generation` is the child's spawn generation, resolved by
     * the caller from the mark row (or from the in-process spawn map). The
     * default 2 is the direct child of a user-started dispatcher — the shape
     * every pre-141 spawn produced.
     */
    activateSpawnedDispatcher(
      agent: AgentLike,
      sessionId: string,
      generation = 2,
    ): SpawnedActivationOutcome {
      if (unbound) {
        return { ok: false, reason: "unbound" };
      }
      if (String(agent.session.id) !== sessionId) {
        return { ok: false, reason: "session-mismatch" };
      }
      if (sessions.has(sessionId)) {
        return { ok: false, reason: "already-active-here" };
      }
      bindActivation(agent, sessionId, "spawned", generation);
      return { ok: true };
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
