/**
 * Ticket 31 — conversational stop semantics + restart honesty
 * (design-17 §4.6/§4.7/§7).
 *
 * Offline only (S8): a fake host context with a PERSISTENT marker table
 * and a settings-capturing scope drives the real plugin apply(). The
 * markers are seeded to simulate a previous host life; activation must
 * rebuild BEFORE the first roster publish and inject exactly one honest
 * restart notice. Plus: the no-stop guard (structural absence of any
 * stop/cancel affordance on the client face), the new policy rules, and
 * the aborted-worker no-revival presentation. No network, no LLM.
 *
 * Fake-vs-host (ticket 91): both host fakes' `commands.register` /
 * `tools.register` throw on a duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`).
 *
 * Fake-vs-host (ticket 93): the settings-provider fake models the shipped
 * scope contract — `register(ns, schema, options?)` returns the owner scope
 * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`) while
 * `installSection(...)` returns VOID (`:327-343`;
 * `lib/types/index.d.ts:228`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply as pluginApply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  DISPATCHER_STEER_COMMAND,
  MARKER_TABLE_NAME,
  markerDomainSpec,
  RESTART_DEGRADED_NOTICE,
  RESTART_NOTICE_HEADING,
  RESTART_NOTICE_SUMMARY,
  restartRestoredLine,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";

import { buildDispatcherPolicySection } from "../src/core/policy/prompts.js";
import {assembleSessionPolicy} from "../src/core/policy/assembler.js";
import {
  abortedReportBody,
  emptyReportPlaceholder,
  formatWakeReportBody,
} from "../src/core/report-clamp.js";

/** Drain the async rebuild chain queued by activation (ticket 31). */
async function flushActivation(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface AppendedRecord {
  readonly type: string;
  readonly data: unknown;
  readonly options?: unknown;
}

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
  /** Ticket 57: waking deliveries (`followup`) — must not be confused with injects. */
  readonly woken: unknown[];
  /**
   * Ticket 31 (restart notice): surface writes. The notice queue appends the
   * deferred notice here; no wake/inject is involved.
   */
  readonly appended: AppendedRecord[];
  readonly scopedTools: ScopedToolSurface;
}

interface ScopedToolSurface extends ToolsLike {
  register(definition: unknown): () => void;
  get(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

/**
 * ADR-0019: the live host mints a scoped tool surface per agent. The plugin
 * refuses the retired process-global fallback, so test agents carry one.
 */
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
      if (scoped.has(tool.name)) {
        throw new Error(`tool "${tool.name}" is already registered`);
      }
      scoped.set(tool.name, tool);
      return () => {
        scoped.delete(tool.name);
      };
    },
    get: (name) => scoped.get(name),
  };
}

