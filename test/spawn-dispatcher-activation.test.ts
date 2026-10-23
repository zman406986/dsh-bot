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
 * Pinned here:
 * 1. `spawn_dispatcher` reaches the host seam; the host RESERVES the child id
 *    and the child is activated through the non-gated path — `activate()`
 *    still refuses non-top-level agents for user chats.
 * 2. The child registers the dispatcher tool set on ITS OWN scope (not the
 *    creator's, not the global layer) and receives the dispatcher policy.
 * 3. `isDispatcherSession(child)` is true (observable through peer-send
 *    liveness and `await_agent`'s `not-awaitable`), and the child spawns a
 *    worker under its own session while keeping wake state separate.
 * 4. No recursion gate of ours: the depth derivation is what the host reads,
 *    and the host's own rule is what refuses a hop past a ceiling. The
 *    second-level dispatcher spawn is ADMITTED — recorded, because the
 *    ticket expected a refusal there (finding in the ticket comment).
 * 5. Deactivating the child tears down its tool surface and cancels its
 *    awaits (ticket 115's `cancelWaits` rides the same path).
 * 6. The `pendingSpawns` race is closed: a dispatcher spawn racing a worker
 *    spawn from the SAME parent composes the worker and activates the
 *    dispatcher — matched by reserved identity, never by the shared counter.
 * 7. Identity probe on the HOST's own facts: no `agentPreset` mark, no
 *    `sessionKind` — nothing there says "dispatcher".
 * 8. Ticket 130: a spawned dispatcher DOES carry our own durable mark, and a
 *    cold-resumed child is re-activated from it — role, scoped surface, and
 *    policy — exactly once, while an unmarked child stays a plain subagent.
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
  type ToolsLike,
} from "../src/adapter/index.js";
import { resolveSessionKind } from "../src/client/session-kind.js";
import { DISPATCHER_SESSION_TABLE_NAME, WORKER_SESSION_TABLE_NAME } from "../src/adapter/durable-marker.js";
import { SPAWN_DISPATCHER_TOOL, buildDispatcherPolicySection } from "../src/core/policy/prompts.js";
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

interface ScopedAgentOptions {
  topLevel?: boolean;
  depth?: number;
  parentSessionId?: string;
  withScopedCtx?: boolean;
  /** Header preset fact, when the test wants to model the installed host. */
  agentPreset?: string;
}

function createScopedAgent(id: string, opts?: ScopedAgentOptions): ScopedAgent {
  const topLevel = opts?.topLevel ?? true;
  const depth = opts?.depth ?? (topLevel ? 0 : 1);
  const injected: unknown[] = [];
  const followed: unknown[] = [];
  const sections: string[] = [];
  const scopedTools = createScopedTools();
  const header = {
    parentSession: topLevel ? null : (opts?.parentSessionId ?? "parent-x"),
    delegationDepth: depth,
    ...(opts?.agentPreset !== undefined
      ? { agentPreset: opts.agentPreset }
      : {}),
    ...(topLevel ? {} : { origin: "subagent" as const }),
  };
  const agent: ScopedAgent = {
    session: { id, header },
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
  const commands = new Map<string, CommandDefinitionLike>();
  const globalTools = new Map<string, ScopedTool>();
  const disposers: Array<() => void> = [];
  const startActivationCalls: ActivationSpecLike[] = [];
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

  /** Ticket 138/142: the host's cold-resume of an absent child. */
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
    // No settings service and no projection registry in this stub.
    inject() {},
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
          // Ticket 118 identity probe: the installed host copies the parent's
          // composed preset into the child header (`childSessionMeta`,
          // dsh-subagent/lib/index.js:346-356) and appends
          // `agent-preset/selected` only for an INDEPENDENT selection, which
          // mitosis never makes. Modelled so the probe measures the real
          // shape instead of a friendlier one.
          ...(spec.request.parent.session.header?.agentPreset !== undefined
            ? {
                agentPreset: String(
                  spec.request.parent.session.header.agentPreset,
                ),
              }
            : {}),
        });
        children.push({ id: childId, agent: child });
        agentsById.set(childId, child);
        if (sabotageNext) {
          sabotageNext = false;
          // A hostile scoped registry: every registration throws, exactly as
          // a real conflict would.
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

const DISPATCHER_TOOL_SET = [
  "await_agent",
  "check_workers",
  "deliver_result",
  "message_agent",
  "spawn_dispatcher",
  "spawn_worker",
  "steer_worker",
  "stop_worker",
];

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

    // The activation request is chunk 1's shape plus chunk 3's reservation.
    assert.equal(ctx.startActivationCalls.length, 1);
    const spec = ctx.startActivationCalls[0] as ActivationSpecLike;
    assert.equal(spec.provider, "spawn");
    assert.equal(spec.delivery, "parent");
    assert.equal("agentPreset" in spec, false);
    assert.equal("agentPreset" in spec.request, false);
    assert.equal(spec.request.maxDepth, 2);
    // Reserved before the spawn: the id the activation path binds is the id
    // the host was told to use.
    assert.equal(String(spec.childId), dispatcherId);

    const child = ctx.children[0] as StubChild;
    assert.equal(child.id, dispatcherId);
    // The child's OWN scope holds the full dispatcher set…
    assert.deepEqual(child.agent.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
    // …nothing leaked into the creator's scope or the global layer…
    assert.equal(creator.scopedTools.names().length, 8);
    assert.deepEqual(ctx.globalToolNames(), ["request_access"]);
    // …and the dispatcher policy was injected (ADR-0025 decision 1-2).
    assert.equal(child.agent.injected.length, 1);
    assert.ok(textOf(child.agent.injected[0]).includes("# Multitask dispatcher"));
    // A dispatcher child is NOT composed as a worker: no contract, no barrier.
    assert.ok(!child.agent.scopedSections.includes(WORKER_PERSONA_SECTION));
  });

  it("the spawned origin reaches the policy text; the user-started text is untouched (ticket 141)", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;

    const creatorPolicy = textOf(creator.injected[0]);
    const childPolicy = textOf(child.agent.injected[0]);

    // The user-started dispatcher keeps the original opener and delivery line.
    assert.ok(
      creatorPolicy.includes(
        "You are the user's main assistant in this chat.",
      ),
    );
    assert.ok(creatorPolicy.includes("Only you deliver."));
    assert.ok(!creatorPolicy.includes("Another dispatcher summoned you."));

    // The summoned dispatcher is told what it is, and where its results go.
    assert.ok(
      childPolicy.includes("Another dispatcher summoned you."),
      "the child policy names the summoner",
    );
    assert.ok(
      childPolicy.includes(
        "your results go back to that dispatcher, not to a user",
      ),
    );
    assert.ok(
      !childPolicy.includes("You are the user's main assistant in this chat."),
      "the child is never told it is the user's assistant",
    );
    assert.ok(
      !childPolicy.includes("Only you deliver."),
      "the child is never told it owns the user channel",
    );

    // Both surfaces carry the same eight dispatcher tools.
    assert.deepEqual(creator.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
    assert.deepEqual(child.agent.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
  });

  it("a cold-resumed child is re-activated with the spawned wording (ticket 141)", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    const resumedChild = createScopedAgent(dispatcherId, {
      topLevel: false,
      parentSessionId: "chat-1",
      agentPreset: "standard",
    });
    second.agentsById.set(dispatcherId, resumedChild);
    second.fire("agent/created", { agent: resumedChild, source: "resume" });
    await drain();

    const policy = textOf(resumedChild.injected[0]);
    assert.ok(policy.includes("Another dispatcher summoned you."));
    assert.ok(!policy.includes("You are the user's main assistant in this chat."));
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

  it("the child is a live dispatcher session for the core (peer send accepted, await refused not-awaitable)", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    const spawn = await spawnPeer(creator);
    const dispatcherId = String(spawn.dispatcher_id);
    const child = ctx.children[0] as StubChild;

    // sendPeer refuses `unknown-target` unless the target is a live
    // dispatcher session (the plugin wires `lifecycle.isDispatcherSession`).
    const accepted = await callScoped(creator, "message_agent", {
      target: dispatcherId,
      text: "Status?",
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    // `not-awaitable` is only produced for a session the core knows is a
    // dispatcher — an unknown id gets `unknown-target` instead.
    const awaited = await callScoped(creator, "await_agent", {
      target: dispatcherId,
      timeout_ms: 0,
    });
    assert.equal(awaited.ok, false);
    assert.equal(awaited.reason, "not-awaitable");

    // And the child can address its creator.
    const reply = await callScoped(child.agent, "message_agent", {
      target: "chat-1",
      text: "Working on it.",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
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

    assert.equal(ctx.startActivationCalls.length, 2);
    const workerSpec = ctx.startActivationCalls[1] as ActivationSpecLike;
    assert.equal(String(workerSpec.request.parent.session.id), child.id);
    assert.equal(workerSpec.request.parent.session.header?.delegationDepth, 1);
    // The child's own worker hop stays inside the ceiling granted at ITS
    // spawn (parent depth 1 + leaf budget 0 = 2).
    assert.equal(workerSpec.request.maxDepth, 2);

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
    assert.equal(child.agent.followed.length, 1, "the child owns its worker's wake");
    assert.equal(creator.followed.length, 0, "the creator is not woken");
  });

  it("no recursion gate of ours: a second-level dispatcher spawn is admitted, and the host depth rule is what refuses a hop past a ceiling", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;

    // The child carries the FULL dispatcher surface, `spawn_dispatcher`
    // included: we hide nothing, so the only question is what the host does.
    assert.ok(child.agent.scopedTools.names().includes(SPAWN_DISPATCHER_TOOL));

    // FACT (verified against the installed host's `resolveChildDepth`): the
    // depth ceiling is recomputed on EVERY hop from the parent's own depth,
    // so `parentDepth + 2` keeps admitting dispatcher hops. A second-level
    // dispatcher spawn therefore SUCCEEDS — the ticket's expectation that the
    // ceiling refuses it is not what the shipped derivation does. Recorded as
    // a finding; no gate of ours is added to manufacture the refusal
    // (ADR-0025: no recursion-limit).
    const second = await spawnPeer(child.agent, "Grandchild", "Own the slice.");
    assert.equal(second.ok, true, JSON.stringify(second));
    const grandchild = ctx.children[1] as StubChild;
    assert.equal(grandchild.agent.session.header.delegationDepth, 2);
    // Its own ceiling was derived from the CHILD's depth (1): +2 = 3, which
    // still admits the grandchild's worker hop at depth 3.
    assert.equal(ctx.startActivationCalls.at(-1)?.request.maxDepth, 3);

    // The wall the ceiling DOES hold, at the host boundary: a hop that
    // outruns its own ceiling is refused by the host's rule, never by us.
    // This is exactly the ADR's "+1 would be wrong" consequence — a depth-1
    // child admitted with maxDepth 1 cannot create its depth-2 worker.
    await assert.rejects(
      ctx.subagents.startActivation({
        provider: "spawn",
        label: "past the ceiling",
        request: {
          prompt: [{ type: "text", text: "x" }],
          parent: child.agent as AgentLike,
          maxDepth: 1,
        },
        signal: new AbortController().signal,
        delivery: "parent",
      }),
      /subagent depth 2 exceeds maxDepth 1/,
    );
    // The derivation our own spawn path sends for that hop is 3 (child depth
    // 1 + 2), so the refusal above is unreachable from `spawn_dispatcher`:
    // the ceiling is always raised past the hop it is about to admit.
    const grandchildSpawnSpec = ctx.startActivationCalls.find(
      (spec) => spec.label === "Grandchild",
    );
    assert.equal(grandchildSpawnSpec?.request.maxDepth, 3);
  });

  it("deactivating the child tears down its tool surface and releases its awaits", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;
    assert.deepEqual(child.agent.scopedTools.names().sort(), DISPATCHER_TOOL_SET);

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
    assert.equal(creator.scopedTools.names().length, 8);
  });

  it("a dispatcher spawn racing a worker spawn from the same parent composes the worker and activates the dispatcher", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    // Park the FIRST announcement, then start both spawns from one parent.
    ctx.holdNextActivation();
    const workerPending = callScoped(creator, "spawn_worker", {
      stream_key: "race",
      title: "Worker",
      prompt: "P",
    });
    await tick();

    // The dispatcher spawn resolves its announcement first, while the worker
    // spawn is still in flight — `pendingSpawns` for this parent is 1.
    const dispatcherSpawn = await spawnPeer(creator, "Racing peer", "Own it.");

    // Release the held worker announcement and let both spawns finish.
    ctx.releaseHeld();
    const worker = await workerPending;
    assert.equal(worker.ok, true, JSON.stringify(worker));

    const workerChild = ctx.children.find(
      (entry) => entry.id === String(worker.worker_id),
    );
    const dispatcherChild = ctx.children.find(
      (entry) => entry.id === String(dispatcherSpawn.dispatcher_id),
    );
    assert.ok(workerChild, "the worker child exists");
    assert.ok(dispatcherChild, "the dispatcher child exists");

    // Identity, not a counter: the worker got the contract and the barrier
    // and no dispatcher tools; the dispatcher got the full dispatcher set and
    // none of the worker composition.
    assert.ok(
      workerChild.agent.scopedSections.includes(WORKER_PERSONA_SECTION),
      "the worker is composed as a worker",
    );
    // A worker's scope holds ONLY its own reply tool (ticket 122) — never a
    // dispatcher tool, never `spawn_dispatcher`.
    assert.deepEqual(workerChild.agent.scopedTools.names(), [
      "reply_to_dispatcher",
    ]);
    assert.ok(
      !dispatcherChild.agent.scopedSections.includes(WORKER_PERSONA_SECTION),
      "the dispatcher child is never composed as a worker",
    );
    assert.deepEqual(
      dispatcherChild.agent.scopedTools.names().sort(),
      DISPATCHER_TOOL_SET,
    );
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
    // name rule (and would double-inject the policy).
    assert.equal(child.agent.scopedTools.names().length, 8);
    assert.equal(child.agent.injected.length, 1);
  });

  it("a stub host that announces no agent/created still activates from the agents registry", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    // No `agent/created` at all — the fallback path is the only one left.
    ctx.setAnnounceChildren(false);

    const spawn = await spawnPeer(creator, "Unannounced peer", "Own it.");
    const child = ctx.children[0] as StubChild;
    assert.equal(child.id, String(spawn.dispatcher_id));
    assert.deepEqual(child.agent.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
    assert.equal(child.agent.injected.length, 1);
  });

  it("activation failure never turns a successful spawn into a host refusal", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    // The host accepts the child, then the child's own scope rejects the
    // dispatcher registration (a hostile registry). The honest outcome is a
    // successful spawn and a live-but-inert child — never `host-refused`,
    // which would tell the model nothing started while a live child exists.
    ctx.sabotageNextChildRegistration();

    const spawned = await spawnPeer(creator, "Fragile peer", "Own it.");

    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    const child = ctx.children[0] as StubChild;
    assert.equal(child.id, String(spawned.dispatcher_id));
    // Nothing registered, and the child is still spelled out in the ack the
    // model reads (the ack is about the spawn, which did happen).
    assert.deepEqual(child.agent.scopedTools.names(), []);
    assert.match(String(spawned.note), /Fragile peer/);
  });

  it("a child whose surface registration failed does not release a sibling's request_access hold", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    // Two live sessions hold the global worker ask tool (refcount 2).
    const sibling = createScopedAgent("chat-2");
    await activateDispatcher(ctx, sibling);
    assert.deepEqual(ctx.globalToolNames(), ["request_access"]);

    // A spawned child whose scoped registry throws: its activation aborts
    // before acquiring the global tool.
    ctx.sabotageNextChildRegistration();
    await spawnPeer(creator, "Fragile peer", "Own it.");
    const fragile = ctx.children[0] as StubChild;
    assert.deepEqual(fragile.agent.scopedTools.names(), []);

    // Disposing the fragile child must not decrement the shared refcount —
    // the two live dispatchers still hold it.
    ctx.fire("agent/disposed", { agent: fragile.agent });
    assert.deepEqual(
      ctx.globalToolNames(),
      ["request_access"],
      "a sibling dispatcher still holds request_access",
    );

    // Both real sessions still work; disposing them does release it.
    ctx.fire("agent/disposed", { agent: sibling });
    assert.deepEqual(ctx.globalToolNames(), ["request_access"]);
    ctx.fire("agent/disposed", { agent: creator });
    assert.deepEqual(ctx.globalToolNames(), []);
  });

  it("identity probe: the HOST's own facts carry no dispatcher mark (reduced shape)", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1", { agentPreset: "standard" });
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator);
    const child = ctx.children[0] as StubChild;
    const header = child.agent.session.header as {
      origin?: string;
      delegationDepth?: number;
      agentPreset?: string;
    };

    // What the child DOES carry durably: the host's own subagent facts.
    assert.equal(header.origin, "subagent");
    assert.equal(header.delegationDepth, 1);
    // It inherits the parent's composition preset (mitosis passes no
    // `agentPreset`), so ADR-0027's `agentPreset === 'multitask-dispatcher'`
    // condition cannot hold — there is no dispatcher preset row.
    assert.equal(header.agentPreset, "standard");

    // `sessionKind` is absent: a spawned child never runs `/dsh-bot`, so the
    // projection folds no command pair for it.
    const projected = {
      origin: "subagent",
      projectionValues: {
        sessionKind: null,
        agentPreset: header.agentPreset,
      },
    };
    // The client therefore renders the child as a WORKER, never a dispatcher.
    assert.equal(resolveSessionKind(projected), "worker");
    assert.notEqual(resolveSessionKind(projected), "dispatcher");

    // None of the HOST's own facts says "dispatcher". Ticket 130 adds OUR own
    // durable mark (see the cases below) — it is not derived from any field
    // above, which is why this probe stays pinned: no marker was invented out
    // of the host's vocabulary.
    const stillLive = await callScoped(creator, "await_agent", {
      target: child.id,
      timeout_ms: 0,
    });
    assert.equal(stillLive.reason, "not-awaitable");
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
    const depth = (first.children[0] as StubChild).agent.session.header
      ?.delegationDepth;

    // ── process restart ────────────────────────────────────────────────
    // A NEW plugin instance and a NEW host over the SAME storage tables. The
    // child is re-announced by the host as a resumed session — the shape the
    // installed host emits for a cold-resumed continuable child.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    const resumedChild = createScopedAgent(dispatcherId, {
      topLevel: false,
      // The persisted depth, untouched by this ticket: nothing recomputes it.
      depth: depth ?? 1,
      parentSessionId: "chat-1",
      agentPreset: "standard",
    });
    second.agentsById.set(dispatcherId, resumedChild);

    second.fire("agent/created", {
      agent: resumedChild,
      source: "resume",
    });
    await drain();

    // Role: the session is a live dispatcher again — the core's peer fence
    // and its await classification both say so.
    const creatorTwo = createScopedAgent("chat-2");
    await activateDispatcher(second, creatorTwo);
    const awaited = await callScoped(creatorTwo, "await_agent", {
      target: dispatcherId,
      timeout_ms: 0,
    });
    assert.equal(awaited.reason, "not-awaitable", JSON.stringify(awaited));

    // Tool surface: the eight dispatcher tools re-registered in the CHILD's
    // own scope.
    assert.deepEqual(
      resumedChild.scopedTools.names().sort(),
      DISPATCHER_TOOL_SET,
    );
    // Policy: injected exactly once.
    const policyInjects = resumedChild.injected
      .map(textOf)
      .filter((text) => text.includes("# Multitask dispatcher"));
    assert.equal(policyInjects.length, 1);
    // Depth untouched: the resumed header keeps its persisted value.
    assert.equal(
      resumedChild.session.header?.delegationDepth,
      depth ?? 1,
    );
  });

  it("a second resume of the same child does not double-register tools or double-inject policy (ticket 130)", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    const resumedChild = createScopedAgent(dispatcherId, {
      topLevel: false,
      parentSessionId: "chat-1",
      agentPreset: "standard",
    });
    second.agentsById.set(dispatcherId, resumedChild);

    second.fire("agent/created", { agent: resumedChild, source: "resume" });
    await drain();
    assert.equal(resumedChild.scopedTools.names().length, 8);
    assert.equal(resumedChild.injected.length, 1);

    // A second resume of the SAME session in the SAME process: still one
    // surface, still one policy. The scoped registry would throw on a
    // duplicate name, so a double registration could not pass silently.
    second.fire("agent/created", { agent: resumedChild, source: "resume" });
    await drain();
    assert.deepEqual(
      resumedChild.scopedTools.names().sort(),
      DISPATCHER_TOOL_SET,
    );
    assert.equal(resumedChild.injected.length, 1);
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

    // (b) The child exists again and came back AS A DISPATCHER.
    const resumed = second.children.find((child) => child.id === dispatcherId);
    assert.ok(resumed, "the host's sendMessage resumed the child");
    assert.deepEqual(resumed.agent.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
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

  it("a marked dispatcher that IS live takes the normal wake path — no resume, no double activation (ticket 138)", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    const spawned = await spawnPeer(creator);
    const dispatcherId = String(spawned.dispatcher_id);

    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    await drain();
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);

    // The child IS live: the host announced it (any announcement, not just a
    // resume) and ticket 130 re-activated it from the mark.
    const live = createScopedAgent(dispatcherId, {
      topLevel: false,
      parentSessionId: "chat-1",
    });
    second.agentsById.set(dispatcherId, live);
    second.fire("agent/created", { agent: live, source: "startup" });
    await drain();
    assert.equal(live.injected.length, 1);

    const sent = await callScoped(creatorTwo, "message_agent", {
      target: dispatcherId,
      text: "Still there?",
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await drain();

    // Normal path: one followup, no resume call, one activation.
    assert.equal(second.sendMessageCalls.length, 0);
    assert.equal(live.followed.length, 1);
    assert.ok(textOf(live.followed[0]).includes("Still there?"));
    assert.equal(live.injected.length, 1);
    assert.deepEqual(live.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
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

  it("generation 1 spawns 2, generation 2 spawns 3: the child's policy names the pair", async () => {
    const ctx = createActivationCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);

    // The user-started dispatcher's own text: byte-identical to the shipped
    // block, and it never mentions a generation.
    const creatorPolicy = textOf(creator.injected[0]);
    assert.equal(creatorPolicy, buildDispatcherPolicySection());
    assert.ok(!creatorPolicy.includes("generation"));

    // generation 1 → child is generation 2.
    await spawnPeer(creator, "Second", "Own the slice.");
    const child = ctx.children[0] as StubChild;
    const childPolicy = textOf(child.agent.injected[0]);
    assert.ok(
      childPolicy.includes(
        "A generation-1 dispatcher spawned you. You are the generation-2 team leader.",
      ),
      childPolicy,
    );

    // generation 2 → grandchild is generation 3, spawned BY the child.
    await spawnPeer(child.agent, "Third", "Own the next slice.");
    const grandchild = ctx.children[1] as StubChild;
    const grandchildPolicy = textOf(grandchild.agent.injected[0]);
    assert.ok(
      grandchildPolicy.includes(
        "A generation-2 dispatcher spawned you. You are the generation-3 team leader.",
      ),
      grandchildPolicy,
    );
    // The creator's text is untouched by the deeper spawn.
    assert.equal(textOf(creator.injected[0]), creatorPolicy);
  });

  it("the generation rides the mark row, one past the spawner's", async () => {
    const storage: StorageTables = new Map();
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(ctx, creator);
    await spawnPeer(creator, "Second", "Own the slice.");
    const child = ctx.children[0] as StubChild;
    await spawnPeer(child.agent, "Third", "Own the next slice.");
    const grandchild = ctx.children[1] as StubChild;

    const marks = await readMarks(storage);
    assert.equal(marks.get(String(child.agent.session.id))?.generation, 2);
    assert.equal(
      marks.get(String(grandchild.agent.session.id))?.generation,
      3,
    );
  });

  it("a cold-resumed grandchild keeps generation 3, with no parent activated in the new process", async () => {
    const storage: StorageTables = new Map();
    const first = createActivationCtx(storage);
    apply(first, volatileConfig({ enabled: true }));
    const creator = createScopedAgent("chat-1");
    await activateDispatcher(first, creator);
    await spawnPeer(creator, "Second", "Own the slice.");
    const child = first.children[0] as StubChild;
    await spawnPeer(child.agent, "Third", "Own the next slice.");
    const grandchild = first.children[1] as StubChild;
    const grandchildId = String(grandchild.agent.session.id);
    const childId = String(child.agent.session.id);

    // ── process restart ────────────────────────────────────────────────
    // Storage survives; plugin + host state does not. NOTHING is activated
    // in the new process — the resumed child alone must resolve its number.
    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    assert.equal(second.children.length, 0);

    const resumed = createScopedAgent(grandchildId, {
      topLevel: false,
      depth: 2,
      parentSessionId: childId,
      agentPreset: "standard",
    });
    second.agentsById.set(grandchildId, resumed);
    second.fire("agent/created", { agent: resumed, source: "resume" });
    await drain();

    const policy = textOf(resumed.injected[0]);
    assert.ok(
      policy.includes(
        "A generation-2 dispatcher spawned you. You are the generation-3 team leader.",
      ),
      policy,
    );
    // Re-activated as a dispatcher, not degraded to a plain subagent.
    assert.deepEqual(resumed.scopedTools.names().sort(), DISPATCHER_TOOL_SET);
  });

  it("a pre-141 mark row without a generation activates as generation 2, no throw", async () => {
    const storage: StorageTables = new Map();
    // A row written by the old code: session id only, no generation field.
    storage.set(
      DISPATCHER_SESSION_TABLE_NAME,
      new Map<string, unknown>([["legacy-child", { sessionId: "legacy-child" }]]),
    );
    const ctx = createActivationCtx(storage);
    apply(ctx, volatileConfig({ enabled: true }));

    const legacy = createScopedAgent("legacy-child", {
      topLevel: false,
      parentSessionId: "chat-1",
    });
    ctx.agentsById.set("legacy-child", legacy);
    ctx.fire("agent/created", { agent: legacy, source: "resume" });
    await drain();

    const policy = textOf(legacy.injected[0]);
    assert.ok(
      policy.includes(
        "A generation-1 dispatcher spawned you. You are the generation-2 team leader.",
      ),
      policy,
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
    assert.deepEqual(resumed.agent.scopedTools.names(), ["reply_to_dispatcher"]);
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

  it("two sends before the worker returns coalesce: one resume, one delivered correction (the latest)", async () => {
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
    const workerId = String(spawned.worker_id);

    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    await drain();
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);

    second.holdResumes();
    const firstSend = await callScoped(creatorTwo, "message_agent", {
      target: workerId,
      text: "first instruction",
    });
    assert.equal(firstSend.ok, true, JSON.stringify(firstSend));
    const secondSend = await callScoped(creatorTwo, "message_agent", {
      target: workerId,
      text: "second instruction",
    });
    assert.equal(secondSend.ok, true, JSON.stringify(secondSend));
    // Both accepted, one resume requested (the guard), nothing delivered yet.
    assert.equal(second.sendMessageCalls.length, 1);

    await second.releaseResumes();
    await drain();

    // One resume call total, and only the LATEST correction is delivered —
    // the same last-wins rule the live steer queue applies.
    const resumeCalls = second.sendMessageCalls.filter((call) =>
      call.text.includes("resumed"),
    );
    assert.equal(resumeCalls.length, 1);
    const delivered = second.sendMessageCalls.filter(
      (call) => !call.text.includes("resumed"),
    );
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0]?.text.includes("second instruction"));
    assert.ok(!delivered[0]?.text.includes("first instruction"));
  });

  it("a second announcement of the resumed worker delivers nothing new (no double delivery)", async () => {
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
    const workerId = String(spawned.worker_id);

    const second = createActivationCtx(storage);
    apply(second, volatileConfig({ enabled: true }));
    await drain();
    const creatorTwo = createScopedAgent("chat-1");
    await activateDispatcher(second, creatorTwo);

    await callScoped(creatorTwo, "message_agent", {
      target: workerId,
      text: "resume it",
    });
    await drain();
    const afterFirst = second.sendMessageCalls.length;
    assert.equal(afterFirst, 2, "one resume + one correction");

    const resumed = second.children.find((child) => child.id === workerId);
    assert.ok(resumed);
    // The host re-announces the same live session (a second resume, a
    // reconnect): the parked slot is empty, so nothing is sent again.
    second.fire("agent/created", { agent: resumed.agent, source: "resume" });
    await drain();
    assert.equal(second.sendMessageCalls.length, afterFirst);
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
