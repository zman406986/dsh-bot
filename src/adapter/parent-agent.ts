import type { Multitask } from "../core/multitask.js";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
  buildPeerRosterSnapshot,
} from "../core/policy/assembler.js";
import { textBlocks } from "./content-blocks.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "./cordis-dsh-host.js";
import { WAKE_SOURCE_KIND, wakeUserMessage } from "./wake-copy.js";
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
   * `activateSpawnedDispatcher` existed only to dodge that gate). What the
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

  function deactivateSession(sessionId: string): void {
    if (!sessions.has(sessionId)) return;
    sessions.delete(sessionId);
    spawnTitles.delete(sessionId);
    origins.delete(sessionId);
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
    if (policyEnabled) {
      tryInject(
        agent,
        assembleSessionPolicy(true, origin, generation, policyLanguage),
      );
    }
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
