/**
 * Excessive auto-wake defect — activation de-wake (design note Decision 3).
 *
 * DESIRED behavior: a session open/resume activation rebuilds durable
 * obligations but NEVER opens a model turn. plugin.ts rebuildAndNotice must
 * not call multitask.redriveUndelivered -> openWakeTurn -> agent.followup on
 * mere open/resume (owner ruling 2026-11-19, extending the 2026-11-13
 * restart-notice ruling). Undelivered results surface on the next REAL turn.
 *
 * Today this is RED: the activation redrive (plugin.ts:1856) opens a followup
 * turn with no user message. The control pins the preserved notice gate
 * (ticket 31/57 + 2026-11-13, #300 wording) and the restart sweep.
 *
 * Offline (S8): real plugin.apply over a stub host context with a persistent
 * marker table and the REAL sessionKind projection fold; no network, no LLM.
 * The agent is bound into ctx.agents so a wake would reach agent.followup —
 * the seam the defect fires through.
 *
 * Portable host discovery (copied from test/stock-worker-model-default.test.ts):
 * set DSH_HOST_DIR to the installed @deepseek-ai/dsh package dir to override;
 * otherwise repo-local module resolution, then the global npm root. When no
 * usable host is found every test skips with a reason and the process exits 0.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  MARKER_TABLE_NAME,
  markerDomainSpec,
  RESTART_NOTICE_HEADING,
  restartRestoredLine,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type SessionKindProjectionState,
  type SessionProjectionChildLike,
  type SessionProjectionDefinitionLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";

const requireFromTest = createRequire(import.meta.url);

/** The installed @deepseek-ai/dsh package directory, or undefined. */
function findHostDir(): string | undefined {
  const override = process.env.DSH_HOST_DIR;
  if (override !== undefined && override !== "") {
    const dir = resolve(override);
    return existsSync(join(dir, "package.json")) ? dir : undefined;
  }
  try {
    return dirname(requireFromTest.resolve("@deepseek-ai/dsh/package.json"));
  } catch { /* not installed repo-locally; fall through to the global npm root */ }
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot === "") return undefined;
    const requireFromGlobal = createRequire(join(globalRoot, "dsh-host-probe.js"));
    return dirname(requireFromGlobal.resolve("@deepseek-ai/dsh/package.json"));
  } catch { return undefined; }
}

const hostDir = findHostDir();
let skip: string | false = hostDir !== undefined ? false
  : process.env.DSH_HOST_DIR
    ? `DSH_HOST_DIR (${process.env.DSH_HOST_DIR}) does not point at an installed dsh host`
    : "no installed dsh host found (repo-local module resolution or global npm root); set DSH_HOST_DIR to the @deepseek-ai/dsh package directory";

