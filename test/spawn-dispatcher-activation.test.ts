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
 *    liveness and `await_agent`'s `not-awaitable`), and the child spawns a
 *    worker under its own session while keeping wake state separate.
 * 4. No recursion gate of ours: a dispatcher summoned by a dispatcher is
 *    admitted and is ITSELF parentless. The subagent depth rule stays where
 *    it belongs — on the worker hop, which still rides `startActivation`.
 * 5. Deactivating the child tears down its tool surface and cancels its
 *    awaits (ticket 115's `cancelWaits` rides the same path).
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
  type ActivationSpecLike,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type SessionKindProjectionState,
  type SessionProjectionDefinitionLike,
  type ToolsLike,
} from "../src/adapter/index.js";

import { DISPATCHER_SESSION_TABLE_NAME, WORKER_SESSION_TABLE_NAME } from "../src/adapter/durable-marker.js";
import {SPAWN_DISPATCHER_TOOL} from "../src/core/policy/prompts.js";
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
};

function createScopedTools(): ScopedTools {
  const scoped = new Map<string, ScopedTool>();
  return {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
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
    names: () => [...scoped.keys()],
    get: (name: string) => scoped.get(name),
  };
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
  const scopedTools = createScopedTools();
  // A real session header carries its own id (`sessionIdOfHeader` reads it, and
  // the ticket-147 resume check goes through the projection unit's `init`).
  const header = {
    id,
    parentSession: topLevel ? null : (opts?.parentSessionId ?? "parent-x"),
    delegationDepth: depth,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
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
  readonly meta: Record<string, unknown>;
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
   * ADR-0032: a session the host re-creates keeps the shape it was created
   * with. A DISPATCHER (durably marked) was created as a TOP-LEVEL session, so
   * its resume is parentless at depth 0 — it lands in the host's parentless
   * branch, exactly like a user chat coming back. A WORKER was created as a
   * subagent child of its spawning dispatcher, so it resumes parented at
   * parent depth + 1. The durable dispatcher mark is what tells them apart;
   * nothing in memory survives the restart being modelled.
   */
  const resumeTarget = (sender: AgentLike, target: string): void => {
    if (agentsById.has(target)) return;
    const durablyDispatcher =
      storage.get(DISPATCHER_SESSION_TABLE_NAME)?.has(target) === true;
    const parentSessionId = String(sender.session.id);
    const parentDepth = sender.session.header?.delegationDepth ?? 0;
    const resumed = durablyDispatcher
      ? createScopedAgent(target, { topLevel: true })
      : createScopedAgent(target, {
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
    inject(services: readonly string[], callback: (child: unknown) => void) {
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
       * Ticket 138: the installed host's `sendMessage` cold-resumes an absent
       * child (`docs/research/dsh-adapter-api-notes.md:83`: "steers nearest
       * step if running; wakes if idle; cold-resumes absent child"). Modelled
       * here so wake-on-send is measured against the real seam instead of a
       * no-op: an absent target is re-created, announced with
       * `source: "resume"`, and returned as live.
       */
      async sendMessage(
        sender: AgentLike,
        targetId: unknown,
        content: Array<{ type?: string; text?: string }>,
      ) {
        const target = String(targetId);
        const text = content.map((block) => block.text ?? "").join("");
        sendMessageCalls.push({
          senderSessionId: String(sender.session.id),
          targetId: target,
          text,
        });
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
      async create(options: {
        sessionId: string;
        meta?: Record<string, unknown>;
        agentOptions?: unknown;
        setup?: (agentCtx: unknown, agent: AgentLike) => void | Promise<void>;
        signal?: unknown;
      }) {
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
          typeof options.meta?.["cwd"] === "string"
            ? String(options.meta["cwd"])
            : undefined;
        const child = createScopedAgent(childId, {
          topLevel: true,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(route !== undefined ? { route } : {}),
        });
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
            return {
              get: (key: string) => store.get(key) as unknown,
              entries: () => store.entries() as unknown,
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

// The scoped dispatcher surface: the eight dispatcher tools plus the
// ticket-145 per-session recall, which registers on the same agent scope.
// This is the USER-STARTED (chief of staff) set — the human's own chat.
const DISPATCHER_TOOL_SET = [
  "await_agent",
  "check_workers",
  "deliver_result",
  "message_agent",
  "recall",
  "spawn_dispatcher",
  "spawn_worker",
  "steer_worker",
  "stop_worker",
];

/**
 * Ticket 176 (owner ruling 2026-11-03): a summoned dispatcher is a TEAM
 * LEADER and may not summon further dispatchers. Its surface is the same set
 * minus `spawn_dispatcher` — the tool is not registered at all, so the model
 * never sees the name (ADR-0019: visibility is the fence).
 */
const SPAWNED_DISPATCHER_TOOL_SET = DISPATCHER_TOOL_SET.filter(
  (name) => name !== "spawn_dispatcher",
);

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
    assert.deepEqual(Object.keys(call.meta), []);
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
    // The child's OWN scope holds the spawned-class dispatcher set — everything
    // the user-started class has EXCEPT `spawn_dispatcher` (ticket 176).
    assert.deepEqual(
      child.agent.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    assert.ok(!child.agent.scopedTools.names().includes(SPAWN_DISPATCHER_TOOL));
    // …nothing leaked into the creator's scope or the global layer…
    assert.equal(creator.scopedTools.names().length, 9);
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

    // The host resolves the bound parent from `parentSessionId`, so a wrong
    // binding would throw "no parent agent bound for session …".
    const worker = await callScoped(child.agent, "spawn_worker", {
      stream_key: "migrate",
      title: "Migration",
      prompt: "Do the migration.",
    });
    assert.equal(worker.ok, true, JSON.stringify(worker));
    const workerId = String(worker.worker_id);

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

    // Per-session rosters: the creator sees no worker; the child sees its own.
    const creatorRoster = await callScoped(creator, "check_workers", {});
    assert.deepEqual(
      (creatorRoster.rows as Array<{ worker_id: string }>).map((r) => r.worker_id),
      [],
    );
    const childRoster = await callScoped(child.agent, "check_workers", {});
    assert.deepEqual(
      (childRoster.rows as Array<{ worker_id: string }>).map((r) => r.worker_id),
      [workerId],
    );

    // The settle wake targets the owning dispatcher only.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "Migration done." }],
    });
    await drain();
    // ADR-0032 re-based this count. Under the subagent shape the child's first
    // turn came from the subagent runtime, so `followed` held the wake alone
    // (1). A top-level summoned dispatcher is handed its first turn through
    // `agent.followup` — the same seam every wake uses — so the spawn prompt is
    // followup #1 and the settle wake is #2. Asserting 1 here would pin the
    // retired shape; the wake is still owned by the child, which is what the
    // second entry proves.
    assert.equal(child.agent.followed.length, 2, "spawn prompt, then the child's own worker wake");
    assert.ok(
      textOf(child.agent.followed[0]).includes("Own the second half."),
      "followup #1 is the spawn prompt",
    );
    assert.ok(
      textOf(child.agent.followed[1]).includes(workerId),
      "followup #2 is the settle wake for the child's own worker",
    );
    assert.equal(creator.followed.length, 0, "the creator is not woken");
  });

  it("deactivating the child tears down its tool surface and releases its awaits", async () => {
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

    const worker = await callScoped(child.agent, "spawn_worker", {
      stream_key: "k",
      title: "T",
      prompt: "P",
    });
    const workerId = String(worker.worker_id);

    // Park a real bounded await on the child's own worker.
    const pending = callScoped(child.agent, "await_agent", {
      target: workerId,
      timeout_ms: 60_000,
    });

    // The host dispose path — the same one the UI delete affordance takes.
    ctx.fire("agent/disposed", { agent: child.agent });

    const awaited = await pending;
    assert.equal(awaited.ok, true);
    assert.equal(awaited.status, "released");
    assert.equal(awaited.reason, "stopped");

    // That session's surface is gone; the creator's is untouched (ADR-0019).
    assert.deepEqual(child.agent.scopedTools.names(), []);
    assert.equal(creator.scopedTools.names().length, 9);
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
    // class carries 8 scoped tools, not 9 — `spawn_dispatcher` is withheld.
    assert.equal(child.agent.scopedTools.names().length, 8);
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

  it("a cold-resumed child marked as a dispatcher is re-activated: role, 8 scoped tools, one policy inject (ticket 130)", async () => {
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
    second.agentsById.set(dispatcherId, resumedChild);
    // The host's boot order: the user's own chat activates first, which warms
    // the durable mark mirror; only then is the resumed session announced.
    const creatorTwo = createScopedAgent("chat-2");
    await activateDispatcher(second, creatorTwo);

    second.fire("agent/created", {
      agent: resumedChild,
      source: "resume",
    });
    await drain();

    // Role: the session is a live dispatcher again — the core's peer fence
    // and its await classification both say so.
    const awaited = await callScoped(creatorTwo, "await_agent", {
      target: dispatcherId,
      timeout_ms: 0,
    });
    assert.equal(awaited.reason, "not-awaitable", JSON.stringify(awaited));

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
   * A send to a marked dispatcher that is NOT live must be accepted and must
   * wake it: the adapter cold-resumes the child through the host's own
   * `subagents.sendMessage` (the documented resume seam), the host announces
   * `agent/created` with `source: "resume"`, ticket 130's activation path
   * brings the dispatcher surface back, and the parked wake turn delivers the
   * peer message. A target with NO mark keeps the ticket-70 refusal.
   */
  it("a send to a marked dispatcher that is not live cold-resumes and wakes it (ticket 138)", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    // The mark now records the spawner — the sender a cold resume needs.
    const marks = await readMarks(storage);
    assert.equal(
      (marks.get(dispatcherId) as { parentSessionId?: string })
        .parentSessionId,
      "chat-1",
    );

    // ── process restart ────────────────────────────────────────────────
    // Same storage, fresh plugin + host. NOTHING re-announces the child:
    // the send is the only thing that can bring it back.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    await drain();
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);
    assert.equal(second.children.length, 0, "the child is not live yet");

    const sent = await callScoped(creatorTwo, "message_agent", {
      target: dispatcherId,
      text: "Pick the work back up.",
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    if (!sent.ok) return;
    assert.equal(sent.delivered_as, "peer");
    await drain();

    // (a) The resume went through the host's own seam, from the SPAWNER.
    assert.equal(second.sendMessageCalls.length, 1);
    const resume = second.sendMessageCalls[0];
    assert.ok(resume);
    assert.equal(resume.targetId, dispatcherId);
    assert.equal(resume.senderSessionId, "chat-1");
    // The payload is the resume cue, never the peer text — the peer message
    // rides the parked wake turn, so it is not delivered twice.
    assert.ok(resume.text.includes("resumed"));
    assert.ok(!resume.text.includes("Pick the work back up."));

    // (b) The child exists again and came back AS A DISPATCHER — and, ticket
    // 176, as the SPAWNED class: no `spawn_dispatcher` on its surface.
    const resumed = second.children.find((child) => child.id === dispatcherId);
    assert.ok(resumed, "the host's sendMessage resumed the child");
    assert.deepEqual(
      resumed.agent.scopedTools.names().sort(),
      SPAWNED_DISPATCHER_TOOL_SET,
    );
    assert.equal(resumed.agent.injected.length, 1);

    // (c) It received the peer message as its wake turn, with the structured
    // agent-message origin — not as user input.
    assert.equal(resumed.agent.followed.length, 1);
    const wake = resumed.agent.followed[0] as {
      content?: Array<{ text?: string }>;
      source?: { kind?: string; senderSessionId?: string };
    };
    const wakeText = textOf(wake);
    assert.ok(wakeText.includes("Pick the work back up."));
    assert.equal(wake.source?.kind, "agent-message");
    assert.equal(wake.source?.senderSessionId, "chat-1");
    // Exactly one activation: a second resume would throw on the scoped
    // registry (duplicate tool names) or add a second policy inject.
    assert.equal(resumed.agent.injected.length, 1);
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

    const spawned = await callScoped(creator, "spawn_worker", {
      stream_key: "migrate",
      title: "Migration",
      prompt: "Do it.",
    });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const workerId = String(spawned.worker_id);

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

    const spawned = await callScoped(creator, "spawn_worker", {
      stream_key: "migrate",
      title: "Migration",
      prompt: "Do it.",
    });
    const workerId = String(spawned.worker_id);
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
    const spawned = await callScoped(creator, "spawn_worker", {
      stream_key: "migrate",
      title: "Migration",
      prompt: "Do the migration.",
    });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const workerId = String(spawned.worker_id);
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
    // record, which is exactly why the id needs the durable wake row.
    const holdsBefore = await callScoped(creatorTwo, "check_workers", {});
    assert.deepEqual(holdsBefore.rows, []);
    assert.equal(second.children.length, 0, "the worker is not live yet");

    const sent = await callScoped(creatorTwo, "message_agent", {
      target: workerId,
      text: "Pick the migration back up.",
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    if (!sent.ok) return;
    assert.equal(sent.delivered_as, "steer");
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
    assert.ok(!resume.text.includes("Pick the migration back up."));

    // (b) The worker exists again and was composed as a WORKER: no dispatcher
    // tools, its own reply tool, and the contract section on its scope.
    const resumed = second.children.find((child) => child.id === workerId);
    assert.ok(resumed, "the host's sendMessage resumed the worker");
    assert.deepEqual(resumed.agent.scopedTools.names().sort(), [
      "recall",
      "reply_to_dispatcher",
    ]);
    assert.deepEqual(resumed.agent.scopedSections, [WORKER_PERSONA_SECTION]);
    assert.equal(resumed.agent.injected.length, 0, "no dispatcher policy");

    // (c) The correction was delivered as its own message, exactly once, with
    // the parent-correction wrapper a live steer gets.
    const delivered = second.sendMessageCalls.filter(
      (call) => call.text.includes("Pick the migration back up."),
    );
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0]?.text.includes("[Parent correction]"));

    // (d) The core's unknown-state hold became a live roster record.
    const roster = await callScoped(creatorTwo, "check_workers", {});
    assert.deepEqual(
      (roster.rows as Array<{ worker_id: string }>).map((row) => row.worker_id),
      [workerId],
    );

    // Depth is the persisted one, not recomputed.
    assert.equal(
      resumed.agent.session.header?.delegationDepth,
      workerDepth ?? 1,
    );
  });

  it("an UNMARKED dead worker keeps the fence: unknown-worker from steer_worker, nothing resumed", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    const steered = await callScoped(creator, "steer_worker", {
      worker_id: "never-spawned-worker",
      message: "try harder",
    });
    assert.equal(steered.ok, false);
    assert.equal(steered.reason, "unknown-worker");
    assert.equal(ctx.sendMessageCalls.length, 0);
    assert.equal(ctx.children.length, 0);

    const messaged = await callScoped(creator, "message_agent", {
      target: "never-spawned-worker",
      text: "hello?",
    });
    assert.equal(messaged.ok, false);
    assert.equal(messaged.reason, "unknown-target");
    assert.equal(ctx.sendMessageCalls.length, 0);
  });

  it("a LIVE worker takes the unchanged steer path — no resume, no re-composition", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    const spawned = await callScoped(creator, "spawn_worker", {
      stream_key: "migrate",
      title: "Migration",
      prompt: "Do the migration.",
    });
    const workerId = String(spawned.worker_id);
    await drain();
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
