/**
 * Ticket 19 — activation lifecycle end to end (ADR-0009, design-16 §3.3/§3.7).
 *
 * Offline only (S8): fake AdapterContext seams (commands + tools registry,
 * listener bus, storage stub) driving the real plugin apply() and the real
 * CordisDshHost. No network, no LLM, no running dsh.
 *
 * Fake-vs-host (ticket 91): the command and tool registries here (both the
 * plugin-level `ctx` and the per-agent scoped `agent.ctx.tools` surface) are
 * fail-loud on a duplicate name, like the shipped `NamedEntries` tables
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`). A double registration now
 * aborts the fake's apply/activation instead of silently overwriting.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import { DISPATCHER_TOOL_NAMES } from "../src/core/policy/prompts.js";
import {ACTIVATION_COMMAND_CARD_NO_TURN_TEXT, ACTIVATION_COMMAND_CARD_TEXT, DISPATCHER_ALREADY_HERE_MESSAGE_SENT, DISPATCHER_MESSAGE_NOT_SENT, DISPATCHER_START_ALREADY_HERE, DISPATCHER_START_COMMAND, DISPATCHER_START_INPUT_HINT, DISPATCHER_START_NOT_TOP_LEVEL, DISPATCHER_START_UNRESOLVED, DISPATCHER_STEER_COMMAND, type AdapterContext, type AgentLike, type CommandDefinitionLike, type CommandResultLike, type ToolsLike} from "../src/adapter/index.js";

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
  readonly followups: unknown[];
}

/**
 * A per-agent scoped tool surface (ADR-0019): what the live host mints per
 * agent loop. Registrations here are visible only to THIS agent. The plugin
 * refuses the retired process-global fallback, so ordinary test agents carry
 * one.
 */
