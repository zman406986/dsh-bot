/**
 * Ticket 118 chunk 3 — the ACTIVATION PATH that makes a spawned child an
 * actual dispatcher (ADR-0025 mitosis; ADR-0019 per-dispatcher scoped tools;
 * ADR-0027 identity).
 *
 * Offline only (S8): fake AdapterContext seams (a per-agent SCOPED tool
 * surface for every test agent, a listener bus, a storage stub) driving the
 * real plugin `apply()`, the real `CordisDshHost`, and the real Multitask
 * core. No network, no LLM, no running dsh.
 *
 * ADR-0032 (owner ruling 2026-10-28): the summon is a NEW TOP-LEVEL SESSION
 * parallel to its summoner, NOT a subagent child. The host seam under test is
 * now `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup,
 * signal })` followed by `handle.agent.followup(...)`. There is no
 * `subagents.startActivation` on this path, no `request.parent`, no
 * `delivery: "parent"` and no `maxDepth` — and `meta` admits only `cwd`, so
 * the parentless shape is the only one the type can express.
 *
 * Pinned here:
 * 1. `spawn_dispatcher` reaches `ctx.agents.create`; the host RESERVES the
 *    child id, passes it as `sessionId`, and the child is activated through
 *    the ORDINARY path from the create `setup` hook. `activate()` still
 *    refuses non-top-level agents for user chats.
 * 2. The child registers the dispatcher tool set on ITS OWN scope (not the
 *    creator's, not the global layer) and receives the dispatcher policy.
 * 3. `isDispatcherSession(child)` is true (observable through peer-send
 *    liveness), and the child spawns a worker under its own session through
 *    the stock `subagent` verb the preset mounts while keeping wake state
 *    separate.
 * 4. No recursion gate of ours: a dispatcher summoned by a dispatcher is
 *    admitted and is ITSELF parentless. The subagent depth rule stays where
 *    it belongs — on the worker hop, which still rides `startActivation`.
 * 5. Deactivating the child tears down its tool surface (ticket 115's
 *    `cancelWaits` rides the same path; the bounded-wait half of the old
 *    case has no model-facing surface left — see the case's own note).
 * 6. Identity, not a counter: a dispatcher spawn racing a worker spawn from
 *    the same parent composes the worker and activates the dispatcher. A
 *    summoned dispatcher never touches `pendingSpawns` at all now, so the
 *    race cannot mis-compose either child.
 * 7. Identity probe on the HOST's own facts: a parentless session carries no
 *    `origin: "subagent"`, no parent and no dispatcher preset — nothing in
 *    the host's vocabulary says "dispatcher" (that is OUR durable mark).
 * 8. Ticket 130: a spawned dispatcher carries our own durable mark, and a
 *    cold-resumed child is re-activated from it through the parentless
 *    `sessionKind` route — role, scoped surface, and policy — exactly once,
 *    while an unmarked child stays a plain subagent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_NOT_TOP_LEVEL,
  RESUME_WAKE_CUE,
  textBlocks,
  type ActivationSpecLike,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type SessionKindProjectionState,
  type SessionProjectionChildLike,
  type SessionProjectionDefinitionLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import type {
  CreateAgentOptionsLike,
  TopLevelSessionMetaLike,
} from "../src/adapter/cordis-dsh-host.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";

import { DISPATCHER_SESSION_TABLE_NAME, WORKER_SESSION_TABLE_NAME } from "../src/adapter/durable-marker.js";
import {
  DISPATCHER_TOOL_NAMES,
  SPAWN_DISPATCHER_TOOL,
} from "../src/core/policy/prompts.js";
import { workerSpawnMaxDepth } from "../src/worker/agent-def.js";
import { WORKER_PERSONA_SECTION } from "../src/worker/preset.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

/** Text of an injected plugin context message (policy / reminder). */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

interface ScopedTool {
  name: string;
  execute: (args: unknown, exec?: unknown) => Promise<unknown>;
}

/** A per-agent scoped tool registry, shaped like the live host's. */
type ScopedTools = ToolsLike & {
  names(): string[];
  get(name: string): ScopedTool | undefined;
  /**
   * The host's inherited-surface filter (dsh-tools `restrict`). Only a
   * session that inherits the stock preset gets one: worker children carry a
   * registration-only scope in this fake, and the worker barrier's stub-host
   * carve-out (`src/worker/preset.ts`) depends on `restrict` being absent
   * there.
   */
  restrict?(filter: { deny?: readonly string[] }): () => void;
};

function createScopedTools(restrictable: boolean): ScopedTools {
  const scoped = new Map<string, ScopedTool>();
  // Tools the preset mounted but this scope is told to hide. The host keeps
  // inherited definitions in place and filters them per scope; a disposer
  // lifts the filter (which is what activation teardown must do).
  const withheld = new Set<string>();
  const visible = (): string[] =>
    [...scoped.keys()].filter((name) => !withheld.has(name));
  const tools: ScopedTools = {
    schemas: () => visible().map((name) => ({ name })),
    register(definition: unknown) {
      const def = definition as ScopedTool;
      // Shipped rule (ticket 91): duplicates within one scope fail loud
      // (dsh-tools lib/index.js:2538, NamedEntries factory).
      if (scoped.has(def.name)) {
        throw new Error(
          `tool "${def.name}" is already registered (for a per-agent ` +
            `variant, register through that agent's \`agent.ctx\` instead)`,
        );
      }
      scoped.set(def.name, def);
      return () => {
        scoped.delete(def.name);
      };
    },
    names: () => visible(),
    get: (name: string) => (withheld.has(name) ? undefined : scoped.get(name)),
  };
  if (restrictable) {
    tools.restrict = (filter) => {
      const denied = (filter.deny ?? []).filter((name) => scoped.has(name));
      for (const name of denied) withheld.add(name);
      return () => {
        for (const name of denied) withheld.delete(name);
      };
    };
  }
  return tools;
}

interface ScopedAgent extends AgentLike {
  readonly injected: unknown[];
  readonly followed: unknown[];
  readonly scopedTools: ScopedTools;
  /** Sections registered on this agent's own scoped system prompt. */
  readonly scopedSections: string[];
}

/** The provider/model route pair `spawnDispatcher` copies into `agentOptions`. */
interface RouteLike {
  readonly provider?: string;
  readonly model?: string;
  // `AgentOptionsLike` carries an index signature; a bare interface without one
  // is not assignable to it even when the known keys line up.
  readonly [key: string]: unknown;
}

interface ScopedAgentOptions {
  topLevel?: boolean;
  depth?: number;
  parentSessionId?: string;
  withScopedCtx?: boolean;
  /** Header preset fact, when the test wants to model the installed host. */
  agentPreset?: string;
  /**
   * ADR-0032: the working directory a summoned session is created in — the ONE
   * field `TopLevelSessionMetaLike` admits. Read off the summoner's header.
   */
  cwd?: string;
  /** ADR-0032: the request route the summoner carries (`agent.options`). */
  route?: RouteLike;
}

function createScopedAgent(id: string, opts?: ScopedAgentOptions): ScopedAgent {
  const topLevel = opts?.topLevel ?? true;
  const depth = opts?.depth ?? (topLevel ? 0 : 1);
  const injected: unknown[] = [];
  const followed: unknown[] = [];
  const sections: string[] = [];
  // Top-level sessions inherit the stock preset, so their scope can be
  // restricted; a subagent child in this fake is composed by the plugin's
  // worker barrier through the bare-scope carve-out.
  const scopedTools = createScopedTools(topLevel);
  // A real session header carries its own id (`sessionIdOfHeader` reads it, and
  // the ticket-147 resume check goes through the projection unit's `init`).
  //
  // Ticket 163 defect 2: every agent carries a `cwd` by default. A summon from
  // a session with none is now REFUSED (the peer it would create could never
  // be cold-resumed), so a stub without one models a summoner that cannot
  // summon at all. That refusal has its own test in
  // `spawn-dispatcher-host.test.ts`, whose stub leaves `cwd` off.
  const header = {
    id,
    parentSession: topLevel ? null : (opts?.parentSessionId ?? "parent-x"),
    delegationDepth: depth,
    cwd: opts?.cwd ?? "C:\\work",
    ...(opts?.agentPreset !== undefined
      ? { agentPreset: opts.agentPreset }
      : {}),
    ...(topLevel ? {} : { origin: "subagent" as const }),
  };
  const agent: ScopedAgent = {
    session: { id, header },
    ...(opts?.route !== undefined ? { options: opts.route } : {}),
    injected,
    followed,
    scopedTools,
    scopedSections: sections,
    followup(message: unknown) {
      followed.push(message);
    },
    inject(message: unknown) {
      injected.push(message);
    },
    ...(opts?.withScopedCtx === false
      ? {}
      : {
          ctx: {
            tools: scopedTools,
            systemPrompt: {
              section(section: { name: string }) {
                sections.push(section.name);
                return () => {};
              },
              getSectionOrder() {
                return 0;
              },
            },
          },
        }),
  };
  return agent;
}