let pluginApply: typeof import("../src/plugin.js").apply;
if (hostDir !== undefined) {
  try {
    const hostRequire = createRequire(join(hostDir, "package.json"));
    const scopeUrl = pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-scope")).href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== "@deepseek-ai/dsh-scope") return nextResolve(specifier, context);
        return { url: scopeUrl, shortCircuit: true };
      },
    });
    ({ apply: pluginApply } = await import("../src/plugin.js"));
  } catch (error) {
    skip = `dsh host at ${hostDir} is not usable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── offline fixture (minimum of restart-honesty + dispatcher-resume-reactivation) ──

const SESSION = "chat-1";
const TOP_LEVEL_HEADER = { parentSession: null, delegationDepth: 0 } as const;

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

interface AppendedRecord {
  readonly type: string;
  readonly data: unknown;
  readonly options?: unknown;
}

interface ScopedToolSurface extends ToolsLike {
  register(definition: unknown): () => void;
  get(name: string): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

function createScopedTools(): ScopedToolSurface {
  const scoped = new Map<string, { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }>();
  return {
    schemas: () => [...scoped.keys()].map((name) => ({ name })),
    register(definition: unknown) {
      const tool = definition as { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> };
      if (scoped.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
      scoped.set(tool.name, tool);
      return () => { scoped.delete(tool.name); };
    },
    get: (name) => scoped.get(name),
  };
}

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
  readonly woken: unknown[];
  readonly appended: AppendedRecord[];
  readonly scopedTools: ScopedToolSurface;
}

function createAgent(id: string): TestAgent {
  const injected: unknown[] = [];
  const woken: unknown[] = [];
  const appended: AppendedRecord[] = [];
  const scopedTools = createScopedTools();
  return {
    session: {
      id,
      header: { ...TOP_LEVEL_HEADER },
      append(type: string, data: unknown, options?: unknown) {
        appended.push(options === undefined ? { type, data } : { type, data, options });
        return Promise.resolve();
      },
    },
    followup(message: unknown) { woken.push(message); },
    inject(message: unknown) { injected.push(message); },
    injected,
    woken,
    appended,
    ctx: { tools: scopedTools },
    scopedTools,
  };
}

// The durable session log + REAL projection fold (dispatcher-resume-reactivation).
interface LoggedEvent { readonly type: string; readonly data: unknown; readonly seq: number; }
interface StubSession {
  readonly id: string;
  readonly header: Record<string, unknown>;
  readonly inheritedEventCount: number;
  readonly events: LoggedEvent[];
  snapshotEvents(): readonly LoggedEvent[];
  eventAt(seq: number): LoggedEvent | undefined;
}
function createSession(id: string, header: Record<string, unknown>): StubSession {
  const events: LoggedEvent[] = [];
  return {
    id, header, inheritedEventCount: 0, events,
    snapshotEvents: () => [...events],
    eventAt: (seq) => events[seq],
  };
}
function appendDispatcherStart(session: StubSession, commandId: string): void {
  session.events.push({ type: "command/run", data: { commandId, name: DISPATCHER_START_COMMAND, args: "", source: "user" }, seq: session.events.length });
  session.events.push({ type: "command/done", data: { commandId, kind: "success" }, seq: session.events.length });
}
function createProjectionRegistry() {
  const definitions = new Map<string, SessionProjectionDefinitionLike<SessionKindProjectionState>>();
  const cells = new WeakMap<object, Map<string, { state: SessionKindProjectionState }>>();
  return {
    register(definition: SessionProjectionDefinitionLike<SessionKindProjectionState>) {
      definitions.set(definition.key, definition);
      return () => { definitions.delete(definition.key); };
    },
    stateOf(session: unknown, key: string): SessionKindProjectionState | undefined {
      const definition = definitions.get(key);
      if (definition === undefined) return undefined;
      const view = session as StubSession;
      let forSession = cells.get(view);
      if (forSession === undefined) { forSession = new Map(); cells.set(view, forSession); }
      let cell = forSession.get(key);
      if (cell === undefined) {
        let state = definition.init(view.header, view.inheritedEventCount);
        for (const event of view.snapshotEvents()) state = definition.apply(state, event);
        cell = { state };
        forSession.set(key, cell);
      }
      return cell.state;
    },
  };
}

function createCtx(storage: Map<string, Map<string, unknown>>) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const boundAgents = new Map<string, AgentLike>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<string, { execute: (args: unknown, exec?: unknown) => Promise<unknown> }>();
  const projections = createProjectionRegistry();
  const settingsProvider = {
    register(_ns: string) { return { async update(_value: unknown) {} }; },
    installSection(_owner: unknown, _ns: string) {},
  };
  const makeTable = (name: string) => {
    let table = storage.get(name);
    if (table === undefined) { table = new Map<string, unknown>(); storage.set(name, table); }
    const rows = table;
    return {
      get: (key: string) => rows.get(key) as never,
      entries: () => rows.entries() as never,
      async put(key: string, value: unknown) { rows.set(key, value); },
      async delete(key: string) { return rows.delete(key); },
    };
  };
  const ctx = {
    effect(execute: () => unknown) {
      const result = execute();
      if (typeof result === "object" && result !== null && Symbol.iterator in result) {
        for (const step of result as Iterable<unknown>) void step;
      }
    },
    inject(services: readonly string[], callback: (child: unknown) => void) {
      if (services.includes("settings")) callback({ settings: settingsProvider });
      if (services.includes("sessionProjections")) callback({ sessionProjections: projections });
    },
    get(name: string) { return name === "sessionProjections" ? projections : undefined; },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => { listeners.set(name, (listeners.get(name) ?? []).filter((c) => c !== cb)); };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        if (commands.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`);
        commands.set(definition.name, definition);
        return () => { commands.delete(definition.name); };
      },
    },
    tools: {
      schemas: () => [...tools.keys()].map((name) => ({ name })),
      register(definition: { name: string; execute: (args: unknown, exec?: unknown) => Promise<unknown> }) {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
        tools.set(definition.name, definition);
        return () => { tools.delete(definition.name); };
      },
    },
    subagents: {
      async startActivation() { return { childId: "child-stub", messageId: "msg-stub", dispose: async () => {} }; },
      interrupt() {},
      async sendMessage() { return "msg-stub"; },
    },
    agents: { get: (id: string) => boundAgents.get(id) },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return { async table(name: string) { return makeTable(name); }, async close() {}, name: "stub" };
      },
    },
    fire(name: string, ...payload: unknown[]) {
      for (const cb of [...(listeners.get(name) ?? [])]) (cb as unknown as (...args: unknown[]) => void)(...payload);
    },
    bindAgent(agent: AgentLike) { boundAgents.set(String(agent.session.id), agent); },
    runCommand(invocation: { commandId: string; agent?: AgentLike }): CommandResultLike {
      const command = commands.get(invocation.commandId);
      if (command === undefined) throw new Error(`command not registered: ${invocation.commandId}`);
      return command.handler(invocation as never) as CommandResultLike;
    },
  };
  return ctx as unknown as Parameters<typeof pluginApply>[0] & {
    fire(name: string, ...payload: unknown[]): void;
    bindAgent(agent: AgentLike): void;
    runCommand(invocation: { commandId: string; agent?: AgentLike }): CommandResultLike;
  };
}
type Ctx = ReturnType<typeof createCtx>;