interface ScopedToolSurface extends ToolsLike {
  registeredNames(): string[];
  get(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

function createScopedTools(): ScopedToolSurface {
  const scoped = new Map<
    string,
    { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  return {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
    register(definition: unknown) {
      const tool = definition as {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      };
      // Shipped rule: duplicate tool name throws
      // (dsh-tools lib/index.js:2538, NamedEntries factory).
      if (scoped.has(tool.name)) {
        throw new Error(
          `tool "${tool.name}" is already registered (for a ` +
            `per-agent variant, register through that agent's ` +
            `\`agent.ctx\` instead)`,
        );
      }
      scoped.set(tool.name, tool);
      return () => {
        scoped.delete(tool.name);
      };
    },
    registeredNames: () => [...scoped.keys()],
    get: (name) => scoped.get(name),
  };
}

interface ScopedAgent extends TestAgent {
  readonly ctx?: {
    readonly tools: ScopedToolSurface;
  };
}

function createScopedAgent(id: string): ScopedAgent {
  return createAgent(id) as ScopedAgent;
}

function createAgent(
  id: string,
  opts?: { topLevel?: boolean; withInject?: boolean; withScopedTools?: boolean },
): TestAgent & { ctx?: { tools: ScopedToolSurface } } {
  const topLevel = opts?.topLevel ?? true;
  const injected: unknown[] = [];
  const followups: unknown[] = [];
  const withScoped = opts?.withScopedTools ?? true;
  const agent: TestAgent & { ctx?: { tools: ScopedToolSurface } } = {
    session: {
      id,
      header: topLevel
        ? { parentSession: null, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup(message: unknown) {
      followups.push(message);
    },
    injected,
    followups,
    ...(withScoped
      ? { ctx: { tools: createScopedTools() } }
      : {}),
    ...(opts?.withInject === false
      ? {}
      : {
          inject(message: unknown) {
            injected.push(message);
          },
        }),
  };
  return agent;
}

function createFullCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const tables = new Map<string, Map<string, unknown>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const disposers: Array<() => void> = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; a returned
    // function — or each value a generator yields — is the unload disposer.
    // (The old inverted fake collected the passed function itself, which hid
    // the live self-unregister bug.)
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
    // Settings-section optional inject: no settings service in this stub.
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
        // Shipped rule: duplicate command name throws
        // (dsh-commands lib/index.js:82, NamedEntries factory).
        if (commands.has(definition.name)) {
          throw new Error(
            `command "${definition.name}" is already registered (for a ` +
              `per-agent variant, mount a command-injected plugin under ` +
              `that agent's \`agent.ctx\`)`,
          );
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
        // Shipped rule: duplicate tool name throws
        // (dsh-tools lib/index.js:2538, NamedEntries factory).
        if (tools.has(definition.name)) {
          throw new Error(
            `tool "${definition.name}" is already registered (for a ` +
              `per-agent variant, register through that agent's ` +
              `\`agent.ctx\` instead)`,
          );
        }
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    },
    subagents: {
      async startActivation() {
        const childId = `child-${nextChild++}`;
        return {
          childId,
          messageId: `msg-${childId}`,
          dispose: async () => {},
        };
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
          table() {
            const t = new Map<string, unknown>();
            tables.set(`t${tables.size}`, t);
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
    // Test surface
    fire,
    disposers,
    commandNames: () => [...commands.keys()],
    command: (name: string) => commands.get(name),
    toolNames: () => [...tools.keys()],
    tool: (name: string) => tools.get(name),
    listenerCount: () => {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
    },
    runCommand(
      invocation: { commandId: string; agent?: AgentLike; rawInput?: string },
    ): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return ctx as typeof ctx & AdapterContext;
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

describe("activation lifecycle — flag matrix (design-16 §3.7)", () => {
  // Ticket 32: the dormant-registration matrix. Tickets 27–31 (snapshot v2,
  // panel sections, live activity, approval UX, restart rebuild) all landed
  // after this matrix was written; the dormant surface must remain exactly
  // the host commands with the passive listeners and no tool surface. The
  // negative assertions pin the absence, so a future ticket cannot quietly
  // register a dormant-visible surface.
  it("tickets 27–31 add no dormant-visible registration: no tools, no listeners beyond the passive eight", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename).
      DISPATCHER_START_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);
    // Three lifecycle listeners (agent/disposed, agent/status, and the
    // ticket-296 `session/event` compaction/end policy restore) + five host
    // listeners (subagent/start and subagent/end native run identity,
    // session/event, agent/created — the worker
    // composition seam, passive until a spawn is in flight — and agent/disposed,
    // the resumed-user-dispatcher release from ticket 163 defect 3). Owner
    // ruling 2026-11-05: the ticket-145 racoons mount adds four more, but only
    // when `racoonsEnabled` is on — the default product is racoons-free.
    const EXPECTED_DORMANT_LISTENERS = 8;
    assert.equal(ctx.listenerCount(), EXPECTED_DORMANT_LISTENERS);
    // No dispatcher tool claims a dormant key: a stock caller sees stock.
    // The custom three come from the const; the four stock agent verbs are
    // mounted by the PRESET (never by this plugin), and they must not be
    // dormant claims of ours either.
    const STOCK_AGENT_TOOL_NAMES = [
      "subagent",
      "list_agents",
      "send_message",
      "interrupt_agent",
    ];
    for (const name of [...DISPATCHER_TOOL_NAMES, ...STOCK_AGENT_TOOL_NAMES]) {
      assert.equal(ctx.tool(name), undefined, `${name} must not be dormant`);
    }
  });
});

describe("activation lifecycle — command behavior", () => {
  it("activation binds the parent once, injects policy once, registers tools", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });

    assert.deepEqual(result, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_NO_TURN_TEXT,
    });
    assert.equal(agent.injected.length, 1);
    assert.ok(textOf(agent.injected[0]).includes("# Multitask dispatcher"));
    // Full CUSTOM dispatcher surface in the agent's OWN scope: the three
    // verbs stock DSH does not cover (workers/status/steering/stopping are the
    // preset's stock `subagent` / `list_agents` / `send_message` /
    // `interrupt_agent`, so this fixture mounts none of them). Owner ruling
    // 2026-11-05: the ticket-145 per-session `recall` is absent by default —
    // racoons is off unless `racoonsEnabled` turns it on. Ticket 174 /
    // ADR-0033 removed the global `request_access`.
    assert.deepEqual(
      agent.ctx?.tools.registeredNames().sort(),
      [...DISPATCHER_TOOL_NAMES].sort(),
    );
    // Nothing claims a process-global name.
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("the command advertises an optional message and sends it as exactly one user turn", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    const definition = ctx.command(DISPATCHER_START_COMMAND);
    assert.equal(
      definition?.input?.hint,
      DISPATCHER_START_INPUT_HINT,
      "the composer only recognizes an argument after an input descriptor",
    );

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
      // The host's rawInput carries the separator whitespace; it is not part
      // of the message.
      rawInput: "  Please triage the failing test.  ",
    });

    assert.deepEqual(result, { kind: "success", text: ACTIVATION_COMMAND_CARD_TEXT });
    assert.equal(agent.followups.length, 1, "exactly one first turn");
    const message = agent.followups[0] as {
      role?: unknown;
      content?: Array<{ text?: string }>;
      source?: { kind?: unknown; form?: unknown };
    };
    assert.equal(message.role, "user");
    assert.equal(textOf(message), "Please triage the failing test.");
    assert.deepEqual(
      message.source,
      { kind: "user" },
      "the human source kind renders it as the user's message, not a notice",
    );

    // Already active: a second argument is the user's message again, not
    // something to drop. It opens exactly one more turn carrying exactly that
    // text, and the card says so instead of printing the bare already-active
    // line. (It used to return DISPATCHER_START_ALREADY_HERE and discard the
    // text with no turn at all — the silent-drop defect this guards.)
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
      rawInput: "  a second message  ",
    });
    assert.deepEqual(again, {
      kind: "success",
      text: DISPATCHER_ALREADY_HERE_MESSAGE_SENT,
    });
    assert.equal(agent.followups.length, 2, "the second argument opened a turn");
    assert.equal(
      textOf(agent.followups[1]),
      "a second message",
      "the turn carries the argument, trimmed",
    );
    assert.equal(agent.injected.length, 1, "no second policy inject");
  });

  it("plain /dsh-bot and a whitespace-only argument stay turn-free", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const bare = createAgent("s-bare");
    const bareResult = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: bare,
    });
    assert.deepEqual(bareResult, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_NO_TURN_TEXT,
    });
    assert.equal(bare.followups.length, 0, "no argument means no turn");
    assert.equal(bare.injected.length, 1, "activation itself still happened");
    assert.equal(bare.ctx?.tools.registeredNames().length, DISPATCHER_TOOL_NAMES.length);

    const blank = createAgent("s-blank");
    const blankResult = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: blank,
      rawInput: "   \n\t ",
    });
    assert.deepEqual(blankResult, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_NO_TURN_TEXT,
    });
    assert.equal(blank.followups.length, 0, "whitespace is not a message");
  });

  it("the context-less path refuses the global fallback instead of leaking tools", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    // A host without `agent.ctx.tools` is a wiring bug. The plugin must not
    // register the dispatcher tools on the process-global registry (that
    // exposed them to every session and closed over one session id).
    const first = createAgent("s-1", { withScopedTools: false });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    assert.deepEqual(ctx.toolNames(), []);
    assert.equal(first.injected.length, 1, "activation itself still stands");

    // A second bare session is not a duplicate registration (nothing was
    // registered at all).
    const second = createAgent("s-2", { withScopedTools: false });
    assert.doesNotThrow(() =>
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second }),
    );
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("activation in a child chat is refused with not-top-level copy", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const child = createAgent("child-1", { topLevel: false });

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent: child,
      rawInput: "this must not become a turn",
    });

    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_START_NOT_TOP_LEVEL,
    });
    assert.equal(child.injected.length, 0);
    assert.equal(child.followups.length, 0, "activation failure sends no message");
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("an invocation without a resolvable agent is refused, never guessed", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
    });

    assert.deepEqual(result, {
      kind: "error",
      text: DISPATCHER_START_UNRESOLVED,
    });
    assert.deepEqual(ctx.toolNames(), []);
  });

});