/**
 * The installed host's depth rule, replicated offline
 * (`dsh-subagent/lib/types/child-agent.js:31-39`): `childDepth = parentDepth
 * + 1` (the header depth is the monotone floor), refused when it exceeds the
 * requested `maxDepth`. The only depth bound in play — we add none.
 */
function hostDepthAllows(
  parentDepth: number,
  maxDepth: number | undefined,
): boolean {
  return maxDepth === undefined || parentDepth + 1 <= maxDepth;
}

interface StubChild {
  readonly id: string;
  readonly agent: ScopedAgent;
}

/**
 * One `ctx.agents.create` call, recorded with the exact options the host
 * passed (ADR-0032: `sessionId`, `meta`, `agentOptions`, `setup`, `signal`).
 */
interface CreateCall {
  readonly sessionId: string;
  readonly meta: TopLevelSessionMetaLike;
  readonly agentOptions: unknown;
  readonly hasSetup: boolean;
  readonly signal: unknown;
}

/**
 * The storage tables of one simulated process. Held OUTSIDE the plugin so a
 * second `createActivationCtx` can share them: that is how a restart is
 * modelled — the durable store survives, the in-memory host/plugin state does
 * not (ticket 130).
 */
type StorageTables = Map<string, Map<string, unknown>>;

/**
 * Structural ctx stub. `startActivation` announces the child on
 * `agent/created` the way the installed host does — inside the call, before
 * it resolves — with the child's header carrying the parent's id and
 * depth + 1. It also applies the host's depth rule, so a depth refusal always
 * comes from the HOST side of this file.
 *
 * `holdNextActivation()` parks the NEXT announcement behind a gate, which is
 * how the race test interleaves a worker spawn and a dispatcher spawn from
 * one parent.
 */
