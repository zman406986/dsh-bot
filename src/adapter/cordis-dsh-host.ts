import type { DshHost } from "../core/dsh-host.js";
import type {
  DurableDispatcherMark,
  DurableDispatcherMarkAnswer,
  DurabilityPort,
} from "../core/durability.js";
import type { AgentMessageWakeOrigin } from "../core/peer-types.js";
import { randomUUID } from "node:crypto";
import { clampActivity, clampRecentResultExcerpt } from "../core/report-clamp.js";
import {
  isTerminalStatus,
  type SettledEvent,
  type SpawnOptions,
  type TerminalWorkerStatus,
} from "../core/types.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
  ModelOptionPurpose,
  ModelOptionResolution,
  ModelRoute,
} from "../core/types.js";
import type { RosterRecentResultSource } from "../core/roster-snapshot.js";
import {
  normalizeWorkerErrorReport,
  normalizeWorkerReport as normalizeWorkerTextReport,
} from "../worker/report.js";
import {
  WORKER_MAX_DEPTH,
  workerSpawnMaxDepth,
  type WorkerAgentDef,
} from "../worker/agent-def.js";
import { applyWorkerComposition } from "../worker/preset.js";
import { blocksToText, textBlocks, type ContentBlock } from "./content-blocks.js";
import type { StorageDomainLike } from "./durable-marker.js";
import {
  resolveModelOption as resolveModelOptionInCatalog,
  type ModelCatalogLike,
} from "./model-option.js";
import {
  WAKE_SOURCE_KIND,
  resumeWakeCueFor,
  wakeCueFor,
  wakeUserMessage,
} from "./wake-copy.js";
import {
  formatSummoningDispatcherHandoffLine,
  type DispatcherOrigin,
  type PolicyLanguage,
} from "../core/policy/prompts.js";

export type { WorkerAgentDef };

/**
 * Structural Agent view — the live parent object dsh spawn/interrupt/send need.
 * Never re-fetched loosely for authority paths.
 */
export interface AgentLike {
  readonly session: {
    readonly id: unknown;
    readonly header?: {
      readonly parentSession?: unknown;
      readonly delegationDepth?: number;
      /**
       * The host's ownership marker. `"subagent"` (with a `parentSession`) is
       * the legacy subagent-child shape; a top-level session leaves it absent
       * (ADR-0032). Read as evidence only in `resumeDormantDispatcher`.
       */
      readonly origin?: unknown;
      /**
       * ADR-0032: the summoning dispatcher's working directory. A summoned
       * dispatcher session is created in the SAME cwd, because the host's
       * cross-session route (`sessionController.resolveAgent`) refuses a
       * session whose header carries no `cwd`
       * (`dsh-api-session-controller/lib/index.js:393`) — i.e. no `cwd`
       * means no cold resume, ever.
       */
      readonly cwd?: unknown;
    };
    /**
     * The session's current request header, when the structural session view
     * exposes it. `config` is the resolved route the next request uses
     * (`provider`/`model`/`reasoningEffort`/`maxTokens`) — the fallback source
     * for a summoned dispatcher's `agentOptions` when `Agent.model` is absent.
     */
    requestHeader?(): unknown;
  };
  /**
   * The agent's live model selection, when the structural view exposes it.
   * `current()` answers the route the NEXT request will use (a selection made
   * in the UI is reflected here), which is what a summoned peer must inherit —
   * `options` alone is only the initial/deployment route.
   */
  readonly model?: {
    current(): unknown;
  };
  /**
   * ADR-0032: the provider/model route this agent's requests use
   * (`dsh-agent/lib/types/runtime-types.d.ts:139`). Read, never written — the
   * summoned session is created on the summoner's own route instead of
   * inheriting it through a subagent descriptor that no longer exists.
   */
  readonly options?: AgentOptionsLike;
  followup(message: unknown): void;
  /** Queue context without opening a turn (optional; policy inject). */
  inject?(message: unknown): void;
  /**
   * ADR-0019: the host's own per-agent scoped context (structural view of
   * `agent.ctx` — every agent loop mints one; `tools.register` addressed
   * through it registers in THIS agent's scope only, so a second dispatcher
   * never sees the first's tools and worker children never see any of them).
   * `systemPrompt.section` likewise contributes to this agent's prompt only,
   * which is what makes a scoped `deployment:persona-prefix` shadow the
   * deployment persona for one child. Optional so stub agents stay minimal.
   */
  readonly ctx?: {
    readonly tools?: ToolsLike;
    readonly systemPrompt?: SystemPromptLike;
  };
}

/** Scoped system-prompt surface used to shadow a child's persona section. */
export interface SystemPromptLike {
  section(section: {
    readonly name: string;
    readonly order: number;
    readonly text: string;
    readonly interpolate?: boolean;
  }): () => void;
  getSectionOrder(name: string): number;
}

export interface ActivationLike {
  readonly childId: unknown;
  readonly messageId?: unknown;
  readonly result?: Promise<unknown>;
  /** Stop and release this exact activation; never a later cold resume. */
  dispose(): Promise<void>;
}

/**
 * Structural view of `AgentOptions` (`dsh-agent/lib/types/runtime-types.d.ts:21`).
 * Only the route pair this adapter copies; the rest is opaque and never sent.
 */
export interface AgentOptionsLike {
  readonly provider?: string;
  readonly model?: string;
  /**
   * Forwarded to a summoned peer when the summoner's live route carries them.
   * Values stay `unknown`-compatible through the index signature; the reader
   * below accepts only a string/number effort and a positive numeric
   * `maxTokens`.
   */
  readonly reasoningEffort?: string | number;
  readonly maxTokens?: number;
  readonly [key: string]: unknown;
}

/**
 * Structural session metadata for a plugin-created TOP-LEVEL session
 * (ADR-0032). Deliberately narrow: `cwd` and nothing else. The host also
 * accepts `parentSession`, `origin` and `delegationDepth` here, and setting
 * ANY of them re-classifies the session as subagent-owned by the host's OR
 * guard (`dsh-api-session-controller/lib/index.js:128-134`), after which every
 * ordinary route refuses it with `session/agent-busy`. Typing them out is what
 * keeps that mistake unrepresentable.
 */
export interface TopLevelSessionMetaLike {
  readonly cwd?: string;
  /**
   * The agent preset this session JOINED — the same field, with the same
   * meaning, that the host's own create route writes
   * (`dsh-api-session-controller/lib/index.js:433-436`).
   *
   * It is the only durable record of that choice: the session header is seeded
   * from it (`dsh-session/lib/index.js:1840`), the `agentPreset` projection
   * inits from that header (`dsh-agent-preset-registry/lib/index.js:51`), and
   * a cold resume composes whatever the projection still says
   * (`dsh-api-session-controller/lib/index.js:305-308`). Omitted, the peer
   * comes back on the deployment DEFAULT preset — a different tool surface
   * from the one its summoner runs. Unlike `parentSession`/`origin`/
   * `delegationDepth` this is not an ownership field: it does not
   * re-classify the session.
   */
  readonly agentPreset?: string;
}

/** Structural view of `CreateAgentOptions` (`dsh-agent/lib/types/index.d.ts:53`). */
export interface CreateAgentOptionsLike {
  readonly sessionId: string;
  readonly meta?: TopLevelSessionMetaLike;
  readonly agentOptions?: AgentOptionsLike;
  /**
   * Per-agent scoped-world composition. ORDER (corrected): `setup` runs
   * AFTER `session/created` and is awaited BEFORE `agent/created` and the
   * first prompt assembly (`dsh-agent/lib/types/index.d.ts:99-101`), so
   * everything registered here exists before the agent is announced and
   * before its first request. It does NOT run before `session/created`.
   * Setup COMPOSES; it must never drive the agent.
   */
  readonly setup?: (
    agentCtx: unknown,
    agent: AgentLike,
  ) => void | Promise<void>;
  /**
   * Abort before publication only — same rule as `ActivationSpecLike.signal`.
   */
  readonly signal?: AbortSignal;
}

/** Structural view of `AgentHandle` (`dsh-agent/lib/types/index.d.ts:143-146`). */
export interface AgentHandleLike {
  readonly agent: AgentLike;
  dispose(): Promise<void>;
}

export interface ActivationSpecLike {
  readonly provider: string;
  readonly label: string;
  /**
   * Caller-reserved durable child session id (local backends only —
   * `SubagentActivationSpec & { childId }`). Ticket 118 uses it for the
   * DISPATCHER spawn: minting the id up front is what lets `agent/created`
   * recognise that exact child without a per-parent counter, which is the
   * race the per-parent `pendingSpawns` counter cannot express. The host
   * refuses a reserved id that is already live or persisted
   * (`DUPLICATE_CHILD`), exactly as it would for its own minted id.
   */
  readonly childId?: unknown;
  readonly request: {
    readonly prompt: ContentBlock[];
    readonly parent: AgentLike;
    /**
     * Ticket 83: the CHILD'S ABSOLUTE delegation-depth ceiling for a SUBAGENT
     * spawn. The host's `resolveChildDepth` refuses the spawn when
     * `parentDepth + 1 > maxDepth` — it is NOT the worker's own budget. Derive
     * with `workerSpawnMaxDepth`; never send `WORKER_MAX_DEPTH` (0) here raw.
     *
     * ADR-0032: the DISPATCHER path (`spawnDispatcher`) sends no `maxDepth` at
     * all. A summoned dispatcher is a top-level session, so this ceiling and
     * the 8-slot root pool are subagent-runtime bounds and never reach it.
     */
    readonly maxDepth?: number;
    /**
     * Ticket 285 (plan §1.2): the route THIS child's requests should use,
     * when a spawn option chose one — a plain provider/model pair and nothing
     * else. The option deliberately carries no reasoning effort or maxTokens
     * (plan §1.5); a route CHANGE also clears the parent's effort in the
     * host's child-option merge
     * (`dsh-subagent/lib/types/child-agent.js:88-91`), so sending tuning here
     * would describe a model it was not chosen for. Omitted means today's
     * behaviour: the child inherits the parent's live route.
     *
     * The activation provider must advertise the `agentOptions`
     * capability (`dsh-subagent/lib/types/types.d.ts:153-160`); the live
     * in-process provider does (`dsh-subagent-spawn-in-process/lib/index.js:21-22`).
     */
    readonly agentOptions?: {
      readonly provider: string;
      readonly model: string;
    };
  };
  /**
   * Cancellation before publication only. Once the activation is live, stop
   * it through `activation.dispose()` — aborting this signal does nothing.
   */
  readonly signal: AbortSignal;
  /** `parent` supplies the completion notice to the model; we keep it. */
  readonly delivery: "parent" | "caller";
}

export interface JobSnapshotLike {
  readonly id: unknown;
  readonly kind: string;
  readonly label: string;
  readonly status: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly owner?: unknown;
  readonly detail?: string;
}

/**
 * Structural view of `ctx.tools` for listing an agent's tool names and
 * registering dispatcher tools.
 *
 * `schemas(scope)` with NO scope answers the context-global layer only (on
 * dsh 0.2.1 that is the two bookkeeping tools); pass the agent to read the
 * surface it actually inherits. `listGlobalToolNames` requires that scope.
 */
export interface ToolsLike {
  schemas(scope?: unknown): ReadonlyArray<{ readonly name: string }>;
  /** Register a tool; returns the exact disposer. Optional for stub contexts. */
  register?(definition: unknown): () => void;
}

/**
 * Structural host slash-command invocation (ticket 19). The handler runs
 * instead of sending the line to the model; the result is user-visible copy.
 */
export interface CommandInvocationLike {
  readonly commandId: string;
  /** The live agent (chat) the command was invoked in. */
  readonly agent: AgentLike;
  readonly rawInput?: string;
}

/** User-visible command outcome. */
export interface CommandResultLike {
  readonly kind: "success" | "error";
  readonly text?: string;
}

/** Structural command definition (mirrors dsh CommandRegistry.register). */
export interface CommandDefinitionLike {
  /** Globally unique, fail-loud on collision. */
  readonly name: string;
  readonly description: string;
  /**
   * Optional advertised input (Finding 2: `input?: { hint, attachments? }`).
   * The hint text is shown in the command menu; never enforced by the host.
   */
  readonly input?: {
    readonly hint: string;
    readonly attachments?: boolean;
  };
  readonly handler: (
    invocation: CommandInvocationLike,
  ) => CommandResultLike | Promise<CommandResultLike>;
}

/**
 * Structural view of `ctx.commands` for plugin-owned human slash commands.
 * `register` returns the exact disposer. Optional for stub contexts.
 */
export interface CommandsLike {
  register(definition: CommandDefinitionLike): () => void;
}

/**
 * Structural Cordis context surface the adapter needs.
 * Narrow local interface — prefer this over importing full Cordis types.
 */
export interface AdapterContext {
  /**
   * Global tool registry. Optional so stub contexts stay minimal; live
   * plugin injects `tools` so the deny-list can intersect real names.
   */
  tools?: ToolsLike;
  /**
   * Host slash-command registry. Optional so stub contexts stay minimal;
   * the live plugin injects `commands` so activation can register.
   */
  commands?: CommandsLike;
  subagents: {
    startActivation(spec: ActivationSpecLike): Promise<ActivationLike>;
    interrupt(targetSessionId: unknown, authority: unknown): void;
    sendMessage(
      sender: AgentLike,
      targetId: unknown,
      content: ContentBlock[],
      options: { signal: AbortSignal },
    ): Promise<unknown>;
  };
  agents: {
    get(id: unknown): AgentLike | undefined;
    /**
     * ADR-0032: create a genuinely NEW TOP-LEVEL session — the same call the
     * host's own "new conversation" makes
     * (`dsh-api-session-controller/lib/index.js:517-525`).
     *
     * The summoned dispatcher is created with `meta: { cwd }` — plus
     * `agentPreset` once it has joined one — and NO `parentAgent`, NO `origin`,
     * NO `parentSession`, NO `delegationDepth`.
     * All three header fields must be omitted TOGETHER: the host's ownership
     * guard is an OR (`origin === 'subagent'` OR `parentSession` set and its
     * live parent owns the agent — `dsh-api-session-controller/lib/index.js`
     * `:128-134`), so passing a parent "for convenience" silently
     * re-classifies the child and every ordinary route then refuses it with
     * `session/agent-busy`.
     *
     * Optional so stub contexts stay minimal: a host without this seam cannot
     * summon a parallel dispatcher at all and `spawnDispatcher` refuses by
     * name rather than falling back to the subagent shape.
     */
    create?(options: CreateAgentOptionsLike): Promise<AgentHandleLike>;
  };
  /**
   * ADR-0032: the host's cross-session delivery facade (`ctx.sessionController`,
   * `@deepseek-ai/dsh-api-session-controller`). `resolveAgent(sessionId)` is
   * get-or-cold-resume and deduped (`lib/index.js:221-246`), so it addresses a
   * session BY ID — no parent edge, which is exactly the shape a summoned
   * top-level dispatcher has. This is the route `dsh-schedule` uses to deliver
   * to a session it does not own (`:1576-1596`).
   *
   * Optional so stub contexts stay minimal, and because only the web-app
   * profile mounts it: when absent, the dormant-dispatcher resume falls back to
   * the pre-ADR-0032 parent→child `subagents.sendMessage` route (which cannot
   * wake a parentless peer — there is no sender to resolve).
   */
  sessionController?: {
    resolveAgent(
      sessionId: string,
    ): Promise<{ readonly agent: AgentLike } | { readonly error: unknown }>;
  };
  /**
   * Ticket 157 (ADR-0032): guarded read of the cros-session delivery facade
   * (`ctx.get`, `cordis/lib/index.js:763`), mirroring the plugin's other
   * host-plane reads (ticket 124 `tokenMeter`, ticket 147 `sessionProjections`).
   *
   * The facade is mounted by the web-app profile only
   * (`dsh-web-app/cordis.patch.yml:122`), so it is deliberately NOT in the
   * inject list: a headless/ACP deployment must still load this plugin, and
   * `resumeDormantDispatcher` already degrades honestly when it is absent.
   *
   * Optional so stub contexts stay minimal; an absent getter means "no facade",
   * which is exactly the pre-existing behaviour.
   */
  get?: (name: string) => unknown;
  jobs: {
    /** Omitted caller lists unowned jobs only; pass the reading session. */
    list(callerSessionId?: unknown): readonly JobSnapshotLike[];
  };
  storageDomain: StorageDomainLike;
  /** Host event bus. Payload arity varies per event (e.g. session/event is two-arg). */
  on(name: string, cb: (...args: never[]) => void): () => void;
}

export interface CordisDshHostOptions {
  /** Durable marker store (T08 DurabilityPort over storageDomain). */
  markers?: DurabilityPort;
  /** Worker agent definition; T10 supplies the real one. */
  workerAgentDef?: WorkerAgentDef;
  /**
   * Upper bound on awaiting a successful spawn's POST-CREATE bookkeeping (the
   * durable dispatcher mark, then the workspace attach) before the first turn
   * is queued. The mark write still runs first for crash safety; this only
   * bounds a stalled store so `followup` is never blocked forever. Default
   * {@link DEFAULT_BOOKKEEPING_TIMEOUT_MS}. Exposed so tests can drive a
   * never-resolving store without a long wait.
   */
  bookkeepingTimeoutMs?: number;
  /**
   * Ticket 153: the model-facing copy language, resolved once at apply from
   * the host locale preference. Omitted means EN — no cue or block changes
   * bytes for a pre-153 caller.
   */
  language?: PolicyLanguage;
  /**
   * Compose the user-visible wake follow-up text for a background settle.
   * Return null to fall back to the short cue. The plugin supplies this so
   * drainWake + assembleWakeTurn land the notices in model context.
   */
  composeWakeText?: (sessionId: string) => string | null;
  /**
   * Build the worker-local tool definitions for one child (ticket 122). The
   * plugin supplies this so the adapter stays core-agnostic; the returned
   * definitions are registered on the child's own scope at `agent/created`.
   */
  workerLocalTools?: (workerSessionId: unknown) => readonly unknown[];
  /**
   * Ticket 118 (ADR-0025 mitosis): activate a freshly spawned DISPATCHER
   * child — bind it as a parent, register its own scoped tool surface, inject
   * the dispatcher policy, register it in the lifecycle registry, and start
   * its durability rebuild.
   *
   * ADR-0032 changed what "activate" means here: the summoned dispatcher is a
   * TOP-LEVEL session created through `ctx.agents.create`, so it goes through
   * the ORDINARY activation gate rather than around it. This hook runs from
   * that create call's `setup`, i.e. the last moment its own scope can take
   * registrations before its first turn (the same seam the worker composition
   * uses). A host or stub with no `agents.create` path reaches it from the
   * `agent/created` listener instead; in that case the child's first turn may
   * already be open, so a tool surface registered here may miss it (recorded
   * limit, not hidden).
   *
   * The adapter passes the exact live child Agent and its session id, plus the
   * child's spawn generation (ticket 141: the spawner's generation + 1, 1 for
   * a user-started dispatcher). It never inspects the outcome — activation
   * failure must not turn a successful spawn into a host error.
   *
   * Ticket 159 — the fourth argument, the spawn's human label, is delivered
   * WITH the session id it belongs to. The hook used to carry no title at all,
   * so the plugin kept the label in a plugin-wide array and claimed it by
   * queue position: only exact while one summon is in flight. Two dispatchers
   * summoning at the same instant pushed two entries and popped them in
   * whatever order the host's creates reached `setup`, so each child could be
   * bound with the other's label. Passing the title on the same call as the
   * session id removes the queue from the problem — there is nothing
   * positional left to get wrong.
   *
   * It is present only on the spawn path, which is the only place a title
   * exists. A re-announcement or cold resume of the same session passes
   * `undefined`, and the plugin then keeps the label that session was bound
   * with — the roster read in `parent-agent.ts` already falls back to the
   * session id, and the title is not persisted (recorded limit on ticket 159,
   * deliberately not folded into this fix).
   */
  onDispatcherSpawned?: (
    agent: AgentLike,
    sessionId: string,
    generation: number,
    title?: string,
  ) => void;
  /**
   * Ticket 141: the spawn generation of a session this host knows, or null.
   * The plugin supplies this (the lifecycle answers it for live sessions), so
   * a spawn from a child computes parent generation + 1 instead of assuming
   * the spawner is a user-started generation 1.
   *
   * Optional: a stub or pre-141 caller that omits it means "generation 1",
   * which is exactly the old single-level shape.
   */
  dispatcherGenerationOf?: (sessionId: string) => number | null;
  /**
   * Ticket 147: activate a USER-STARTED (generation-1) dispatcher that the
   * host has resumed from durable state. The host calls this from its
   * `agent/created` listener for a session with NO parent when the durable
   * `sessionKind` projection says `"dispatcher"` — the same session the
   * sidebar has been drawing a dispatcher glyph for since the restart.
   *
   * It routes into the same activation path the `/dsh-bot` command uses
   * (`lifecycle.activate`, hence `bindActivation` → `onActivated` →
   * `activateToolSurface`), so role, the 8 scoped tools, `recall`, the policy
   * inject and the durability rebuild all come back together. The plugin's activation path is idempotent per session
   * (`parent-agent.ts` `sessions` membership), and the host additionally
   * deduplicates by session id before calling.
   *
   * Absent means "no reactivation path exists" — a stub host keeps the
   * pre-147 dormant behavior.
   *
   * Ticket 177: the third argument is the durable CLASS the resumed session
   * was activated with (`"user"` when {@link dispatcherClassOf} cannot
   * answer). It is what a summoned dispatcher needs to come back as a team
   * leader instead of falling back to the chief-of-staff instructions.
   */
  onUserDispatcherResumed?: (
    agent: AgentLike,
    sessionId: string,
    origin: DispatcherOrigin,
  ) => void;
  /**
   * Ticket 147: the session's durable dispatcher kind, as the host's
   * session-projection registry answers it — `"dispatcher"` or `null`.
   *
   * The plugin supplies this because the registry is resolved through a
   * guarded `ctx.get` on the plugin's own context (a bare `ctx.sessionProjections`
   * read throws on a live cordis context that never injected the service),
   * and because the projection key belongs to the plugin, not to the host.
   * The host only asks; it never interprets the answer.
   *
   * Absent means "no durable kind readable" — the resumed-dispatcher check
   * then does nothing, exactly as before ticket 147.
   */
  sessionKindOf?: (session: unknown) => "dispatcher" | null;
  /**
   * Ticket 177: the durable CLASS of a resumed dispatcher — `"user"` (the
   * chief of staff the human started) or `"spawned"` (the team leader another
   * dispatcher summoned) — or null when it cannot be read.
   *
   * It exists because ADR-0032 made a summoned dispatcher top-level: its cold
   * resume lands in the parentless branch, which before this option had no way
   * to ask which class the session was. That is ticket 173's recorded
   * limitation ("the class is not restored after a restart"), and passing the
   * answer into {@link onUserDispatcherResumed} is its fix.
   *
   * Optional and fail-closed: absent, or an answer of null, activates as
   * `"user"` — the pre-175 behavior.
   */
  dispatcherClassOf?: (session: unknown) => DispatcherOrigin | null;
  /**
   * Ticket 142 (owner ruling 2026-10-22 — children half): a worker this
   * plugin spawned was adopted back into the host's registry after the host
   * re-created its session (a cold resume on send). The plugin wires this to
   * the core's `reclaimWorker`, which turns the ticket-59 unknown-state hold
   * into a live roster record.
   *
   * Fired exactly once per adoption; errors thrown here are logged and
   * swallowed — the child is already live, so a core-side bookkeeping failure
   * must not turn the host's create path into an error.
   */
  onWorkerReattached?: (workerId: string, parentSessionId: string) => void;
}
/**
 * Live `DshHost` over Cordis dsh services.
 * Core stays pure; this is the only place that knows subagents/agents/jobs.
 */
