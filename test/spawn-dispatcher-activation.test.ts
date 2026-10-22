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
 * 7. Identity probe: a spawned child carries NO durable dispatcher mark.
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
import { SPAWN_DISPATCHER_TOOL } from "../src/core/policy/prompts.js";
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
function createActivationCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const globalTools = new Map<string, ScopedTool>();
  const disposers: Array<() => void> = [];
  const startActivationCalls: ActivationSpecLike[] = [];
  const children: StubChild[] = [];
  const agentsById = new Map<string, AgentLike>();
  let nextChild = 1;
  let heldGate: (() => void) | null = null;
  let holdNext = false;
  let announceChildren = true;
  let sabotageNext = false;

  const fire = (name: string, payload: unknown): void => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      (cb as (arg: unknown) => void)(payload);
    }
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
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: {
      get: (id: unknown) => agentsById.get(String(id)),
    },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        const tables = new Map<string, Map<string, unknown>>();
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

  it("identity probe: the spawned child carries no durable dispatcher mark (reduced shape)", async () => {
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

    // The only dispatcher signal for this session is the in-memory lifecycle
    // registry (`isDispatcherSession`), which is not durable: after a restart
    // the child is a plain subagent until its creator summons it again.
    const stillLive = await callScoped(creator, "await_agent", {
      target: child.id,
      timeout_ms: 0,
    });
    assert.equal(stillLive.reason, "not-awaitable");
  });
});