function createActivationCtx(storage: StorageTables = new Map()) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  // Ticket 147: the projection registry is the parentless resume seam. The
  // REAL unit is registered and the REAL fold runs; the stub only supplies the
  // host half (`stateOf`), materialising the cell from the session header —
  // which is where `init` consults the dispatcher-mark probe.
  const projectionDefinitions = new Map<
    string,
    SessionProjectionDefinitionLike<SessionKindProjectionState>
  >();
  const projectionCells = new WeakMap<object, SessionKindProjectionState>();
  const projections = {
    register(
      definition: SessionProjectionDefinitionLike<SessionKindProjectionState>,
    ) {
      projectionDefinitions.set(definition.key, definition);
      return () => {
        projectionDefinitions.delete(definition.key);
      };
    },
    stateOf(session: unknown, key: string) {
      const definition = projectionDefinitions.get(key);
      if (definition === undefined) return undefined;
      if (typeof session !== "object" || session === null) return undefined;
      const cached = projectionCells.get(session);
      if (cached !== undefined) return cached;
      const header = (session as { header?: unknown }).header;
      // A top-level session starts its own log, so it inherits no events.
      const state = definition.init(header, 0) as SessionKindProjectionState;
      projectionCells.set(session, state);
      return state;
    },
  };
  const commands = new Map<string, CommandDefinitionLike>();
  const globalTools = new Map<string, ScopedTool>();
  const disposers: Array<() => void> = [];
  const startActivationCalls: ActivationSpecLike[] = [];
  const createCalls: CreateCall[] = [];
  const children: StubChild[] = [];
  const agentsById = new Map<string, AgentLike>();
  /** Ticket 138: every host `sendMessage`, with its resume payload. */
  const sendMessageCalls: Array<{
    senderSessionId: string;
    targetId: string;
    text: string;
  }> = [];
  /**
   * Ticket 138 fidelity: every host send REFUSED by the adjacency rule,
   * with the reason. The real `ctx.subagents.sendMessage` is exact live
   * sender → direct continuable child (`docs/research/dsh-adapter-api-notes.md`
   * §11); a top-level peer has no parent edge, so the degraded path must be
   * observable instead of silently succeeding.
   */
  const sendMessageRefusals: Array<{
    senderSessionId: string;
    targetId: string;
    text: string;
    reason: string;
  }> = [];
  let nextChild = 1;
  let heldGate: (() => void) | null = null;
  let holdNext = false;
  let announceChildren = true;
  let sabotageNext = false;
  /**
   * Ticket 142: park cold resumes so a test can send TWICE before the child
   * returns (the coalescing case) and then release them in order. The first
   * released call recreates the child and announces it; later ones find it
   * live, exactly as the host's own `sendMessage` does.
   */
  let holdResumes = false;
  const parkedResumes: Array<{
    sender: AgentLike;
    targetId: string;
    text: string;
  }> = [];

  const fire = (name: string, payload: unknown): void => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      (cb as (arg: unknown) => void)(payload);
    }
  };

  /**
   * Ticket 138/142: the host's cold-resume of an absent session.
   *
   * The live seam is ADJACENCY-ONLY: exact live sender → direct continuable
   * child (`docs/research/dsh-adapter-api-notes.md` §11). A WORKER was created
   * as a subagent child of its spawning dispatcher, so it resumes parented at
   * parent depth + 1. A summoned DISPATCHER is a top-level session with no
   * parent edge (ADR-0032), so it is not addressable here at all — its resume
   * route is `ctx.sessionController.resolveAgent`, and the caller must degrade
   * honestly when that facade is absent. This helper therefore never invents
   * a top-level target; the adjacency check runs before it is reached.
   */
  const resumeTarget = (sender: AgentLike, target: string): void => {
    if (agentsById.has(target)) return;
    const parentSessionId = String(sender.session.id);
    const parentDepth = sender.session.header?.delegationDepth ?? 0;
    const resumed = createScopedAgent(target, {
      topLevel: false,
      depth: parentDepth + 1,
      parentSessionId,
    });
    children.push({ id: target, agent: resumed });
    agentsById.set(target, resumed);
    // The host announces a cold resume under its own source value — the shape
    // tickets 130/142 handle.
    fire("agent/created", { agent: resumed, source: "resume" });
  };

  /**
   * The installed host's parent/child adjacency fence. Returns the refusal
   * reason, or undefined when the send is allowed.
   *
   * Verified against dsh-subagent 0.2.2-rc.1
   * (`dsh-subagent/lib/index.js:1545`, `:1665-1668`):
   * - The sender must be the EXACT live agent (`ctx.agents.get(sender.id)
   *   === sender`); a stale Agent object is UNAUTHORIZED.
   * - A cold resume authorizes the durable direct-parent lineage
   *   (`source.header.parentSession === sender.id`); anything else is
   *   "belongs to another parent session".
   * - A live target must be a direct child of that sender.
   * - An absent target is resumable only when the host knows it as the
   *   sender's child. A durably marked DISPATCHER was created top-level and
   *   has no parent edge; a durable WORKER row names its spawner. An id the
   *   host knows nothing about is not a child either.
   */
  const sendMessageRefusal = (
    sender: AgentLike,
    target: string,
  ): string | undefined => {
    const senderSessionId = String(sender.session.id);
    if (agentsById.get(senderSessionId) !== sender) return "sender-not-live";
    const targetAgent = agentsById.get(target);
    if (targetAgent !== undefined) {
      return String(targetAgent.session.header?.parentSession ?? "") ===
        senderSessionId
        ? undefined
        : "not-a-direct-child";
    }
    if (storage.get(DISPATCHER_SESSION_TABLE_NAME)?.has(target) === true) {
      return "not-a-direct-child";
    }
    const workerRow = storage.get(WORKER_SESSION_TABLE_NAME)?.get(target) as
      | { parentSessionId?: string }
      | undefined;
    return workerRow?.parentSessionId === senderSessionId
      ? undefined
      : "unknown-child";
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; a returned
    // function — or each value a generator yields — is the unload disposer.
    effect(execute: () => unknown, label?: string) {
      void label;
      const result = execute();
      if (typeof result === "function") {
        disposers.push(result as () => void);
        return;
      }
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") disposers.push(step as () => void);
        }
      }
    },
    // No settings service. The projection registry is the ticket-147 resume
    // seam: the plugin asks for it through `inject` and reads it back through
    // the guarded `get` (see `resolveSessionProjections`), so both routes are
    // provided here over ONE real registry + real fold.
    inject(
      services: readonly string[],
      callback: (child: SessionProjectionChildLike) => void,
    ) {
      void services;
      callback({ sessionProjections: projections });
    },
    get(name: string) {
      if (name === "sessionProjections") return projections;
      return undefined;
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        // Shipped rule (ticket 91): duplicate command name throws.
        if (commands.has(definition.name)) {
          throw new Error(`command "${definition.name}" is already registered`);
        }
        commands.set(definition.name, definition);
        return () => {
          commands.delete(definition.name);
        };
      },
    },
    tools: {
      schemas: () => [...globalTools.keys()].map((name) => ({ name })),
      register(definition: unknown) {
        const def = definition as ScopedTool;
        if (globalTools.has(def.name)) {
          throw new Error(`tool "${def.name}" is already registered`);
        }
        globalTools.set(def.name, def);
        return () => {
          globalTools.delete(def.name);
        };
      },
    },
    subagents: {
      /**
       * The WORKER hop only (ADR-0032: a summoned dispatcher no longer rides
       * this seam — see `agents.create` below). Announces the child on
       * `agent/created` inside the call, before it resolves, with the child's
       * header carrying the parent's id and depth + 1, and applies the host's
       * depth rule, so a depth refusal always comes from the HOST side of this
       * file.
       */
      async startActivation(spec: ActivationSpecLike) {
        startActivationCalls.push(spec);
        const parentSessionId = String(spec.request.parent.session.id);
        const parentDepth =
          spec.request.parent.session.header?.delegationDepth ?? 0;
        // The host's OWN ceiling check — never ours (ADR-0025: no gate, no
        // cap; the number in the request is the only bound).
        if (!hostDepthAllows(parentDepth, spec.request.maxDepth)) {
          const error = new Error(
            `subagent depth ${parentDepth + 1} exceeds maxDepth ${spec.request.maxDepth}`,
          );
          error.name = "SubagentDepthError";
          throw error;
        }
        const childId =
          spec.childId !== undefined
            ? String(spec.childId)
            : `child-${nextChild++}`;
        const child = createScopedAgent(childId, {
          topLevel: false,
          depth: parentDepth + 1,
          parentSessionId,
        });
        children.push({ id: childId, agent: child });
        agentsById.set(childId, child);
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            heldGate = resolve;
          });
        }
        if (announceChildren) {
          // Announced inside the call, before it resolves (the installed
          // host's order: dsh-agent/lib/index.js:574-586).
          fire("agent/created", { agent: child, source: "startup" });
        }
        return {
          childId,
          messageId: `msg-${childId}`,
          dispose: async () => {},
          result: Promise.resolve(undefined),
        };
      },
      interrupt() {},
      /**
       * Ticket 138: the installed host's `sendMessage` steers a running child,
       * wakes an idle one, and cold-resumes an ABSENT DIRECT CHILD
       * (`docs/research/dsh-adapter-api-notes.md:83`, §11). It is
       * adjacency-only: a sibling or top-level peer is not a public path, and
       * an exact live sender Agent is required. The double enforces both so a
       * test can never mistake a fake success for a host capability.
       */
      async sendMessage(
        sender: AgentLike,
        targetId: unknown,
        content: Array<{ type?: string; text?: string }>,
      ) {
        const target = String(targetId);
        const text = content.map((block) => block.text ?? "").join("");
        const call = {
          senderSessionId: String(sender.session.id),
          targetId: target,
          text,
        };
        sendMessageCalls.push(call);
        const refusal = sendMessageRefusal(sender, target);
        if (refusal !== undefined) {
          sendMessageRefusals.push({ ...call, reason: refusal });
          throw new Error(
            `ctx.subagents.sendMessage refused ${target} from ${call.senderSessionId}: ${refusal}`,
          );
        }
        if (holdResumes) {
          parkedResumes.push({ sender, targetId: target, text });
          return `msg-${target}`;
        }
        resumeTarget(sender, target);
        return `msg-${target}`;
      },
    },
    agents: {
      get: (id: unknown) => agentsById.get(String(id)),
      /**
       * ADR-0032: `spawnDispatcher` summons a NEW TOP-LEVEL session through
       * this seam (the same call the host's "new conversation" makes) and then
       * drives it with `followup`. The stub models the two facts the host
       * relies on: `meta` carries ONLY `cwd` (parentless by construction —
       * `parentAgent`/`origin`/`parentSession`/`delegationDepth`/`maxDepth`
       * are absent, and the type admits only `cwd`), and `setup` runs BEFORE
       * publication, so the dispatcher surface exists before the first turn.
       */
      async create(options: CreateAgentOptionsLike) {
        createCalls.push({
          sessionId: options.sessionId,
          meta: options.meta ?? {},
          agentOptions: options.agentOptions,
          hasSetup: typeof options.setup === "function",
          signal: options.signal,
        });
        const childId = options.sessionId;
        // The route is copied from the summoner (`agentOptions`), and the cwd
        // comes from `meta.cwd`; the header is TOP-LEVEL (no parent, depth 0).
        const route = options.agentOptions as RouteLike | undefined;
        const cwd =
          typeof options.meta?.cwd === "string"
            ? String(options.meta.cwd)
            : undefined;
        const child = createScopedAgent(childId, {
          topLevel: true,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(route !== undefined ? { route } : {}),
        });
        // A top-level session is created ON the stock preset; the plugin's
        // layer is what the create `setup` adds below.
        mountStockPreset(ctx, child);
        children.push({ id: childId, agent: child });
        agentsById.set(childId, child);
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve) => {
            heldGate = resolve;
          });
        }
        // `setup` is awaited BEFORE publication — this is where the plugin
        // composes the dispatcher surface (`onDispatcherSpawned`). A sabotaged
        // registry must be in place BEFORE that call, or the failure would
        // never happen.
        if (sabotageNext) {
          sabotageNext = false;
          Object.defineProperty(child, "ctx", {
            value: {
              tools: {
                schemas: () => [],
                register() {
                  throw new Error("scoped registry refused the registration");
                },
              },
            },
          });
        }
        if (options.setup !== undefined) {
          await options.setup({}, child);
        }
        if (announceChildren) {
          fire("agent/created", { agent: child, source: "startup" });
        }
        return {
          agent: child,
          dispose: async () => {},
        };
      },
    },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        const tables = storage;
        return {
          table(name: string) {
            let table = tables.get(name);
            if (table === undefined) {
              table = new Map<string, unknown>();
              tables.set(name, table);
            }
            const store = table;
            // The stub stores opaque rows for several logical tables; the
            // KvTableLike view only names the marker shape it is read through.
            return {
              get: (key: string) =>
                store.get(key) as DurableWorkerMarker | undefined,
              entries: () =>
                store.entries() as IterableIterator<
                  [string, DurableWorkerMarker]
                >,
              async put(key: string, value: unknown) {
                store.set(key, value);
              },
              async delete(key: string) {
                return store.delete(key);
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    // Test surface
    fire,
    disposers,
    startActivationCalls,
    createCalls,
    children,
    agentsById,
    sendMessageCalls,
    sendMessageRefusals,
    /** Park the NEXT `agent/created` announcement until `releaseHeld()`. */
    holdNextActivation() {
      holdNext = true;
    },
    releaseHeld() {
      const gate = heldGate;
      heldGate = null;
      gate?.();
    },
    /** Stop announcing `agent/created` (a stub host, or an earlier order). */
    setAnnounceChildren(value: boolean) {
      announceChildren = value;
    },
    /** The NEXT child's scoped registry rejects every registration. */
    sabotageNextChildRegistration() {
      sabotageNext = true;
    },
    /** Ticket 142: park cold resumes until `releaseResumes()`. */
    holdResumes() {
      holdResumes = true;
    },
    /** Deliver every parked resume, in call order. */
    async releaseResumes() {
      holdResumes = false;
      const parked = parkedResumes.splice(0);
      for (const call of parked) {
        resumeTarget(call.sender, call.targetId);
      }
      await Promise.resolve();
    },
    parkedResumes,
    commandNames: () => [...commands.keys()],
    globalToolNames: () => [...globalTools.keys()],
    globalTool: (name: string) => globalTools.get(name),
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return ctx;
}

type ActivationCtx = ReturnType<typeof createActivationCtx>;

async function activateDispatcher(
  ctx: ActivationCtx,
  agent: ScopedAgent,
): Promise<void> {
  ctx.agentsById.set(String(agent.session.id), agent);
  // The session is born on the host's stock preset; activation adds our
  // layer on top of it (and withholds the preset's fork verb).
  mountStockPreset(ctx, agent);
  const result = ctx.runCommand({
    commandId: DISPATCHER_START_COMMAND,
    agent,
  });
  assert.deepEqual(result.kind, "success");
  await drain();
}

/** Call one tool on a specific agent's own scoped surface. */
async function callScoped(
  agent: ScopedAgent,
  name: string,
  args: unknown,
  exec?: unknown,
): Promise<Record<string, unknown>> {
  const tool = agent.scopedTools.get(name);
  assert.ok(tool, `${String(agent.session.id)} has no scoped ${name}`);
  return (await tool.execute(args, exec)) as Record<string, unknown>;
}

async function spawnPeer(
  creator: ScopedAgent,
  title = "Peer",
  prompt = "Own the second half.",
): Promise<Record<string, unknown>> {
  return callScoped(creator, SPAWN_DISPATCHER_TOOL, { title, prompt });
}

/**
 * The stock preset verbs a dispatcher session inherits. In the live host the
 * agent preset mounts them (never us); the fake `subagent` below is the
 * worker spawn path now, and the other four exist only to be seen — or, for
 * the fork, to be withheld by the plugin's own restriction (ADR-0003: workers
 * start blank, so a dispatcher cannot fork).
 */
const STOCK_DISPATCHER_TOOL_SET = [
  "subagent",
  "list_agents",
  "send_message",
  "interrupt_agent",
] as const;

/** Everything the preset mounts on a dispatcher scope, fork included. */
const STOCK_PRESET_TOOL_SET: readonly string[] = [
  ...STOCK_DISPATCHER_TOOL_SET,
  "subagent_fork",
];

/**
 * The USER-STARTED (chief of staff) surface: the three verbs stock DSH does
 * not cover (`DISPATCHER_TOOL_NAMES`), on top of the preset's visible stock
 * tools.
 */
const DISPATCHER_TOOL_SET: readonly string[] = [
  ...DISPATCHER_TOOL_NAMES,
  ...STOCK_DISPATCHER_TOOL_SET,
].sort();

/**
 * Ticket 176 (owner ruling 2026-11-03): a summoned dispatcher is a TEAM
 * LEADER and may not summon further dispatchers. Its surface is the same set
 * minus `spawn_dispatcher` — the tool is not registered at all, so the model
 * never sees the name (ADR-0019: visibility is the fence).
 */
const SPAWNED_DISPATCHER_TOOL_SET: readonly string[] = [
  ...DISPATCHER_TOOL_NAMES.filter((name) => name !== SPAWN_DISPATCHER_TOOL),
  ...STOCK_DISPATCHER_TOOL_SET,
].sort();

/**
 * Mount the stock preset verbs on a dispatcher session, the way the agent
 * preset does before the plugin's activation adds its layer.
 *
 * The `subagent` fake is the worker spawn path now (the T3b pattern): it
 * drives the host's `startActivation` seam — the same call the stock tool
 * makes — so the child is announced on `agent/created` with the header the
 * real host writes (`origin: "subagent"`, parent, depth + 1), and the plugin
 * adopts it from that header. Never a plugin spawn handler.
 */
function mountStockPreset(ctx: ActivationCtx, agent: ScopedAgent): void {
  if (agent.scopedTools.get("subagent") !== undefined) return;
  // `ToolsLike.register` is optional (a stub context need not expose it), but
  // this is the fake's own always-registrable scope: bind it once and fail
  // loud rather than losing the stock surface if that invariant ever breaks.
  const register = agent.scopedTools.register;
  if (register === undefined) {
    throw new Error("stock preset mount needs a registrable agent scope");
  }
  register({
    name: "subagent",
    async execute(args: unknown) {
      const call = (args ?? {}) as { description?: string; prompt?: string };
      const parentDepth = agent.session.header?.delegationDepth ?? 0;
      const activation = await ctx.subagents.startActivation({
        provider: "stub",
        label: call.description ?? "Worker",
        request: {
          prompt: textBlocks(call.prompt ?? ""),
          parent: agent,
          // The child's ABSOLUTE ceiling: parent depth + one hop + the
          // worker's own (leaf) budget.
          maxDepth: workerSpawnMaxDepth(parentDepth),
        },
        signal: new AbortController().signal,
        delivery: "parent",
      });
      return { ok: true, childId: String(activation.childId) };
    },
  });
  for (const name of STOCK_PRESET_TOOL_SET) {
    if (name === "subagent") continue;
    register({
      name,
      async execute() {
        return { ok: true };
      },
    });
  }
}

/**
 * Start one worker through the stock `subagent` verb — the only spawn path a
 * dispatcher has now. The plugin adopts the announced child (persona, barrier,
 * roster, durable wake row) from its header.
 */
async function spawnWorker(
  dispatcher: ScopedAgent,
  label = "Migration",
  prompt = "Do the migration.",
): Promise<string> {
  const spawned = await callScoped(dispatcher, "subagent", {
    description: label,
    prompt,
  });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  await drain();
  return String(spawned.childId);
}

/**
 * The kept replacement for `check_workers`: `message_agent` routes an id
 * with a roster record on THIS session to the worker-steer branch
 * (`not-running` for a worker that has not taken a turn) and an id with none
 * to the peer branch (`unknown-target`). A refusal records nothing and
 * spends no budget, so the probe is read-only.
 */
async function workerOnRoster(
  dispatcher: ScopedAgent,
  workerId: string,
): Promise<boolean> {
  const probed = await callScoped(dispatcher, "message_agent", {
    target: workerId,
    text: "roster probe",
  });
  return probed.ok === false && probed.reason === "not-running";
}

describe("ticket 118 — spawned dispatcher activation (ADR-0025, ADR-0019)", () => {
  it("spawns through the host seam and activates the child without the top-level gate", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    assert.ok(creator.scopedTools.names().includes(SPAWN_DISPATCHER_TOOL));

    const result = await spawnPeer(creator);

    assert.equal(result.ok, true, JSON.stringify(result));
    const dispatcherId = String(result.dispatcher_id);
    assert.equal(result.title, "Peer");

    // ADR-0032: the summon goes through `ctx.agents.create`, NOT through the
    // subagent runtime. Nothing about this spawn may look like a subagent.
    assert.equal(ctx.startActivationCalls.length, 0);
    assert.equal(ctx.createCalls.length, 1);
    const call = ctx.createCalls[0] as CreateCall;
    // The reserved id IS the session id: identity is what recognises this
    // session later, never a counter.
    assert.equal(call.sessionId, dispatcherId);
    // Parentless by construction — `meta` admits only `cwd`. Every field the
    // host's ownership guard treats as "subagent-owned" is absent.
    //
    // Ticket 163 defect 2 REWROTE this assertion. It used to read
    // `assert.deepEqual(Object.keys(call.meta), [])` — i.e. it pinned the bug:
    // an empty `meta` is a session the host can never cold-resume. `cwd` is
    // now required, so the key set is exactly `["cwd"]` and its value is the
    // summoner's own directory.
    assert.deepEqual(Object.keys(call.meta), ["cwd"]);
    assert.equal(call.meta.cwd, "C:\\work");
    for (const forbidden of [
      "parentSession",
      "parentAgent",
      "origin",
      "delegationDepth",
    ]) {
      assert.equal(forbidden in call.meta, false);
    }
    // No `maxDepth`, no `delivery`, no `provider`: those were subagent-runtime
    // fields and there is no spawn cap of ours.
    assert.equal("maxDepth" in call, false);
    assert.equal("delivery" in call, false);
    // `setup` is how the dispatcher surface is composed before publication.
    assert.equal(call.hasSetup, true);

    const child = ctx.children[0] as StubChild;
    assert.equal(child.id, dispatcherId);
    // The child is TOP-LEVEL: no parent, depth 0 — the ordinary activation
    // path admits it without the spawned-specific exemption.
    assert.equal(child.agent.session.header?.parentSession, null);
    assert.equal(child.agent.session.header?.delegationDepth, 0);
    // The first turn arrives through `followup`, which is the only call that
    // both queues a turn and wakes the driver.
    assert.equal(child.agent.followed.length, 1);
    assert.ok(textOf(child.agent.followed[0]).includes("Own the second half."));
    // The child's OWN scope holds the spawned-class dispatcher set — the two
    // dispatcher verbs it keeps on top of the stock preset. `spawn_dispatcher`
    // is not registered at all (ticket 176).
    assert.deepEqual(
      child.agent.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    assert.ok(!child.agent.scopedTools.names().includes(SPAWN_DISPATCHER_TOOL));
    // The stock preset surface stays visible (workers, status, steering and
    // stopping are stock verbs now); only the fork spawn is withheld.
    for (const name of STOCK_DISPATCHER_TOOL_SET) {
      assert.ok(
        child.agent.scopedTools.names().includes(name),
        "stock " + name + " stays visible on the team leader",
      );
    }
    assert.equal(
      child.agent.scopedTools.names().includes("subagent_fork"),
      false,
      "only the fork verb is withheld",
    );
    // …nothing leaked into the creator's scope or the global layer…
    assert.equal(creator.scopedTools.names().length, DISPATCHER_TOOL_SET.length);
    // Ticket 174 / ADR-0033 removed `request_access`, the one global name.
    assert.deepEqual(ctx.globalToolNames(), []);
    // …and the dispatcher policy was injected (ADR-0025 decision 1-2).
    assert.equal(child.agent.injected.length, 1);
    assert.ok(textOf(child.agent.injected[0]).includes("# Multitask dispatcher"));
    // A dispatcher child is NOT composed as a worker: no contract, no barrier.
    assert.ok(!child.agent.scopedSections.includes(WORKER_PERSONA_SECTION));
  });

  it("the summoned dispatcher gets the team-leader class, not the chief-of-staff one", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;

    const creatorPolicy = textOf(creator.injected[0]);
    const childPolicy = textOf(child.agent.injected[0]);

    // Owner-directed 2026-11-02: two classes. The summoner is the user's chief
    // of staff; the summoned one leads one massive job as a team leader.
    assert.notEqual(
      childPolicy,
      creatorPolicy,
      "the spawned class has its own text",
    );
    assert.ok(
      creatorPolicy.includes("You are the user's chief of staff for a large project."),
    );
    assert.ok(childPolicy.includes("Lead a team to tackle a massive job"));
    // Owner ruling 2026-11-03: the scheduling health-check block is gone.
    assert.ok(!childPolicy.includes("health check"));
    assert.ok(!childPolicy.includes("Another dispatcher summoned you."));

    // Ticket 176 REVERSES what this assertion used to say. It read "Both
    // surfaces carry the same eight dispatcher tools" — that equality is now
    // false by design: the user-started class keeps `spawn_dispatcher`, the
    // summoned class does not. Everything else still matches, which the first
    // assertion pins so a wider drift would still fail here.
    assert.deepEqual(creator.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
    assert.deepEqual(
      child.agent.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    // Both classes see the stock verbs; neither sees the fork.
    for (const surface of [creator, child.agent]) {
      for (const name of STOCK_DISPATCHER_TOOL_SET) {
        assert.ok(surface.scopedTools.names().includes(name), name);
      }
      assert.equal(surface.scopedTools.names().includes("subagent_fork"), false);
    }
    assert.deepEqual(
      creator.scopedTools
        .names()
        .filter((name) => name !== SPAWN_DISPATCHER_TOOL)
        .sort(),
      child.agent.scopedTools.names().sort(),
      "the classes differ in exactly one tool: the summon verb",
    );
  });

  it("activate() still refuses a non-top-level user chat — the command gate moved nowhere", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const childChat = createScopedAgent("child-chat", { topLevel: false });

    ctx.agentsById.set("child-chat", childChat);
    const refused = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: childChat,
    });

    assert.deepEqual(refused, {
      kind: "error",
      text: DISPATCHER_START_NOT_TOP_LEVEL,
    });
    assert.equal(childChat.injected.length, 0);
    assert.deepEqual(childChat.scopedTools.names(), []);
  });

  it("the child spawns a worker under its own session; wake state stays separate from the creator's", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    const spawn = await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;
    assert.equal(child.id, String(spawn.dispatcher_id));

    // The stock `subagent` verb is the spawn path now; the child dispatcher
    // is the bound parent, so the host adopts the announced child as a worker.
    const workerId = await spawnWorker(child.agent);

    // ADR-0032: the dispatcher spawn did NOT ride the subagent runtime, so
    // this worker hop is the FIRST and only `startActivation` call.
    assert.equal(ctx.startActivationCalls.length, 1);
    const workerSpec = ctx.startActivationCalls[0] as ActivationSpecLike;
    assert.equal(String(workerSpec.request.parent.session.id), child.id);
    // The child is a top-level session (depth 0), so its worker lands at
    // depth 1 whatever the creator's own depth is.
    assert.equal(workerSpec.request.parent.session.header?.delegationDepth, 0);
    // Ceiling for the worker hop: parent depth 0 + 1 hop + leaf budget 0.
    assert.equal(workerSpec.request.maxDepth, 1);

    // Per-session rosters, read through the kept probe: the creator does not
    // own this worker (unknown-target), the child does (a roster record, so
    // the steer branch answers not-running until the worker's first turn).
    assert.equal(
      await workerOnRoster(creator, workerId),
      false,
      "the creator sees no worker",
    );
    assert.equal(
      await workerOnRoster(child.agent, workerId),
      true,
      "the child sees its own worker",
    );

    // The settle opens no plugin wake for either session; the stock notice
    // goes to the owning dispatcher's parent channel.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "Migration done." }],
    });
    await drain();
    // No plugin settle wake follows. `followed` holds only the spawn prompt
    // the child dispatcher received when it was created; the stock completion
    // notice is delivered through the host's own parent channel.
    assert.equal(
      child.agent.followed.length,
      1,
      "spawn prompt only — no plugin settle wake",
    );
    assert.ok(
      textOf(child.agent.followed[0]).includes("Own the second half."),
      "followup #1 is the dispatcher spawn prompt",
    );
    assert.equal(creator.followed.length, 0, "the creator is not woken");
  });

  it("deactivating the child tears down its tool surface", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;
    assert.deepEqual(
      child.agent.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );

    // A live child exists under the child dispatcher (the earlier release
    // half of this case parked a bounded await on it; `await_agent` is
    // retired and the stock completion path is push-only, so there is no
    // model-facing wait left to release here — the activation teardown is
    // what remains assertable from the tool surface).
    const workerId = await spawnWorker(child.agent, "T", "P");
    assert.equal(await workerOnRoster(child.agent, workerId), true);

    // The host dispose path — the same one the UI delete affordance takes.
    ctx.fire("agent/disposed", { agent: child.agent });

    // Our layer is gone with the activation: the two dispatcher verbs AND the
    // withhold restriction were disposed together. The preset's own stock
    // surface remains, fork included — this session is a plain stock session
    // again, and the creator's surface is untouched (ADR-0019).
    const remaining = child.agent.scopedTools.names();
    for (const name of DISPATCHER_TOOL_NAMES) {
      assert.equal(
        remaining.includes(name),
        false,
        `${name} was disposed with the activation`,
      );
    }
    assert.equal(remaining.includes(SPAWN_DISPATCHER_TOOL), false);
    assert.deepEqual(
      remaining.sort(),
      [...STOCK_PRESET_TOOL_SET].sort(),
      "only the preset's stock surface is left, fork restored",
    );
    assert.deepEqual(creator.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
  });

  it("activates the child exactly once even when the host announces it (no double registration)", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;

    // The announcement fired inside `startActivation` and the post-resolve
    // fallback also looked at `ctx.agents` — two candidate call sites, ONE
    // activation. A second one would throw on the scoped registry's duplicate
    // name rule (and would double-inject the policy). Ticket 176: the spawned
    // class withholds `spawn_dispatcher`, and the preset's four visible stock
    // verbs stay — six tools in all.
    assert.deepEqual(
      child.agent.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    assert.equal(child.agent.injected.length, 1);
  });

  /**
   * Ticket 130 — the IDENTITY half: a spawned dispatcher writes our own
   * durable mark, and a cold resume re-activates the child from it.
   *
   * A restart is modelled exactly as `test/durable-roster.test.ts` does it:
   * the STORAGE TABLES survive, the in-memory host + plugin state is thrown
   * away and a fresh `apply()` runs over a fresh ctx. Anything the plugin
   * remembers in-process is therefore gone; only the store can carry the
   * identity forward.
   */
  const DISPATCHER_SESSIONS_TABLE = DISPATCHER_SESSION_TABLE_NAME;

  async function readMarks(
    storage: StorageTables,
  ): Promise<Map<string, unknown>> {
    return new Map(storage.get(DISPATCHER_SESSIONS_TABLE) ?? []);
  }

  it("writes a durable dispatcher mark at spawn, keyed by the child session id (ticket 130)", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    // Ticket 138: an activation now WARMS the mark mirror (read-only), so the
    // table may exist here — what must not exist is a mark. The pin's intent
    // is unchanged: nothing is written before a dispatcher is spawned.
    assert.deepEqual([...(storage.get(DISPATCHER_SESSIONS_TABLE) ?? [])], []);

    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    const marks = await readMarks(storage);
    assert.deepEqual([...marks.keys()], [dispatcherId]);
    assert.equal(
      (marks.get(dispatcherId) as { sessionId?: string }).sessionId,
      dispatcherId,
    );
  });

  it("a cold-resumed child marked as a dispatcher is re-activated: role, spawned-class surface, one policy inject (ticket 130)", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    // ── process restart ────────────────────────────────────────────────
    // A NEW plugin instance and a NEW host over the SAME storage tables. The
    // child is re-announced by the host as a resumed session.
    //
    // ADR-0032: a summoned dispatcher was CREATED as a top-level session, so
    // the host resumes it parentless at depth 0 — that is the shape its own
    // session row has, and the durable mark (not a parent edge) is what makes
    // it a dispatcher again.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    const resumedChild = createScopedAgent(dispatcherId, {
      topLevel: true,
      agentPreset: "standard",
    });
    // A resumed top-level session is composed from its preset again, before
    // the plugin's activation re-adds our layer.
    mountStockPreset(second, resumedChild);
    second.agentsById.set(dispatcherId, resumedChild);
    // The host's boot order: the user's own chat activates first, which warms
    // the durable mark mirror; only then is the resumed session announced.
    // The SAME summoner id comes back: dispatcher visibility is lineage-scoped
    // (a different root's chat does not see another root's team leader, even
    // with the same cwd), and the peer probe below must be an allowed edge.
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);

    second.fire("agent/created", {
      agent: resumedChild,
      source: "resume",
    });
    await drain();

    // Role: the session is a live dispatcher again. `await_agent` (the old
    // not-awaitable probe) is retired; the equivalent model-facing probe is a
    // PEER send — the core accepts it as a dispatcher message and delivers it
    // to the resumed session's own turn, which a dormant row cannot do.
    const poked = await callScoped(creatorTwo, "message_agent", {
      target: dispatcherId,
      text: "Welcome back.",
    });
    assert.equal(poked.ok, true, JSON.stringify(poked));
    assert.equal(poked.delivered_as, "peer");
    await drain();
    assert.ok(
      resumedChild.followed.some((message) =>
        textOf(message).includes("Welcome back."),
      ),
      "the peer message reached the live resumed dispatcher",
    );

    // Tool surface: the spawned-class dispatcher tools re-registered in the
    // CHILD's own scope. Ticket 176: 8, not 9 — the resumed session comes back
    // as a team leader and a team leader cannot summon, so `spawn_dispatcher`
    // is withheld here too (the class is durable; see the ticket).
    assert.deepEqual(
      resumedChild.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    // Policy: injected exactly once.
    const policyInjects = resumedChild.injected
      .map(textOf)
      .filter((text) => text.includes("# Multitask dispatcher"));
    assert.equal(policyInjects.length, 1);
    // Depth untouched: a top-level session has no delegation depth, and the
    // resume does not invent one.
    assert.equal(resumedChild.session.header?.delegationDepth, 0);
  });

  it("a resumed child with no dispatcher mark stays a plain subagent (ticket 130)", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));

    // Never spawned by us: no mark, no reservation, nothing durable.
    const plainChild = createScopedAgent("plain-child", {
      topLevel: false,
      parentSessionId: "chat-1",
      agentPreset: "standard",
    });
    ctx.agentsById.set("plain-child", plainChild);

    ctx.fire("agent/created", { agent: plainChild, source: "resume" });
    await drain();

    assert.deepEqual(plainChild.scopedTools.names(), []);
    assert.equal(plainChild.injected.length, 0);
  });

  /**
   * Ticket 138 (owner ruling 2026-10-22: "bots should be wake-able, both
   * dispatchers and children" — the DISPATCHERS half).
   *
   * A send to a marked dispatcher that is NOT live is ACCEPTED (the durable
   * mark is the whole permission), but a facade-less host cannot resume it.
   * ADR-0032 made the summoned dispatcher a TOP-LEVEL session: it has no
   * parent edge, so `ctx.subagents.sendMessage` cannot address it at all
   * (adjacency-only: exact live sender → direct continuable child).
   *
   * SECOND-ROUND AUDIT: the old adapter still TRIED that route whenever the
   * mark recorded a bound spawner, even though the mark's `origin: "top-level"`
   * (and the absent parent edge) says the target is a peer. The host refused
   * it, but the attempt was the bug. The corrected contract does not attempt
   * it: the adapter logs `is undeliverable` and leaves the wake parked. The
   * live web-app route is `ctx.sessionController.resolveAgent`, which only
   * that profile mounts.
   *
   * The honest outcome is unchanged: the message waits in the peer inbox, no
   * session is resumed, and a later announcement discharges the parked wake
   * exactly once.
   */
  it("a send to a marked dispatcher without the sessionController facade is accepted but waits, never fake-resumed (ticket 138)", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    // The mark now records the spawner — the sender the OLD fallback would
    // have tried. The row also records the session SHAPE, which is what keeps
    // this top-level peer off that route.
    const marks = await readMarks(storage);
    assert.equal(
      (marks.get(dispatcherId) as { parentSessionId?: string })
        .parentSessionId,
      "chat-1",
    );
    assert.equal(
      (marks.get(dispatcherId) as { origin?: string }).origin,
      "top-level",
      "the row records the session shape that bars the subagent route",
    );

    // ── process restart ────────────────────────────────────────────────
    // Same storage, fresh plugin + host. NOTHING re-announces the child:
    // the send is the only thing that could bring it back.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    await drain();
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);
    assert.equal(second.children.length, 0, "the child is not live yet");

    // The adapter reports the refused resume once, honestly, and leaves the
    // text parked — capture it so the degraded path is asserted and the test
    // output stays quiet.
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    const sent = await (async () => {
      try {
        const result = await callScoped(creatorTwo, "message_agent", {
          target: dispatcherId,
          text: "Pick the work back up.",
        });
        await drain();
        return result;
      } finally {
        console.warn = originalWarn;
      }
    })();
    // The core ACCEPTED it: a durable mark is not a phantom, and acceptance
    // must not depend on whether this host can issue a resume.
    assert.equal(sent.ok, true, JSON.stringify(sent));
    if (!sent.ok) return;
    assert.equal(sent.delivered_as, "peer");
    assert.equal(
      warnings.filter((args) =>
        String(args[0]).includes("is undeliverable"),
      ).length,
      1,
      "the unreachable peer is named once, not silently swallowed",
    );
    assert.equal(
      warnings.filter((args) =>
        String(args[0]).includes("could not be resumed on send"),
      ).length,
      0,
      "no resume was attempted at all",
    );

    // (a) The subagent route is NOT attempted for a top-level peer. The mark
    // records a spawner, but a spawner is not a parent edge: a summoned
    // dispatcher has no `parentSession`, so `ctx.subagents.sendMessage` could
    // neither address nor cold-resume it. The old fallback tried anyway; that
    // attempt is the defect this pins.
    assert.equal(
      second.sendMessageCalls.length,
      0,
      "ctx.subagents.sendMessage is never used for a top-level peer",
    );
    assert.equal(
      second.sendMessageRefusals.length,
      0,
      "and therefore nothing is refused by the subagent double either",
    );

    // (b) Nothing was resumed. The old double re-created the peer here and
    // the test mistook that for a live host capability.
    assert.equal(second.children.length, 0, "no child was resurrected");
    assert.equal(
      second.agentsById.has(dispatcherId),
      false,
      "the peer is still dormant",
    );

    // (c) The message was not lost: the adapter parks the wake turn, so a
    // later announcement of the same session delivers it exactly once, with
    // the structured agent-message origin — never as user input.
    const resumedChild = createScopedAgent(dispatcherId, {
      topLevel: true,
      agentPreset: "standard",
    });
    // The resumed session is composed from its preset again before the
    // announcement re-activates the dispatcher layer.
    mountStockPreset(second, resumedChild);
    second.agentsById.set(dispatcherId, resumedChild);
    second.children.push({ id: dispatcherId, agent: resumedChild });
    second.fire("agent/created", { agent: resumedChild, source: "resume" });
    await drain();

    assert.equal(resumedChild.followed.length, 1);
    const wake = resumedChild.followed[0] as {
      content?: Array<{ text?: string }>;
      source?: { kind?: string; senderSessionId?: string };
    };
    assert.ok(textOf(wake).includes("Pick the work back up."));
    assert.equal(wake.source?.kind, "agent-message");
    assert.equal(wake.source?.senderSessionId, "chat-1");
    // Ticket 176: the resumed session is still the SPAWNED class, so it comes
    // back as a team leader with no summon verb — and exactly one policy
    // inject, because the announcement ran one activation.
    assert.deepEqual(
      resumedChild.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    assert.equal(resumedChild.injected.length, 1);
  });

  it("the host-send double requires the EXACT live sender and a direct-child edge (fidelity)", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const liveCreator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, liveCreator);
    // Same id, different Agent object: the live host compares the instance
    // (`ctx.agents.get(sender.id) === sender`), not the id string.
    const staleCreator = createScopedAgent("chat-1");
    const child = createScopedAgent("worker-direct", {
      topLevel: false,
      parentSessionId: "chat-1",
    });
    ctx.agentsById.set("worker-direct", child);

    await assert.rejects(
      () =>
        ctx.subagents.sendMessage(staleCreator, "worker-direct", [
          { type: "text", text: "hi" },
        ]),
      /sender-not-live/,
    );
    assert.equal(ctx.sendMessageRefusals[0]?.reason, "sender-not-live");

    // The exact live sender + a direct child is accepted, and a LIVE target
    // is steered rather than re-created.
    await ctx.subagents.sendMessage(liveCreator, "worker-direct", [
      { type: "text", text: "hi" },
    ]);
    assert.equal(ctx.sendMessageCalls.length, 2);
    assert.equal(ctx.sendMessageRefusals.length, 1);
    assert.equal(ctx.children.length, 0, "a live child is never re-created");
  });

  it("an unmarked unknown target still refuses unknown-target through the real wiring (ticket 138 fence)", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    const refused = await callScoped(creator, "message_agent", {
      target: "never-spawned-session",
      text: "hello?",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "unknown-target");
    assert.equal(ctx.sendMessageCalls.length, 0);
    assert.equal(ctx.children.length, 0);
  });

  /**
   * Ticket 142 (owner ruling 2026-10-22: "yes bots should be wake-able, both
   * dispatchers and children" — the CHILDREN half).
   *
   * The worker half parallels the dispatcher half: the SAME `sendMessage`
   * cold-resume seam, the same cue payload and the same "deliver on
   * activation" rule. What is different is what has to come back with the
   * child — a worker must be re-composed as a worker (contract + barrier +
   * reply tool), never inherit the dispatcher surface — and that the core's
   * ticket-59 unknown-state hold is resolved on live evidence.
   *
   * The storage tables are the only thing that survives the restart, exactly
   * as in the ticket-130/138 tests above.
   */
  const WORKER_SESSIONS_TABLE = WORKER_SESSION_TABLE_NAME;

  async function readWorkerSessions(
    storage: StorageTables,
  ): Promise<Map<string, unknown>> {
    return new Map(storage.get(WORKER_SESSIONS_TABLE) ?? []);
  }

  it("writes a durable worker session row at spawn, with the spawning dispatcher as parent (ticket 142)", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    // Nothing is written before a worker exists.
    assert.deepEqual([...(storage.get(WORKER_SESSIONS_TABLE) ?? [])], []);

    const workerId = await spawnWorker(creator);

    const rows = await readWorkerSessions(storage);
    assert.deepEqual([...rows.keys()], [workerId]);
    assert.deepEqual(rows.get(workerId), {
      sessionId: workerId,
      parentSessionId: "chat-1",
    });
  });

  it("a settled worker's row is dropped, so the store never wakes a finished worker (ticket 142)", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    const workerId = await spawnWorker(creator);
    assert.equal((await readWorkerSessions(storage)).size, 1);

    ctx.fire("agent/status", {
      agent: { session: { id: workerId, header: { parentSession: "chat-1" } } },
      status: "running",
    });
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "Done." }],
    });
    await drain();

    // The OBLIGATION marker stays (a result may still be owed a delivery);
    // the WAKE row goes (a finished worker must not be woken back).
    assert.equal((await readWorkerSessions(storage)).size, 0);
    const refusedSteer = await callScoped(creator, "message_agent", {
      target: workerId,
      text: "one more thing",
    });
    assert.equal(refusedSteer.ok, false);
    assert.equal(refusedSteer.reason, "not-running");
  });
});

