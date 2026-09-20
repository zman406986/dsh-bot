/**
 * Ticket 101 — the `/dispatcher-stop` host command (ADR-0021 decision 3:
 * dispatcher sessions can be added and deleted from our UI; "delete" =
 * deactivate the dispatcher binding, never dispose the dsh chat; exception
 * U-G amended for dispatcher sessions ONLY — worker turns stay unstoppable
 * from any UI, design-17 §4.6).
 *
 * Offline only (S8): fake AdapterContext seams (commands + tools registries,
 * listener bus, storage stub, settings provider) driving the real plugin
 * apply() and the real lifecycle — the same fakes-as-host discipline as
 * `activation-lifecycle.test.ts` (fail-loud duplicate registries, ticket 91)
 * and `restart-honesty.test.ts` (ticket 93's settings-provider shape, so the
 * roster mirror writes are observable).
 *
 * The load-bearing property under test: the command's deactivation is the
 * SAME path the host `agent/disposed` listener runs — no second deactivation
 * exists — so a command-path stop is observably indistinguishable from a
 * host-side dispose (tool surfaces, access-policy rows, prompts, roster
 * mirror; the restart-honesty and durable-roster invariants carry).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply as pluginApply } from "../src/plugin.js";
import {
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_STOP_COMMAND,
  DISPATCHER_STOP_DESCRIPTION,
  DISPATCHER_STOP_NOT_DISPATCHER,
  DISPATCHER_STOP_SUCCESS,
  DISPATCHER_STOP_UNRESOLVED,
  DISPATCHER_STEER_COMMAND,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import { rosterSessionKey } from "../src/adapter/roster-channel.js";
import { ROSTER_SETTINGS_KEY } from "../src/core/roster-snapshot.js";

/** Drain the async rebuild chain queued by activation (ticket 31 idiom). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
}

/** A per-agent scoped tool surface (ADR-0019): what the live host mints. */
interface ScopedAgent extends TestAgent {
  readonly ctx?: {
    readonly tools: ToolsLike & { registeredNames(): string[] };
  };
}