export interface CordisDshHost extends DshHost {
  /** Bind the exact live dispatcher Agent (explicit activation, ticket 19).
   *  ADR-0019: per dispatcher session — a map of live parents, not one slot. */
  bindParent(agent: AgentLike, sessionId: string): void;
  /**
   * Clear parent binding(s) (dispose / replace). ADR-0019: WITH a session id
   * only that session's binding is cleared (a sibling dispatcher stays
   * bound); without one, every binding is cleared (plugin unload).
   */
  unbindParent(sessionId?: string): void;
  /** Whether any parent Agent is currently bound. */
  hasParent(): boolean;
  /**
   * The live parent Agent bound for one dispatcher session, if any
   * (ADR-0019: authority is per session — spawn, interrupt, send, and the
   * access prompts resolve their agent from the session they serve).
   */
  parentAgentOf(sessionId: string): AgentLike | undefined;
  /**
   * Ticket 118 (ADR-0025 mitosis): spawn ANOTHER DISPATCHER from a bound
   * dispatcher session, returning the host-assigned child session id.
   *
   * Deliberately NOT `spawnWorker`: the child is a peer, so this path
   * - does not mark a pending spawn (no worker composition at
   *   `agent/created` — the child inherits the parent's full composition),
   * - does not enter the `workers` registry (it is not a work stream and
   *   no dispatcher-sized cap of ours exists), and
   * - passes no `agentPreset` (none exists in `ActivationSpecLike`).
   *
   * ADR-0032: a summoned dispatcher is a TOP-LEVEL session, so there is no
   * `maxDepth` bound (parent depth + 2) and no 8-slot root pool to respect —
   * both are subagent-runtime bounds. We impose no cap of our own; observe
   * the host's real behaviour first rather than inventing one here.
   * Host errors surface unchanged — no refusal class is invented here.
   */
  spawnDispatcher(opts: DispatcherSpawnOptions): Promise<DispatcherSpawnResult>;
  /**
   * Ticket 285 (`.scratch/model-arg/PLAN.md` §§3.2–3.4): validate one spawn
   * model option against the LIVE model catalog, for the session that is
   * doing the spawning.
   *
   * The tool layer passes the raw argument, the caller's session id, and the
   * purpose; this wrapper supplies the live catalog, the spawning session's
   * provider (the bare-id tie-break), and the fallback sentence that purpose
   * names. A rejected non-empty value is never an error: the spawn proceeds on
   * the inherited route, this returns `fallback`, and exactly one
   * `[multitask-dispatcher]` warning reaches the process log. An empty value
   * returns `absent` and logs nothing.
   */
  resolveModelOption(
    raw: string,
    sessionId: string,
    purpose: ModelOptionPurpose,
  ): Promise<ModelOptionResolution>;
  /**
   * Ticket 176: record which CLASS a session this host activates belongs to.
   * `"user"` is the human's own `/dsh-bot` chat; `"spawned"` is a team leader
   * another dispatcher summoned, which may not summon further dispatchers.
   *
   * The host records `"spawned"` itself for every session it activates as a
   * summoned peer, and reads the durable class back on a cold resume, so a
   * caller never HAS to use this. It exists for the one path the host cannot
   * observe: the user running `/dsh-bot` in their own chat, which reaches the
   * lifecycle directly. Recording it there keeps the no-summon check exact
   * instead of inferring the class from an absent mark row.
   */
  recordDispatcherClass(sessionId: string, origin: DispatcherOrigin): void;
  /** Live job snapshots for the check surface. Process-local; not durable. */
  listLiveJobs(callerSessionId?: string): readonly JobSnapshotLike[];
  /** Durable markers (ADR-0006). */
  readonly markers: DurabilityPort | undefined;
  /**
   * Ticket 138 (owner ruling 2026-10-22 — dispatchers half): whether this
   * session carries our own durable `dispatcher_sessions` mark. Synchronous,
   * backed by an in-memory mirror warmed from the mark table; the peer fence
   * consults it so a marked dispatcher that the host has not re-announced yet
   * is accepted instead of refused (`unknown-target` still applies to a
   * target with NO mark — ticket 70 §2's fence is intact).
   *
   * Only sessions spawned by THIS plugin in THIS OR AN EARLIER process carry
   * a mark, so widening the fence cannot accept an arbitrary id.
   */
  isDurablyMarkedDispatcher(sessionId: string): boolean;
  /**
   * Ticket 140 (review fix): the tri-state answer the `sessionKind` projection
   * unit consumes from `init` and from every fold step of an unresolved cell.
   *
   * - `"dispatcher"` — the in-memory mirror knows the id (spawn-time seed, an
   *   in-process write, or a warm-up read), OR the durable table holds a row;
   * - `"not-dispatcher"` — nothing knows it AND no durable seam exists at all
   *   (stub stores), the only case where absence is definitive;
   * - `"unknown"` — the durable store has not been opened yet, so absence
   *   proves nothing. The unit records that as UNRESOLVED and re-asks on the
   *   next event instead of caching a wrong kind.
   *
   * Synchronous by construction: the projection contract forbids I/O.
   */
  dispatcherMarkAnswer(
    sessionId: string,
  ): "dispatcher" | "not-dispatcher" | "unknown";
  /**
   * Ticket 138: merge the store's current mark table into the mirror.
   * Called once per dispatcher activation (from the plugin's `onActivated`
   * chain, after the durability rebuild) — in-process writes enter the mirror
   * directly at write time, so this is the restart/boot half only. A failing
   * read leaves the mirror untouched: a marker problem must never turn an
   * activation or a send into a refusal.
   */
  refreshDispatcherMarks(): Promise<void>;
  /**
   * Ticket 142 (owner ruling 2026-10-22 — the children half): the durable
   * wake identity of a WORKER session, from the same synchronous mirror
   * pattern as {@link isDurablyMarkedDispatcher}. Undefined means "no row":
   * never spawned as a worker by us, already terminal, or abandoned.
   *
   * The core consults this when a steer arrives for an id it has no roster
   * record for — a marked id is dormant, not unknown, so the correction is
   * accepted and `wakeDormantWorker` cold-resumes it.
   */
  workerSessionMark(
    workerId: string,
  ): { readonly parentSessionId: string } | undefined;
  /**
   * Ticket 142: merge the store's current `worker_sessions` rows into the
   * mirror. Called once per dispatcher activation beside
   * {@link refreshDispatcherMarks}; in-process writes enter the mirror
   * synchronously. A failing read leaves the mirror untouched — a marker
   * problem must never turn a send into a refusal.
   */
  refreshWorkerSessionMarks(): Promise<void>;
  /** Map agent session id → workerId for owned workers. */
  workerIdOf(agentSessionId: string): string | undefined;
  /** Whether this host spawned the worker id. */
  owns(workerId: string): boolean;
  /**
   * Latest observed activity phrase for an owned worker, derived from the
   * host `session/event` firehose (`tool/call` events; ticket 29). Null
   * when nothing has been observed or the worker settled — never polled,
   * never guessed.
   */
  recentActivity(workerId: string): string | null;
  /**
   * Ticket 61: host-clock ms of the last firehose-observed activity for an
   * owned worker — the observation moment of `recentActivity`'s phrase.
   * Null when nothing has been observed or the worker settled. Same
   * subscription as `recentActivity` — no new seam, no polling.
   */
  lastActivityAtMs(workerId: string): number | null;
  /**
   * Ticket 155: the latest `tool/call` a DISPATCHER session was observed
   * making, from the same `session/event` firehose the worker activity feed
   * rides (`{ tool, target }`; the target is null when unreadable).
   *
   * Deliberately a SEPARATE map from the worker activity ring: the ring is
   * keyed by worker id and every existing reader (`recentActivity`,
   * `lastActivityAtMs`, `recentActivities`, `check_workers`) must never see a
   * dispatcher key. Null when nothing was observed for that session — never
   * polled, never guessed, and cleared when the session's turn ends, because
   * a finished turn has no current tool.
   */
  peerToolActivity(sessionId: string): PeerToolActivity | null;
  /**
   * Ticket 110: the bounded per-worker activity ring, newest-first — up to
   * `n` of the last firehose-observed phrases with their observation
   * moments, from the same subscription as `recentActivity` (no new seam,
   * no polling, nothing persisted). The breadcrumb is RETAINED through
   * settle so the wake digest (ticket 110 phase 2) can show what the
   * worker did before finishing — `recentActivity`/`lastActivityAtMs`
   * still go null at settle, so the ticket-29 check-row honesty rule is
   * unchanged. Empty when nothing has been observed; `n <= 0` yields an
   * empty array. Cleared on dispose.
   */
  recentActivities(workerId: string, n: number): readonly WorkerActivityEntry[];
  /**
   * Ticket 75: subscribe to firehose-observed tool calls on owned workers.
   * The `session/event` handler already matches every `tool/call` for an
   * owned session (the ticket-29 subscription); this notifies subscribers so
   * the core's `noteToolCall` count advances on the same observation. Fired
   * once per observed event, whether or not the payload was readable enough
   * for an activity phrase. No new seam, no polling.
   */
  onWorkerToolCall(cb: (workerId: string) => void): void;
  /**
   * Ticket 117: subscribe to STRUCTURED user-message observations on any
   * session (never text). Fired once per real user prompt the host records,
   * with the session it landed on.
   *
   * What this watches, verified against `dsh@0.2.1-rc.2`:
   * - `agent/inbox/spliced` (`dsh-agent-loop/lib/index.js:180-207`) — the
   *   commit `Agent.send`/`followup`/`steer` performs SYNCHRONOUSLY
   *   (`:800-814`), so a message user typed while a tool call is blocked
   *   reaches this listener immediately. Its `inserted` entries are the
   *   `UserMessage`s, carrying `source.kind`.
   * - `user/message` — the same message committed at a turn's pre-step
   *   (`dsh-agent-loop/lib/index.js:1069-1073`); only relevant when a wait
   *   spans a turn boundary.
   *
   * Admitted source kinds: `"user"` only — the host's real human prompt
   * (`dsh-api-session-controller/lib/types/index.js:3225`, also every slash
   * command that steers user input, `dsh-plan-mode`). Explicitly NOT our own
   * `plugin:multitask-dispatcher` wakes, NOT `agent-message` peer wakes, NOT
   * `runtime-context`/`system-prompt`/`model` bookkeeping. The text is never
   * inspected, so no wording can forge or suppress a release.
   */
  onDispatcherUserMessage(cb: (sessionId: string) => void): void;
  /**
   * Ticket 41: the bounded settle-report excerpt observed for an owned
   * worker when it settled (adapter-side projection of the same
   * `subagent/end` event the core receives), or `null` when nothing honest
   * was observed (never settled, empty report). The core stores no report
   * text — this seam is how the roster projection sources the deliverables
   * line's excerpt at publish time without new core state.
   */
  recentResult(workerId: string): RosterRecentResultSource | null;
  /** Fire step-boundary callbacks (called from parent-agent status wiring). */
  emitStepBoundary(workerId: string): void;
  /** Notify core that a worker's first turn started (spawned → running). */
  onWorkerTurnStarted?: (workerId: string) => void;
  dispose(): void;
}

/** Default in-process spawn provider name (dsh-subagent-spawn-in-process). */
export const SPAWN_PROVIDER = "spawn";

/** Max characters of the argument hint inside an activity phrase. */
export const ACTIVITY_HINT_CHARS = 60;

/**
 * Committed session event, structural view (`dsh-session` `session/event`
 * firehose; ticket 29 live-verification). Only the fields the activity
 * derivation reads are declared — everything else stays opaque.
 */
export interface SessionEventLike {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** Session handle carried as the first `session/event` argument. */
export interface SessionRefLike {
  readonly id?: unknown;
}

/**
 * Ticket 117: the message source kind of a real human prompt on
 * `dsh@0.2.1-rc.2`. Every host producer of human-authored input stamps
 * exactly this (`dsh-api-session-controller/lib/types/index.js:3225`,
 * `dsh-acp/lib/index.js:835`, `dsh-plan-mode/lib/index.js:221`,
 * `dsh-command-goal/lib/index.js:105`). Our own wakes use
 * `plugin:multitask-dispatcher` and peer wakes `agent-message`, so the
 * filter cannot mistake host background traffic for the user.
 */
export const USER_MESSAGE_SOURCE_KIND = "user";

/** Whether one structural message records a real user prompt by source. */
function isUserSourcedMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as {
    readonly role?: unknown;
    readonly source?: { readonly kind?: unknown } | null;
  };
  if (record.role !== "user") return false;
  if (typeof record.source !== "object" || record.source === null) return false;
  return record.source.kind === USER_MESSAGE_SOURCE_KIND;
}

/**
 * Ticket 117: the session id when ONE committed `session/event` reports a
 * real user-authored message, otherwise null. Structured only — no text is
 * read, no heading is matched, so copy can neither forge nor suppress a
 * release.
 *
 * Two event types count, both host-authored (`dsh@0.2.1-rc.2`):
 * - `agent/inbox/spliced` — the durable inbox mutation `Agent.send`/
 *   `followup`/`steer` commits synchronously inside the send call
 *   (`dsh-agent-loop/lib/index.js:180-207`, sinks at `:800-814`). This is
 *   the one that fires while a tool call is blocked, i.e. during an await.
 *   Only `inserted` entries count: they are the messages the caller supplied,
 *   while `removedCount`/`outcome` describe queue management.
 * - `user/message` — the same message committed at a turn's pre-step
 *   (`dsh-agent-loop/lib/index.js:1069-1073`). It arrives after a wait has
 *   already ended in the common case, so it is a secondary, harmless catch
 *   for a wait that spans a turn boundary.
 *
 * Explicit non-matches, by source: our `plugin:multitask-dispatcher` wakes,
 * `agent-message` peer sends, `runtime-context`/`system-prompt` context, and
 * `model`/`tool` traffic.
 */
export function dispatcherUserMessageSession(
  sessionRef: unknown,
  event: unknown,
): string | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as { readonly type?: unknown; readonly data?: unknown };
  const data = record.data;
  if (typeof data !== "object" || data === null) return null;

  let userAuthored = false;
  if (record.type === "agent/inbox/spliced") {
    const inserted = (data as { readonly inserted?: unknown }).inserted;
    userAuthored =
      Array.isArray(inserted) && inserted.some(isUserSourcedMessage);
  } else if (record.type === "user/message") {
    userAuthored = isUserSourcedMessage(data);
  }
  if (!userAuthored) return null;

  if (typeof sessionRef !== "object" || sessionRef === null) return null;
  const sessionId = (sessionRef as SessionRefLike).id;
  if (sessionId === undefined || sessionId === null) return null;
  return String(sessionId);
}

/**
 * One human-readable activity phrase from a `tool/call` event body
 * (`{ name, arguments }`): the tool name plus a short primary-argument
 * hint, whitespace-collapsed and clamped to `CHECK_ACTIVITY_CHARS`.
 * Null for anything unreadable — never invented.
 */
export function describeToolActivity(data: unknown): string | null {
  const call = describeToolCall(data);
  if (call === null || call.tool === null) return null;
  return clampActivity(
    call.target === null ? call.tool : `${call.tool}: ${call.target}`,
  );
}

/**
 * Ticket 155: the tool NAME and the primary-argument hint of one `tool/call`
 * body, kept apart instead of joined into a phrase. Null only when the
 * payload names no tool at all — the caller may still get a `null` target
 * when the arguments carry no readable string.
 *
 * This is the peer roster's source: `describeToolActivity` is the worker
 * phrase (one joined string, `tool: hint`); a peer row needs the pair so the
 * shared renderer can print `using <tool> on <target>`.
 */
export function describeToolCall(data: unknown): PeerToolActivity | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    return null;
  }
  const hint = primaryArgumentHint(record.arguments);
  return { tool: record.name, target: hint };
}

/**
 * First non-empty string field of the parsed raw-arguments JSON — a generic
 * primary-argument hint without knowing any host tool's vocabulary. Junk,
 * non-JSON, or no string field → null.
 */
function primaryArgumentHint(rawArguments: unknown): string | null {
  if (typeof rawArguments !== "string" || rawArguments.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, ACTIVITY_HINT_CHARS);
    }
  }
  return null;
}

/**
 * Map dsh SubagentStopReason → core TerminalWorkerStatus.
 * max-tokens / refusal / unknown → error.
 */
export function mapStopReason(stopReason: string): TerminalWorkerStatus {
  switch (stopReason) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    default:
      return "error";
  }
}

/**
 * Settle report from host ContentBlocks: join text, then apply worker
 * normalization (empty → placeholder; error passes message).
 * Abort delivers no invented report — empty text stays empty.
 */
export function normalizeSettleReport(
  status: TerminalWorkerStatus,
  lastAssistantMessage: readonly ContentBlock[] | undefined,
): string {
  const text = blocksToText(lastAssistantMessage);
  if (status === "aborted") {
    // Abort must not invent a report; keep any real text, else empty.
    return text.trim();
  }
  if (status === "error") {
    return normalizeWorkerErrorReport(text);
  }
  return normalizeWorkerTextReport(text);
}

/**
 * Back-compat ContentBlock wrapper: completed-style empty → placeholder.
 * Prefer {@link normalizeSettleReport} when status is known.
 */
export function normalizeWorkerReport(
  lastAssistantMessage: readonly ContentBlock[] | undefined,
): string {
  return normalizeSettleReport("completed", lastAssistantMessage);
}

/**
 * Live tool names visible to ONE agent scope (empty when tools are absent).
 *
 * The `scope` argument is REQUIRED and load-bearing: on dsh 0.2.1
 * `tools.schemas()` with no scope answers only the context-global layer, which
 * is the same two bookkeeping tools for every agent — not the surface the agent
 * actually inherits. A caller that wants a meaningful set must pass the agent
 * (the same rule `src/worker/preset.ts` documents).
 */
export function listGlobalToolNames(
  ctx: AdapterContext,
  scope: unknown,
): ReadonlySet<string> {
  const tools = ctx.tools;
  if (tools === undefined) return new Set();
  try {
    const schemas = tools.schemas(scope);
    return new Set(schemas.map((schema) => schema.name));
  } catch {
    return new Set();
  }
}

interface WorkerEntry {
  readonly parentSessionId: string;
  readonly agentSessionId: string;
}

/** Max phrases retained per worker in the activity ring (ticket 110). */
export const WORKER_ACTIVITY_RING_CAPACITY = 5;

/** One firehose-observed activity phrase with its observation moment. */
export interface WorkerActivityEntry {
  readonly phrase: string;
  readonly atMs: number;
}

/**
 * Ticket 155: the current tool a dispatcher peer was observed calling, split
 * into the two halves the peer roster renders (`using <tool> on <target>`).
 * The tool NAME is always present (a payload without one is unreadable and
 * yields no record at all); the target is the first non-empty string
 * argument — the same generic "primary argument" hint the worker phrase uses
 * — and is null when the arguments carry nothing readable, never an invented
 * value.
 */
export interface PeerToolActivity {
  readonly tool: string;
  readonly target: string | null;
}

/**
 * Ticket 110: bounded in-memory per-worker activity ring — the last
 * {@link WORKER_ACTIVITY_RING_CAPACITY} observed phrases,
 * insertion-ordered, oldest evicted. Plain adapter state: nothing
 * persisted, no new seam. The existing single-entry accessors
 * (`recentActivity`, `lastActivityAtMs`) read `latest` and are gated on
 * settle (ticket 29 honesty: a settled worker has no LIVE activity), while
 * the wake digest reads `recent` (newest-first) — retained through settle
 * so the digest can show the final breadcrumb.
 */
export class WorkerActivityRing {
  readonly #rings = new Map<string, WorkerActivityEntry[]>();

  /** Append an observed phrase, evicting the oldest past the capacity. */
  record(workerId: string, phrase: string, atMs: number): void {
    const ring = this.#rings.get(workerId);
    const entries = ring ?? [];
    entries.push({ phrase, atMs });
    if (entries.length > WORKER_ACTIVITY_RING_CAPACITY) {
      entries.splice(0, entries.length - WORKER_ACTIVITY_RING_CAPACITY);
    }
    this.#rings.set(workerId, entries);
  }

  /** The newest entry — the view the single-entry accessors read. */
  latest(workerId: string): WorkerActivityEntry | undefined {
    const ring = this.#rings.get(workerId);
    return ring?.[ring.length - 1];
  }

  /** Up to `n` entries, newest-first. `n <= 0` (or non-finite) → empty. */
  recent(workerId: string, n: number): readonly WorkerActivityEntry[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    const ring = this.#rings.get(workerId);
    if (ring === undefined) return [];
    return ring.slice(-n).reverse();
  }

  /** Drop one worker's ring (settle/abort cleanup). */
  clear(workerId: string): void {
    this.#rings.delete(workerId);
  }

  /** Drop every ring (dispose). */
  clearAll(): void {
    this.#rings.clear();
  }
}

/** The facade shape, named once so both the seam and the read below agree. */
type SessionControllerLike = {
  resolveAgent(
    sessionId: string,
  ): Promise<{ readonly agent: AgentLike } | { readonly error: unknown }>;
};

/**
 * Ticket 138: one wake turn parked for a session that was not live (or whose
 * followup failed). `text` is the composed body WHEN one was already built —
 * `composeWakeText` drains the wake bus, so a retry must reuse this exact text
 * rather than compose (and lose) the report a second time. Absent means the
 * activation hook still has to compose.
 */
interface PendingWakeTurn {
  readonly origin: AgentMessageWakeOrigin | undefined;
  readonly text?: string;
}

/**
 * The agent-preset registry shape (`ctx.get("agentPresets")`,
 * `@deepseek-ai/dsh-agent-preset-registry`), narrowed to the two reads a
 * plugin-created session needs.
 *
 * WHY THIS EXISTS (defect: a summoned session came up with no work tools): the
 * host mounts every model-facing work tool inside an AGENT PRESET — the
 * `standard` preset composes `tool-fs`, `tool-fs-search`, `tool-pwsh`/`tool-bash`,
 * `tool-web`, `tool-jobs`, `tool-todo`, `tool-subagent`, … on the agent's own
 * isolated scope (`dsh-web-app/presets/standard.patch.yml:21-118`). Only
 * host-plane rows such as `tool-working-directory`
 * (`dsh-base/cordis.patch.yml:169-170`) sit outside a preset. A session created
 * by `ctx.agents.create` therefore gets a scope with NO preset joined, and
 * inherits nothing but the host-plane layer — which is exactly the reported
 * surface: the plugin's seven dispatched tools plus `working_directory`.
 *
 * The host's own create route always mounts one: `composeAgent` resolves the
 * requested or default preset and calls `presets.mount(agentCtx, id)` inside
 * `setup`, which runs after `session/created` and before `agent/created` and
 * the first prompt (`dsh-api-session-controller/lib/index.js:264-277`). A plugin that calls
 * `ctx.agents.create` directly has to do the same, so this shape names the two
 * calls: read the parent's joined preset, then join the child to it.
 */
type AgentPresetsLike = {
  /**
   * The preset id a live Agent is joined to, or null/undefined in a
   * preset-free composition. Defect fix: the LIVE registry answers `null`
   * while this type used to promise only `undefined`; the caller normalizes
   * with `?? undefined` before it reaches `meta.agentPreset` or `mount`,
   * either of which rejects a non-string ("session header agentPreset must
   * be a string").
   */
  presetForSession(session: unknown): string | null | undefined;
  /** Join a child Agent's scope to one preset; resolves after it is mounted. */
  mount(
    ctx: unknown,
    id?: string,
  ): Promise<{ readonly id?: string } | undefined>;
};

/**
 * Read the agent-preset registry from a live context, guarded — same two-step
 * rule as {@link readSessionController}, and for the same reason: a bare
 * `ctx.agentPresets` property read THROWS on a live cordis context that never
 * injected the service.
 *
 * Returns `undefined` when the deployment composes no preset roster (the
 * documented preset-free case, `src/core/tools.ts:717`). That is NOT an error:
 * a preset-free session is a valid session, it simply has no preset tools to
 * inherit — and a stub host in a unit test has no registry either.
 */
function readAgentPresets(
  ctx: AdapterContext,
): AgentPresetsLike | undefined {
  if (typeof ctx.get !== "function") return undefined;
  try {
    const service = ctx.get("agentPresets");
    if (typeof service !== "object" || service === null) return undefined;
    const candidate = service as Partial<AgentPresetsLike>;
    if (
      typeof candidate.presetForSession !== "function" ||
      typeof candidate.mount !== "function"
    ) {
      return undefined;
    }
    return service as AgentPresetsLike;
  } catch {
    // Absent, or not yet active: the caller simply mounts nothing.
    return undefined;
  }
}