/**
 * Ticket 3xx — the "/dsh-bot <question>, nothing happened" report.
 *
 * Two defects sat behind it. (a) On an already-active chat the command returned
 * the already-active line and DROPPED the argument with no turn (the early
 * return in the handler). (b) A bare activation is deliberately turn-free
 * (tickets 295/298, kept), but its card said nothing about that, so a bare
 * submission — easy to produce because the web client PICKS a claimed command
 * on Enter instead of submitting the line — left a chat that looked dead until
 * the user happened to type again.
 *
 * These are the regression guards for both, plus the failure path that used to
 * be two empty catch blocks.
 */
describe("activation lifecycle — the message argument is never dropped", () => {
  it("a bare /dsh-bot opens no turn AND the card says no turn started", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-bare-card");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });

    assert.deepEqual(result, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_NO_TURN_TEXT,
    });
    // The card must NAME the fact, not merely differ from the other card: the
    // user's only evidence that the chat is alive is this one clipped line.
    assert.match(String(result.text), /no turn started/i);
    assert.match(String(result.text), /send a message/i);
    assert.notEqual(
      result.text,
      ACTIVATION_COMMAND_CARD_TEXT,
      "the with-message card would claim a turn that never opened",
    );
    assert.equal(agent.followups.length, 0, "still turn-free: no model call");
  });

  it("a non-empty argument on an inactive chat opens exactly one turn with it", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-message");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
      rawInput: "  Find the flaky test.  ",
    });

    assert.deepEqual(result, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_TEXT,
    });
    assert.equal(agent.followups.length, 1, "exactly one turn");
    assert.equal(textOf(agent.followups[0]), "Find the flaky test.");
    assert.deepEqual(
      (agent.followups[0] as { source?: unknown }).source,
      { kind: "user" },
      "an ordinary human turn, not a plugin notice",
    );
  });

  it("a non-empty argument on an already-active chat opens a turn, never vanishes", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-active");

    // First activation: bare, so the chat is live with zero followups.
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(agent.followups.length, 0);

    const second = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
      rawInput: "And summarize what you find.",
    });
    assert.deepEqual(second, {
      kind: "success",
      text: DISPATCHER_ALREADY_HERE_MESSAGE_SENT,
    });
    assert.equal(agent.followups.length, 1, "the argument opened a turn");
    assert.equal(textOf(agent.followups[0]), "And summarize what you find.");
    assert.equal(agent.injected.length, 1, "activation is not repeated");

    // A bare re-invocation still opens nothing, and says exactly that.
    const third = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(third, {
      kind: "success",
      text: DISPATCHER_START_ALREADY_HERE,
    });
    assert.equal(agent.followups.length, 1, "no turn without an argument");
  });

  it("a synchronously refused followup is logged with its error and reported", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-refused");
    const failure = new Error("turn driver refused the hand-off");
    agent.followup = () => {
      throw failure;
    };

    const warn = mock.method(console, "warn", () => {});
    let result: CommandResultLike;
    try {
      result = ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent,
        rawInput: "This must not disappear.",
      });
    } finally {
      mock.restoreAll();
    }

    // Visible, not swallowed: the user is told the message did not become a
    // turn, and the activation itself still stands.
    assert.deepEqual(result!, {
      kind: "error",
      text: DISPATCHER_MESSAGE_NOT_SENT,
    });
    assert.equal(agent.injected.length, 1, "activation still happened");
    assert.equal(warn.mock.callCount(), 1, "the failure is logged exactly once");
    const [line, logged] = warn.mock.calls[0]?.arguments ?? [];
    assert.ok(
      String(line).startsWith("[multitask-dispatcher]"),
      "the producer prefix is what makes the line findable in the log",
    );
    assert.ok(String(line).includes("message argument"));
    assert.equal(logged, failure, "the error itself rides the log line");
  });

  it("a rejecting followup is logged with its error instead of vanishing", async () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-rejected");
    const failure = new Error("inbox closed");
    agent.followup = () => Promise.reject(failure);

    const warn = mock.method(console, "warn", () => {});
    let result: CommandResultLike;
    try {
      result = ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent,
        rawInput: "Queued into a closed inbox.",
      });
      // The rejection settles after the handler returns; the warning must be
      // observed rather than surfacing as an unhandled rejection.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      mock.restoreAll();
    }

    assert.deepEqual(result!, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_TEXT,
    });
    assert.equal(warn.mock.callCount(), 1, "the async failure is logged");
    const [line, logged] = warn.mock.calls[0]?.arguments ?? [];
    assert.ok(String(line).startsWith("[multitask-dispatcher]"));
    assert.equal(logged, failure, "the error itself rides the log line");
  });
});