function createAgent(id: string): TestAgent {
  const injected: unknown[] = [];
  const woken: unknown[] = [];
  const appended: AppendedRecord[] = [];
  const scopedTools = createScopedTools();
  return {
    session: {
      id,
      header: { parentSession: null, delegationDepth: 0 },
      append(type: string, data: unknown, options?: unknown) {
        appended.push(
          options === undefined ? { type, data } : { type, data, options },
        );
        return Promise.resolve();
      },
    },
    followup(message: unknown) {
      woken.push(message);
    },
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
    woken,
    appended,
    ctx: { tools: scopedTools },
    scopedTools,
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

/**
 * Host context whose marker table PERSISTS across `table()` calls (the
 * durability port re-resolves the table per operation) and whose settings
 * scope records every mirrored update. Markers can be seeded through the
 * stub before apply() to simulate a previous host life (ADR-0006 source).
 */
function createRestartCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const boundAgents = new Map<string, AgentLike>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const tables = new Map<string, Map<string, unknown>>();
  const updates: unknown[] = [];
  const claimedNamespaces = new Set<string>();
  // Settings-provider fake: the shipped scope contract (ticket 93).
  // - `register(ns, schema, options?)` RETURNS the owner scope
  //   (dsh-settings lib/index.js:281-315).
  // - `installSection(...)` returns VOID (dsh-settings lib/index.js:327-343;
  //   types :228).
  // - a second claim of one namespace fails loud (shipped rule,
  //   dsh-settings lib/index.js:283). Exposed on the test surface so the
  //   ticket-91 pin can exercise it directly.
  const claim = (ns: string): { update(value: unknown): Promise<void> } => {
    if (claimedNamespaces.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`);
    }
    claimedNamespaces.add(ns);
    return {
      // The host scope's `update` is ASYNC (dsh-settings
      // lib/types/index.d.ts:105-108).
      async update(value: unknown) {
        updates.push(value);
      },
    };
  };
  const settingsProvider = {
    register(ns: string) {
      return claim(ns);
    },
    installSection(_owner: unknown, ns: string) {
      claim(ns);
    },
  };
  let nextChild = 1;
  /**
   * Ticket 90: one-shot holds on the NEXT marker-table resolution(s). The
   * durability adapter resolves the table per operation
   * (`ensureTable()` = `domainPromise.then(domain => domain.table(...))`), so
   * a hold parked here delays exactly one read or write. The restart-honesty
   * findings need a marker read that is genuinely pending while the test
   * acts — a deactivation (F1), a concurrent roster transition (F3), a
   * deactivate → re-activate (F2) — instead of a read that always resolves
   * within the same tick. A hold stays in the queue (marked `taken`) until it
   * is released, so the test can release it after the read has picked it up.
   */
  const tableHolds: Array<{
    promise: Promise<void>;
    release: () => void;
    taken: boolean;
  }> = [];

  const fire = (name: string, ...payload: unknown[]) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      (cb as unknown as (...args: unknown[]) => void)(...payload);
    }
  };

  const makeTable = (name: string) => {
    let table = tables.get(name);
    if (table === undefined) {
      table = new Map<string, unknown>();
      tables.set(name, table);
    }
    return {
      get: (key: string) => table!.get(key) as never,
      entries: () => table!.entries() as never,
      async put(key: string, value: unknown) {
        table!.set(key, value);
      },
      async delete(key: string) {
        return table!.delete(key);
      },
    };
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply; whatever
    // it returns (or a generator yields) is the unload disposer — dropped
    // here because these tests never unload the fiber. Draining the iterator
    // is what runs a generator effect's body (lazy until iterated).
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
        callback({ settings: settingsProvider });
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
        // Shipped rule (ticket 91): duplicate command name throws
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
        // Shipped rule (ticket 91): duplicate tool name throws
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
    agents: { get: (id: string) => boundAgents.get(id) },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          // Ticket 90: `table()` is awaited by the durability adapter, so a
          // parked hold here delays exactly this one resolution.
          async table(name: string) {
            const hold = tableHolds.find((candidate) => !candidate.taken);
            if (hold !== undefined) {
              hold.taken = true;
              await hold.promise;
            }
            return makeTable(name);
          },
          async close() {},
          name: "stub",
        };
      },
    },
    // Test surface
    fire,
    updates,
    settingsProvider,
    commandNames: () => [...commands.keys()],
    tool: (name: string, agent?: AgentLike) =>
      (agent?.ctx?.tools as ScopedToolSurface | undefined)?.get(name) ??
      tools.get(name),
    bindAgent(agent: AgentLike) {
      boundAgents.set(String(agent.session.id), agent);
    },
    /**
     * The preset's stock `subagent` tool, faked at the host boundary: it
     * announces the child the stock runtime creates (`agent/created` with
     * `origin: "subagent"`), never a plugin spawn handler. The plugin adopts
     * the child from that header — the same core seam a restart rebuild uses.
     */
    mountStockTools(agent: TestAgent) {
      if (agent.scopedTools.get("subagent") !== undefined) return;
      agent.scopedTools.register({
        name: "subagent",
        async execute() {
          const childId = `child-${nextChild++}`;
          // The child's inherited scope: one denied verb is enough for the
          // worker barrier, and `restrict`/registration are the seams the
          // composition writes through (test stub, never the live host).
          const childTools = {
            schemas: () => [{ name: "deliver_result" }],
            restrict: () => () => {},
            register: () => () => {},
          };
          const child: AgentLike = {
            session: {
              id: childId,
              header: {
                parentSession: "s-1",
                delegationDepth: 1,
                origin: "subagent",
              },
            },
            followup() {},
            inject() {},
            ctx: { tools: childTools as unknown as ToolsLike },
          };
          boundAgents.set(childId, child);
          fire("agent/created", { agent: child, source: "startup" });
          return { ok: true, childId };
        },
      });
    },
    /** Start one stock worker and return its id. */
    async spawnStockWorker(agent: TestAgent, label: string): Promise<string> {
      const subagent = agent.scopedTools.get("subagent");
      assert.ok(subagent, "the preset must be mounted on the dispatcher");
      const value = (await subagent.execute({
        description: label,
        prompt: "work",
      })) as { ok: boolean; childId: string };
      assert.equal(value.ok, true);
      return value.childId;
    },
    /**
     * The kept replacement for `check_workers`: `message_agent` routes an id
     * with a roster record to the worker-steer branch (`not-running` for a
     * terminal or pre-turn worker) and an id with none to the peer branch
     * (`unknown-target`). Neither refusal mutates state or spends budget.
     */
    async workerOnRoster(agent: TestAgent, workerId: string): Promise<boolean> {
      const message = agent.scopedTools.get("message_agent");
      assert.ok(message, "the dispatcher surface is registered");
      const result = (await message.execute({
        target: workerId,
        text: "roster probe",
      })) as { ok: boolean; reason?: string };
      return result.ok === false && result.reason === "not-running";
    },
    /** Park the next marker-table resolution until released (ticket 90). */
    holdNextMarkerTable() {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      tableHolds.push({ promise, release, taken: false });
    },
    /** Release the OLDEST parked marker-table resolution (ticket 90). */
    releaseMarkerTableHold() {
      tableHolds.shift()?.release();
    },
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
  return ctx as unknown as Parameters<typeof pluginApply>[0] & {
    fire(name: string, ...payload: unknown[]): void;
    readonly updates: unknown[];
    readonly settingsProvider: {
      register(ns: string): { update(value: unknown): Promise<void> };
      installSection(owner: unknown, ns: string): void;
    };
    commandNames(): string[];
    tool(
      name: string,
      agent?: AgentLike,
    ):
      | { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
      | undefined;
    bindAgent(agent: AgentLike): void;
    mountStockTools(agent: TestAgent): void;
    spawnStockWorker(agent: TestAgent, label: string): Promise<string>;
    workerOnRoster(agent: TestAgent, workerId: string): Promise<boolean>;
    holdNextMarkerTable(): void;
    releaseMarkerTableHold(): void;
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike;
  };
}

async function seedMarkers(
  ctx: ReturnType<typeof createRestartCtx>,
  markers: DurableWorkerMarker[],
): Promise<void> {
  const domain = await ctx.storageDomain.open(markerDomainSpec());
  const table = await domain.table(MARKER_TABLE_NAME);
  for (const marker of markers) {
    await table.put(marker.workerId, marker);
  }
}

/** Read the durable markers back through the same store (ticket 90). */
async function readMarkers(
  ctx: ReturnType<typeof createRestartCtx>,
): Promise<Map<string, DurableWorkerMarker>> {
  const domain = await ctx.storageDomain.open(markerDomainSpec());
  const table = await domain.table(MARKER_TABLE_NAME);
  const entries = table.entries() as Iterable<[string, DurableWorkerMarker]>;
  return new Map([...entries]);
}

const DONE_MARKER: DurableWorkerMarker = {
  workerId: "w-done",
  parentSessionId: "s-1",
  streamKey: "todo-done",
  title: "Report generator",
  status: "completed",
  transcriptRef: "child-done",
  todoId: "todo-done",
  startedAtMs: 1_000,
  updatedAtMs: 2_000,
};

const LIVE_MARKER: DurableWorkerMarker = {
  workerId: "w-live",
  parentSessionId: "s-1",
  streamKey: "todo-live",
  title: "Live at crash",
  status: "running",
  transcriptRef: null,
  todoId: null,
  startedAtMs: 1_000,
  updatedAtMs: 2_000,
};

describe("restart honesty — rebuild on activation (design-17 §4.7)", () => {
  it("activation rebuilds durable markers BEFORE the first publish; one notice; unknown rows stay off the roster", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [DONE_MARKER, LIVE_MARKER]);

    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();

    // Exactly ONE restart notice, carrying the id, the transcript pointer,
    // the honest unknown wording, and the restored count (design-17 §7).
    //
    // Ticket 31 clarification (supersedes ticket 57 for THIS notice): it is
    // queued, not woken. A restart must never auto-wake a dispatcher; the
    // notice waits for the user's own first turn, then appends exactly once.
    const restartAppended = () =>
      agent.appended.filter((entry) =>
        textOf(entry.data).includes(RESTART_NOTICE_HEADING),
      );
    assert.equal(
      agent.woken.length,
      0,
      "activation queues the restart notice and opens no turn at all",
    );
    assert.equal(
      agent.injected
        .map(textOf)
        .filter((text) => text.includes(RESTART_NOTICE_HEADING)).length,
      0,
      "the restart notice must NOT go through the queueing primitive",
    );
    assert.equal(
      restartAppended().length,
      0,
      "nothing is visible before the first real user turn",
    );

    // The first step's protected system head is not a user message: the
    // restart notice stays queued.
    ctx.fire(
      "session/event",
      { id: "s-1" },
      {
        type: "system/message",
        data: { turn: 1, step: 1, message: { role: "system", content: [] } },
      },
    );
    await flushActivation();
    assert.equal(
      restartAppended().length,
      0,
      "a system head alone does not flush the restart notice",
    );

    // A plugin-authored notice is not a user turn either.
    ctx.fire(
      "session/event",
      { id: "s-1" },
      {
        type: "user/message",
        data: {
          role: "user",
          content: [{ type: "text", text: "Dispatcher active in this chat." }],
          source: { kind: "plugin:multitask-dispatcher", form: "notice" },
        },
      },
    );
    await flushActivation();
    assert.equal(
      restartAppended().length,
      0,
      "plugin notices do not open the restart queue",
    );

    // The user's first real message flushes exactly once.
    ctx.fire(
      "session/event",
      { id: "s-1" },
      {
        type: "user/message",
        data: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "user" },
        },
      },
    );
    await flushActivation();
    assert.equal(
      restartAppended().length,
      1,
      "exactly one restart notice arrives with the first user turn",
    );

    // R2: the activation-time session policy rides the already-open turn, so
    // it stays on `inject` (waking it would cost an extra model call).
    const policyInjects = agent.injected
      .map(textOf)
      .filter((text) => text.includes("# Multitask dispatcher"));
    assert.equal(policyInjects.length, 1, "session policy still injects");
    assert.equal(
      agent.woken
        .map(textOf)
        .filter((text) => text.includes("# Multitask dispatcher")).length,
      0,
      "session policy does not wake",
    );
    const restartRecord = restartAppended()[0];
    const notice = textOf(restartRecord?.data ?? {});
    assert.equal(
      (restartRecord?.data as { source?: { form?: unknown } }).source?.form,
      "notice",
      "the restart notice uses the notice form",
    );
    assert.equal(
      (restartRecord?.data as { source?: { summary?: unknown } }).source?.summary,
      RESTART_NOTICE_SUMMARY,
      "the restart notice carries its collapsed summary",
    );
    assert.deepEqual(
      restartRecord?.options,
      { surfaceOp: "append" },
      "the restart notice is a surface append, never a turn",
    );
    assert.ok(notice.includes("w-live"), "notice names the unknown worker");
    assert.ok(
      notice.includes("state is unknown"),
      "notice says the state is unknown",
    );
    assert.ok(
      notice.includes("nothing was replayed"),
      "notice says nothing was replayed",
    );
    assert.ok(
      notice.includes("Transcripts: w-live"),
      "notice carries the transcript pointer (id fallback)",
    );
    assert.ok(
      notice.includes("1 worker(s) were still running"),
      "notice carries the unknown count",
    );
    assert.ok(
      notice.includes(restartRestoredLine(1)),
      "notice carries the restored-count line",
    );

    // A second user turn must not duplicate it: the queue drained once.
    ctx.fire(
      "session/event",
      { id: "s-1" },
      {
        type: "user/message",
        data: {
          role: "user",
          content: [{ type: "text", text: "and again" }],
          source: { kind: "user" },
        },
      },
    );
    await flushActivation();
    assert.equal(
      restartAppended().length,
      1,
      "the restart notice is appended exactly once",
    );

    // The rebuild must have landed before the first roster read: the live
    // roster already carries the restored terminal row. `check_workers` is
    // retired; `message_agent` still answers roster membership (a roster id
    // hits the worker branch and refuses not-running; an absent id falls to
    // the peer branch and refuses unknown-target).
    assert.equal(
      await ctx.workerOnRoster(agent, "w-done"),
      true,
      "restored row is on the roster",
    );
    // Unknown-state rows NEVER land on the roster (core rule) — the notice
    // is their only surface.
    assert.equal(
      await ctx.workerOnRoster(agent, "w-live"),
      false,
      "unknown-state worker never appears on the roster",
    );
  });

  it("rebuild failure: activation still succeeds with the degraded honest notice", async () => {
    const commands = new Map<string, CommandDefinitionLike>();
    const tools = new Map<string, { name?: string }>();
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const injected: unknown[] = [];
    const agent = createAgent("s-1");
    const fire = (name: string, ...payload: unknown[]) => {
      for (const cb of [...(listeners.get(name) ?? [])]) cb(...payload);
    };
    const ctx = {
      // Cordis effect contract (ticket 44): `execute` runs at apply; whatever
      // it returns (or a generator yields) is the unload disposer — dropped
      // here because this test never unloads the fiber. Draining the iterator
      // is what runs a generator effect's body (lazy until iterated).
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
      inject() {},
      on(name: string, cb: (...args: unknown[]) => void) {
        const list = listeners.get(name) ?? [];
        list.push(cb);
        listeners.set(name, list);
        return () => {
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter((entry) => entry !== cb),
          );
        };
      },
      fire,
      commands: {
        register(definition: CommandDefinitionLike) {
          // Shipped rule (ticket 91): duplicate command name throws
          // (dsh-commands lib/index.js:82, NamedEntries factory).
          if (commands.has(definition.name)) {
            throw new Error(
              `command "${definition.name}" is already registered (for a ` +
                `per-agent variant, mount a command-injected plugin under ` +
                `that agent's \`agent.ctx\`)`,
            );
          }
          commands.set(definition.name, definition);
          return () => {};
        },
      },
      tools: {
        schemas: () => [] as Array<{ name: string }>,
        // Shipped rule (ticket 91): duplicate tool name throws
        // (dsh-tools lib/index.js:2538). Nothing registers here in this
        // test, so the check is a shape pin, not a live path.
        register(definition?: { name?: string }) {
          const name = definition?.name;
          if (name !== undefined && tools.has(name)) {
            throw new Error(
              `tool "${name}" is already registered (for a per-agent ` +
                `variant, register through that agent's \`agent.ctx\` ` +
                `instead)`,
            );
          }
          if (name !== undefined && definition !== undefined) {
            tools.set(name, definition);
          }
          return () => {};
        },
      },
      subagents: {
        async startActivation() {
          return { childId: "c", messageId: "m", dispose: async () => {} };
        },
        interrupt() {},
        async sendMessage() {
          return "msg";
        },
      },
      agents: { get: () => undefined },
      jobs: { list: () => [] },
      // Broken marker store: open rejects. The rebuild must fail without
      // taking the activation down with it.
      storageDomain: {
        open(): Promise<never> {
          return Promise.reject(new Error("marker store unreadable"));
        },
      },
    };
    pluginApply(
      ctx as unknown as Parameters<typeof pluginApply>[0],
      volatileConfig({ enabled: true }),
    );

    const command = commands.get(DISPATCHER_START_COMMAND);
    assert.ok(command, "activation command registered despite broken store");
    const result = command.handler({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    } as never) as CommandResultLike;
    assert.equal(result.kind, "success", "activation survives a broken store");
    await flushActivation();

    // Ticket 31: the degraded notice is queued like the normal one — it must
    // never auto-wake, and it stays invisible until the user speaks.
    const degraded = (records: readonly { data: unknown }[]) =>
      records.filter((entry) => textOf(entry.data).includes(RESTART_DEGRADED_NOTICE));
    assert.equal(
      agent.woken.filter((entry) => textOf(entry).includes(RESTART_DEGRADED_NOTICE))
        .length,
      0,
      "the degraded notice does not wake the agent",
    );
    assert.equal(
      degraded(agent.appended).length,
      0,
      "the degraded notice waits for the first real user turn",
    );

    ctx.fire(
      "session/event",
      { id: "s-1" },
      {
        type: "user/message",
        data: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "user" },
        },
      },
    );
    await flushActivation();

    const notices = degraded(agent.appended);
    assert.equal(
      notices.length,
      1,
      "exactly one degraded notice: nothing restored, nothing replayed",
    );
    assert.equal(
      (notices[0]?.data as { source?: { summary?: unknown } }).source?.summary,
      RESTART_NOTICE_SUMMARY,
      "the degraded notice carries the restart summary",
    );
    assert.equal(
      agent.woken.filter((entry) => textOf(entry).includes(RESTART_DEGRADED_NOTICE))
        .length,
      0,
      "delivery is an append, not a followup",
    );
  });

  it("a deactivation during the marker read ends the chain: nothing published, nothing woken, no redrive spent (ticket 90 F1)", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [{ ...DONE_MARKER }]);
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    // The marker read is genuinely pending: activation has returned, the
    // chain is parked inside `rebuildFromDurability`.
    ctx.holdNextMarkerTable();
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();

    // The activation ends mid-read.
    ctx.fire("agent/disposed", { agent });

    ctx.releaseMarkerTableHold();
    await flushActivation();

    // The guard's false branch: a chain that resumes for a session that is
    // no longer an activated dispatcher must not wake the notice and must
    // not spend a redrive attempt of the persisted D-5 budget.
    assert.equal(
      agent.woken.length,
      0,
      "the dead chain wakes nothing (no restart notice, no redrive turn)",
    );
    const markers = await readMarkers(ctx);
    assert.equal(
      markers.get("w-done")?.redriveAttempts ?? 0,
      0,
      "redriveUndelivered never ran: the persisted budget is untouched",
    );
  });

  it("a roster transition during the marker read cannot publish a pre-rebuild snapshot (ticket 90 F3)", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [{ ...DONE_MARKER }]);
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.mountStockTools(agent);

    ctx.holdNextMarkerTable();
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(result.kind, "success");
    await flushActivation();

    // A roster-affecting transition lands inside the window. A stock worker
    // adoption is the cheapest real one: its marker write is a LATER table
    // resolution, so it completes while the activation read is still parked.
    const racedId = await ctx.spawnStockWorker(agent, "Raced task");
    assert.equal(racedId, "child-1", "the stock child was adopted mid-rebuild");

    ctx.releaseMarkerTableHold();
    await flushActivation();

    // The post-rebuild roster carries BOTH the restored rows and the raced
    // transition — the mid-read adoption was never dropped.
    assert.equal(
      await ctx.workerOnRoster(agent, "w-done"),
      true,
      "the restored rows are present",
    );
    assert.equal(
      await ctx.workerOnRoster(agent, racedId),
      true,
      "the raced transition is present",
    );
  });

  it("a stale chain from an earlier activation of the same session id is refused (ticket 90 F2)", async () => {
    const ctx = createRestartCtx();
    await seedMarkers(ctx, [{ ...DONE_MARKER }]);
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.mountStockTools(agent);

    // Activation #1 starts a chain and parks on the marker read.
    ctx.holdNextMarkerTable();
    const first = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(first.kind, "success");
    await flushActivation();

    // Deactivate → re-activate the SAME session id: activation #2 owns the
    // session now, and its chain parks on its own held read. This is the
    // window the session-id check cannot see: set membership is true again.
    ctx.fire("agent/disposed", { agent });
    ctx.holdNextMarkerTable();
    const second = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(second.kind, "success");

    // The stale chain resumes first. It is no longer acting for a live
    // activation, so it must not spend a redrive of the persisted budget.
    ctx.releaseMarkerTableHold();
    await flushActivation();
    const afterStale = await readMarkers(ctx);
    assert.equal(
      afterStale.get("w-done")?.redriveAttempts ?? 0,
      0,
      "the stale chain spends no redrive",
    );

    // A roster transition lands while the LIVE chain is still reading.
    const racedId = await ctx.spawnStockWorker(agent, "Raced task");
    assert.equal(racedId, "child-1", "the stock child was adopted mid-rebuild");

    // The live chain resumes: one redrive pass, and the raced transition is
    // not lost.
    ctx.releaseMarkerTableHold();
    await flushActivation();

    const markers = await readMarkers(ctx);
    assert.equal(
      markers.get("w-done")?.redriveAttempts ?? 0,
      1,
      "the persisted D-5 budget was spent once, not twice",
    );
    assert.equal(
      await ctx.workerOnRoster(agent, "w-done"),
      true,
      "the restored rows are present",
    );
    assert.equal(
      await ctx.workerOnRoster(agent, racedId),
      true,
      "the raced transition is present",
    );
  });
});