/**
 * Read the live model catalog (`ctx.llm`) from a live context, guarded — the
 * same two-step rule as {@link readAgentPresets}, and for the same reason: a
 * bare `ctx.llm` property read THROWS on a live cordis context that never
 * injected the service (the trap documented on `readAgentPresets` above).
 *
 * Returns `undefined` when the deployment mounts no catalog (a stub host, a
 * headless composition, or a service that is not active yet). That is NOT an
 * error: the resolver answers `catalog-unavailable` and the spawn proceeds on
 * the inherited route, exactly as it does today.
 */
function readLlmCatalog(ctx: AdapterContext): ModelCatalogLike | undefined {
  if (typeof ctx.get !== "function") return undefined;
  try {
    const service = ctx.get("llm");
    if (typeof service !== "object" || service === null) return undefined;
    const candidate = service as Partial<ModelCatalogLike>;
    if (
      typeof candidate.listProviders !== "function" ||
      typeof candidate.listModels !== "function"
    ) {
      return undefined;
    }
    return service as ModelCatalogLike;
  } catch {
    // Absent, or not yet active: the caller falls back and says so once.
    return undefined;
  }
}

/**
 * One Workspace, narrowed to the only two members a plugin-created session
 * needs to FILE ITSELF under its summoner's project:
 * the ordered `sessionIds` account it reads and the `attachSession` write.
 *
 * The account is the membership: `sessionIds` is the ordered ownership list on
 * the durable workspace record (`dsh-workspace/lib/index.js:102-104`, field
 * `sessionIds` in `workspaceRecord` at `:212`), and `attachSession` prepends
 * one id to it (`:111-129`, the write at `:125-128`). It is not a cwd: the
 * getter filters every id through `candidateMatches`, i.e. a session belongs
 * to a workspace only while its stored cwd still canonicalizes to that
 * workspace's path (`:367`, `:875-895`).
 */
type WorkspaceEntityLike = {
  /** Sessions this Workspace accounts, display order, already cwd-filtered. */
  readonly sessionIds: readonly string[];
  /** Add one session to the account; idempotent, validates its stored cwd. */
  attachSession(sessionId: string): Promise<void>;
};

/**
 * The Workspace REGISTRY shape (`ctx.get("workspaceRegistry")`,
 * `@deepseek-ai/dsh-workspace`), narrowed to durable display order.
 *
 * WHY THIS EXISTS (defect: a summoned session appeared in the sidebar's
 * "Ungrouped" section instead of its summoner's project): the sidebar groups
 * by Workspace MEMBERSHIP, never by folder —
 * `groupByWorkspace` walks each workspace's `sessionIds` and pushes every
 * session no workspace met into one empty-key group
 * (`dsh-client-ui-workspace/lib/client.js:1027-1044`). A session created
 * through `ctx.agents.create` carries `meta.cwd` and no membership, so it has
 * no group to land in. The registry only re-buckets such sessions by canonical
 * cwd at STARTUP (`dsh-workspace/lib/index.js:758-813`), which is why the
 * defect healed itself one restart later.
 */
type WorkspaceRegistryLike = {
  /** Workspaces in durable registry order (`dsh-workspace/lib/index.js:454-460`). */
  list(): readonly WorkspaceEntityLike[];
};

/**
 * Resolve the Workspace that ACCOUNTS `sessionId`, guarded — the same
 * two-step rule as {@link readAgentPresets}, and for the same reason: a bare
 * `ctx.workspaceRegistry` property read THROWS on a live cordis context that
 * never injected the service.
 *
 * The lookup is membership, exactly as the sidebar computes it
 * (`dsh-client-ui-workspace/lib/client.js:20505`), NOT a path guess: a session
 * no Workspace accounts has no workspace id to inherit, and inventing one from
 * its cwd would file the child under a project its summoner is not in.
 *
 * Returns `undefined` when the deployment mounts no registry (a stub host, or
 * a headless composition) and when the session belongs to no Workspace. Both
 * are valid: the caller simply attaches nothing.
 */
function readWorkspaceOfSession(
  ctx: AdapterContext,
  sessionId: string,
): WorkspaceEntityLike | undefined {
  if (typeof ctx.get !== "function") return undefined;
  try {
    const service = ctx.get("workspaceRegistry");
    if (typeof service !== "object" || service === null) return undefined;
    const registry = service as Partial<WorkspaceRegistryLike>;
    if (typeof registry.list !== "function") return undefined;
    for (const workspace of registry.list()) {
      if (workspace.sessionIds.includes(sessionId)) return workspace;
    }
    return undefined;
  } catch {
    // Absent, not yet started, or a broken registry read: file nothing.
    return undefined;
  }
}

/**
 * Ticket 157 (ADR-0032): read the cross-session delivery facade from a live
 * context, guarded.
 *
 * Tried in order:
 * 1. `ctx.get("sessionController")` — the host-plane read (cordis
 *    `lib/index.js:763`), the same route this repo already uses for
 *    `tokenMeter` (ticket 124) and `sessionProjections` (ticket 147). This is
 *    the one that works on a LIVE context, where an un-injected property read
 *    throws.
 * 2. the declared seam — a stub or a host that supplies it directly.
 *
 * Returns `undefined` when neither exists, which is the pre-existing behaviour:
 * the caller falls back to the parent→child route and says so once.
 *
 * Ticket 163 defect 4: BOTH reads are guarded, including the declared seam.
 * `ctx.sessionController` is a bare cordis service property read, and this
 * repo records that such a read THROWS on a live context that never injected
 * the service (the same reason `session-kind-projection.ts` wraps its read).
 * An unguarded final read made the whole "degrade to the parent route"
 * promise false: a deployment without the service threw out of `sendMessage`
 * instead of falling back. Every caller already resolves the facade through
 * this one accessor, so guarding here covers all of them.
 */
function readSessionController(
  ctx: AdapterContext,
): SessionControllerLike | undefined {
  if (typeof ctx.get === "function") {
    try {
      const service = ctx.get("sessionController");
      if (
        typeof service === "object" &&
        service !== null &&
        typeof (service as SessionControllerLike).resolveAgent === "function"
      ) {
        return service as SessionControllerLike;
      }
    } catch {
      // Absent (or not yet active): fall through to the declared seam.
    }
  }
  try {
    return ctx.sessionController;
  } catch {
    // A live cordis context throws at property ACCESS for a service it never
    // injected. That is the same "no facade" answer as an absent one, so the
    // caller degrades to the parent route instead of propagating a throw.
    return undefined;
  }
}

/**
 * The host's session-title service, narrowed to the two members a summoned
 * dispatcher needs.
 *
 * `rename` is the native EXPLICIT title write: it appends one `session/title`
 * event with source `user`, the same public path the host uses for sessions it
 * creates itself (`dsh-schedule/lib/index.js:1519-1529`) and the sidebar rename
 * action calls through the session controller
 * (`dsh-api-session-controller/lib/index.js:729-748`). Two consequences matter
 * here: the title is DURABLE (the plugin's roster label is not), and a `user`
 * title pins itself, so the host's model auto-naming never rewrites it.
 *
 * `get` is optional because it is best-effort: when a host version exposes it,
 * the helper below skips a session another native path already named.
 */
interface SessionTitleLike {
  /** Current stored title, when the host version exposes it. */
  get?(session: unknown): unknown;
  /** Native explicit title write. Synchronous in dsh 0.2.2. */
  rename(session: unknown, title: string): unknown;
}

/**
 * Read the host's session-title service from a live context, guarded — the
 * same two-step rule as {@link readAgentPresets}: a bare `ctx.sessionTitle`
 * property read THROWS on a live cordis context that never injected the
 * service, so the host's documented `ctx.get` accessor
 * (`cordis/lib/index.js:763`) is the only safe read.
 *
 * Returns `undefined` when the deployment mounts no title service, when the
 * service exposes no `rename`, or when the read itself throws. Titles are an
 * optional host surface: a headless or minimal profile must still summon, so
 * an absent service is a valid composition, not an error.
 */
function readSessionTitle(ctx: AdapterContext): SessionTitleLike | undefined {
  if (typeof ctx.get !== "function") return undefined;
  try {
    const service = ctx.get("sessionTitle");
    if (typeof service !== "object" || service === null) return undefined;
    const candidate = service as Partial<SessionTitleLike>;
    return typeof candidate.rename === "function"
      ? (service as SessionTitleLike)
      : undefined;
  } catch {
    // Absent, not yet active, or a broken read: the caller simply names
    // nothing and the session stays "Untitled".
    return undefined;
  }
}

/**
 * Write a summoned dispatcher's spawn title into the host's title store.
 *
 * This is the native EXPLICIT rename, not model auto-naming: the dispatcher
 * already chose the words, so no model call is made and none is needed. The
 * host owns the title policy — normalization, control-character stripping and
 * UTF-8 truncation (`dsh-session-title/lib/index.js:24-54`) — and throws when
 * a title normalizes to empty. Both outcomes are caught here.
 *
 * Never throws. Naming is bookkeeping around a session that already exists and
 * whose first turn is about to be queued: a missing service, a failed read or
 * a refused rename must leave the spawn intact (the session simply stays
 * "Untitled"). A title another native path already stored wins — this helper
 * only fills a gap.
 */
function nameSummonedDispatcher(
  titles: SessionTitleLike | undefined,
  session: unknown,
  title: string,
): void {
  const normalizedInput = title.trim();
  if (titles === undefined || normalizedInput.length === 0) return;
  if (titles.get !== undefined) {
    try {
      // Do not overwrite a title another native path already produced.
      if (titles.get(session) !== undefined) return;
    } catch {
      // A read failure must not suppress the write; fall through to rename.
    }
  }
  try {
    titles.rename(session, normalizedInput);
  } catch (error) {
    // Naming is bookkeeping: a failure must never turn a successful spawn
    // into a host refusal or suppress the first turn.
    try {
      console.warn(
        "[multitask-dispatcher] summoned dispatcher could not be named:",
        error,
      );
    } catch {
      // A broken console must not break the spawn either.
    }
  }
}

/**
 * Ticket 177: read a resumed session's durable dispatcher class, never
 * letting a plugin-supplied reader break the host's resume path.
 *
 * Null means "cannot answer", which the caller reads as `"user"` — the
 * pre-175 behavior — so a projection that throws or returns junk can only
 * preserve the old fallback, never invent a class.
 */
function readDispatcherClass(
  reader: ((session: unknown) => DispatcherOrigin | null) | undefined,
  session: unknown,
): DispatcherOrigin | null {
  if (reader === undefined) return null;
  let answer: unknown;
  try {
    answer = reader(session);
  } catch {
    return null;
  }
  return answer === "user" || answer === "spawned" ? answer : null;
}

/**
 * Ticket 177: read a resumed session's durable dispatcher KIND through the
 * same guard as {@link readDispatcherClass}. The plugin supplies the reader,
 * and a throwing projection must read as "not answered", never as a session
 * the resume path refuses to touch with a throw of its own.
 */
function readSessionKind(
  reader: ((session: unknown) => "dispatcher" | null) | undefined,
  session: unknown,
): "dispatcher" | null {
  if (reader === undefined) return null;
  try {
    return reader(session) === "dispatcher" ? "dispatcher" : null;
  } catch {
    return null;
  }
}

/**
 * Second-round audit: one route-shaped value reduced to the four fields a
 * summoned dispatcher's `agentOptions` may carry. Anything unreadable is
 * omitted; a partial answer is merged with lower-priority sources by the
 * caller, never invented here.
 */