async function seedMarkers(ctx: Ctx, markers: readonly DurableWorkerMarker[]): Promise<void> {
  const domain = await ctx.storageDomain.open(markerDomainSpec());
  const table = await domain.table(MARKER_TABLE_NAME);
  for (const marker of markers) await table.put(marker.workerId, marker);
}
async function readMarkers(ctx: Ctx): Promise<Map<string, DurableWorkerMarker>> {
  const domain = await ctx.storageDomain.open(markerDomainSpec());
  const table = await domain.table(MARKER_TABLE_NAME);
  return new Map([...(table.entries() as Iterable<[string, DurableWorkerMarker]>)]);
}

// A post-fix owed obligation (delivered:false, attempts:0) and a pre-fix legacy
// row (no delivered field). The extra delivered field is seeded through the raw
// KV store; current code ignores it, the fix reads it. No new symbol imported.
const OWED_BASE: DurableWorkerMarker = {
  workerId: "w-owed", parentSessionId: SESSION, streamKey: "todo-owed",
  title: "Owed result", status: "completed", transcriptRef: "child-owed",
  todoId: "todo-owed", redriveAttempts: 0, startedAtMs: 1_000, updatedAtMs: 2_000,
};
const OWED_MARKER = { ...OWED_BASE, delivered: false };
const LEGACY_MARKER: DurableWorkerMarker = {
  workerId: "w-legacy", parentSessionId: SESSION, streamKey: "todo-legacy",
  title: "Legacy result", status: "completed", transcriptRef: "child-legacy",
  todoId: "todo-legacy", startedAtMs: 1_000, updatedAtMs: 2_000,
};
const LIVE_MARKER: DurableWorkerMarker = {
  workerId: "w-live", parentSessionId: SESSION, streamKey: "todo-live",
  title: "Live at crash", status: "running", transcriptRef: null,
  todoId: null, startedAtMs: 1_000, updatedAtMs: 2_000,
};

/** Drive a real resume activation (agent/created) over the seeded markers. */
async function resumeWithMarkers(markers: readonly DurableWorkerMarker[]) {
  const storage = new Map<string, Map<string, unknown>>();
  const ctx = createCtx(storage);
  await seedMarkers(ctx, markers);
  pluginApply(ctx, volatileConfig({ enabled: true }));
  const session = createSession(SESSION, { ...TOP_LEVEL_HEADER });
  appendDispatcherStart(session, "cmd-1");
  const agent = createAgent(SESSION);
  const announced = { ...agent, session: { ...agent.session, ...session } };
  // The host's live Agent registry answers for this id, so a wake reaches
  // agent.followup instead of parking (the seam the activation defect fires).
  ctx.bindAgent(announced);
  ctx.fire("agent/created", { agent: announced, source: "resume" });
  await drain();
  return { ctx, agent, announced };
}

test("resume activation opens NO model turn — agent.followup is never called on mere open/resume", { skip }, async () => {
  const { agent } = await resumeWithMarkers([OWED_MARKER, LEGACY_MARKER]);
  assert.equal(
    agent.woken.length,
    0,
    "activation must rebuild obligations without opening a followup turn (no user message)",
  );
});

test("control: the restart sweep + notice gate still run — notice queued, never woken, rides the first real user message", { skip }, async () => {
  const { ctx, agent } = await resumeWithMarkers([OWED_MARKER, LEGACY_MARKER, LIVE_MARKER]);

  // Sweep still runs: the bare live-at-crash marker is released by activation.
  assert.equal((await readMarkers(ctx)).has("w-live"), false, "the restart sweep still releases the stale live hold");

  const noticeAppended = () => agent.appended.filter((e) => textOf(e.data).includes(RESTART_NOTICE_HEADING));
  assert.equal(noticeAppended().length, 0, "the notice stays queued until the first real user message");
  assert.equal(
    agent.woken.map(textOf).filter((t) => t.includes(RESTART_NOTICE_HEADING)).length,
    0,
    "the restart notice never opens a turn (ticket 31/57 + 2026-11-13 gate preserved)",
  );

  ctx.fire("session/event", { id: SESSION }, {
    type: "user/message",
    data: { role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
  });
  await drain();
  assert.equal(noticeAppended().length, 1, "exactly one restart notice on the first real user turn");
  const record = noticeAppended()[0];
  assert.deepEqual(record?.options, { surfaceOp: "append" }, "the notice is a surface append, not a turn");
  assert.ok(
    textOf(record?.data ?? {}).includes(restartRestoredLine(2)),
    "rebuild ran: the notice reports the two restored terminal markers",
  );
});