describe("restart honesty — no-stop guard (design-17 §4.6)", () => {
  /** Recursively collect every object key in a view model tree. */
  function collectKeys(value: unknown, visit: (key: string) => void): void {
    if (Array.isArray(value)) {
      for (const entry of value) collectKeys(entry, visit);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        collectKeys(child, visit);
      }
    }
  }

  /** Recursively visit every primitive string value with its own key. */
  function collectEntries(
    value: unknown,
    visit: (key: string, value: string) => void,
  ): void {
    if (Array.isArray(value)) {
      for (const entry of value) collectEntries(entry, visit);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string") visit(key, child);
        else collectEntries(child, visit);
      }
    }
  }

  const AFFORDANCE_PATTERN = /stop|cancel|button|action|affordance/i;

  // Ticket 129 re-base (2026-10-21, ADR-0030): this guard once forbade ANY
  // stop-shaped command, then an ADR-0021-era re-base exempted the sanctioned
  // `/dispatcher-stop` (the ticket-101 session-BINDING deactivation). ADR-0030
  // withdrew that command — the last user-facing deactivation affordance — so
  // the exemption is gone and the guard is strictly stronger than its
  // original form: NO stop/cancel-shaped command may be registered at all.
  // Its original object stands unchanged too: worker turns / the worker
  // runtime keep no stop control (design-17 §4.6, docs/surfaces.md "No stop
  // control"); deactivation is implicit only (host disposal or plugin unload).
  it("the plugin registers no stop/cancel command at all (design-17 §4.6; strengthened by ADR-0030 — ticket 129)", () => {
    const ctx = createRestartCtx();
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const names = ctx.commandNames().sort();
    assert.deepEqual(names, [
          DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename); the
      // withdrawn dispatcher-stop (ticket 101) is gone (ticket 129).
      DISPATCHER_START_COMMAND,
    ]);
    const offenders = names.filter((name) => /stop|cancel/i.test(name));
    assert.deepEqual(
      offenders,
      [],
      "no stop/cancel-shaped command may be registered (ADR-0030 withdrew the last one)",
    );
  });
});