function createScopedAgent(id: string): ScopedAgent {
  const agent = createAgent(id) as ScopedAgent;
  const scoped = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  agent.ctx = {
    tools: {
      schemas: () => [...scoped.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        // Shipped rule (ticket 91): duplicate tool name throws.
        if (scoped.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered`);
        }
        scoped.set(definition.name, definition);
        return () => {
          scoped.delete(definition.name);
        };
      },
      registeredNames: () => [...scoped.keys()],
    },
  };
  return agent;
}

function createAgent(id: string): TestAgent {
  const injected: unknown[] = [];
  return {
    session: {
      id,
      header: { parentSession: null, delegationDepth: 0 },
    },
    followup() {},
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
  };
}

/**
 * Host fake (the restart-honesty idiom): commands + tools registries, the
 * listener bus, a storage stub, and the ticket-93 settings-provider shape
 * whose `update` documents are recorded so the roster mirror writes —
 * including the deactivation clear — are observable.
 */
function createStopCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const updates: unknown[] = [];
  const claimedNamespaces = new Set<string>();
  const claim = (ns: string): { update(value: unknown): Promise<void> } => {
    if (claimedNamespaces.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`);
    }
    claimedNamespaces.add(ns);
    return {
      async update(value: unknown) {
        updates.push(value);
      },
    };
  };

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    effect(execute: () => unknown) {
      const result = execute();
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) void step;
      }
    },
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (services.includes("settings")) {
        callback({
          settings: {
            register(ns: string) {
              return claim(ns);
            },
            installSection() {
              // Host shape (ticket 93): returns void.
            },
          },
        });
      }
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
      schemas: () => [...tools.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        if (tools.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered`);
        }
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    },
    subagents: {
      async startContinuable() {
        return { childId: "child-1", messageId: "msg-1" };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: () => undefined },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          async table() {
            const t = new Map<string, unknown>();
            return {
              get: (key: string) => t.get(key) as never,
              entries: () => t.entries() as never,
              async put(key: string, value: unknown) {
                t.set(key, value);
              },
              async delete(key: string) {
                return t.delete(key);
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    // Test surface.
    fire,
    updates,
    commandNames: () => [...commands.keys()],
    toolNames: () => [...tools.keys()],
    command: (name: string) => commands.get(name),
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
  return ctx as unknown as AdapterContext & {
    fire(name: string, payload: unknown): void;
    readonly updates: unknown[];
    commandNames(): string[];
    toolNames(): string[];
    command(name: string): CommandDefinitionLike | undefined;
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike;
  };
}

/**
 * Normalize mirrored documents for comparison: the roster snapshot's
 * `publishedAtMs` is the wall clock at publish, so equivalence between two
 * fakes is judged with it zeroed (JSON round-trip also drops undefined
 * fields, keeping deepEqual deterministic).
 */
function normalize(updates: readonly unknown[]): unknown[] {
  return updates.map((update) =>
    JSON.parse(
      JSON.stringify(update, (_key, value) =>
        _key === "publishedAtMs" ? 0 : value,
      ),
    ),
  );
}

/** Last value written under a session's roster mirror key. */
function mirrorValue(
  updates: readonly unknown[],
  sessionId: string,
): unknown {
  const key = rosterSessionKey(sessionId);
  let value: unknown;
  for (const update of updates as Array<Record<string, unknown>>) {
    if (update !== null && typeof update === "object" && key in update) {
      value = update[key];
    }
  }
  return value;
}

describe("dispatcher-stop — registration (ticket 101)", () => {
  it("registers alongside the other dispatcher commands, dormant, no input hint", () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });

    assert.deepEqual(ctx.commandNames(), [
      DISPATCHER_START_COMMAND,
      DISPATCHER_STEER_COMMAND,
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STOP_COMMAND,
    ]);
    const command = ctx.command(DISPATCHER_STOP_COMMAND);
    assert.ok(command);
    assert.equal(command.name, "dispatcher-stop");
    assert.equal(command.description, DISPATCHER_STOP_DESCRIPTION);
    assert.equal(command.input, undefined, "the command takes no input");
    assert.deepEqual(ctx.toolNames(), [], "dormant: no tools");
  });
});

describe("dispatcher-stop — deactivates through the dispose path", () => {
  it("deactivates the invoking chat: tools unbound, mirror cleared, re-activation works", async () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });
    const agent = createScopedAgent("s-1");

    const started = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(started, { kind: "success", text: DISPATCHER_START_SUCCESS });
    await flush();
    assert.equal(agent.ctx?.tools.registeredNames().length, 6);
    assert.ok(ctx.updates.length >= 1, "the roster snapshot was mirrored");

    const stopped = ctx.runCommand({
      commandId: DISPATCHER_STOP_COMMAND,
      agent,
    });
    assert.deepEqual(stopped, { kind: "success", text: DISPATCHER_STOP_SUCCESS });

    // The full per-session teardown (onDeactivated): the scoped tool surface
    // is unregistered and the global request_access reference is released.
    assert.deepEqual(agent.ctx?.tools.registeredNames(), []);
    assert.deepEqual(ctx.toolNames(), []);
    // The roster mirror for THIS session is cleared (null — the documented
    // "no dispatcher here anymore" value), so the client read-side drops the
    // dispatcher flag instead of rendering a deactivated session as live.
    assert.equal(
      mirrorValue(ctx.updates, "s-1"),
      null,
      "roster.s-1 mirror is cleared on stop",
    );

    // Deactivation is reversible (ADR-0021 decision 3): the chat itself was
    // never disposed, and an explicit start re-activates it.
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(again, { kind: "success", text: DISPATCHER_START_SUCCESS });
    await flush();
    assert.equal(agent.ctx?.tools.registeredNames().length, 6);
    assert.ok(
      mirrorValue(ctx.updates, "s-1") !== null,
      "the mirror carries a live snapshot again",
    );
  });

  it("a command-path stop is observably identical to a host agent/disposed", async () => {
    // Two identical fakes; the ONLY difference is how the session ends —
    // the command here, the host dispose event there. Every observable
    // (mirrored documents, scoped surface, global surface, commands) must
    // match: one deactivation path, not two.
    const viaCommand = createStopCtx();
    pluginApply(viaCommand, { enabled: true });
    const commandAgent = createScopedAgent("s-1");
    viaCommand.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: commandAgent,
    });
    await flush();
    const stopped = viaCommand.runCommand({
      commandId: DISPATCHER_STOP_COMMAND,
      agent: commandAgent,
    });
    assert.equal(stopped.kind, "success");
    await flush();

    const viaDispose = createStopCtx();
    pluginApply(viaDispose, { enabled: true });
    const disposedAgent = createScopedAgent("s-1");
    viaDispose.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: disposedAgent,
    });
    await flush();
    viaDispose.fire("agent/disposed", { agent: disposedAgent });
    await flush();

    assert.deepEqual(
      normalize(viaCommand.updates),
      normalize(viaDispose.updates),
      "identical mirror write sequences",
    );
    assert.deepEqual(
      commandAgent.ctx?.tools.registeredNames(),
      disposedAgent.ctx?.tools.registeredNames(),
    );
    assert.deepEqual(viaCommand.toolNames(), viaDispose.toolNames());
  });
});

describe("dispatcher-stop — honest refusals", () => {
  it("stopping a chat that is not an activated dispatcher is an honest no-op", async () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });
    const agent = createAgent("plain-chat");

    const result = ctx.runCommand({
      commandId: DISPATCHER_STOP_COMMAND,
      agent,
    });
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STOP_NOT_DISPATCHER,
    });
    assert.deepEqual(ctx.updates, [], "nothing was written");
    assert.deepEqual(ctx.toolNames(), [], "no tool surface appeared");
  });

  it("a second stop is refused with the same honest no-op (idempotent-honest)", async () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });
    const agent = createScopedAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await flush();

    const first = ctx.runCommand({
      commandId: DISPATCHER_STOP_COMMAND,
      agent,
    });
    assert.equal(first.kind, "success");
    const writesAfterFirst = ctx.updates.length;

    const second = ctx.runCommand({
      commandId: DISPATCHER_STOP_COMMAND,
      agent,
    });
    assert.deepEqual(second, {
      kind: "error",
      text: DISPATCHER_STOP_NOT_DISPATCHER,
    });
    assert.equal(
      ctx.updates.length,
      writesAfterFirst,
      "the refusal writes nothing",
    );
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("an invocation without a resolvable agent is refused, never guessed", () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });
    const result = ctx.runCommand({ commandId: DISPATCHER_STOP_COMMAND });
    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_STOP_UNRESOLVED,
    });
  });

  it("per-session keying: stopping one dispatcher never touches a sibling (ADR-0019)", async () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });
    await flush();

    const stopped = ctx.runCommand({
      commandId: DISPATCHER_STOP_COMMAND,
      agent: first,
    });
    assert.equal(stopped.kind, "success");

    assert.deepEqual(first.ctx?.tools.registeredNames(), []);
    assert.equal(
      second.ctx?.tools.registeredNames().length,
      6,
      "the sibling's scoped surface is untouched",
    );
    assert.deepEqual(
      ctx.toolNames(),
      ["request_access"],
      "the global access tool lives until the LAST dispatcher ends",
    );
    assert.equal(mirrorValue(ctx.updates, "s-1"), null);
    assert.notEqual(
      mirrorValue(ctx.updates, "s-2"),
      null,
      "the sibling's mirror still carries its live snapshot",
    );
    for (const update of ctx.updates as Array<Record<string, unknown>>) {
      assert.notEqual(
        update[rosterSessionKey("s-2")],
        null,
        "no clear was ever written for the sibling",
      );
    }
  });
});

describe("dispatcher-stop — the mirror clear is surgical", () => {
  it("the clear writes only the per-session mirror key, never the legacy panel key", async () => {
    const ctx = createStopCtx();
    pluginApply(ctx, { enabled: true });
    const agent = createScopedAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await flush();
    ctx.runCommand({ commandId: DISPATCHER_STOP_COMMAND, agent });

    const clearWrites = (ctx.updates as Array<Record<string, unknown>>).filter(
      (update) => rosterSessionKey("s-1") in update && update[rosterSessionKey("s-1")] === null,
    );
    assert.equal(clearWrites.length, 1);
    const clear = clearWrites[0] ?? {};
    assert.deepEqual(
      Object.keys(clear),
      [rosterSessionKey("s-1")],
      "the clear is a single-key document: the legacy roster key is not clobbered",
    );
    assert.equal(
      clear[ROSTER_SETTINGS_KEY],
      undefined,
      "the legacy panel key never receives null",
    );
  });
});