describe("ticket 141 — spawn generation through the real wiring", () => {
  /**
   * The owner's ruled line, end to end: a user-started dispatcher is
   * generation 1, each spawn adds one, and a cold-resumed child keeps its
   * number because the mark row carries it.
   *
   * Everything here runs the real plugin `apply()`, the real host, and the
   * real core over a storage stub — no live dsh, no LLM.
   */
  async function readMarks(
    storage: StorageTables,
  ): Promise<Map<string, { sessionId?: string; generation?: number }>> {
    return new Map(
      storage.get(DISPATCHER_SESSION_TABLE_NAME) ?? [],
    ) as Map<string, { sessionId?: string; generation?: number }>;
  }

  it("the generation rides the mark row, one past the spawner's", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator, "Second", "Own the slice.");
    const child = ctx.children[0] as StubChild;

    const marks = await readMarks(storage);
    assert.equal(marks.get(String(child.agent.session.id))?.generation, 2);
    // Ticket 176 REVERSES this test's second half. It used to spawn a THIRD
    // dispatcher from the child and pin generation 3 on the grandchild. A
    // summoned dispatcher may not summon any more, so there is no grandchild:
    // the surface carries no `spawn_dispatcher` and the host refuses the call
    // outright (the host-level refusal is pinned in
    // `test/spawn-dispatcher-host.test.ts`).
    assert.ok(
      !child.agent.scopedTools.names().includes(SPAWN_DISPATCHER_TOOL),
      "the summoned class has no summon verb on its surface",
    );
    assert.equal(ctx.children.length, 1, "no grandchild was ever created");
  });

  it("a cold-resumed summoned dispatcher comes back as a team leader with no summon verb", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    await spawnPeer(creator, "Second", "Own the slice.");
    const child = first.children[0] as StubChild;
    const childId = String(child.agent.session.id);

    // ── process restart ────────────────────────────────────────────────
    // Storage survives; plugin + host state does not. Nothing is activated
    // except the user's own chat — which is also what warms the durable mark
    // mirror on boot. The resumed child alone must resolve its identity.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    assert.equal(second.children.length, 0);
    await activateDispatcher(second, createScopedAgent("chat-1"));

    // ADR-0032: parentless at depth 0, like every summoned dispatcher.
    const resumed = createScopedAgent(childId, {
      topLevel: true,
      agentPreset: "standard",
    });
    mountStockPreset(second, resumed);
    second.agentsById.set(childId, resumed);
    second.fire("agent/created", { agent: resumed, source: "resume" });
    await drain();

    // Ticket 176: what a cold resume must still restore is the role, the
    // surface AND the no-summon rule. The class survives because a
    // `dispatcher_sessions` row is written only by the spawn path, so a row's
    // presence already means "another dispatcher summoned this session".
    assert.ok(
      textOf(resumed.injected[0]).includes("Lead a team to tackle a massive job"),
      "the team-leader class is restored from the durable mark",
    );
    assert.ok(!textOf(resumed.injected[0]).includes("chief of staff"));
    assert.deepEqual(
      resumed.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
      "the resumed team leader cannot summon",
    );
  });

});