describe("restart honesty — policy copy (new, clean-room)", () => {
  it("the policy is the owner's chief-of-staff copy and rides the flag gate", () => {
    // Owner-directed rewrite 2026-11-02 cut the per-session section to four
    // chief-of-staff bullets. The conversational-stop and no-task-board rules
    // this test used to pin lived in the retired section and are no longer
    // stated in any prompt; the pins were retired with it rather than
    // re-pointed at text that does not exist.
    const policy = buildDispatcherPolicySection();
    assert.ok(policy.includes("chief of staff"));
    assert.ok(policy.includes("plain language"));

    const injected = assembleSessionPolicy(true);
    assert.ok(injected.includes("# Multitask dispatcher"));
    // Flag OFF: empty policy — the rules ride the ADR-0005 gate like all copy.
    assert.equal(assembleSessionPolicy(false), "");
  });
});

describe("restart honesty — aborted workers settle with an honest report (no revival)", () => {
  it("abortedReportBody is the exact no-report body; real partial findings are kept and labelled", () => {
    assert.equal(
      abortedReportBody(),
      "(Stopped before completion. No report.)",
    );
    // A report that raced the stop is REAL work product: keep it, but label it
    // partial so it can never read as a completed deliverable.
    const partial = formatWakeReportBody(
      "aborted",
      "confidential partial work",
      "child-1",
    );
    assert.ok(partial.includes("confidential partial work"));
    assert.ok(partial.includes("Partial report"));
    assert.ok(!partial.includes("completed"));
    // No text — or the completed placeholder a normalized empty settle leaves —
    // still gets the exact no-report body.
    assert.equal(
      formatWakeReportBody("aborted", "", null),
      "(Stopped before completion. No report.)",
    );
    assert.equal(
      formatWakeReportBody("aborted", emptyReportPlaceholder(), null),
      "(Stopped before completion. No report.)",
    );
  });

});

// Ticket 91's fail-loud duplicate-registration pin lives in
// test/plugin-scaffold.test.ts: it is one host rule, pinned once.