function readRouteFields(value: unknown): Partial<AgentOptionsLike> {
  if (typeof value !== "object" || value === null) return {};
  const outer = value as Record<string, unknown>;
  // `requestHeader()` nests the route under `config`; a model selection may
  // answer it directly (or under `config`/`options` on some host builds).
  const candidates = [
    value,
    outer["config"],
    outer["options"],
    outer["route"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const provider = record["provider"];
    const model = record["model"];
    if (
      typeof provider === "string" &&
      provider !== "" &&
      typeof model === "string" &&
      model !== ""
    ) {
      const reasoningEffort = record["reasoningEffort"];
      const maxTokens = record["maxTokens"];
      return {
        provider,
        model,
        ...(typeof reasoningEffort === "string" ||
        typeof reasoningEffort === "number"
          ? { reasoningEffort }
          : {}),
        ...(typeof maxTokens === "number" &&
        Number.isFinite(maxTokens) &&
        maxTokens > 0
          ? { maxTokens }
          : {}),
      };
    }
  }
  return {};
}

/**
 * The summoner's LIVE route, most specific source first:
 * 1. `agent.model.current()` — the selection the next request will use (a UI
 *    model switch is reflected here), which is what the peer must inherit;
 * 2. `session.requestHeader()?.config` — the resolved header of the current
 *    request, when the structural Agent view exposes it.
 *
 * `parent.options` is NOT read here: it is the fallback in `spawnDispatcher`,
 * because it may be the deployment default rather than the live selection.
 */
function liveSummonerRoute(agent: AgentLike): Partial<AgentOptionsLike> {
  const fromHeader: Partial<AgentOptionsLike> = (() => {
    const requestHeader = agent.session.requestHeader;
    if (typeof requestHeader !== "function") return {};
    try {
      return readRouteFields(requestHeader.call(agent.session));
    } catch {
      return {};
    }
  })();
  const modelApi = agent.model;
  if (modelApi !== undefined && typeof modelApi.current === "function") {
    try {
      const fields = readRouteFields(modelApi.current());
      if (fields.provider !== undefined && fields.model !== undefined) {
        // The live selection wins per field; a field it does not carry (say
        // `maxTokens`) is still forwarded from the request header.
        return { ...fromHeader, ...fields };
      }
    } catch {
      // A model facade that cannot answer falls through to the header.
    }
  }
  return fromHeader;
}

/**
 * Ticket 285 (plan §§3.3, 8, Task 8): narrow a route object supplied by a
 * caller to the only shape the spawn model option promises — a provider and a
 * model, both non-empty after trimming. This is the LAST guard, not catalog
 * validation: the tool path resolves and validates the raw string, while this
 * catches a JS caller handing the host an empty or malformed route.
 *
 * `undefined` means "not provided" and stays silent. A PRESENT but unusable
 * route is treated as absent with one warning (a spawn must never be refused,
 * or handed a route the host would only fail on at its first request); the
 * caller then keeps its inherited route. Shared by the leader path here and
 * the worker path (Task 9), so both reject the same shapes the same way.
 */
function usableRoute(value: ModelRoute | undefined): ModelRoute | undefined {
  if (value === undefined) return undefined;
  // A JS caller can pass anything despite the static type — null and
  // non-objects included — so read defensively rather than throw here.
  const record: Record<string, unknown> =
    typeof value === "object" && value !== null
      ? (value as unknown as Record<string, unknown>)
      : {};
  const provider =
    typeof record["provider"] === "string" ? record["provider"].trim() : "";
  const model =
    typeof record["model"] === "string" ? record["model"].trim() : "";
  if (provider !== "" && model !== "") return { provider, model };
  try {
    console.warn(
      "[multitask-dispatcher] a spawn model route with an empty provider or model was ignored; using the inherited route.",
    );
  } catch {
    // A broken console must not break the spawn either.
  }
  return undefined;
}

/**
 * Defect fix (a terminal worker was woken back): the durable `worker_sessions`
 * rows are deleted when a worker settles or is stopped, but that delete is
 * asynchronous and best-effort, so an orphan row can survive a crash or a
 * failing store. The durable WORKER MARKER is the cross-check: a marker whose
 * snapshot is terminal proves the worker finished, and "stop is for good".
 *
 * Grouped by parent because `readWorkerMarkers` is keyed by parent session.
 * A read that throws proves nothing and contributes no tombstones — the
 * caller then keeps the row, which is the pre-fix behaviour.
 */
async function terminalWorkerIdsByParent(
  store: DurabilityPort,
  parentSessionIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const terminal = new Map<string, Set<string>>();
  for (const parentSessionId of new Set(parentSessionIds)) {
    try {
      const markers = await store.readWorkerMarkers(parentSessionId);
      const ids = new Set(
        markers
          .filter((marker) => isTerminalStatus(marker.status))
          .map((marker) => marker.workerId),
      );
      if (ids.size > 0) terminal.set(parentSessionId, ids);
    } catch {
      // Unreadable table: no tombstone, so the caller keeps its row.
    }
  }
  return terminal;
}

/**
 * Default bound on post-create bookkeeping that runs BEFORE a summoned
 * dispatcher's first turn. The mark write must stay ahead of the turn (a crash
 * between the create and the write would lose the session's dispatcher
 * identity), but a stalled store must not suppress the first turn forever.
 */
export const DEFAULT_BOOKKEEPING_TIMEOUT_MS = 2_000;

export function createCordisDshHost(
  ctx: AdapterContext,
  options?: CordisDshHostOptions,
): CordisDshHost {
  const workerAgentDef = options?.workerAgentDef;
  const bookkeepingTimeoutMs =
    options?.bookkeepingTimeoutMs ?? DEFAULT_BOOKKEEPING_TIMEOUT_MS;
  /** Ticket 153: the cue faces this host renders (EN unless exactly "zh"). */
  const hostLanguage: PolicyLanguage = options?.language ?? "en";
  const resumeWakeCue = resumeWakeCueFor(hostLanguage);
  const settleWakeCue = wakeCueFor(hostLanguage);
  const markers = options?.markers;
  const composeWakeText = options?.composeWakeText;
  const workerLocalTools = options?.workerLocalTools;
  const onDispatcherSpawned = options?.onDispatcherSpawned;
  const dispatcherGenerationOf = options?.dispatcherGenerationOf;
  const onWorkerReattachedRaw = options?.onWorkerReattached;
  const onUserDispatcherResumed = options?.onUserDispatcherResumed;
  const sessionKindOfSession = options?.sessionKindOf;
  const dispatcherClassOfSession = options?.dispatcherClassOf;

  /**
   * Ticket 142: fire the re-attachment hook, never letting it break the
   * host's create path — the child is already live, so a core bookkeeping
   * failure must not read as a spawn error.
   */
  function onWorkerReattached(workerId: string, parentSessionId: string): void {
    if (onWorkerReattachedRaw === undefined) return;
    try {
      onWorkerReattachedRaw(workerId, parentSessionId);
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] worker ${workerId} could not be re-adopted by the core:`,
          error,
        );
      } catch {
        // A broken console must not break the create path either.
      }
    }
  }

  /**
   * The child's mid-task reply tool (ticket 122). Null when the plugin did not
   * supply a builder, so composition simply registers nothing extra.
   */
  function buildWorkerLocalTools(workerSessionId: unknown): readonly unknown[] {
    if (workerLocalTools === undefined) return [];
    return workerLocalTools(workerSessionId);
  }

  /**
   * ADR-0019: live dispatcher parents, keyed by dispatcher session id —
   * a map of sessions, not one slot. Spawn, interrupt, and sendMessage
   * resolve the authority agent from the session they serve (spawn from the
   * request's `parentSessionId`; interrupt/send from the worker's recorded
   * parent).
   */
  const parents = new Map<string, AgentLike>();
  const workers = new Map<string, WorkerEntry>();
  /**
   * Every worker id this host ever reserved in THIS process. Unlike `workers`
   * (pruned on dispose) and `workerSessions` (absent on a host with no durable
   * store), this is the in-process settle proof: a `subagent/end` for one of
   * these ids is accepted even after the live entry was pruned, so a
   * disposal-before-settle cannot drop the terminal event. Cleared only on
   * host dispose.
   */
  const spawnedWorkerIds = new Set<string>();
  const spawnControllers = new Map<string, AbortController>();
  /**
   * Ticket 196: set by the one host disposal. A worker spawn awaits
   * `startActivation` between its reservation and its live map registration;
   * this flag makes the continuation after that await treat the host as gone
   * (release the receipt, register nothing), and makes that check idempotent
   * with the teardown itself.
   */
  let disposed = false;
  /** Ticket 196: drop every registration belonging to one spawn id. */
  function forgetSpawn(id: string): void {
    workers.delete(id);
    spawnedWorkerIds.delete(id);
    spawnControllers.delete(id);
  }
  /**
   * Live activations keyed by worker id. `startActivation`'s signal owns
   * pre-publication cancellation only; a published worker is stopped by
   * disposing this exact activation.
   */
  const workerActivations = new Map<string, ActivationLike>();
  /**
   * Spawns in flight per dispatcher session. `agent/created` is the only seam
   * that hands us a child's own scoped context BEFORE its first turn, and it
   * fires inside `startActivation`; this counter is what identifies the child
   * that call created (a dispatcher can also delegate through the host's own
   * `subagent` tool, whose child must not receive the worker composition).
   */
  const pendingSpawns = new Map<string, number>();
  /**
   * Ticket 118 chunk 3: child ids this host RESERVED for a dispatcher spawn,
   * recorded before `startActivation` is called. A reserved id is the exact
   * answer to the `agent/created` identification problem that `pendingSpawns`
   * cannot give: `spawnDispatcher` mints the id and passes it as
   * `spec.childId`, so the listener matches this child by IDENTITY, never by
   * a counter shared with concurrent worker spawns from the same parent.
   *
   * The window is therefore closed in both directions:
   * - a dispatcher child announced while a worker spawn is in flight is
   *   activated as a dispatcher and never receives the worker composition;
   * - a worker child announced while a dispatcher spawn is in flight cannot
   *   match a reserved id, so it still takes the normal `pendingSpawns` path.
   *
   * Entries are removed in `spawnDispatcher`'s `finally`, so a stale id can
   * never mislabel a later child. Classification of an announcement that
   * arrives AFTER the spawn resolved does NOT come from this set: the durable
   * `dispatcherMarks` mirror (seeded before the create, written after)
   * already answers it. ADR-0032: a summoned dispatcher is a top-level
   * session, so neither is bounded by a subagent live-child pool — they grow
   * with the sessions that were really created, which is not a cap of ours.
   */
  const reservedDispatcherIds = new Set<string>();
  /**
   * PER-ACTIVATION dedupe for `activateSummonedDispatcher`: the id of a
   * dispatcher this host has already activated IN THIS ACTIVATION. It is NOT
   * a classification source (the durable marks and the spawn reservation
   * answer that) and it is DELETED on `agent/disposed`, so a session that is
   * disposed and re-announced activates again — with its parent binding,
   * scoped tool surface and policy — exactly once.
   */
  const dispatcherActivations = new Set<string>();
  /**
   * Ticket 138: in-memory mirror of the durable `dispatcher_sessions` table,
   * keyed by session id → the spawner recorded on the row (undefined for a
   * pre-138 row). The peer fence is synchronous and cannot await a store
   * read, so the mark table is warmed once per dispatcher activation
   * (`refreshDispatcherMarks`, called from the plugin's `onActivated`) and
   * every in-process write is added immediately. Entries are never removed
   * (the table never deletes either — see ticket 130).
   */
  const dispatcherMarks = new Map<string, string | undefined>();
  /**
   * Ticket 176 (owner ruling 2026-11-03): which CLASS each session this host
   * activated belongs to — `"user"` (the human's own `/dsh-bot` chat) or
   * `"spawned"` (a team leader another dispatcher summoned).
   *
   * A separate map, like the generation one above, and for a distinct reason:
   * `dispatcherMarks` answers "is this a dispatcher at all", whereas the class
   * answers "may it summon". A spawned dispatcher may NOT summon further
   * dispatchers, so `spawnDispatcher` must be able to answer this for its
   * CALLER before doing anything else.
   *
   * Written by the two activation entry points that know the answer —
   * `activateSummonedDispatcher` (always `"spawned"`) and
   * `resumeUserStartedDispatcher` (the class the durable projection reported,
   * `"user"` by default). Never removed, for the same reason `dispatcherMarks`
   * is never removed: the classification of a session id cannot change, and a
   * re-announcement must resolve the same answer.
   */
  const dispatcherClasses = new Map<string, DispatcherOrigin>();
  /**
   * Ticket 141: spawn generation per spawned dispatcher session (1 =
   * user-started, +1 per spawn). A SEPARATE map on purpose: `dispatcherMarks`
   * is read as a bare parent id in several places, and the generation is not
   * a property of the parent — it is the child's depth in the dispatcher tree.
   *
   * Filled from three places, in this order of authority:
   * - the reserved-id seed in `spawnDispatcher` (BEFORE `startActivation`
   *   resolves, because `agent/created` fires inside that call and the mark
   *   row does not exist yet);
   * - the mark row, on a cold resume (`resumeMarkedDispatcher`) and on the
   *   boot read (`refreshDispatcherMarks`);
   * - never removed until `dispose` — a re-announcement of the same child
   *   must resolve the same number.
   */
  const dispatcherGenerations = new Map<string, number>();
  /**
   * Ticket 285 (plan §§1.6, 4.2): the model a team leader's workers run on by
   * default, keyed by the LEADER's session id — the default the leader
   * received as `worker_model` when it was summoned. A worker spawn resolves
   * an explicit per-worker route first, then this, then today's inheritance;
   * a worker-level option never writes it.
   *
   * Populated by `spawnDispatcher` through `writeDispatcherMark` and restored
   * by `refreshDispatcherMarks` from the same durable mark, so a cold-resumed
   * leader keeps its worker default (Task 10). Values are routes the tool
   * resolver validated; `spawnWorker` still narrows them with `usableRoute`
   * because a JS caller can hand us any shape.
   */
  const workerModelDefaults = new Map<string, ModelRoute>();
  /**
   * Ticket 138: sessions whose cold resume this process already asked the
   * host for. A second send before the resumed child is announced must not
   * ask again — both messages are queued in our own peer inbox and wake lane,
   * so one request is enough. Cleared when the resume call fails.
   */
  const resumeRequested = new Set<string>();
  /**
   * Ticket 147: user-started dispatchers this process already re-activated
   * from the durable `sessionKind` projection. A host that announces the same
   * resumed session twice must not run the activation path twice — the
   * plugin's path is idempotent, but the projection read is the only authority
   * here and one answered yes is enough.
   *
   * Ticket 163 defect 3: the entry is dropped when the session is DISPOSED,
   * not kept for the process lifetime. The guard exists to deduplicate
   * concurrent/repeat ANNOUNCEMENTS of one live session; it must not outlive
   * the activation it stands for. Keeping it was a real defect in two ways:
   * a re-announcement after disposal skipped re-activation entirely, leaving
   * the session without its scoped tools or policy; and the set grew for the
   * whole process. `agent/disposed` is the event that ends an activation, so
   * it is the event that ends this record.
   */
  const resumedUserDispatchers = new Set<string>();
  /**
   * Ticket 138: wake turns the host was asked to open for a session that was
   * NOT live. They are parked here and re-opened by the activation hook — the
   * "deliver on activation" half of wake-on-send, carried by the SAME
   * `openWakeTurn` → `composeWakeText` → wake-bus path a live wake uses. Only
   * durably marked targets are parked; an unmarked id keeps today's silent
   * no-op (the core fence refuses those sends before a wake is ever asked
   * for).
   *
   * The composed TEXT is parked with the origin when one was already built.
   * `composeWakeText` drains the wake bus, so a followup that fails after
   * composition must not fall back to composing a second time: the drained
   * worker report / inbox text would be gone and the retry would deliver the
   * generic cue instead. Retrying the exact text is also what keeps the wake
   * from being delivered twice.
   */
  const pendingWakeTurns = new Map<string, PendingWakeTurn>();
  /**
   * Ticket 142: in-memory mirror of the durable `worker_sessions` table,
   * keyed by worker id → the spawner recorded on the row. Same discipline as
   * `dispatcherMarks` (the fence is synchronous): warmed once per activation
   * from the store, extended synchronously at spawn, and DROPPED on settle,
   * stop, or hold release — a finished worker must never be woken back.
   */
  const workerSessions = new Map<string, string>();
  /**
   * Ticket 142: corrections sent to a dormant worker, one slot per worker id
   * (last-wins — the same rule the core's steer queue applies to a live
   * worker). Delivered once when the resumed child is announced, then
   * dropped. A worker that is resumed by something OTHER than our wake keeps
   * its text here until the next activation, which is the honest place for it.
   */
  const parkedWorkerWakes = new Map<string, string>();
  /**
   * Defect fix companion: a correction is cleared only AFTER its send
   * resolves, so a repeat announcement during the flight must not queue a
   * second copy. One in-flight delivery per worker.
   */
  const workerWakeDeliveries = new Set<string>();
  const settledCallbacks: Array<(event: SettledEvent) => void> = [];
  const stepBoundaryCallbacks: Array<(workerId: string) => void | Promise<void>> = [];
  // Ticket 75: firehose-observed tool calls on owned workers, fanned out to
  // subscribers (the plugin wires the core's noteToolCall onto this).
  const toolCallCallbacks: Array<(workerId: string) => void> = [];
  // Ticket 117: structured user-message observations on ANY session, fanned
  // out to subscribers (the plugin wires `multitask.releaseWaits` onto this).
  // The observation is the SAME `session/event` subscription below — no new
  // host seam, no polling, no timers.
  const userMessageCallbacks: Array<(sessionId: string) => void> = [];
  // Ticket 29: per-worker activity phrases, projected from the host
  // `session/event` firehose. Pure subscription — no polling, no timers.
  // Ticket 61: each entry carries its observation moment (host clock at
  // event arrival) so the liveness verdict is derivable over existing truth
  // — no new subscription, no new seam, no background machinery.
  // Ticket 110: the single-entry slot became a bounded ring (last 5
  // phrases, oldest evicted) so the wake digest can show a multi-step
  // breadcrumb; `recentActivity`/`lastActivityAtMs` still read the newest
  // entry, so their semantics are unchanged. Plain in-memory state —
  // nothing persisted; entries clear on dispose. Ticket 110 phase 2: the
  // ring is no longer cleared at settle — the digest composes AFTER the
  // settle, so the breadcrumb must survive it — and settle honesty is
  // enforced instead by `settledWorkerIds`, which gates the live-activity
  // accessors to null while `recentActivities` keeps the full breadcrumb.
  const activityRing = new WorkerActivityRing();
  // Ticket 29 honesty, ticket 110 phase 2 mechanism: workers whose
  // `subagent/end` was observed. A settled worker has no live activity —
  // the check row shows the terminal status — so the single-entry
  // accessors read null for these ids even though the ring retains the
  // breadcrumb for the wake digest.
  //
  // Defect fix: this is also the TOMBSTONE set. `forgetWorkerWake` adds every
  // terminal/abandoned worker id here (the core calls it on settle, abort and
  // hold release), and the dormancy paths (`refreshWorkerSessionMarks`,
  // `reattachMarkedWorker`) refuse to resurrect a tombstoned worker — an
  // orphan `worker_sessions` row whose async delete was lost must never make
  // "stop is for good" false.
  const settledWorkerIds = new Set<string>();
  // Ticket 41: latest bounded settle-report excerpt per settled worker,
  // clamped once at observation. Same subscription discipline as
  // `workerActivity`: adapter-side projection of host-observed truth —
  // the core stores no report text and no second transcript exists.
  const workerResults = new Map<string, RosterRecentResultSource>();
  /**
   * Ticket 155: current `tool/call` per DISPATCHER session, keyed by session
   * id — a map of its own, never the worker ring. A peer row's activity is
   * "what is it doing right now", so an entry is dropped when that session's
   * turn ends (`turn/end` on the same firehose): a finished turn has no
   * current tool, and the roster must not keep showing one. Only sessions
   * whose parent is bound here (`parents`) are recorded — the dispatchers
   * this host serves — so an ordinary chat never enters it.
   */
  const peerToolCalls = new Map<string, PeerToolActivity>();
  let wakeMissingLogged = false;
  /** Say the no-facade resume gap once, not once per send. */
  let resumeDegradedLogged = false;
  /**
   * ADR-0032 defect fix: say "this peer cannot be reached at all" once, on a
   * facade refusal with no live spawner to fall back to.
   */
  let resumeUndeliverableLogged = false;
  /**
   * The `resumeRequested` short-circuit is logged once per session instead of
   * returning silently; a repeat send before the resume lands is otherwise
   * indistinguishable from a lost request.
   */
  const resumeShortCircuitLogged = new Set<string>();
  /** Same once-only rule for the worker half (`requestDormantWorkerWake`). */
  let workerResumeDegradedLogged = false;

  /**
   * The host's live Agent for one session, guarded.
   *
   * A stub context (and a live cordis context whose service was never
   * injected) may throw at the call rather than answer `undefined`; a wake
   * must degrade to "not live" instead of escaping into the host listener
   * that asked for it.
   */
  function liveAgentOf(sessionId: string): AgentLike | undefined {
    try {
      return ctx.agents.get(sessionId);
    } catch {
      return undefined;
    }
  }

  /**
   * Second-round audit (resume fallback): the durable dispatcher row carries
   * its SHAPE as an extra `origin` field on rows this build writes —
   * `"top-level"` for a summoned peer (ADR-0032), `"subagent"` for a legacy
   * parented child. Old rows written before the field existed are read by
   * shape: a pre-141 row (no `generation`) with a spawner predates ADR-0032,
   * so it is a legacy child. Anything else without the field is NOT provably
   * legacy, which keeps a top-level peer off the subagent route.
   */
  function dispatcherMarkOrigin(mark: unknown): "subagent" | "top-level" | null {
    if (typeof mark !== "object" || mark === null) return null;
    const value = (mark as { readonly origin?: unknown }).origin;
    return value === "subagent" || value === "top-level" ? value : null;
  }

  /** Header evidence for the legacy SUBAGENT shape; null when unreadable. */
  function headerDispatcherShape(
    session: unknown,
  ): "subagent" | "top-level" | null {
    if (typeof session !== "object" || session === null) return null;
    const header = (session as {
      readonly header?: {
        readonly origin?: unknown;
        readonly parentSession?: unknown;
        readonly delegationDepth?: unknown;
      };
    }).header;
    if (typeof header !== "object" || header === null) return null;
    if (header.origin === "subagent") return "subagent";
    if (
      header.parentSession !== undefined &&
      header.parentSession !== null &&
      String(header.parentSession).length > 0
    ) {
      return "subagent";
    }
    if (
      header.delegationDepth === undefined ||
      header.delegationDepth === null ||
      Number(header.delegationDepth) === 0
    ) {
      return "top-level";
    }
    return null;
  }

  /**
   * Whether a dormant dispatcher target is a LEGACY parented (subagent-owned)
   * child — the only shape `ctx.subagents.sendMessage` can reach. Evidence is
   * the live session header when readable, else the durable row: an explicit
   * `origin`, or the pre-141 shape (spawner recorded, no generation) that
   * predates ADR-0032. No evidence means NO subagent fallback: a top-level
   * peer must stay parked rather than be sent through a route the host refuses.
   */
  async function isLegacyParentedDispatcher(sessionId: string): Promise<boolean> {
    const live = liveAgentOf(sessionId);
    if (live !== undefined) {
      const shape = headerDispatcherShape(live.session);
      if (shape !== null) return shape === "subagent";
    }
    const store = markers;
    if (store !== undefined && store.readDispatcherMark !== undefined) {
      let mark: unknown;
      try {
        mark = await store.readDispatcherMark(sessionId);
      } catch {
        return false;
      }
      if (mark !== undefined) {
        const origin = dispatcherMarkOrigin(mark);
        if (origin !== null) return origin === "subagent";
        const record = mark as {
          readonly generation?: unknown;
          readonly parentSessionId?: unknown;
        };
        return (
          record.generation === undefined &&
          typeof record.parentSessionId === "string" &&
          record.parentSessionId.length > 0
        );
      }
    }
    const mirroredParent = dispatcherMarks.get(sessionId);
    if (mirroredParent !== undefined && !dispatcherGenerations.has(sessionId)) {
      return true;
    }
    return false;
  }

  /**
   * Ticket 138: park one wake turn for a later activation. Last-wins — a
   * newer wake already parked for this session is newer than the one that
   * just failed, so it is kept instead of being overwritten by stale text.
   */
  function parkWakeTurn(
    sessionId: string,
    origin: AgentMessageWakeOrigin | undefined,
    text?: string,
  ): void {
    if (pendingWakeTurns.has(sessionId)) return;
    pendingWakeTurns.set(
      sessionId,
      text === undefined ? { origin } : { origin, text },
    );
  }

  /** Say a wake could not be opened without escaping into the host listener. */
  function warnWakeFailure(sessionId: string, error: unknown): void {
    try {
      console.warn(
        `[multitask-dispatcher] wake turn for ${sessionId} could not be opened:`,
        error,
      );
    } catch {
      // A broken console must not break the wake path either.
    }
  }

  /**
   * Shared wake-turn mechanics (ticket 116). `origin` is the optional
   * structured source override: a peer wake passes the `agent-message`
   * shape, everything else keeps the producer-owned plugin kind. The
   * composed text is never consulted for origin.
   *
   * `followup` is GUARDED — synchronously AND as a promise. This runs from
   * two places that must not throw outward: the synchronous `agent/created`
   * listener (through `flushPendingWakeTurn`) and the asynchronous wake
   * request (`requestDispatcherWakeup`, reached from a settle callback). A
   * throwing driver would escape a host listener, and the pending wake would
   * already have been popped by its caller — so a failed wake is re-parked
   * (last-wins) for the next activation instead of being lost.
   *
   * The composed text is re-parked WITH the origin. `composeWakeText` drains
   * the wake bus, so composing again on the retry would deliver the generic
   * cue and lose the worker report / inbox job text that was already drained.
   * `parkedText` (supplied by `flushPendingWakeTurn`) makes the retry deliver
   * that exact body, exactly once.
   */
  function openWakeTurn(
    sessionId: string,
    origin?: AgentMessageWakeOrigin,
    liveAgent?: AgentLike,
    parkedText?: string,
  ): void {
    const agent = liveAgent ?? liveAgentOf(sessionId);
    if (agent === undefined) {
      // Ticket 138: a marked dispatcher that is not live is exactly the
      // wake-on-send case. Park the turn (latest send wins — one turn
      // surfaces the whole inbox) and ask the host to cold-resume the child;
      // the activation hook re-opens it. An UNMARKED id keeps the pre-138
      // no-op: nothing can resume it, and the core fence refuses such sends
      // before a wake is ever requested.
      if (dispatcherMarks.has(sessionId)) {
        parkWakeTurn(sessionId, origin, parkedText);
        resumeDormantDispatcher(sessionId);
        return;
      }
      if (!wakeMissingLogged) {
        wakeMissingLogged = true;
        // Unknown session: no-op. Never throw into the wake bus.
      }
      return;
    }
    let text: string | null = parkedText ?? null;
    if (text === null && composeWakeText !== undefined) {
      try {
        text = composeWakeText(sessionId);
      } catch {
        text = null;
      }
    }
    const failed = (error: unknown): void => {
      // The caller already removed any parked copy (`flushPendingWakeTurn`
      // pops before calling), so re-park it — last-wins, with the composed
      // body — or the wake/report is lost.
      parkWakeTurn(sessionId, origin, text ?? undefined);
      warnWakeFailure(sessionId, error);
    };
    try {
      const result = agent.followup(
        wakeUserMessage(text ?? settleWakeCue, origin),
      );
      // The live turn was accepted. Any SLOT parked for this id is now stale:
      // its body exists only to retry a turn that FAILED (or was opened before
      // the session was live). Leaving it would let a later activation open a
      // SECOND, generic wake turn for work this followup already delivered.
      // A rejection below re-parks the exact body through `failed`, so this is
      // not a loss path.
      pendingWakeTurns.delete(sessionId);
      // A live driver can also return a rejected promise; the synchronous
      // try/catch above cannot see that, and dsh treats an unhandled
      // rejection as fatal. Own both failure shapes the same way.
      void Promise.resolve(result).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /**
   * Ticket 138 (owner ruling 2026-10-22 — "bots should be wake-able, both
   * dispatchers and children"; this is the DISPATCHERS half): cold-resume a
   * marked dispatcher the host has not re-announced since the restart.
   *
   * ADR-0032: a summoned dispatcher is its own TOP-LEVEL session, so there is
   * no parent→child edge to ride. The address is the session id itself and the
   * route is the host's cross-session delivery facade:
   * `ctx.sessionController.resolveAgent(id)` is get-or-cold-resume and deduped
   * (`dsh-api-session-controller/lib/index.js:221-246`) — the same route
   * `dsh-schedule` uses to deliver to a session it does not own (`:1576-1596`).
   *
   * Two rules are load-bearing here:
   * - Never append a `user/message` into the target's log: it renders but never
   *   enters that inbox and never wakes anything.
   * - Resume alone runs nothing. A restored inbox stays parked (publication
   *   sets no `wakeRequested`, `dsh-agent-loop/lib/index.js:1942-1956`), so the
   *   resume MUST be paired with an explicit `followup`, which is what opens
   *   the turn (`:806-808`). Never "resume and hope".
   *
   * The payload is the resume cue, NOT the peer text: the peer message itself
   * is drained from our wake bus once the target is announced
   * (`pendingWakeTurns` → `openWakeTurn` → `composeWakeText`), so it is never
   * delivered twice and always carries its `agent-message` origin.
   *
   * Graceful degradation: a host without the facade (only the web-app profile
   * mounts it) keeps the pre-ADR-0032 parent→child `subagents.sendMessage`
   * route. That route needs the spawner live in this process, so it cannot
   * wake a parentless dispatcher — it says so once instead of claiming success.
   *
   * Failure is honest and quiet: the send was already ACCEPTED by the core
   * (the mark is the whole permission), so a resume that cannot be issued —
   * no facade, no bound parent Agent, a host refusal — leaves the message in
   * the peer inbox for the next activation to deliver. Nothing is thrown into
   * the wake bus, and no refusal class is invented.
   *
   * Defect fix (a legacy row could never be resumed): a facade REFUSAL is not
   * terminal. `dispatcher_sessions` rows are never deleted, so pre-ADR-0032
   * rows point at subagent-owned sessions the facade refuses forever with
   * `session/agent-busy`; those fall through to `ctx.subagents.sendMessage`
   * from the recorded spawner. Only when neither route can be issued does the
   * wake stay parked, with one distinct "undeliverable" line — never a claimed
   * resume.
   *
   * Defect fix (a followup failure double-sent the cue): a facade REFUSAL and
   * a followup FAILURE are different outcomes and must not share a catch.
   * Only a refusal — `resolveAgent` throwing/rejecting or answering
   * `{error}` — falls back to the spawner route, because no agent was
   * resumed. Once `resolveAgent` SUCCEEDED that route alone owns the wake: a
   * throwing (or rejecting) `followup` is logged and the parked turn is kept
   * for the activation hook, never re-sent through `subagents.sendMessage`.
   */
  function resumeDormantDispatcher(sessionId: string): void {
    if (resumeRequested.has(sessionId)) {
      // Ticket 138: one resume covers every send that arrives before the
      // resumed child is announced. Say it ONCE rather than returning
      // silently — a caller otherwise cannot tell this from a lost request.
      if (!resumeShortCircuitLogged.has(sessionId)) {
        resumeShortCircuitLogged.add(sessionId);
        try {
          console.warn(
            `[multitask-dispatcher] dispatcher ${sessionId} already has a resume in flight; ` +
              `the wake stays queued until it activates.`,
          );
        } catch {
          // A broken console must not break the wake path either.
        }
      }
      return;
    }
    resumeRequested.add(sessionId);
    void Promise.resolve()
      .then(async () => {
        let facadeRefused = false;
        const facade = readSessionController(ctx);
        if (facade !== undefined) {
          let found:
            | { readonly agent: AgentLike }
            | { readonly error: unknown }
            | undefined;
          try {
            found = await facade.resolveAgent(sessionId);
          } catch {
            // A resolve refusal is the only failure that may fall through to
            // the recorded-spawner route: no agent was resumed, so the other
            // route is still allowed to try.
            facadeRefused = true;
          }
          if (found !== undefined) {
            if ("error" in found) {
              // ADR-0032: `dispatcher_sessions` rows are never deleted, so
              // rows written before a summon became a TOP-LEVEL session point
              // at subagent-owned sessions the facade refuses forever
              // (`session/agent-busy`). A facade refusal is therefore not
              // terminal — it falls through to the recorded-spawner route
              // below.
              facadeRefused = true;
            } else {
              // Resume alone runs nothing: this followup is what opens the
              // turn. The resume ALREADY SUCCEEDED, so a followup failure is
              // mine to own — never a second cue through `subagents`, which
              // would deliver the same wake twice. Keep it parked instead;
              // the activation hook (`agent/created`) discharges the parked
              // turn when the resumed session is announced.
              try {
                const result = found.agent.followup(
                  wakeUserMessage(resumeWakeCue),
                );
                // A live driver may return a rejected promise; the
                // synchronous try/catch cannot see that, and an unhandled
                // rejection is fatal in dsh.
                await Promise.resolve(result).catch((error: unknown) => {
                  try {
                    console.warn(
                      `[multitask-dispatcher] dispatcher ${sessionId} was resumed but its followup failed; ` +
                        `the wake stays parked until the next activation:`,
                      error,
                    );
                  } catch {
                    // A broken console must not break the wake path either.
                  }
                });
              } catch (error) {
                try {
                  console.warn(
                    `[multitask-dispatcher] dispatcher ${sessionId} was resumed but its followup failed; ` +
                      `the wake stays parked until the next activation:`,
                    error,
                  );
                } catch {
                  // A broken console must not break the wake path either.
                }
              }
              return;
            }
          }
        }
        const parentSessionId = dispatcherMarks.get(sessionId);
        const sender =
          parentSessionId === undefined || parentSessionId === ""
            ? undefined
            : parents.get(parentSessionId);
        // Second-round audit: the recorded spawner exists for a TOP-LEVEL peer
        // too (the summoned dispatcher's row names its summoner), so a sender
        // alone proves nothing. Only a LEGACY parented child may ride
        // `subagents.sendMessage`; a top-level peer has no route without the
        // facade and must stay parked instead of being sent through a route
        // the host refuses.
        const legacyParented = await isLegacyParentedDispatcher(sessionId);
        if (!legacyParented) {
          // No evidence of the subagent shape. The facade either is absent or
          // refused — both mean a top-level peer is unreachable from here.
          // Say it once; the parked turn is still discharged on activation.
          if (!resumeUndeliverableLogged) {
            resumeUndeliverableLogged = true;
            try {
              console.warn(
                `[multitask-dispatcher] dispatcher ${sessionId} is undeliverable: ` +
                  `it is not a legacy subagent child and no session facade resumed it; ` +
                  `the wake stays parked until the session activates.`,
              );
            } catch {
              // A broken console must not break the wake path either.
            }
          }
          return;
        }
        if (sender !== undefined) {
          // The pre-ADR-0032 route: subagent delivery from the recorded
          // spawner cold-resumes a child that the facade refuses. Same cue,
          // same "resume must open a turn" rule.
          await ctx.subagents.sendMessage(
            sender,
            sessionId,
            textBlocks(resumeWakeCue),
            { signal: new AbortController().signal },
          );
          return;
        }
        if (facadeRefused) {
          // The facade refused AND no recorded spawner is bound. Nothing ran,
          // so do not claim a resume: keep the wake parked (the peer inbox
          // still owes it) and say it once. `resumeRequested` stays set so a
          // later send cannot start a resume storm; the lifecycle listeners
          // (`agent/created` / `agent/disposed`) clear it when the session
          // comes back.
          if (!resumeUndeliverableLogged) {
            resumeUndeliverableLogged = true;
            try {
              console.warn(
                `[multitask-dispatcher] dispatcher ${sessionId} is undeliverable: ` +
                  `the session facade refused the resume and no recorded spawner is bound; ` +
                  `the wake stays parked until the session activates.`,
              );
            } catch {
              // A broken console must not break the wake path either.
            }
          }
          return;
        }
        // Degraded host: nothing was issued, so the next send may try again.
        resumeRequested.delete(sessionId);
        if (!resumeDegradedLogged) {
          resumeDegradedLogged = true;
          try {
            console.warn(
              `[multitask-dispatcher] dispatcher ${sessionId} cannot be cold-resumed: ` +
                `no ctx.sessionController and no live spawner bound; the peer ` +
                `message waits in its inbox until it activates.`,
            );
          } catch {
            // A broken console must not break the wake path either.
          }
        }
      })
      .catch((error) => {
        // Retry on the NEXT send: the resume never reached the host.
        resumeRequested.delete(sessionId);
        try {
          console.warn(
            `[multitask-dispatcher] dispatcher ${sessionId} could not be resumed on send:`,
            error,
          );
        } catch {
          // A broken console must not break the wake path either.
        }
      });
  }

  function ownsSession(agentSessionId: string): string | undefined {
    return workers.has(agentSessionId) ? agentSessionId : undefined;
  }

  /**
   * Ticket 142 (owner ruling 2026-10-22 — "bots should be wake-able, both
   * dispatchers and children"; this is the CHILDREN half): wake a worker that
   * carries our own durable `worker_sessions` row but has no live Agent.
   *
   * The mechanics mirror `resumeDormantDispatcher` exactly: park the text
   * (last-wins — one slot, like the core's steer queue), then cold-resume the
   * worker session by id, using `RESUME_WAKE_CUE` rather than the correction.
   * The correction itself is delivered by `deliverParkedWorkerWake` once the
   * resumed child is announced, so it is never sent twice.
   *
   * Resume route: `ctx.subagents.sendMessage` from the SPAWNER recorded on the
   * row. ADR-0032's `sessionController` facade is NOT a substitute here: it
   * serves top-level dispatcher peers, and the host's ownership guard refuses
   * a subagent-owned child on that route by design
   * (`dsh-api-session-controller/lib/index.js:128-134`). The subagent route
   * does cold-resume an absent direct child
   * (`dsh-subagent/lib/types/index.d.ts:151-168`), which is exactly the
   * dormant case; without a bound spawner there is no sender, so the text
   * waits.
   *
   * Failure is honest and quiet, same rule as the dispatcher half: the send
   * was already ACCEPTED by the core, so a wake that cannot be issued — no
   * bound spawner, a host refusal — logs, and the text stays parked for the
   * next activation. Nothing is thrown into the caller and no refusal class
   * is invented.
   */
  function requestDormantWorkerWake(workerId: string, message: string): void {
    parkedWorkerWakes.set(workerId, message);
    if (resumeRequested.has(workerId)) return;
    const parentSessionId = workerSessions.get(workerId);
    const sender =
      parentSessionId === undefined ? undefined : parents.get(parentSessionId);
    if (sender === undefined) {
      // The spawner is not bound in this process (it never activated this
      // boot): the text waits here for when it does. Nothing was issued, so
      // the next send may try again.
      if (!workerResumeDegradedLogged) {
        workerResumeDegradedLogged = true;
        try {
          console.warn(
            `[multitask-dispatcher] worker ${workerId} cannot be cold-resumed: ` +
              `no live spawner bound; the parked wake waits until it activates.`,
          );
        } catch {
          // A broken console must not break the wake path either.
        }
      }
      return;
    }
    resumeRequested.add(workerId);
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        ctx.subagents.sendMessage(
          sender,
          workerId,
          textBlocks(resumeWakeCue),
          { signal: controller.signal },
        ),
      )
      .catch((error) => {
        // Retry on the NEXT send: the resume never reached the host. The
        // parked text stays, so nothing was lost.
        resumeRequested.delete(workerId);
        try {
          console.warn(
            `[multitask-dispatcher] worker ${workerId} could not be resumed on send:`,
            error,
          );
        } catch {
          // A broken console must not break the wake path either.
        }
      });
  }

  /**
   * Ticket 142: hand a parked correction to a worker the host just brought
   * back. The slot is cleared only AFTER the send resolves: a failed delivery
   * (no bound sender, or a refused `sendMessage`) re-parks the text
   * last-wins, so the correction is never lost. A newer correction parked
   * while the send was in flight wins — it is not overwritten by this one.
   *
   * Second-round audit fixes:
   * - a FALLING delivery must not re-park text for a worker that settled in
   *   the meantime (the tombstone means stop was for good);
   * - when a newer correction is parked while this send is in flight, the
   *   in-flight guard must not strand it: after the guard clears, delivery is
   *   started again for the newer text.
   */
  function deliverParkedWorkerWake(workerId: string): void {
    resumeRequested.delete(workerId);
    // A terminal worker gets nothing delivered. This also covers a send that
    // resolves after the worker settled.
    if (settledWorkerIds.has(workerId)) {
      parkedWorkerWakes.delete(workerId);
      return;
    }
    const text = parkedWorkerWakes.get(workerId);
    if (text === undefined) return;
    const entry = workers.get(workerId);
    const parentSessionId =
      entry?.parentSessionId ?? workerSessions.get(workerId);
    const sender =
      parentSessionId !== undefined ? parents.get(parentSessionId) : undefined;
    if (sender === undefined) {
      // Nothing to send WITH (the spawner is not bound): keep the text parked
      // so the spawner's activation can still deliver it. The slot was never
      // popped, so this is a no-op on the map; logged, not silently dropped.
      try {
        console.warn(
          `[multitask-dispatcher] worker ${workerId} was resumed but its spawner is not bound; the parked correction stays queued`,
        );
      } catch {
        // A broken console must not break the create path either.
      }
      return;
    }
    // One delivery per worker at a time: the slot now survives until the send
    // resolves, so a repeat announcement must not queue the same text twice.
    if (workerWakeDeliveries.has(workerId)) return;
    workerWakeDeliveries.add(workerId);
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        ctx.subagents.sendMessage(sender, workerId, textBlocks(text), {
          signal: controller.signal,
        }),
      )
      .then(() => {
        // Last-wins: a correction parked while this send was in flight is
        // newer and must survive (the `finally` below starts its delivery).
        if (parkedWorkerWakes.get(workerId) === text) {
          parkedWorkerWakes.delete(workerId);
        }
      })
      .catch((error) => {
        // A settled worker is done: never re-park a correction for it.
        if (settledWorkerIds.has(workerId)) {
          parkedWorkerWakes.delete(workerId);
          return;
        }
        // Re-park last-wins: keep a newer correction if one arrived.
        if (!parkedWorkerWakes.has(workerId)) {
          parkedWorkerWakes.set(workerId, text);
        }
        try {
          console.warn(
            `[multitask-dispatcher] correction for resumed worker ${workerId} could not be delivered; it stays queued:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      })
      .finally(() => {
        workerWakeDeliveries.delete(workerId);
        // The guard that just cleared may have hidden a NEWER correction
        // parked during the flight. Deliver exactly that newer text; when the
        // slot holds the text just sent (or the send failed and re-parked it),
        // nothing is started here.
        const parked = parkedWorkerWakes.get(workerId);
        if (
          parked !== undefined &&
          parked !== text &&
          !settledWorkerIds.has(workerId)
        ) {
          deliverParkedWorkerWake(workerId);
        }
      });
  }

  const offSubagentEnd = ctx.on("subagent/end", (info: never) => {    const end = info as {
      id: unknown;
      stopReason: string;
      lastAssistantMessage?: ContentBlock[];
    };
    const workerId = String(end.id);
    // A late duplicate after the first terminal event is not a new settle.
    if (settledWorkerIds.has(workerId)) return;
    // A settled worker is still OURS even after its live registry entry was
    // pruned (`agent/disposed` does that): the durable wake identity — or,
    // when the deployment has no durable store at all, the in-process spawn
    // proof — is what proves ownership here, so the settle is never dropped
    // and the core cannot be left with a running worker that will never
    // finish.
    if (
      !workers.has(workerId) &&
      !workerSessions.has(workerId) &&
      !spawnedWorkerIds.has(workerId)
    ) {
      return;
    }
    // A settled worker has no live activity; the check row shows the
    // terminal status instead (ticket 29 honesty rule). Ticket 110 phase 2:
    // the ring itself is retained — the wake digest composes after this
    // event and reads the final breadcrumb via `recentActivities` — so
    // settle honesty is enforced here by marking the worker settled, which
    // gates `recentActivity`/`lastActivityAtMs` to null.
    settledWorkerIds.add(workerId);
    const status = mapStopReason(end.stopReason);
    const event: SettledEvent = {
      workerId,
      status,
      report: normalizeSettleReport(status, end.lastAssistantMessage),
      transcriptRef: workerId,
    };
    // Ticket 41: hold the bounded excerpt for the roster's deliverables
    // line BEFORE the core observers run, so the publish the settle
    // transition triggers already sees it. Empty report (an aborted worker
    // with no text) → no excerpt rather than an invented one.
    const excerpt = clampRecentResultExcerpt(event.report);
    if (excerpt !== null) {
      workerResults.set(workerId, { text: excerpt, settledAtMs: Date.now() });
    } else {
      workerResults.delete(workerId);
    }
    for (const cb of [...settledCallbacks]) {
      cb(event);
    }
    // Defect fix (leaked per-worker state): a terminal worker's live entries
    // are dead weight — the registry entry kept it wake-able and `owns()` true
    // for the rest of the process, and the abort controller + activation were
    // only released on host dispose. Prune them HERE. What the late settle /
    // wake paths still need lives elsewhere: the settle record (`workerResults`)
    // and the activity breadcrumb (`activityRing`) are retained, the tombstone
    // (`settledWorkerIds`) blocks resurrection, and `workerSessions` is dropped
    // by the core's own `forgetWorkerWake` on this same event.
    const finished = workerActivations.get(workerId);
    workerActivations.delete(workerId);
    spawnControllers.delete(workerId);
    workers.delete(workerId);
    // The settle has been accepted; the in-process ownership proof has no
    // further job (the tombstone above blocks a duplicate/resurrection).
    spawnedWorkerIds.delete(workerId);
    if (finished !== undefined) {
      // Release exactly this activation (never a later cold resume); a failing
      // dispose is logged, never thrown into the settle path.
      void Promise.resolve(finished.dispose()).catch((error) => {
        try {
          console.warn(
            `[multitask-dispatcher] settled worker ${workerId} could not be released:`,
            error,
          );
        } catch {
          // A broken console must not break the settle path either.
        }
      });
    }
  });

  const offSessionEvent = ctx.on("session/event", (...args: never[]) => {
    const [sessionRef, rawEvent] = args as unknown as [unknown, unknown];
    const event = rawEvent as SessionEventLike | null;
    if (typeof event !== "object" || event === null) return;
    // Ticket 117: a real user prompt on ANY session releases that session's
    // await waiters. Read BEFORE the worker-only filter below, because the
    // dispatcher session is never an owned worker — the filter would drop it.
    // Structured source only; the text is never inspected.
    if (userMessageCallbacks.length > 0) {
      const userId = dispatcherUserMessageSession(sessionRef, event);
      if (userId !== null) {
        for (const cb of [...userMessageCallbacks]) {
          cb(userId);
        }
      }
    }
    if (event.type !== "tool/call" && event.type !== "turn/end") return;
    const session = sessionRef as SessionRefLike | null;
    if (typeof session !== "object" || session === null) return;
    const workerId = String(session.id);
    // Ticket 155: the dispatcher branch. It records the CURRENT tool of a
    // bound dispatcher session for the peer roster and returns — the worker
    // path below stays exactly as it was, so no ring or count ever sees a
    // dispatcher key. `turn/end` clears the entry: a closed turn has no
    // current tool, and a stale one would be an invented activity.
    if (parents.has(workerId)) {
      if (event.type === "turn/end") {
        peerToolCalls.delete(workerId);
        return;
      }
      const call = describeToolCall(event.data);
      if (call === null) {
        peerToolCalls.delete(workerId);
      } else {
        peerToolCalls.set(workerId, call);
      }
      return;
    }
    if (event.type !== "tool/call") return;
    if (!workers.has(workerId)) return;
    // Ticket 75: an observed `tool/call` is a tool call whether or not the
    // payload was readable — the count advances unconditionally, while the
    // phrase stays null (never invented) for unreadable payloads.
    for (const cb of [...toolCallCallbacks]) {
      cb(workerId);
    }
    const phrase = describeToolActivity(event.data);
    if (phrase !== null) {
      activityRing.record(workerId, phrase, Date.now());
    }
  });

  /**
   * Ticket 118 chunk 3: the one activation call per spawned dispatcher,
   * deduplicated by session id so the `agent/created` listener and the
   * post-`startActivation` fallback can never both activate the same child.
   *
   * Failure policy: the hook is the PLUGIN's step (bind parent, scoped tool
   * surface, policy, lifecycle, rebuild) and must not turn a spawn the host
   * already accepted into a host refusal — the model would be told nothing
   * started while a live child exists. A throw is therefore logged honestly
   * and the child stays live but inert; `dispatcherActivations` still records
   * the attempt so neither path retries it.
   *
   * `generation` (ticket 141) is resolved by the caller from the map/mark and
   * forwarded to the hook; it is the number the policy text names.
   *
   * `flushWake` (ADR-0032): when the activation runs from the create `setup`
   * hook, the parked-wake discharge is suppressed here and performed by the
   * caller after creation resolves. `setup` COMPOSES, never drives
   * (`dsh-agent/lib/types/index.d.ts:99-101`), and `flushPendingWakeTurn`
   * drives — it opens a `followup` turn.
   *
   * `title` (ticket 159) is the spawn's human label and is passed straight
   * through to the hook, so the plugin never has to pair a label to a session
   * by queue position. Present only on the spawn path; a re-announcement
   * passes `undefined`.
   *
   * Named for the SUMMON, not the old subagent spawn: since ADR-0032 this runs
   * for a summoned top-level session that went through the ordinary gate.
   */
  function activateSummonedDispatcher(
    childAgent: AgentLike,
    sessionId: string,
    generation: number = dispatcherGenerations.get(sessionId) ?? 2,
    flushWake = true,
    title?: string,
  ): void {
    // Ticket 176: every session THIS function activates is spawned-class by
    // definition — it is called only for a child a dispatcher summoned (the
    // reservation, the durable mark, or the re-announcement of one). The class
    // is recorded before the hook runs, so `spawnDispatcher` can refuse a
    // summon from this session even if the plugin's own surface registration
    // threw.
    dispatcherClasses.set(sessionId, "spawned");
    if (onDispatcherSpawned === undefined) {
      if (flushWake) flushPendingWakeTurn(sessionId, childAgent);
      return;
    }
    if (dispatcherActivations.has(sessionId)) {
      // Ticket 130: a repeat resume does nothing twice. Ticket 138: a wake a
      // send parked for this id is still discharged — for a child that is
      // live again it lands normally, and there is no second activation to
      // wait for. This is per-activation state: `agent/disposed` deletes it,
      // so a re-announced session activates again.
      if (flushWake) flushPendingWakeTurn(sessionId, childAgent);
      return;
    }
    dispatcherActivations.add(sessionId);
    try {
      onDispatcherSpawned(childAgent, sessionId, generation, title);
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] spawned dispatcher ${sessionId} could not be activated:`,
          error,
        );
      } catch {
        // A broken console must not break the spawn either.
      }
    }
    // Ticket 138: the parked wake turn is opened LAST — after the tool
    // surface, the policy inject and the lifecycle registration have landed
    // (the plugin's `onDispatcherSpawned` runs synchronously above) — so the
    // resumed dispatcher's first turn already has its own tools and policy.
    // If no send parked a turn for this id, this is a no-op.
    if (flushWake) flushPendingWakeTurn(sessionId, childAgent);
  }

  /**
   * Ticket 138: discharge a wake turn a send parked for a session the host
   * had not announced yet. Called from the activation helper, i.e. only once
   * the resumed child exists, and handed the exact child Agent the host
   * announced (no re-fetch from `ctx.agents`).
   *
   * `resumeRequested` is cleared HERE, on activation: the resume is finished,
   * so a later cold death of the same session may be resumed again. It is
   * also cleared when a resume call FAILS (so the next send retries).
   */
  function flushPendingWakeTurn(
    sessionId: string,
    childAgent: AgentLike,
  ): void {
    resumeRequested.delete(sessionId);
    // Never escape a listener: the callers are the synchronous
    // `agent/created` path and the post-create spawn path, and a throw here
    // would abort a listener that owns no failure handling.
    try {
      if (!pendingWakeTurns.has(sessionId)) return;
      const parked = pendingWakeTurns.get(sessionId);
      pendingWakeTurns.delete(sessionId);
      // Deliver the parked body when one was composed; `openWakeTurn` only
      // composes when the text is absent (the not-live case), so a report
      // drained before a failed followup is never replaced by the generic cue.
      openWakeTurn(sessionId, parked?.origin, childAgent, parked?.text);
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] parked wake for ${sessionId} could not be discharged:`,
          error,
        );
      } catch {
        // A broken console must not break the create path either.
      }
    }
  }

  /**
   * Ticket 130: record the child's dispatcher identity durably.
   *
   * Called once per successful `spawnDispatcher`, after `startActivation`
   * resolved (before that there is no session id to key on). Never deleted —
   * deactivation also runs on plugin unload, so a delete would wipe the mark
   * at every restart; the table grows and that is accepted.
   *
   * A store that omits the optional seam (pre-130 doubles) is a no-op, and a
   * failing write is logged rather than surfaced: the host already accepted
   * the spawn, so a marker problem must never read as a host refusal. The
   * lost mark is the accepted crash window, one step wider.
   */
  /**
   * SECOND-ROUND AUDIT (first-turn ordering): bound one POST-CREATE
   * bookkeeping step. The mark write still runs BEFORE the first turn for
   * crash safety, but a store that never settles must not block `followup`
   * forever. The wrapped promise's outcome is always observed (no unhandled
   * rejection), and a timeout is logged, never thrown: the child already
   * exists, so bookkeeping failure is not a spawn refusal.
   */
  function boundedBookkeeping(
    work: Promise<unknown> | void,
    description: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          console.warn(
            `[multitask-dispatcher] ${description} did not settle within ${bookkeepingTimeoutMs}ms; continuing so the first turn is not blocked`,
          );
        } catch {
          // A broken console must not block the turn either.
        }
        finish();
      }, bookkeepingTimeoutMs);
      // Node's timer must not keep the process alive on its own.
      (timer as { unref?: () => void }).unref?.();
      void Promise.resolve(work).then(
        () => finish(),
        (error: unknown) => {
          try {
            console.warn(
              `[multitask-dispatcher] ${description} failed; continuing so the first turn is not blocked:`,
              error,
            );
          } catch {
            // A broken console must not block the turn either.
          }
          finish();
        },
      );
    });
  }

  async function writeDispatcherMark(
    sessionId: string,
    parentSessionId?: string,
    generation?: number,
    workerModel?: ModelRoute,
  ): Promise<void> {
    // Ticket 138: the local mirror is updated FIRST and synchronously, so a
    // send arriving before the store write settles already sees the mark. The
    // parent rides the row because a send-triggered cold resume needs the
    // exact live parent Agent as the host's sender.
    dispatcherMarks.set(sessionId, parentSessionId);
    // Ticket 141: the generation is mirrored the same way, so a re-announced
    // child resolves its number even before the store round-trips.
    if (generation !== undefined) {
      dispatcherGenerations.set(sessionId, generation);
    }
    // Ticket 285: the leader worker default is mirrored the same way, and
    // under the SAME id the row is written for — the host-assigned leader
    // id, never the reservation. usableRoute is the last defensive narrowing:
    // a malformed route from a JS caller is absent (one warning) and stores
    // nothing, so a later worker keeps today's inherited route instead of a
    // route the host could only fail on at its first request.
    const defaultWorkerModel = usableRoute(workerModel);
    if (defaultWorkerModel !== undefined) {
      workerModelDefaults.set(sessionId, defaultWorkerModel);
    }
    const store = markers;
    if (store === undefined || store.writeDispatcherMark === undefined) return;
    try {
      // Second-round audit: the row also records the session SHAPE. Every row
      // this build writes comes from the top-level summon path (ADR-0032), so
      // `origin: "top-level"` lets the dormant-resume fallback keep this peer
      // off the legacy `subagents.sendMessage` route. Older rows omit it and
      // are classified by header/shape instead. The durable schema preserves
      // unknown fields, so this rides the existing row without a version bump.
      await store.writeDispatcherMark({
        sessionId,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(generation !== undefined ? { generation } : {}),
        ...(defaultWorkerModel !== undefined
          ? { workerModel: defaultWorkerModel }
          : {}),
        origin: "top-level",
      } as DurableDispatcherMark);
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] dispatcher mark for ${sessionId} could not be written:`,
          error,
        );
      } catch {
        // A broken console must not break the spawn either.
      }
    }
  }

  /**
   * Ticket 130: re-activate a child that carries a DURABLE dispatcher mark.
   *
   * A spawned dispatcher's only other identity is this process's in-memory
   * registry, which dies with the process. The mark was written at spawn, so
   * a cold-resumed child (or one the host re-announces) is recognised here and
   * routed into the SAME activation path the spawn hook uses: role, scoped
   * tool surface, and policy injection all come back.
   *
   * The store read may be asynchronous while this listener must return
   * synchronously, so the activation lands as soon as the read resolves —
   * the same residual limit the no-announcement fallback already documents.
   * Idempotency is the activation helper's: `dispatcherActivations` is checked
   * synchronously, so a second resume never double-registers tools or
   * double-injects policy. The guard ends with the activation
   * (`agent/disposed` deletes it), so a later re-announcement activates
   * again.
   *
   * Residual limit, stated: if the SAME parent has a worker spawn in flight
   * when a marked child is announced, the worker composition can land in the
   * one-microtask window before the mark is read. The mark still re-activates
   * the child, so its dispatcher role comes back (with the worker persona and
   * reply tool alongside). At boot no spawn is in flight, so a cold resume
   * does not hit this window.
   *
   * Nothing here deletes the mark (deactivation also runs on plugin unload,
   * so a delete would wipe it at every restart) and nothing recomputes the
   * child's `delegationDepth` — the resumed session keeps its persisted one.
   */
  function resumeMarkedDispatcher(
    childAgent: AgentLike,
    sessionId: string,
  ): void {
    const store = markers;
    if (store === undefined || store.readDispatcherMark === undefined) return;
    if (dispatcherActivations.has(sessionId)) return;
    void Promise.resolve()
      .then(() => store.readDispatcherMark?.(sessionId))
      .then((mark) => {
        if (mark === undefined) return;
        // Defect fix (a DISPOSED Agent was installed): the store round-trip
        // can outlive the announcement. Binding a dead Agent would leave the
        // session without a working parent and the durable mark uncorrected.
        // Only the SAME live agent may be activated; a later announcement
        // runs this path again with a fresh store read.
        const current = liveAgentOf(sessionId);
        if (current !== childAgent) {
          try {
            console.warn(
              `[multitask-dispatcher] dispatcher ${sessionId} was disposed before its mark resolved; activation skipped`,
            );
          } catch {
            // A broken console must not break the create path either.
          }
          return;
        }
        // Ticket 141: the resumed child keeps the number it was spawned with.
        // A pre-141 row has no field — every such row came from a spawn, so
        // its honest reading is generation 2 (a direct child of a
        // user-started dispatcher).
        const generation = mark.generation ?? 2;
        dispatcherGenerations.set(sessionId, generation);
        activateSummonedDispatcher(childAgent, sessionId, generation);
      })
      .catch((error) => {
        // A marker-store failure must not break the host's create path; the
        // child simply stays an ordinary subagent, exactly as before 130.
        try {
          console.warn(
            `[multitask-dispatcher] dispatcher mark for ${sessionId} could not be read:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      });
  }

  /**
   * Ticket 142: re-adopt a worker the host brought back from the dormant
   * state, and hand it the correction a send parked.
   *
   * Identity is the durable `worker_sessions` row, never a guess. The mirror
   * is consulted first because a send could only have been accepted (and a
   * resume only issued) when the row was already mirrored; the store read is
   * the fallback for a session the host resumes on its own, before this
   * process warmed anything.
   *
   * WHAT this restores matters for safety: a cold-resumed child starts with
   * its INHERITED composition — the parent dispatcher's — so without the
   * worker composition (contract section, tool barrier, local reply tool) it
   * would come back able to call the dispatcher's own tools. The registry
   * entry is what makes `interruptWorker`/`sendMessage`/settle resolve again.
   *
   * `workers.has` is the idempotency gate: a normal in-process spawn reserved
   * its id BEFORE `startActivation`, so it is already registered and this
   * branch is skipped (the existing composition path handles it).
   */
  function reattachMarkedWorker(childAgent: AgentLike, workerId: string): boolean {
    // Defect fix (a terminal worker was resurrected): a settled/aborted id
    // never comes back. The core records the tombstone on every terminal path
    // (`forgetWorkerWake`), so a late announcement cannot adopt a worker whose
    // stop was already delivered.
    if (settledWorkerIds.has(workerId)) return false;
    // Fast path: an in-process spawn reserved this id before `startActivation`
    // (ticket 120), so it is already registered and the caller's normal
    // composition path handles it — return false so the listener falls
    // through. Only a wake parked for a live worker still needs discharging
    // here (a second send before the resume landed).
    if (workers.has(workerId)) {
      deliverParkedWorkerWake(workerId);
      return false;
    }
    const adopt = (parentSessionId: string): boolean => {
      // Same tombstone rule at the adoption itself — a settle can land
      // between the entry check and the store round-trip below.
      if (settledWorkerIds.has(workerId)) return false;
      if (workers.has(workerId)) {
        // Lost a race with a spawn that registered in the meantime — the
        // parked correction still has to reach it exactly once, and the
        // caller's normal path still applies.
        deliverParkedWorkerWake(workerId);
        return false;
      }
      workers.set(workerId, { parentSessionId, agentSessionId: workerId });
      if (
        workerAgentDef !== undefined &&
        typeof childAgent.ctx === "object" &&
        childAgent.ctx !== null
      ) {
        try {
          applyWorkerComposition(
            childAgent.ctx as Parameters<typeof applyWorkerComposition>[0],
            workerAgentDef,
            childAgent,
            buildWorkerLocalTools(workerId),
          );
        } catch (error) {
          // A resumed child inherits the parent dispatcher's composition, so a
          // failed barrier would leave it with tools a worker must not have.
          // Nothing can roll that back here (the child is already live), so it
          // is logged loudly rather than hidden — the same failure policy the
          // dispatcher activation path uses.
          try {
            console.warn(
              `[multitask-dispatcher] resumed worker ${workerId} could not be composed; it keeps its inherited surface:`,
              error,
            );
          } catch {
            // A broken console must not break the create path either.
          }
        }
      }
      // Core side: resolve the unknown-state hold into a live roster record,
      // so the worker is visible and stoppable again.
      onWorkerReattached?.(workerId, parentSessionId);
      deliverParkedWorkerWake(workerId);
      return true;
    };
    const mirrored = workerSessions.get(workerId);
    if (mirrored !== undefined) {
      return adopt(mirrored);
    }
    const store = markers;
    if (store === undefined || store.readWorkerSession === undefined) {
      return false;
    }
    void Promise.resolve()
      .then(() => store.readWorkerSession?.(workerId))
      .then(async (row) => {
        if (row === undefined) return;
        if (settledWorkerIds.has(workerId)) return;
        // Defect fix (a terminal worker was woken back): the durable row can
        // be an orphan whose async delete was lost. A terminal worker-marker
        // snapshot is the proof that stop was for good, so the row must not
        // re-arm the wake identity or the adoption.
        try {
          const parentMarkers = await store.readWorkerMarkers(
            row.parentSessionId,
          );
          if (
            parentMarkers.some(
              (marker) =>
                marker.workerId === workerId &&
                isTerminalStatus(marker.status),
            )
          ) {
            return;
          }
        } catch {
          // An unreadable table proves nothing; keep the pre-fix behaviour.
        }
        // Defect fix (a DISPOSED Agent was installed): after the store
        // round-trip the announcement may already be stale. Adopt only the
        // live agent for this id; a re-announcement runs this path again.
        if (liveAgentOf(workerId) !== childAgent) {
          try {
            console.warn(
              `[multitask-dispatcher] worker ${workerId} was disposed before its session row resolved; adoption skipped`,
            );
          } catch {
            // A broken console must not break the create path either.
          }
          return;
        }
        workerSessions.set(row.sessionId, row.parentSessionId);
        adopt(row.parentSessionId);
      })
      .catch((error) => {
        // A marker-store failure must not break the host's create path.
        try {
          console.warn(
            `[multitask-dispatcher] worker session row for ${workerId} could not be read:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      });
    return false;
  }

  /**
   * Ticket 176 (owner ruling 2026-11-03): which class the CALLING session
   * belongs to — the answer `spawnDispatcher` needs before it does anything.
   *
   * Resolution order, most specific first:
   *
   * 1. `dispatcherClasses` — written by the two activation entry points, so it
   *    covers every session this process activated. Exact, not inferred.
   * 2. the spawn-generation mirror — `>= 2` means "another dispatcher spawned
   *    this one" (the spawn path writes spawner + 1, so 1 never appears there).
   * 3. the durable mark answer — `"dispatcher"` means spawned,
   *    `"not-dispatcher"` means user-started. This is the cold-resume route: a
   *    `dispatcher_sessions` row is written only by the spawn path
   *    (`parseDispatcherMark` rejects generation 1), so a row's presence IS
   *    "another dispatcher summoned this session".
   *
   * The two unanswerable cases are deliberately NOT the same answer:
   *
   * - **No durable store at all** (or one with no synchronous peek) → `"user"`.
   *   Nothing can ever be proven on that shape, the spawn path's own two
   *   in-memory records above already covered every real spawned session, and
   *   returning `"spawned"` would break the pre-176 behaviour for every
   *   install that carries no marker domain. This is the historical host
   *   shape and it keeps its historical answer.
   * - **A store that exists but has not opened yet** → `"spawned"`, FAIL
   *   CLOSED. Such a store can hold a `dispatcher_sessions` row this process
   *   has not read, so absence proves nothing. The owner set this constraint
   *   explicitly; a wrong allow creates a second dispatcher level nothing else
   *   would catch, while a wrong deny is visible immediately and self-heals
   *   once the store opens (which happens inside `rebuildFromDurability`, at
   *   activation). See the ticket for the residual window.
   */
  function dispatcherClassForSummon(sessionId: string): DispatcherOrigin {
    const recorded = dispatcherClasses.get(sessionId);
    if (recorded !== undefined) return recorded;
    const generation = dispatcherGenerations.get(sessionId);
    if (generation !== undefined) return generation >= 2 ? "spawned" : "user";
    if (dispatcherMarks.has(sessionId)) return "spawned";
    const store = markers;
    if (store === undefined || store.peekDispatcherMark === undefined) {
      // No durable store at all, or one that cannot answer synchronously.
      // Neither can hide a spawned dispatcher: the spawn path records BOTH the
      // class and the generation in this process before the child's surface
      // exists, so the two checks above already answered for one. What is left
      // is the historical host shape, and it keeps its pre-176 behaviour.
      return "user";
    }
    let kind: DurableDispatcherMarkAnswer["kind"] = "unknown";
    try {
      kind = store.peekDispatcherMark(sessionId).kind;
    } catch {
      // An unreadable table is the same "cannot answer" case as an unopened
      // one — handled below.
    }
    if (kind === "not-dispatcher") return "user";
    // "dispatcher" — or a store that exists but has not opened yet, which
    // cannot prove the human started this chat. Deny: see the ticket.
    return "spawned";
  }

  /**
   * Ticket 176: the ONE write path for a session's policy class.
   *
   * The class of a session id cannot change (ADR-0034 decision 1), so
   * `"spawned"` is permanent: a later caller that carries the `"user"`
   * default — a cold resume whose projection could not answer, the plugin's
   * `/dsh-bot` path, an explicit `recordDispatcherClass` call — must never
   * downgrade a team leader and unlock `spawn_dispatcher` for it.
   *
   * Both the public seam and the resume path write through here.
   */
  function recordDispatcherClassValue(
    sessionId: string,
    origin: DispatcherOrigin,
  ): void {
    if (dispatcherClasses.get(sessionId) === "spawned") return;
    dispatcherClasses.set(sessionId, origin);
  }

  /**
   * Ticket 147: re-activate a USER-STARTED dispatcher whose chat the host has
   * resumed after a restart.
   *
   * The identity is the durable `sessionKind` projection, never a guess: it
   * folds the session's own `/dsh-bot` command pair out of its persisted log
   * (`sessionKindOf`, fail-closed) and is the same value the sidebar renders
   * as a dispatcher glyph. A session whose projection says anything else — a
   * normal chat, a worker, a session the fold never saw — is left alone, and
   * so is every session while no registry answers.
   *
   * Why here rather than in the plugin: the listener is the one seam that
   * hands us the live Agent at the moment its scope can still take
   * registrations, and it is synchronous, so the activation lands before the
   * resumed chat's first request builds its tool list. That is exactly what
   * stops the host's "10 removed" notice: the previous request's header named
   * the dispatcher surface, and the surface must exist again by the next one.
   *
   * Deduplication is by session id (`resumedUserDispatchers`), because a host
   * may announce a session more than once and `onActivated` would otherwise
   * run twice; the plugin's own activation path is idempotent as well, so both
   * layers agree.
   *
   * A generation-1 dispatcher carries no `dispatcher_sessions` mark by design
   * (`durable-marker.ts` `parseDispatcherMark` rejects generation 1), so the
   * projection is the ONLY durable signal for this case — it is the primary
   * route, not a fallback.
   */
  function resumeUserStartedDispatcher(
    session: unknown,
    agent: AgentLike,
    sessionId: string,
  ): void {
    // ADR-0032 defect fix: a wake a peer send parked for this id must be
    // discharged on EVERY exit, not only on the activation path. A host with
    // no activation hook (or a session whose durable kind cannot be answered)
    // otherwise dropped the obligation forever. The session is live either
    // way, so opening its turn is honest delivery — not a fake activation.
    if (onUserDispatcherResumed === undefined) {
      flushPendingWakeTurn(sessionId, agent);
      return;
    }
    // Ticket 177: guarded exactly like `readDispatcherClass` — a throwing or
    // absent plugin reader answers "not a dispatcher", never an escaping
    // throw out of the host listener.
    if (readSessionKind(sessionKindOfSession, session) !== "dispatcher") {
      flushPendingWakeTurn(sessionId, agent);
      return;
    }
    // Ticket 177: ADR-0032 made a summoned dispatcher top-level, so IT also
    // arrives here — the branch name is historical and this is the seam where
    // ticket 173's "the class falls back to chief-of-staff after a restart"
    // limitation is closed. The class comes from the same durable projection
    // the glyph reads; when that projection cannot settle an answer, the
    // durable mark is the fallback — NEVER the `"user"` default, which would
    // silently let a summoned team leader summon again.
    const origin: DispatcherOrigin =
      readDispatcherClass(dispatcherClassOfSession, session) ??
      dispatcherClassForSummon(sessionId);
    // Ticket 176: record the class before activating, through the one
    // no-downgrade write path. `"spawned"` here is a summoned dispatcher
    // resuming top-level (ADR-0032), and it keeps the no-summon rule across a
    // restart — the durable `dispatcher_sessions` row is what makes the
    // projection answer `"spawned"` at all.
    recordDispatcherClassValue(sessionId, origin);
    if (!resumedUserDispatchers.has(sessionId)) {
      resumedUserDispatchers.add(sessionId);
      try {
        onUserDispatcherResumed(agent, sessionId, origin);
      } catch (error) {
        // The agent is already live; a failed activation must not turn the
        // host's resume into an error. The id stays recorded so a second
        // announcement does not retry a path that just threw.
        try {
          console.warn(
            `[multitask-dispatcher] resumed dispatcher ${sessionId} could not be re-activated:`,
            error,
          );
        } catch {
          // A broken console must not break the create path either.
        }
      }
    }
    // ADR-0032: a summoned dispatcher is a TOP-LEVEL session, so its cold
    // resume lands in the parentless branch and never reaches
    // `activateSummonedDispatcher`. Without this the wake a send parked
    // (`openWakeTurn` → `pendingWakeTurns`) would be dropped forever. Same
    // order as the parented sites (ticket 138): the flush is LAST, after the
    // hook above mounted the tool surface and applied the policy, so the
    // drained turn's first request already has both. A repeat announcement
    // still discharges a wake parked since the last one.
    flushPendingWakeTurn(sessionId, agent);
  }

  /**
   * Worker composition for a child we are about to publish, plus (ticket
   * 118) dispatcher activation for a child WE reserved.
   *
   * `agent/created` is the last moment a child's own scope can take
   * registrations before its first turn: the loop holds queued input until
   * every serial listener returns. Registering here — rather than through a
   * named Agent Preset — keeps the composition identical on every boot route
   * and needs no preset registry.
   *
   * Dispatcher child vs worker child is decided by IDENTITY (the reserved
   * `childId`), never by the per-parent `pendingSpawns` counter: the counter
   * cannot tell two concurrently spawned children of one parent apart, so a
   * dispatcher spawn racing a worker spawn used to be composable as a worker
   * (chunk 1's recorded limit). With the reservation, the dispatcher child is
   * matched by id and returns before the counter is even read.
   *
   * Ticket 130: BEFORE the reservation is consulted, the child's durable
   * dispatcher mark is read. A child that was spawned as a dispatcher in an
   * earlier process carries no reservation and no activation record here, and
   * without this check it would fall through to the worker path (or to
   * nothing) and degrade to a plain subagent.
   */
  const offAgentCreated = ctx.on("agent/created", (payload: never) => {
    const record = payload as {
      agent?: {
        session?: {
          header?: { parentSession?: unknown; delegationDepth?: unknown };
          id?: unknown;
        };
        ctx?: unknown;
      };
    };
    const child = record.agent;
    if (child === undefined) return;
    const parentSessionId = String(child.session?.header?.parentSession ?? "");
    const childSessionId = String(child.session?.id ?? "");
    if (childSessionId !== "") {
      // Defect fix (a resume stranded forever): the session has been
      // announced, so a resume marker for it has done its job. Clearing HERE
      // — a lifecycle event, not every send — means a failed cold resume
      // cannot block every later attempt, while a second send before the
      // announcement still reuses the one in flight.
      resumeRequested.delete(childSessionId);
    }
    if (parentSessionId === "") {
      // Ticket 147: a session with NO parent is never a subagent, so none of
      // the child paths below apply — but it CAN be a user-started dispatcher
      // the host just resumed, whose live activation died with the process.
      // The durable projection is the only authority here; a normal chat, a
      // worker, or a session whose kind cannot be read stays dormant.
      if (childSessionId !== "") {
        const depth = child.session?.header?.delegationDepth;
        // A top-level session has no parent and depth 0 (absent means 0, the
        // same reading `isTopLevel` uses). Anything else is not a chat the
        // user could have run `/dsh-bot` in.
        if (depth === undefined || depth === null || Number(depth) === 0) {
          resumeUserStartedDispatcher(
            child.session,
            child as AgentLike,
            childSessionId,
          );
        }
      }
      return;
    }
    // Ticket 130: durable identity first — a resumed dispatcher is matched by
    // its mark, not by anything this process remembers.
    if (childSessionId !== "") {
      resumeMarkedDispatcher(child as AgentLike, childSessionId);
    }
    if (
      childSessionId !== "" &&
      (reservedDispatcherIds.has(childSessionId) ||
        // DURABLE classification: the mark mirror is seeded before the create
        // and written after it, so it answers for an announcement that lands
        // after the reservation is gone. `dispatcherActivations` is only the
        // per-activation dedupe and must never classify an id.
        dispatcherMarks.has(childSessionId))
    ) {
      // Ticket 118: the child of our `spawnDispatcher` call — a dispatcher
      // peer, never a worker. No composition, no barrier, no registry entry.
      activateSummonedDispatcher(child as AgentLike, childSessionId);
      return;
    }
    // Ticket 142: a WORKER this plugin spawned. A live in-process spawn is
    // already registered (its id was reserved before `startActivation`), so
    // this only does real work for a session the host re-created after a
    // restart — the wake-on-send case. It must run BEFORE the
    // `pendingSpawns` guard: a resumed worker has no in-flight spawn, and the
    // guard would drop it. The mirror consult is synchronous, so a worker
    // THIS process knows about is adopted (and the listener returns) before
    // the guard; a store fallback runs asynchronously and the guard below
    // simply sees no pending spawn, which is also correct.
    if (childSessionId !== "") {
      const adopted = reattachMarkedWorker(child as AgentLike, childSessionId);
      // Only a session THIS branch adopted returns here — it composed the
      // child itself. A normal in-process spawn is already registered (its id
      // was reserved) and must fall through to the pendingSpawns path below,
      // which is what composes it.
      if (adopted) return;
    }
    if (workerAgentDef === undefined) return;
    if ((pendingSpawns.get(parentSessionId) ?? 0) === 0) return;
    if (typeof child.ctx !== "object" || child.ctx === null) return;
    // Second-round audit: this listener is SYNCHRONOUS and runs inside the
    // host's create call. A section/tool registration throw must not reject
    // child creation (the child already exists), so it is logged exactly like
    // the resume path's composition failure. The surface stays inherited; the
    // spawn still succeeds.
    try {
      applyWorkerComposition(
        child.ctx as Parameters<typeof applyWorkerComposition>[0],
        workerAgentDef,
        child,
        // The mid-task reply channel (ticket 122). Registered on the child's
        // own scope, so the dispatcher's surface never lists it.
        buildWorkerLocalTools(child.session?.id),
      );
    } catch (error) {
      try {
        console.warn(
          `[multitask-dispatcher] worker ${childSessionId} could not be composed; it keeps its inherited surface:`,
          error,
        );
      } catch {
        // A broken console must not break the create path either.
      }
    }
  });

  /**
   * Ticket 163 defect 3: an activation ends when its agent is disposed, so the
   * "already re-activated this session" record must end with it.
   *
   * The guard exists to deduplicate repeat ANNOUNCEMENTS of one live session.
   * Kept past disposal it silently suppressed a legitimate re-activation: the
   * session was re-announced in the same process, `resumeUserStartedDispatcher`
   * saw its id still in the set, and the early return left the session with no
   * scoped tools and no policy. It also grew for the process lifetime.
   *
   * `pendingWakeTurns` is deliberately NOT cleared here: a wake parked for this
   * id is a delivery obligation to the session, and the next announcement
   * discharges it (that is what `flushPendingWakeTurn` is for). Only the
   * deduplication record is per-activation.
   */
  const offAgentDisposed = ctx.on("agent/disposed", (payload: never) => {
    const record = payload as {
      agent?: { session?: { id?: unknown } };
    } | null;
    const disposedAgent = record?.agent;
    const sessionId = disposedAgent?.session?.id;
    if (sessionId === undefined || sessionId === null) return;
    const id = String(sessionId);
    // SECOND-ROUND AUDIT (identity-blind pruning): a re-adopted session can
    // be announced BEFORE a stale disposal event for its PREVIOUS Agent
    // arrives. Pruning or disposing the new activation then would kill a live
    // worker/dispatcher. Only act when the disposed object still answers this
    // id — or when no live agent answers at all (the ordinary dispose).
    const current = liveAgentOf(id);
    if (
      current !== undefined &&
      disposedAgent !== undefined &&
      current !== disposedAgent
    ) {
      return;
    }
    // Per-activation dispatcher dedupe ends with the activation. Kept past
    // disposal it silently suppressed a legitimate re-activation (the
    // re-announced session came back without parent binding, tools or
    // policy).
    dispatcherActivations.delete(id);
    resumedUserDispatchers.delete(id);
    // Defect fix (a resume stranded forever): a cold resume that never reached
    // an activation (kind projection unresolved, activation early-return) left
    // this flag set for the process lifetime. The session is gone now, so the
    // next send may ask again.
    resumeRequested.delete(id);
    // Defect fix (leaked per-worker state): a disposed worker agent's live
    // entries go with it. The wake identity (`workerSessions`), the tombstone
    // and the settle record stay elsewhere, so a later dormancy wake can still
    // resolve its spawner.
    const activation = workerActivations.get(id);
    workerActivations.delete(id);
    spawnControllers.delete(id);
    workers.delete(id);
    if (activation !== undefined) {
      void Promise.resolve(activation.dispose()).catch((error) => {
        try {
          console.warn(
            `[multitask-dispatcher] disposed worker ${id} could not be released:`,
            error,
          );
        } catch {
          // A broken console must not break the dispose path either.
        }
      });
    }
  });

  const host: CordisDshHost = {
    bindParent(agent: AgentLike, sessionId: string): void {
      parents.set(sessionId, agent);
      // Ticket 142 (second-round audit): a correction parked while this
      // spawner was NOT bound has no sender until now. Binding the spawner is
      // exactly the moment it becomes deliverable, so discharge every parked
      // worker wake recorded against this session here — the activation hook
      // is not guaranteed to announce those workers again.
      for (const workerId of [...parkedWorkerWakes.keys()]) {
        const entry = workers.get(workerId);
        const parentSessionId =
          entry?.parentSessionId ?? workerSessions.get(workerId);
        if (parentSessionId === sessionId) {
          deliverParkedWorkerWake(workerId);
        }
      }
    },

    unbindParent(sessionId?: string): void {
      if (sessionId === undefined) {
        parents.clear();
        // Ticket 155: a deactivated dispatcher has no current tool, and the
        // peer input map is keyed by the same live-parent fact.
        peerToolCalls.clear();
        return;
      }
      parents.delete(sessionId);
      peerToolCalls.delete(sessionId);
    },

    hasParent(): boolean {
      return parents.size > 0;
    },

    parentAgentOf(sessionId: string): AgentLike | undefined {
      return parents.get(sessionId);
    },

    get markers(): DurabilityPort | undefined {
      return markers;
    },

    isDurablyMarkedDispatcher(sessionId: string): boolean {
      return dispatcherMarks.has(sessionId);
    },

    recordDispatcherClass(sessionId: string, origin: DispatcherOrigin): void {
      // Ticket 176: never downgrade a known `"spawned"` to `"user"` — one
      // write path for every caller, including the cold-resume class route.
      recordDispatcherClassValue(sessionId, origin);
    },

    dispatcherMarkAnswer(
      sessionId: string,
    ): "dispatcher" | "not-dispatcher" | "unknown" {
      // Ticket 140 review fix: the projection unit's `init`/`apply` asks THIS.
      // Fast path: the in-memory mirror, which carries the spawn-time seed
      // (so a child is answered before its durable row exists) and every mark
      // warmed at boot. When the mirror does not know the id, the durable
      // table answers — that is the cold case this fix is for (a resumed
      // child at boot, before the plugin's activation-time warm-up ran). An
      // unopened store answers "unknown", which the unit records as
      // unresolved instead of caching a wrong "not a dispatcher".
      if (dispatcherMarks.has(sessionId)) return "dispatcher";
      const store = markers;
      if (store === undefined) {
        // No durable store at all: nothing was ever persisted, so the mirror
        // is the whole authority and its absence IS definitive.
        return "not-dispatcher";
      }
      if (store.peekDispatcherMark === undefined) {
        // A store exists but cannot be peeked synchronously (an older
        // implementation, or a test double). Rows from a previous process
        // would be invisible, so absence proves nothing.
        return "unknown";
      }
      try {
        return store.peekDispatcherMark(sessionId).kind;
      } catch {
        return "unknown";
      }
    },

    async refreshDispatcherMarks(): Promise<void> {
      const store = markers;
      if (store === undefined || store.listDispatcherMarks === undefined) {
        return;
      }
      try {
        const marks = await store.listDispatcherMarks();
        for (const mark of marks) {
          // A row written in this process may be richer than the store's
          // copy; never downgrade a known parent to `undefined`.
          if (!dispatcherMarks.has(mark.sessionId)) {
            dispatcherMarks.set(mark.sessionId, mark.parentSessionId);
          }
          // Ticket 141: same rule for the generation — an in-process value
          // (from the reserved-id seed or a spawn) is authoritative, so the
          // store only fills the gap. A pre-141 row reads as generation 2.
          if (!dispatcherGenerations.has(mark.sessionId)) {
            dispatcherGenerations.set(mark.sessionId, mark.generation ?? 2);
          }
          // Ticket 285: same rule for the leader worker default — an
          // in-process value (a spawn in THIS process) is authoritative, so
          // the store only fills the gap. A pre-285 row fills nothing, and
          // its workers inherit the leader's own route (plan §4.4).
          if (!workerModelDefaults.has(mark.sessionId)) {
            const restoredDefault = usableRoute(mark.workerModel);
            if (restoredDefault !== undefined) {
              workerModelDefaults.set(mark.sessionId, restoredDefault);
            }
          }
        }
      } catch (error) {
        // A marker-store failure must never turn an activation or a send into
        // a refusal; the mirror simply stays as it was.
        try {
          console.warn(
            "[multitask-dispatcher] dispatcher marks could not be read:",
            error,
          );
        } catch {
          // A broken console must not break the host either.
        }
      }
    },

    workerSessionMark(
      workerId: string,
    ): { readonly parentSessionId: string } | undefined {
      const parentSessionId = workerSessions.get(workerId);
      return parentSessionId === undefined ? undefined : { parentSessionId };
    },

    async refreshWorkerSessionMarks(): Promise<void> {
      const store = markers;
      if (store === undefined || store.listWorkerSessions === undefined) {
        return;
      }
      try {
        const rows = await store.listWorkerSessions();
        // Defect fix (a settled worker was woken back): `worker_sessions` rows
        // are deleted on settle/stop, but the delete is async and best-effort.
        // A surviving row re-armed this mirror and made the worker wake-able
        // again. Skip every row with a terminal tombstone — the in-process
        // settle set, or a terminal snapshot in the durable worker-marker
        // table (the crash case, where the process-local set is gone).
        const terminalByParent = await terminalWorkerIdsByParent(
          store,
          rows.map((row) => row.parentSessionId),
        );
        for (const row of rows) {
          if (settledWorkerIds.has(row.sessionId)) continue;
          if (
            terminalByParent.get(row.parentSessionId)?.has(row.sessionId) ===
            true
          ) {
            continue;
          }
          // Same discipline as the dispatcher mirror: an in-process write is
          // authoritative, so a store row never overrides it. A row ABSENT
          // from the store but present here is kept — the settle path that
          // deletes rows also drops the mirror entry, so a mirror-only entry
          // means a write whose delete has not been issued yet.
          if (!workerSessions.has(row.sessionId)) {
            workerSessions.set(row.sessionId, row.parentSessionId);
          }
        }
      } catch (error) {
        try {
          console.warn(
            "[multitask-dispatcher] worker session rows could not be read:",
            error,
          );
        } catch {
          // A broken console must not break the host either.
        }
      }
    },

    rememberWorkerWake(workerId: string, parentSessionId: string): void {
      workerSessions.set(workerId, parentSessionId);
    },

    forgetWorkerWake(workerId: string): void {
      // Defect fix (a settled worker was woken back): the core calls this on
      // every terminal outcome (settle, abort, hold release), so it is the
      // tombstone's one write point. A row whose async delete was lost must
      // never re-arm the mirror — `refreshWorkerSessionMarks` and
      // `reattachMarkedWorker` both consult this set.
      settledWorkerIds.add(workerId);
      spawnedWorkerIds.delete(workerId);
      workerSessions.delete(workerId);
      // A worker that is terminal or abandoned gets nothing delivered: the
      // parked slot is a delivery obligation to a session that no longer
      // exists.
      parkedWorkerWakes.delete(workerId);
      workerWakeDeliveries.delete(workerId);
      resumeRequested.delete(workerId);
    },

    async wakeDormantWorker(workerId: string, message: string): Promise<void> {
      requestDormantWorkerWake(workerId, message);
    },

    listLiveJobs(callerSessionId?: string): readonly JobSnapshotLike[] {
      // SECOND-ROUND AUDIT: read the service through `ctx.get("jobs")`, the
      // guarded route a live cordis context requires. A bare `ctx.jobs`
      // property read THROWS when the service was not injected; the guarded
      // `ctx.get` answer is the real one. The property remains only as the
      // fallback for a structural stub context that supplies it directly.
      let jobs: { list(callerSessionId?: unknown): readonly JobSnapshotLike[] } | undefined;
      if (typeof ctx.get === "function") {
        try {
          const service = ctx.get("jobs");
          if (
            typeof service === "object" &&
            service !== null &&
            typeof (service as { list?: unknown }).list === "function"
          ) {
            jobs = service as {
              list(callerSessionId?: unknown): readonly JobSnapshotLike[];
            };
          }
        } catch {
          // Absent/not injected: fall through to the declared seam.
        }
      }
      if (jobs === undefined) {
        try {
          jobs = ctx.jobs;
        } catch {
          return [];
        }
      }
      try {
        return jobs?.list(callerSessionId) ?? [];
      } catch {
        return [];
      }
    },

    workerIdOf(agentSessionId: string): string | undefined {
      return ownsSession(agentSessionId);
    },

    owns(workerId: string): boolean {
      return workers.has(workerId);
    },

    peerToolActivity(sessionId: string): PeerToolActivity | null {
      return peerToolCalls.get(sessionId) ?? null;
    },

    recentActivity(workerId: string): string | null {
      // Ticket 29: a settled worker has no live activity — null, never the
      // stale last phrase (the ring keeps it only for the wake digest).
      if (settledWorkerIds.has(workerId)) return null;
      return activityRing.latest(workerId)?.phrase ?? null;
    },

    /**
     * Ticket 61: host-clock ms of the last firehose-observed activity for an
     * owned worker — the observation moment of `recentActivity`'s phrase,
     * recorded at the same event arrival. Null when nothing has been
     * observed or the worker settled. Same subscription as
     * `recentActivity` — no new seam, no polling.
     */
    lastActivityAtMs(workerId: string): number | null {
      // Same settle gate as `recentActivity` — null once settled.
      if (settledWorkerIds.has(workerId)) return null;
      return activityRing.latest(workerId)?.atMs ?? null;
    },

    /**
     * Ticket 110: the bounded per-worker activity ring, newest-first — up
     * to `n` of the last firehose-observed phrases with their observation
     * moments, from the same `session/event` subscription as
     * `recentActivity` (no new seam, no polling, nothing persisted).
     * Retained through settle so the wake digest can show the final
     * breadcrumb (the single-entry accessors go null at settle); empty
     * once nothing has been observed; `n <= 0` yields an empty array.
     */
    recentActivities(
      workerId: string,
      n: number,
    ): readonly WorkerActivityEntry[] {
      return activityRing.recent(workerId, n);
    },

    /**
     * Ticket 75: subscribers hear every firehose-observed tool call on an
     * owned worker — the same observation moment the activity phrase is
     * recorded at. Fired from the ticket-29 `session/event` subscription.
     */
    onWorkerToolCall(cb: (workerId: string) => void): void {
      toolCallCallbacks.push(cb);
    },

    onDispatcherUserMessage(cb: (sessionId: string) => void): void {
      userMessageCallbacks.push(cb);
    },

    recentResult(workerId: string): RosterRecentResultSource | null {
      return workerResults.get(workerId) ?? null;
    },

    emitStepBoundary(workerId: string): void {
      for (const cb of [...stepBoundaryCallbacks]) {
        // A subscriber's delivery is asynchronous, and this host treats an
        // unhandled rejection as fatal. A failed steer is neither: it leaves a
        // worker that will settle through its normal path, so it is logged and
        // the process stays up.
        try {
          void Promise.resolve(cb(workerId)).catch((error) => {
            try {
              console.warn(
                `[multitask-dispatcher] step-boundary delivery for worker ${workerId} failed:`,
                error,
              );
            } catch {
              // A broken console must not break the host either.
            }
          });
        } catch (error) {
          try {
            console.warn(
              `[multitask-dispatcher] step-boundary callback for worker ${workerId} threw:`,
              error,
            );
          } catch {
            // A broken console must not break the host either.
          }
        }
      }
    },

    // Ticket 102b hardening: the adapter no longer implements the optional
    // `resolveCredential` seam. Its read was `(ctx as { credentials? }).credentials`
    // — a Cordis service declared in NEITHER `plugin.ts`'s `inject` nor
    // `AdapterContext`, behind a cast that hid it from the type system. The
    // resolver matches inject entries by EXACT STRING and throws at property
    // ACCESS, so this was a latent fuse: no caller existed, but the first
    // ticket to wire one would throw on an undeclared service while every
    // offline test stayed green. Deleted rather than declared, because
    // declaring `credentials` in `inject` would gate the whole plugin's apply
    // on a service it never uses, and ADR-0008 routes credentials through
    // `SpawnOptions.credentialNames` (resolved inside adapter/tools), not this
    // seam. The optional `DshHost` member stays for contract compatibility
    // (see `src/core/dsh-host.ts`); like `FakeDshHost`, the live adapter simply
    // does not provide it.

    async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
      // ADR-0019: the authority agent is the worker's OWN dispatcher session.
      const parent = parents.get(opts.parentSessionId);
      if (parent === undefined) {
        throw new Error(
          `CordisDshHost: no parent agent bound for session ${opts.parentSessionId}; cannot spawn before that dispatcher activation`,
        );
      }
      const controller = new AbortController();
      // Blank context is free with the in-process spawn provider.
      //
      // Ticket 55 (register D-1/D-2) — two channels, deliberately:
      //   - the worker CONTRACT and tool barrier are registered on the
      //     child's own scope at `agent/created` (see `offAgentCreated`). The
      //     contract lands in a system-prompt section recomputed every turn,
      //     so it cannot be compacted away and needs no per-steer restatement.
      //   - the TASK stays in `prompt`, i.e. the child's first user turn. That
      //     is what "blank conversation" means, and it matches the reference:
      //     blank conversation, not blank system prompt.
      // Ticket 83 (live pass 2026-09-19): `request.maxDepth` is the child's
      // ABSOLUTE delegation-depth ceiling, NOT the worker's leaf budget. The
      // host's `resolveChildDepth` computes `childDepth =
      // delegationDepthOf(parent) + 1` and throws `SubagentDepthError` when
      // `childDepth > maxDepth`, so shipping the leaf budget 0 in this slot
      // refused every live spawn ("subagent depth 1 exceeds maxDepth 0").
      // Derive the ceiling from the parent's real depth + one hop + the
      // worker's own budget. The `?? 0` fallback assumes the bound dispatcher
      // is top-level, which holds today because activation is isTopLevel-gated
      // (parent-agent.ts; the gate also fails open on an unreadable header);
      // multi-level nesting is deferred by ADR-0003 and would need a revisit
      // if a deeper parent is ever bound here.
      const parentDelegationDepth = parent.session.header?.delegationDepth ?? 0;
      const maxDepth = workerSpawnMaxDepth(
        parentDelegationDepth,
        workerAgentDef?.maxDepth ?? WORKER_MAX_DEPTH,
      );
      // Ticket 285 (plan §§3.3, 4.2, Task 9): the worker's route, highest
      // precedence first — an explicit spawn option, then the default this
      // leader was given when it was summoned (`workerModelDefaults`), then
      // nothing, which is today's inheritance through the host's own
      // child-option merge. `usableRoute` is the same defensive narrowing the
      // leader path uses: a route object with an empty provider/model is
      // treated as absent with one warning, never forwarded to a request that
      // would only fail on its first call. Catalog validation already
      // happened in the tool path; this is the last guard, not a second
      // resolver.
      const explicitWorker = usableRoute(opts.model);
      const storedDefault = usableRoute(
        workerModelDefaults.get(opts.parentSessionId),
      );
      const workerRoute = explicitWorker ?? storedDefault;
      const request: ActivationSpecLike["request"] = {
        prompt: textBlocks(prompt),
        parent,
        // Child's absolute ceiling: parent depth + 1 hop + leaf budget.
        maxDepth,
        // The key is omitted ENTIRELY when no route applies — an explicit
        // `agentOptions: undefined` would still be a property the host (and
        // every pinned test of this request's shape) can see.
        ...(workerRoute === undefined
          ? {}
          : {
              agentOptions: {
                provider: workerRoute.provider,
                model: workerRoute.model,
              },
            }),
      };
      // Ticket 120: RESERVE the child id before the spawn, exactly as
      // `spawnDispatcher` does (ticket 118) and for the same reason — the
      // child is already live inside `startActivation`.
      //
      // The host mints the id when the spec carries none, so a worker spawn
      // used to learn its own id only when `startActivation` RESOLVED. By
      // then the child had already emitted `agent/created` and its first
      // `agent/status: running`, and the plugin's status handler called
      // `workerIdOf(...)` on an id this host had not registered yet: it got
      // `undefined` and dropped the event. There is one `running` edge per
      // turn, so `multitask.noteTurnStarted` never ran and the worker FSM sat
      // at `spawned` for the whole first turn — `steer_worker`/`message_agent`
      // refused `not-running` and `check_workers` under-reported.
      //
      // Reserving the id fixes that at the right layer: this registry answers
      // `workerIdOf` and becomes TRUE (the child exists, under this exact
      // id) before the child can emit anything. Passed as `spec.childId`, so
      // the host either creates the child under this id or refuses the
      // spawn — no other id can ever come back.
      const reservedChildId = randomUUID();
      // Registered here, not after the await: `owns`/`workerIdOf` are what
      // the status and settle listeners consult, and the child is live the
      // moment `startActivation` is entered.
      workers.set(reservedChildId, {
        parentSessionId: opts.parentSessionId,
        agentSessionId: reservedChildId,
      });
      spawnedWorkerIds.add(reservedChildId);
      // Ticket 196: the controller must be reachable by dispose DURING the
      // await below, not only after the activation resolves. Re-key it to
      // `workerId` on success; delete it on every failure/second-id path.
      spawnControllers.set(reservedChildId, controller);
      // Mark the in-flight spawn BEFORE it starts: `agent/created` fires
      // inside `startActivation`, and that listener is what composes the child.
      pendingSpawns.set(
        opts.parentSessionId,
        (pendingSpawns.get(opts.parentSessionId) ?? 0) + 1,
      );
      let activation: ActivationLike;
      try {
        // The core registers its own record through this callback BEFORE the
        // child can emit its first status edge (ticket 120). Both registries
        // must be truthful at the same moment.
        opts.onWorkerId?.(reservedChildId);
        activation = await ctx.subagents.startActivation({
          provider: SPAWN_PROVIDER,
          label: opts.title,
          childId: reservedChildId,
          request,
          signal: controller.signal,
          delivery: "parent",
        });
      } catch (error) {
        // The spawn was refused or aborted before publication: no child
        // exists, so neither registry may keep the reservation.
        forgetSpawn(reservedChildId);
        throw error;
      } finally {
        const remaining = (pendingSpawns.get(opts.parentSessionId) ?? 1) - 1;
        if (remaining <= 0) pendingSpawns.delete(opts.parentSessionId);
        else pendingSpawns.set(opts.parentSessionId, remaining);
      }
      // workerId === child SessionId. Brand erased at the boundary.
      const workerId = String(activation.childId);
      // SECOND-ROUND AUDIT (post-settle re-insertion): the child can settle
      // DURING `startActivation`. `subagent/end` then pruned its live entries
      // and tombstoned the id; re-inserting here would resurrect a finished
      // worker for the life of the process. Release exactly this activation
      // instead (the settle path could not see it yet).
      if (settledWorkerIds.has(workerId)) {
        forgetSpawn(reservedChildId);
        if (workerId !== reservedChildId) forgetSpawn(workerId);
        void Promise.resolve(activation.dispose()).catch((error) => {
          try {
            console.warn(
              `[multitask-dispatcher] settled worker ${workerId} could not be released:`,
              error,
            );
          } catch {
            // A broken console must not break the spawn path either.
          }
        });
        return workerId;
      }
      if (disposed) {
        // Ticket 196: dispose() ran during the startActivation await. A
        // compliant startup already rejected on the aborted signal; one that
        // returns a receipt anyway must be released here, never registered
        // into maps that belong to the disposed host.
        forgetSpawn(reservedChildId);
        if (workerId !== reservedChildId) forgetSpawn(workerId);
        void Promise.resolve(activation.dispose()).catch((error) => {
          try {
            console.warn(
              `[multitask-dispatcher] late activation for worker ${workerId} could not be released:`,
              error,
            );
          } catch {
            // A broken console must not break the spawn path either.
          }
        });
        return workerId;
      }
      if (workerId !== reservedChildId) {
        // The host minted its own id despite the reservation. Keep the
        // registry truthful: move the entry, never leave the reservation
        // behind as a phantom worker.
        forgetSpawn(reservedChildId);
        spawnedWorkerIds.add(workerId);
        workers.set(workerId, {
          parentSessionId: opts.parentSessionId,
          agentSessionId: workerId,
        });
      }
      spawnControllers.set(workerId, controller);
      workerActivations.set(workerId, activation);
      return workerId;
    },

    /**
     * Ticket 285 (`.scratch/model-arg/PLAN.md` §§3.2–3.4): the host half of
     * the spawn model option. Everything syntax-specific lives in
     * `./model-option.js`; this wrapper supplies the three live things that
     * module cannot know:
     *
     * - the catalog, read through the guarded `ctx.get("llm")` seam (a bare
     *   property read throws on a context that never injected the service);
     * - the spawning session's provider for the bare-id tie-break, taken from
     *   its LIVE route first and `options` second — the same precedence
     *   `spawnDispatcher` uses when it inherits a route;
     * - the per-purpose fallback sentence, so the log line says what the spawn
     *   will actually do (plan §3.4).
     *
     * Never throws for a bad value: the resolver turns an unknown, ambiguous,
     * or unreadable route into `fallback` plus one warning, and the caller
     * spawns on the inherited default.
     */
    async resolveModelOption(
      raw: string,
      sessionId: string,
      purpose: ModelOptionPurpose,
    ): Promise<ModelOptionResolution> {
      const parent = parents.get(sessionId);
      const liveRoute = parent === undefined ? {} : liveSummonerRoute(parent);
      const preferredProvider =
        liveRoute.provider ?? parent?.options?.provider;
      const catalog = readLlmCatalog(ctx);
      const fallbackDescription =
        purpose === "leader"
          ? "the summoner's current route"
          : purpose === "worker"
            ? "the team leader's default worker route or its own route"
            : "the team leader's own route";
      return resolveModelOptionInCatalog({
        raw,
        purpose,
        sessionId,
        ...(preferredProvider === undefined ? {} : { preferredProvider }),
        ...(catalog === undefined ? {} : { catalog }),
        fallbackDescription,
        warn(message: string): void {
          try {
            console.warn(`[multitask-dispatcher] ${message}`);
          } catch {
            // A broken console must not break the spawn either.
          }
        },
      });
    },

    /**
     * ADR-0032 (owner ruling 2026-10-28; ticket 157): summon another
     * DISPATCHER as a NEW TOP-LEVEL SESSION PARALLEL to the summoner — not a
     * subagent child of it — then hand it to the ordinary activation path.
     *
     * ADR-0025 decision 6 said the host gives a summoned dispatcher no chat
     * surface and hides it from the sidebar; that is the clause the ruling
     * reverses. The mechanism is now `ctx.agents.create` +
     * `agent.followup` (the same call the host's own "new conversation"
     * makes), and ADR-0019's per-dispatcher scoping is what makes a parallel
     * session cheap.
     *
     * Three things are kept from the ticket-118 shape, all still load-bearing:
     * - the child id is RESERVED here and passed as the session id, so the
     *   `agent/created` listener recognises THIS spawn by identity instead of
     *   the per-parent `pendingSpawns` counter, which cannot tell two
     *   children of one parent apart.
     * - NO `pendingSpawns` bump and NO `workers` registry entry: the session
     *   is a peer, not a work stream, so the firehose/settle subscriptions
     *   ignore it. A top-level session is nobody's child, so it can never
     *   enter a child registry.
     * - the durable mark and `dispatcherGenerations` rows are written exactly
     *   as before; the generation is still spawner + 1 (ticket 141).
     *
     * What is deliberately GONE: `request.parent`, `delivery: "parent"`,
     * `provider: SPAWN_PROVIDER` and `maxDepth`. All four are
     * subagent-runtime fields. There is no spawn cap of ours (owner decision,
     * 2026-10-28) and `maxDepth`/the 8-slot root pool do not bound a
     * top-level session.
     *
     * Activation hook: `onDispatcherSpawned` now runs from the create `setup`
     * callback — awaited BEFORE publication, so the session's scoped tools and
     * policy exist before its `agent/created`, its `session/created` and its
     * first prompt assembly. The `agent/created` listener and the post-resolve
     * fallback remain for a host that resumes or re-announces the session, and
     * both deduplicate through the same helper.
     *
     * Host errors propagate unchanged; no wrapper, no invented refusal class.
     */
    async spawnDispatcher(
      opts: DispatcherSpawnOptions,
    ): Promise<DispatcherSpawnResult> {
      // Ticket 176 (owner ruling 2026-11-03): a dispatcher that another
      // dispatcher summoned is a TEAM LEADER for one job — it does not
      // summon. Its tool surface already omits `spawn_dispatcher`, so this is
      // the backstop for any other route into this method.
      //
      // Loud, not silent: a caller that gets here has hit a real wiring bug or
      // reached the host directly, and both deserve a named refusal the model
      // can act on (report to the parent; the parent summons). It is thrown as
      // a plain Error with this file's `CordisDshHost:` prefix rather than a
      // new error class, because nothing catches it by type.
      //
      // Not a depth cap and not a reversal of the 2026-10-28 "no cap of ours"
      // ruling: the tree has no count bound, it simply has one level.
      if (dispatcherClassForSummon(opts.parentSessionId) === "spawned") {
        throw new Error(
          `CordisDshHost: session ${opts.parentSessionId} is a dispatched team leader; it cannot summon another dispatcher. Report what is needed to the dispatcher that summoned it — that dispatcher spawns.`,
        );
      }
      // ADR-0019: the authority agent is the SPAWNING dispatcher's own
      // session, resolved exactly as `spawnWorker` does.
      const parent = parents.get(opts.parentSessionId);
      if (parent === undefined) {
        throw new Error(
          `CordisDshHost: no parent agent bound for session ${opts.parentSessionId}; cannot spawn a dispatcher before that dispatcher activation`,
        );
      }
      const controller = new AbortController();
      const signal = opts.signal ?? controller.signal;
      // ADR-0032: the summoned dispatcher is a TOP-LEVEL session parallel to
      // this one, so it inherits no delegation depth — `maxDepth` and the
      // host's 8-slot root pool are subagent-runtime bounds and do not apply
      // to it (no cap of ours, per the 2026-10-28 owner decision). The
      // summoner still supplies:
      // - `cwd`, because the host's cross-session route refuses a session
      //   whose header has none (`dsh-api-session-controller/lib/index.js:393`),
      //   which would leave the peer unreachable after a restart;
      // - the provider/model route, because `AgentOptions` is empty otherwise
      //   and the first turn would throw "no provider/model"
      //   (`dsh-agent-loop/lib/index.js:1197`). The subagent path inherited
      //   both through `resolveChildAgentOptions`; that edge is gone.
      const summonerCwd = parent.session.header?.cwd;
      // Ticket 163 defect 2: a summoned session with NO `cwd` can never be
      // cold-resumed (`resolveAgent` refuses a header that carries none, see
      // `dsh-api-session-controller/lib/index.js:393`), so creating it anyway
      // is a silent trap: the peer exists, answers, and is gone for good at
      // the next restart. There is no correct value to invent here — a
      // borrowed or guessed path would create the session in the WRONG
      // directory, which is worse than refusing — so this refuses loudly, with
      // the remedy named, before any session is created.
      if (typeof summonerCwd !== "string" || summonerCwd === "") {
        throw new Error(
          `CordisDshHost: session ${opts.parentSessionId} has no cwd, so a dispatcher summoned from it could never be cold-resumed (the host's cross-session route refuses a session without one). Nothing was created. Start the summoning chat in a directory and summon again.`,
        );
      }
      // Route inheritance (second-round audit): the LIVE selection wins over
      // the static options. A summoner that switched models in the UI has that
      // selection in `parent.model.current()` / the request header, while
      // `parent.options` may still describe the deployment default — copying
      // only the latter gave the peer a different route from its summoner.
      // `options` remains the fallback for a host that exposes neither, and
      // effort/maxTokens ride along whenever any source carries them.
      const optionsRoute = parent.options ?? {};
      const liveRoute = liveSummonerRoute(parent);
      const provider = liveRoute.provider ?? optionsRoute.provider;
      const model = liveRoute.model ?? optionsRoute.model;
      const reasoningEffort =
        liveRoute.reasoningEffort ?? optionsRoute.reasoningEffort;
      const maxTokens = liveRoute.maxTokens ?? optionsRoute.maxTokens;
      const agentOptions: AgentOptionsLike | undefined =
        typeof provider === "string" &&
        provider !== "" &&
        typeof model === "string" &&
        model !== ""
          ? {
              provider,
              model,
              ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
              ...(maxTokens !== undefined ? { maxTokens } : {}),
            }
          : undefined;
      // Ticket 285 (plan §1.5, Task 8): the optional leader route REPLACES the
      // inherited one, with one exception — naming the SAME provider/model is
      // not a model change, so the inherited object is kept whole and its
      // reasoningEffort/maxTokens still describe the model they belong to. A
      // genuine change builds a bare {provider, model}: the option carries no
      // tuning, and an effort chosen for the summoner's model may not exist on
      // the chosen one. A malformed route is absent (one warning inside
      // `usableRoute`) and the inherited route stands.
      const explicitLeader = usableRoute(opts.model);
      const leaderAgentOptions: AgentOptionsLike | undefined =
        explicitLeader === undefined
          ? agentOptions
          : agentOptions !== undefined &&
              agentOptions.provider === explicitLeader.provider &&
              agentOptions.model === explicitLeader.model
            ? agentOptions
            : {
                provider: explicitLeader.provider,
                model: explicitLeader.model,
              };
      // Ticket 118 chunk 3: the child id is still RESERVED here — identity is
      // what lets `agent/created` recognise the summoning session as ours
      // instead of falling through to the worker composition. It is passed as
      // `sessionId` below, so the host either creates the session under this
      // id or refuses; no other id can come back.
      const reservedChildId = randomUUID();
      /** The id the host actually gave the child, or null if it refused. */
      let spawnedId: string | null = null;
      /**
       * The id `setup` activated under when the host assigned its own session
       * id — cleaned up with the reservation if the create still fails.
       */
      let activationChildId: string | null = null;
      // DEFECT FIX (summoned session came up with no work tools): the child is
      // a TOP-LEVEL session, so it inherits nothing implicitly — the host only
      // registers a preset's work tools on a scope that JOINED that preset
      // (`dsh-agent-preset-registry/lib/index.js` `mount`/`bind`). Read the
      // summoner's joined preset HERE, before the create, so a registry/lookup
      // failure refuses the summon instead of producing a tool-less peer; the
      // mount itself has to happen inside `setup`, because that is the only
      // moment the child's own scope exists.
      //
      // Undefined (no roster, or a preset-free summoner) mounts nothing: that
      // is a valid composition, not an error — `readAgentPresets` says why.
      //
      // Defect fix: the live registry answers `null` for a preset-free
      // session, and `null` is NOT a preset id — written into `meta.agentPreset`
      // it makes the create throw "session header agentPreset must be a
      // string", and passed to `mount` it would join nothing. Normalize once,
      // here, so both consumers see the same `string | undefined`.
      const presetRegistry = readAgentPresets(ctx);
      /**
       * Second-round audit: the preset READ happens inside the guarded create
       * path below and is normalized there. A throwing registry read is "no
       * preset" (logged), never a raw error escaping the summon; a failed
       * MOUNT is the loud, named refusal.
       */
      let summonerPreset: string | undefined;
      // DEFECT FIX (a summoned session showed up under "Ungrouped" instead of
      // its summoner's project): read the Workspace that ACCOUNTS the
      // summoner HERE, before the create, so the peer can be filed under it the
      // moment it exists. Membership, not a cwd comparison — a Workspace owns
      // sessions through its ordered `sessionIds` account, and the sidebar
      // groups on exactly that list (`dsh-client-ui-workspace/lib/client.js:1027-1044`).
      //
      // Undefined when no registry is mounted OR when the summoner belongs to
      // no Workspace. Both file nothing: a session opened outside every project
      // has no workspace id to hand down, and there is none to invent — a peer
      // summoned from it stays ungrouped, which is the correct answer, not a
      // second defect.
      const summonerWorkspace = readWorkspaceOfSession(ctx, opts.parentSessionId);
      try {
        // Second-round audit: the preset READ belongs inside this guarded path
        // and is normalized. A throwing lookup means "this summoner joined no
        // readable preset" — the peer is still a valid session, so it is
        // logged and the summon proceeds without one. `null` is normalized the
        // same way (the live registry's "preset-free" answer is not an id).
        if (presetRegistry !== undefined) {
          try {
            summonerPreset =
              presetRegistry.presetForSession(parent.session) ?? undefined;
          } catch (error) {
            summonerPreset = undefined;
            try {
              console.warn(
                `[multitask-dispatcher] preset lookup for summoner ${opts.parentSessionId} failed; summoning without a preset:`,
                error,
              );
            } catch {
              // A broken console must not break the summon either.
            }
          }
        }
        // Every seed below is INSIDE the try (review fix): the generation
        // callback is plugin-supplied and can throw, and a seed written
        // outside the try would then outlive the failed spawn — a phantom
        // reservation / mark the `finally` never revisits.
        reservedDispatcherIds.add(reservedChildId);
        // Ticket 140 (review fix): seed the durable-mark MIRROR with the
        // reserved id BEFORE the create. The `sessionKind` projection unit's
        // `init` runs at `session/created`, inside that call, and reads this
        // source; the durable row is only written after the spawn resolves
        // (below), so an unseeded init would have nothing to read.
        dispatcherMarks.set(reservedChildId, opts.parentSessionId);
        // Ticket 141: the child is one generation past its spawner. A
        // user-started dispatcher is generation 1 (the option is absent for
        // every pre-141 caller), so a direct spawn is generation 2. Seeded
        // BEFORE the create: `agent/created` fires inside that call, and the
        // mark row — the other source of this number — is only written after
        // it resolves.
        //
        // Ticket 163 defect 1: the DURABLE MIRROR is consulted FIRST. The
        // ticket-141 seam (`dispatcherGenerationOf`) reads the PLUGIN's
        // lifecycle, and a summoned dispatcher that comes back through a
        // parentless cold resume is activated there without a generation —
        // `lifecycle.activate(agent, { origin })` defaults it to 1. Reading
        // only the lifecycle therefore recorded generation 2 for a summon made
        // by a generation-3 peer, where the durable row says 4. The mirror is
        // filled from that same row by `refreshDispatcherMarks`, and every
        // spawn in THIS process seeds it before its child exists, so it is at
        // least as authoritative as the lifecycle in both directions. The
        // seam stays as the fallback for a session the mirror does not know.
        const spawnerGeneration =
          dispatcherGenerations.get(opts.parentSessionId) ??
          dispatcherGenerationOf?.(opts.parentSessionId) ??
          1;
        const childGeneration = spawnerGeneration + 1;
        dispatcherGenerations.set(reservedChildId, childGeneration);
        // ADR-0032 — the whole fix. Create a real top-level session, the same
        // call the host's own "new conversation" makes
        // (`dsh-api-session-controller/lib/index.js:517-525`).
        //
        // THE TRAP: `parentAgent`, `meta.origin`, `meta.parentSession` and
        // `meta.delegationDepth` must ALL stay omitted, together. The host's
        // ownership guard is an OR (`origin === 'subagent'` OR `parentSession`
        // set AND its live parent owns the agent —
        // `dsh-api-session-controller/lib/index.js:128-134`), so passing a
        // parent "for convenience" silently re-classifies this session and
        // every ordinary route then refuses it with `session/agent-busy`.
        // `TopLevelSessionMetaLike` types the meta down to `cwd` so the
        // mistake cannot be written here at all.
        const create = ctx.agents.create;
        if (create === undefined) {
          throw new Error(
            "CordisDshHost: this host exposes no ctx.agents.create; cannot summon a parallel dispatcher session",
          );
        }
        const handle = await create.call(ctx.agents, {
          sessionId: reservedChildId,
          // DEFECT FIX (cold resume): record the preset the child joined, the
          // same way the host's own create route does
          // (`dsh-api-session-controller/lib/index.js:433-436`). The mount in
          // `setup` below only fixes THIS process; the header is what survives
          // a restart — `dsh-session` seeds it from this field
          // (`lib/index.js:1840`) and the resume composes from the resulting
          // `agentPreset` projection
          // (`dsh-agent-preset-registry/lib/index.js:51`,
          // `dsh-api-session-controller/lib/index.js:305-308`). Omitted, the
          // peer comes back on the DEFAULT preset with a different tool
          // surface, which is the same defect one restart later.
          meta: {
            cwd: summonerCwd,
            ...(summonerPreset === undefined
              ? {}
              : { agentPreset: summonerPreset }),
          },
          ...(leaderAgentOptions === undefined
            ? {}
            : { agentOptions: leaderAgentOptions }),
          setup: async (agentCtx, agent) => {
            // ADR-0019: the child's own scope takes its scoped tools and
            // policy HERE rather than from `agent/created`. ORDER: `setup`
            // runs AFTER `session/created` and is awaited BEFORE the child's
            // `agent/created` and first prompt, so nothing drives a
            // half-configured dispatcher. This is the same seam the host's own
            // session creation uses; it replaces the subagent composition the
            // old path inherited.
            //
            // DEFECT FIX (order matters): the summoner's preset is mounted
            // FIRST, before our dispatcher surface is registered on the same
            // scope. Two reasons, both load-bearing:
            // 1. the preset's tools (`tool-fs`, `tool-pwsh`, `tool-web`, …)
            //    only exist on a scope that joined the preset, so a mount
            //    after activation would still leave the first prompt — and
            //    the surface snapshot taken at registration — tool-less;
            // 2. `withholdHostSpawnTools` runs inside the activation and reads
            //    the INHERITED surface, so it must already be able to see the
            //    preset's `subagent`/`subagent_fork` verbs to remove them.
            // A mount failure refuses the summon: a peer without its preset
            // has no filesystem, shell or web tools at all, and publishing
            // that session would be the worse failure. Second-round audit:
            // surface a NAMED refusal (this file's prefix + the preset id +
            // the underlying message), never the raw registry error.
            if (presetRegistry !== undefined && summonerPreset !== undefined) {
              try {
                await presetRegistry.mount(agentCtx, summonerPreset);
              } catch (error) {
                const detail =
                  error instanceof Error ? error.message : String(error);
                throw new Error(
                  `CordisDshHost: summoned dispatcher could not join agent preset "${summonerPreset}": ${detail}`,
                );
              }
            }
            // Ticket 118/140: the activation itself still runs through the
            // single deduplicated helper. `setup` COMPOSES, never drives, so
            // the parked-wake discharge is deferred to the caller below and
            // the first turn is opened after creation resolves.
            //
            // Defect fix (activate under the CREATED id): the session `setup`
            // is handed is the one the host actually created. A reservation
            // normally IS that id, but if the host assigns its own the
            // activation and the mark must follow the live agent, not the
            // stale reservation.
            //
            // Ticket 159: `opts.title` rides THIS call. The label and the
            // session it belongs to travel together and no queue can pair
            // them wrongly.
            const activationId = String(agent.session?.id ?? reservedChildId);
            activationChildId = activationId;
            if (activationId !== reservedChildId) {
              dispatcherMarks.set(activationId, opts.parentSessionId);
              dispatcherGenerations.set(activationId, childGeneration);
            }
            activateSummonedDispatcher(
              agent,
              activationId,
              childGeneration,
              false,
              opts.title,
            );
          },
          ...(signal === undefined ? {} : { signal }),
        });
        // The session id IS the dispatcher identity the activation path binds.
        // `create` was handed the reservation, so this is normally the same
        // string; erased at the boundary for the same reason as before.
        //
        // Defect fix (activate under the CREATED id): a host that assigns its
        // own id is a contract violation — `setup` already activated under the
        // agent's own id, and the result/mark must agree with it. Fail LOUDLY
        // but keep the spawn: the child exists, and reporting `host-refused`
        // for a live session is the very misreport this fix removes.
        const createdId = handle.agent.session?.id;
        const dispatcherId =
          createdId === undefined || createdId === null || String(createdId) === ""
            ? reservedChildId
            : String(createdId);
        if (dispatcherId !== reservedChildId) {
          try {
            console.warn(
              `[multitask-dispatcher] host created session ${dispatcherId} instead of the reserved id ${reservedChildId}; the dispatcher continues under the host-assigned id`,
            );
          } catch {
            // A broken console must not break the spawn either.
          }
        }
        spawnedId = dispatcherId;
        // Ticket 130: the child is durable from here on. Written IMMEDIATELY
        // after the create and BEFORE the first `followup` (defect fix), so a
        // crash between the two cannot lose the identity of a session that
        // already exists. Never deleted: deactivation also runs on plugin
        // unload, so a delete would wipe every mark at each restart. The table
        // grows; accepted. A marker-store failure is logged and swallowed —
        // the host already accepted the spawn, so it must never read as a host
        // refusal. Ticket 141: the row carries the generation, so a
        // cold-resumed child comes back with the same number.
        // SECOND-ROUND AUDIT (first-turn ordering): the mark write stays
        // BEFORE the first turn for crash safety, but it is BOUNDED. The
        // in-memory mirror is already updated synchronously inside
        // `writeDispatcherMark`, so a stalled store only delays durability —
        // it must never delay the turn forever.
        await boundedBookkeeping(
          writeDispatcherMark(
            dispatcherId,
            opts.parentSessionId,
            childGeneration,
            // Ticket 285: the worker default rides the same durable row, so
            // a cold-resumed leader restores it (refreshDispatcherMarks).
            opts.workerModel,
          ),
          `dispatcher mark for ${dispatcherId}`,
        );
        // DEFECT FIX (a summoned session landed under "Ungrouped"): file the
        // peer under its summoner's project NOW, in this process, so the
        // sidebar draws it in that group the first time it appears.
        //
        // `create` above writes `meta.cwd` and nothing else — `CreateAgentOptions`
        // has no workspace field at all (`dsh-agent/lib/types/index.d.ts:49-83`)
        // — so a peer created here is unaccounted until the registry's next
        // STARTUP re-buckets sessions by canonical cwd
        // (`dsh-workspace/lib/index.js:758-813`). That one-restart delay is the
        // whole defect.
        //
        // `attachSession` is the write the host's own create route makes for a
        // session it starts inside a Workspace
        // (`dsh-api-session-controller/lib/index.js:686-693`), and it validates
        // the child's STORED cwd against the workspace path before writing
        // (`dsh-workspace/lib/index.js:113-122`), so a peer cannot be filed
        // under a project it is not actually in.
        //
        // Before `followup`, deliberately: a blank session is hidden from the
        // sidebar until its first turn lands (see the note on `followup`
        // below), so filing first is what makes the group correct at first
        // paint rather than a repaint later.
        //
        // A failure is logged and swallowed, exactly like the dispatcher-mark
        // write below: the host already accepted the spawn and the session is
        // live, so a bookkeeping problem must never read as a host refusal. The
        // peer keeps working, ungrouped.
        if (summonerWorkspace !== undefined) {
          // Same bound as the mark write: a stalled workspace write must not
          // suppress the first turn.
          await boundedBookkeeping(
            Promise.resolve()
              .then(() => summonerWorkspace.attachSession(dispatcherId))
              .catch((error: unknown) => {
                try {
                  console.warn(
                    `[multitask-dispatcher] summoned session ${dispatcherId} could not be filed under its summoner's workspace:`,
                    error,
                  );
                } catch {
                  // A broken console must not break the spawn either.
                }
              }),
            `workspace attach for ${dispatcherId}`,
          );
        }
        // Name the child through the host's NATIVE title store — an explicit
        // rename, not model auto-naming. Before `followup`, deliberately: a
        // blank session is hidden from the sidebar until its first turn lands,
        // so naming first means the row already carries this title at first
        // paint. Naming is bookkeeping; a failure here must never fail the
        // spawn.
        nameSummonedDispatcher(
          readSessionTitle(ctx),
          handle.agent.session,
          opts.title,
        );
        // The handoff prompt is the summoned dispatcher's FIRST user turn.
        // `followup` is the only call that both queues a whole turn and wakes
        // the driver (`dsh-agent-loop/lib/index.js:806-808`) — creating the
        // session alone leaves it blank, and a blank session is hidden from
        // the sidebar until its first turn lands. The message carries a
        // producer-owned source kind because session format v4 rejects an
        // empty/`plugin` wrapper (`dsh-session-format-v3-to-v4/lib/index.js:126`).
        //
        // The summoner's session id travels as the first line. A summoned
        // dispatcher is a TOP-LEVEL session (ADR-0032): it inherits no parent
        // session pointer, yet it must report progress and blockers UPWARD.
        // The team-leader policy and its wake steps name this exact line as
        // the upward address source (`src/core/policy/prompts.ts`), so the
        // line and the copy are one contract — the handoff line is the only
        // place the id is stated.
        //
        // Defect fix: a failure HERE is post-create. The child exists, so it is
        // logged and the call returns the created dispatcher — never surfaced
        // as `host-refused`, which would tell the model nothing started.
        const handoffPrompt = `${formatSummoningDispatcherHandoffLine(
          opts.parentSessionId,
        )}\n\n${opts.prompt}`;
        try {
          handle.agent.followup({
            id: `multitask-spawn-${randomUUID()}`,
            role: "user",
            content: textBlocks(handoffPrompt),
            source: { kind: WAKE_SOURCE_KIND },
          });
        } catch (error) {
          try {
            console.warn(
              `[multitask-dispatcher] summoned dispatcher ${dispatcherId} could not be given its first turn:`,
              error,
            );
          } catch {
            // A broken console must not break the spawn either.
          }
        }
        // Ticket 138: a wake a send parked before this session existed is
        // discharged NOW — after activation (`setup`) and after the first turn
        // is queued, so the resumed turn sees tools and policy.
        flushPendingWakeTurn(dispatcherId, handle.agent);
        // Bounded memory: the reservation is dropped in `finally`, and the
        // activation record stays so a LATE `agent/created` for this child is
        // still recognised as a dispatcher instead of falling through to the
        // worker composition.
        return { dispatcherId };
      } finally {
        reservedDispatcherIds.delete(reservedChildId);
        // SECOND-ROUND AUDIT (host-assigned-id cleanup): every per-id seed
        // must move or disappear TOGETHER. The old path deleted the reserved
        // MARK but left its GENERATION behind, and a generation >= 2 makes
        // `dispatcherClassForSummon` call the id a spawned team leader — a
        // phantom that refused a later summon from a session reusing that id.
        // Collect every id that did not become the live child (the
        // reservation, and any id `setup` activated under), then clear all
        // six seed maps for each.
        const phantomIds = new Set<string>([reservedChildId]);
        if (activationChildId !== null) phantomIds.add(activationChildId);
        if (spawnedId !== null) phantomIds.delete(spawnedId);
        for (const id of phantomIds) {
          dispatcherMarks.delete(id);
          dispatcherGenerations.delete(id);
          // Ticket 285: a worker default must never outlive a create that
          // produced no session — it would silently apply to a later spawn
          // that reuses the id.
          workerModelDefaults.delete(id);
          dispatcherClasses.delete(id);
          dispatcherActivations.delete(id);
          reservedDispatcherIds.delete(id);
        }
      }
    },

    async interruptWorker(workerId: string): Promise<void> {
      // ADR-0019: interrupt authority resolves from the worker's recorded
      // parent — one dispatcher's unbinding never strands another's worker.
      //
      // Defect fix (a silent success that stopped nothing): the core has
      // already committed `aborted` by the time it calls this, so returning
      // silently when the recorded parent is not bound claimed a stop that
      // never reached the host. Resolve the authority as the bound parent
      // first, then the host's live registry for the same session id (a
      // dispatcher whose binding was cleared but whose Agent is still live is
      // still the child's ancestor). With neither, THROW: the core catches and
      // reports the missing authority truthfully.
      const entry = workers.get(workerId);
      const parentSessionId =
        entry?.parentSessionId ?? workerSessions.get(workerId);
      const parent =
        parentSessionId === undefined
          ? undefined
          : (parents.get(parentSessionId) ?? liveAgentOf(parentSessionId));
      if (parent === undefined) {
        throw new Error(
          `CordisDshHost: no parent agent bound for worker ${workerId}; the interrupt was not issued`,
        );
      }
      // Fire-and-return: cancel signal issued before return.
      ctx.subagents.interrupt(workerId, {
        kind: "ancestor",
        agent: parent,
      });
    },

    async sendMessage(workerId: string, message: string): Promise<void> {
      // ADR-0032's cross-session facade is for DISPATCHER PEERS, which are
      // top-level sessions. A worker is still a subagent child (ADR-0003): its
      // header carries `origin: "subagent"` and `parentSession`, so the host's
      // ordinary session route refuses it by design
      // (`hasApiSessionSubagentOwner`, `dsh-api-session-controller/lib/index.js`
      // `:128-134`) with `session/agent-busy` — "use subagent delivery for this
      // child session". Subagent delivery is therefore the ONLY route that can
      // reach a worker, and it also cold-resumes an absent direct child
      // (`dsh-subagent/lib/types/index.d.ts:151-168`).
      //
      // ADR-0019: delivery authority resolves from the worker's recorded
      // parent — the answer reaches the worker through ITS dispatcher.
      //
      // Defect fix (disposal pruned the registry entry): an agent disposal
      // removes the live `workers` entry, so the parent id also reads from the
      // durable wake mirror — a dormant worker must stay reachable.
      const entry = workers.get(workerId);
      const parentSessionId =
        entry?.parentSessionId ?? workerSessions.get(workerId);
      const parent =
        parentSessionId === undefined
          ? undefined
          : parents.get(parentSessionId);
      if (parent === undefined) {
        throw new Error("CordisDshHost: no parent agent bound; cannot send");
      }
      const controller = new AbortController();
      await ctx.subagents.sendMessage(parent, workerId, textBlocks(message), {
        signal: controller.signal,
      });
    },

    onWorkerSettled(cb: (event: SettledEvent) => void): void {
      settledCallbacks.push(cb);
    },

    onStepBoundary(cb: (workerId: string) => void | Promise<void>): void {
      stepBoundaryCallbacks.push(cb);
    },

    /**
     * Ticket 116 / ADR-0025: `origin` is the optional structured source
     * override for a wake caused by another agent. Turn mechanics are
     * identical (`followup` + composed text); only the follow-up message's
     * `source` changes, from our producer-owned plugin kind to
     * `{kind:"agent-message", form:"relay", senderSessionId}`. The text
     * heading stays presentation only — nothing here derives origin from
     * it.
     */
    async requestDispatcherWakeup(
      sessionId: string,
      origin?: AgentMessageWakeOrigin,
    ): Promise<void> {
      openWakeTurn(sessionId, origin);
    },

    /**
     * Soft fallback (ticket 14): the local install has no public mid-turn
     * cancel for a dispatcher Agent. Priority already became the ready
     * wake on the bus; the running non-user turn ends and the next flush
     * delivers it. Recorded as a no-op so the seam stays honest.
     */
    async requestDispatcherInterrupt(_sessionId: string): Promise<void> {
      return;
    },

    dispose(): void {
      // Ticket 196: publish the terminal state BEFORE releasing anything, so
      // a spawn continuation that is already queued sees it. The controller
      // for a pre-publication spawn is in `spawnControllers` from before its
      // await, so the loop below aborts its startup signal.
      disposed = true;
      offSubagentEnd();
      offSessionEvent();
      offAgentCreated();
      offAgentDisposed();
      pendingSpawns.clear();
      reservedDispatcherIds.clear();
      dispatcherActivations.clear();
      dispatcherMarks.clear();
      dispatcherGenerations.clear();
      resumeRequested.clear();
      resumeShortCircuitLogged.clear();
      resumedUserDispatchers.clear();
      pendingWakeTurns.clear();
      workerSessions.clear();
      parkedWorkerWakes.clear();
      workerWakeDeliveries.clear();
      // Abort covers spawns still pre-publication; a published worker ignores
      // its start signal, so it is released through its activation instead.
      for (const controller of spawnControllers.values()) {
        controller.abort();
      }
      spawnControllers.clear();
      const activations = [...workerActivations.values()];
      workerActivations.clear();
      void Promise.allSettled(activations.map((a) => a.dispose()));
      workers.clear();
      spawnedWorkerIds.clear();
      activityRing.clearAll();
      settledWorkerIds.clear();
      workerResults.clear();
      peerToolCalls.clear();
      settledCallbacks.length = 0;
      stepBoundaryCallbacks.length = 0;
      toolCallCallbacks.length = 0;
      userMessageCallbacks.length = 0;
      parents.clear();
    },
  };

  return host;
}