describe("ticket 142 — a durably marked worker is wake-able by a send", () => {
  it("a send to a marked worker that is not live cold-resumes it and delivers exactly once", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const workerId = await spawnWorker(creator);
    const workerDepth = first.children[0]?.agent.session.header
      ?.delegationDepth;

    // ── process restart ────────────────────────────────────────────────
    // Same storage, fresh plugin + host. Nothing announces the worker: the
    // send is the only thing that can bring it back.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    await drain();
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);
    // The rebuild ran: the live marker is an unknown-state hold, not a roster
    // record, which is exactly why the id needs the durable wake row. The
    // `check_workers` roster view is retired; the send below is the probe that
    // distinguishes the two (a roster record would answer `not-running`, a
    // dormant durable row accepts and wakes — and says so with `dormant`).
    assert.equal(second.children.length, 0, "the worker is not live yet");

    const sent = await callScoped(creatorTwo, "message_agent", {
      target: workerId,
      text: "Pick the migration back up.",
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    if (!sent.ok) return;
    assert.equal(sent.delivered_as, "steer");
    assert.equal(
      sent.dormant,
      true,
      "the durable hold was the only thing left, so the send resumed it",
    );
    await drain();

    // (a) One cold resume, through the host seam, from the SPAWNER, carrying
    // the cue rather than the correction text.
    const resumes = second.sendMessageCalls.filter((call) =>
      call.text.includes("resumed"),
    );
    assert.equal(resumes.length, 1);
    const resume = resumes[0];
    assert.ok(resume);
    assert.equal(resume.targetId, workerId);
    assert.equal(resume.senderSessionId, "chat-1");
    assert.equal(
      resume.text,
      RESUME_WAKE_CUE,
      "the dormant-worker wake carries the resume cue, not the correction",
    );
    assert.ok(!resume.text.includes("Pick the migration back up."));

    // (b) The worker exists again and was composed as a WORKER: the plugin
    // registers NO tool of its own on the worker's scope any more. The
    // interim steer is the stock `send_message` and the report is the closing
    // answer, both inherited from the preset, so the retired
    // `reply_to_dispatcher` and every dispatcher verb stay absent. The stock
    // barrier (send_message allowed, spawn/control denied) is pinned in
    // `test/worker-composition.test.ts`; this fake models scoped
    // registrations only, which is exactly what the plugin still owns here.
    const resumed = second.children.find((child) => child.id === workerId);
    assert.ok(resumed, "the host's sendMessage resumed the worker");
    assert.deepEqual(
      resumed.agent.scopedTools.names(),
      [],
      "no plugin-local tool on a worker's scope",
    );
    for (const retired of [
      "reply_to_dispatcher",
      "deliver_result",
      "message_agent",
      "spawn_dispatcher",
    ]) {
      assert.ok(
        !resumed.agent.scopedTools.names().includes(retired),
        `a worker must not see ${retired}`,
      );
    }
    assert.deepEqual(resumed.agent.scopedSections, [WORKER_PERSONA_SECTION]);
    assert.equal(resumed.agent.injected.length, 0, "no dispatcher policy");

    // (c) The correction was delivered as its own message, exactly once, with
    // the parent-correction wrapper a live steer gets.
    const delivered = second.sendMessageCalls.filter(
      (call) => call.text.includes("Pick the migration back up."),
    );
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0]?.text.includes("[Parent correction]"));

    // (d) The core's unknown-state hold became a live roster record. The
    // `message_agent` probe answers from that record now: the steer branch
    // refuses `not-running` on the live id instead of resuming it a second
    // time (a still-dormant durable row would have been accepted again).
    const sendsBeforeProbe = second.sendMessageCalls.length;
    assert.equal(await workerOnRoster(creatorTwo, workerId), true);
    assert.equal(
      second.sendMessageCalls.length,
      sendsBeforeProbe,
      "a live roster record, not another cold resume",
    );

    // Depth is the persisted one, not recomputed.
    assert.equal(
      resumed.agent.session.header?.delegationDepth,
      workerDepth ?? 1,
    );
  });

  it("an UNMARKED dead worker keeps the fence: unknown-target from message_agent, nothing resumed", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    // `steer_worker` is retired; its worker branch lives on `message_agent`,
    // and the fence is unchanged: an id with neither a roster record nor a
    // durable worker row refuses `unknown-target` and nothing is resumed.
    const messaged = await callScoped(creator, "message_agent", {
      target: "never-spawned-worker",
      text: "hello?",
    });
    assert.equal(messaged.ok, false);
    assert.equal(messaged.reason, "unknown-target");
    assert.equal(ctx.sendMessageCalls.length, 0);
    assert.equal(ctx.children.length, 0);
  });

  it("a LIVE worker takes the unchanged steer path — no resume, no re-composition", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    const workerId = await spawnWorker(creator);
    const child = ctx.children.find((entry) => entry.id === workerId);
    assert.ok(child);
    const toolsBefore = [...child.agent.scopedTools.names()];
    const sectionsBefore = [...child.agent.scopedSections];

    ctx.fire("agent/status", {
      agent: child.agent,
      status: "running",
    });
    const sent = await callScoped(creator, "message_agent", {
      target: workerId,
      text: "tweak the plan",
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await drain();

    // The correction went into the worker's own turn, not through a resume.
    assert.equal(ctx.sendMessageCalls.length, 0);
    // Composition was not re-applied: no duplicate section, no new tool. The
    // scoped tool registry would have thrown on a duplicate register call.
    assert.deepEqual(child.agent.scopedTools.names(), toolsBefore);
    assert.deepEqual(child.agent.scopedSections, sectionsBefore);
  });
});