describe("activation lifecycle — deactivation and HMR", () => {
  it("agent/disposed unbinds; a later command re-activates fresh", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(agent.ctx?.tools.registeredNames().length, DISPATCHER_TOOL_NAMES.length);

    ctx.fire("agent/disposed", { agent });
    assert.deepEqual(agent.ctx?.tools.registeredNames(), []);

    // Re-consent is deliberate: another explicit command re-attaches.
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(again, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_NO_TURN_TEXT,
    });
    assert.equal(agent.injected.length, 2);
    assert.equal(agent.ctx?.tools.registeredNames().length, DISPATCHER_TOOL_NAMES.length);
  });

  it("dispose-all (HMR simulation) leaves no lingering binding or surface", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    assert.equal(agent.ctx?.tools.registeredNames().length, DISPATCHER_TOOL_NAMES.length);

    for (const dispose of [...ctx.disposers]) {
      dispose();
    }

    assert.deepEqual(ctx.commandNames(), []);
    assert.deepEqual(agent.ctx?.tools.registeredNames(), []);
    assert.deepEqual(ctx.toolNames(), []);
    assert.equal(ctx.listenerCount(), 0);
    // The command itself is unregistered: nothing lingers to activate with.
    assert.throws(
      () =>
        ctx.runCommand({
          commandId: DISPATCHER_START_COMMAND,
          agent,
        }),
      /command not registered/,
    );
  });
});

describe("activation lifecycle — dispatcher tool surface (ADR-0019)", () => {
  it("activation registers the custom tools in the agent's SCOPED surface, with no global tool", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const agent = createScopedAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(result, {
      kind: "success",
      text: ACTIVATION_COMMAND_CARD_NO_TURN_TEXT,
    });

    // The three CUSTOM dispatcher tools live in THIS agent's scope only; the
    // stock agent verbs are the preset's (not mounted in this fixture, so the
    // exact set here is the custom three). Owner ruling 2026-11-05: the
    // ticket-145 per-session `recall` is absent by default — racoons is off
    // unless `racoonsEnabled` turns it on.
    assert.deepEqual(
      agent.ctx?.tools.registeredNames().sort(),
      [...DISPATCHER_TOOL_NAMES].sort(),
    );
    // …and nothing claims a global name (ticket 174 / ADR-0033 removed the
    // one global `request_access`).
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("disposing one session unregisters its scoped set, not the sibling's", () => {
    const ctx = createFullCtx();
    apply(ctx, volatileConfig({ enabled: true }));
    const first = createScopedAgent("s-1");
    const second = createScopedAgent("s-2");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: first });
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: second });

    ctx.fire("agent/disposed", { agent: first });

    assert.deepEqual(first.ctx?.tools.registeredNames(), []);
    assert.equal(second.ctx?.tools.registeredNames().length, DISPATCHER_TOOL_NAMES.length);
    // The sibling's surface is untouched, and no global tool exists to leak
    // past a session (ticket 174 / ADR-0033 removed `request_access`).
    assert.deepEqual(ctx.toolNames(), []);
    ctx.fire("agent/disposed", { agent: second });
    assert.deepEqual(ctx.toolNames(), []);
  });

  // DELETED with the `spawn_worker` handler: "workers spawned through the
  // surface are host children of the activated chat" exercised only that
  // retired tool's host-seam wiring. Workers now start with the stock
  // `subagent` tool, which is the host's own spawn path — the adoption of
  // such a child into this plugin's roster is the source lane's seam (A2a)
  // and is pinned where it lands, not by a handler this plugin no longer
  // registers.
});
