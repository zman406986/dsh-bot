/**
 * Ticket 113 / ADR-0023 — the plugin-level inbox end-to-end path.
 *
 * Offline only (S8): a fake host context with PERSISTENT kv tables (shared
 * across simulated host lives), a disposer-collecting effect fake, and the
 * real plugin apply() drive the whole intake pipeline against a real
 * temp-dir filesystem (short rescan intervals are fine; S8). Covered here —
 * the halves the watcher/core suites cannot see:
 *
 * 1. disabled or empty-dir inbox → nothing starts (no fs.watch, no mkdir,
 *    no checkpoints) — the ADR-0023 off switch is total;
 * 2. the full pipeline: queue.jsonl → watcher claim → checkpoint → the
 *    external-event wake carrying the "## Inbox jobs" section →
 *    deliver_result (todo_id from the checkpoint). Delivery is conversational
 *    (ADR-0009): with no separate `deliverToUser` channel wired, the
 *    dispatcher's reply IS the channel, so the tool closes the obligation
 *    (`channel: "reply"`) and the reply writer lands reply.md/status.json and
 *    a terminal checkpoint;
 * 3. restart re-presentation of a claimed-but-unreplied job across two host
 *    lives over the SAME tables: no double claim (status.json's claimedAtMs
 *    never rewritten), the boot rescan re-presents (presentAttempts 2), and
 *    exactly one inbox wake per life;
 * 4. a malformed queue line is skipped with an honest console.warn while
 *    intake stays alive for the well-formed lines around it;
 * 5. same-process re-activation never re-presents a job its still-live
 *    owner holds (one presentation, ever — the core dedupe stands);
 * 6. N1a: a claimed job with ZERO live dispatcher sessions stays held
 *    (claimed, unowned, no wake) until a later activation presents it
 *    exactly once;
 * 7. N1b: with two live dispatcher sessions the job routes to the
 *    earliest-activated one only — the sibling never sees it;
 * 8. N2: the boot rescan ADOPTS a job dir whose files already show a
 *    terminal outcome (disk truth wins) instead of re-presenting;
 * 9. N4: delivery finishes an inbox job even after intake was disabled —
 *    the reply writer rides the todo's own origin, not current config.
 *
 * Isolation note (ticket 162): the watcher creates its root inside a
 * fire-and-forget async block that `apply` never awaits, so no test here may
 * assume the directory exists merely because `flushActivation()` returned —
 * the writeQueue helper creates it, and the cleanup helper retries, which is
 * why this file no longer loses a race with its own watcher under load.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as pluginApply, INBOX_JOBS_HEADING } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  DISPATCHER_START_COMMAND,
  INBOX_TABLE_NAME,
  MARKER_TABLE_NAME,
  WORKER_SESSION_TABLE_NAME,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type ToolsLike,
} from "../src/adapter/index.js";
import type { InboxJobCheckpoint } from "../src/adapter/index.js";

/** Drain the async activation/rescan chains queued by apply (ticket 31). */
async function flushActivation(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Poll an async predicate on a real clock — watcher events are real fs. */
async function pollUntil(
  check: () => boolean | Promise<boolean>,
  deadlineMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error("pollUntil: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A resumed worker's composition probe. `check_workers` is retired, but the
 * reclaim path still composes the child (persona section + tool barrier), so
 * the test can wait for the SAME observable without a roster tool: the host
 * applies composition before it reclaims the unknown-state hold.
 */
function workerCompositionProbe(): {
  ctx: NonNullable<AgentLike["ctx"]>;
  applied(): boolean;
} {
  let sections = 0;
  return {
    ctx: {
      systemPrompt: {
        section() {
          sections += 1;
          return () => {};
        },
        getSectionOrder: () => 0,
      },
      tools: {
        schemas: () => [{ name: "deliver_result" }],
        restrict: () => () => {},
        register: () => () => {},
      },
    } as NonNullable<AgentLike["ctx"]>,
    applied: () => sections > 0,
  };
}

interface TestAgent extends AgentLike {
  /** Narrow the base view's opaque `id` to the string this fixture mints. */
  readonly session: AgentLike["session"] & { readonly id: string };
  readonly woken: unknown[];
  readonly ctx: { tools: ToolsLike };
  scopedTool(
    name: string,
  ): { execute: (args: unknown, exec?: unknown) => Promise<unknown> } | undefined;
}

/**
 * A test agent with its OWN scoped tool surface (the live host's `agent.ctx`
 * shape — ADR-0019 per-agent visibility). The plugin refuses the retired
 * process-global fallback, so every activation fixture carries one. Two
 * dispatcher sessions can coexist because each activation registers its
 * tools in its own agent's scope (ticket 91).
 */
function createAgent(id: string): TestAgent {
  const woken: unknown[] = [];
  const scoped = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  return {
    session: {
      id,
      header: { parentSession: null, delegationDepth: 0 },
    },
    followup(message: unknown) {
      woken.push(message);
    },
    inject() {},
    woken,
    ctx: {
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
      },
    },
    scopedTool: (name) => scoped.get(name),
  };
}

function createScopedAgent(id: string): TestAgent {
  return createAgent(id);
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

/**
 * The kv store is created OUTSIDE any single context so two apply lives can
 * share it — a host restart keeps its storage, loses its memory.
 */
function createSharedTables(): {
  tables: Map<string, Map<string, unknown>>;
  open(): Promise<{
    table(name: string): Promise<Record<string, unknown> & {
      get(key: string): unknown;
      entries(): IterableIterator<[string, unknown]>;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
    }>;
    close(): Promise<void>;
    name: string;
  }>;
} {
  const tables = new Map<string, Map<string, unknown>>();
  return {
    tables,
    async open() {
      return {
        async table(name: string) {
          let table = tables.get(name);
          if (table === undefined) {
            table = new Map<string, unknown>();
            tables.set(name, table);
          }
          const bound = table;
          return {
            get: (key: string) => bound.get(key),
            entries: () => bound.entries(),
            async put(key: string, value: unknown) {
              bound.set(key, value);
            },
            async delete(key: string) {
              return bound.delete(key);
            },
          } as never;
        },
        async close() {},
        name: "stub",
      };
    },
  };
}

type InboxCtx = AdapterContext & {
  fire(name: string, payload: unknown): void;
  readonly updates: unknown[];
  bindAgent(agent: AgentLike & { session: { id: string } }): void;
  commandNames(): string[];
  tool(name: string):
    | { execute: (args: unknown) => Promise<unknown> }
    | undefined;
  runCommand(invocation: {
    commandId: string;
    agent?: AgentLike;
  }): CommandResultLike;
  /** Run every disposer the plugin registered through ctx.effect. */
  dispose(): void;
};

/**
 * Host context for the inbox lives: same shape as the restart-honesty fake
 * (persistent per-name tables, settings scope contract, duplicate-name
 * throws) plus a disposer-collecting effect fake — the inbox watcher's
 * cleanup rides ctx.effect, so a simulated restart must RUN those disposers
 * to stop the previous life's watcher.
 */
function createInboxCtx(shared: ReturnType<typeof createSharedTables>): InboxCtx {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const updates: unknown[] = [];
  const claimedNamespaces = new Set<string>();
  const disposers: Array<() => void> = [];
  // The wake path resolves the agent by session id
  // (`ctx.agents.get(sessionId)` in requestDispatcherWakeup) — tests must
  // bind their agents or bus-driven wakes silently no-op (unknown session).
  const boundAgents = new Map<string, AgentLike>();

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
  const settingsProvider = {
    register(ns: string) {
      return claim(ns);
    },
    installSection(_owner: unknown, ns: string) {
      claim(ns);
    },
  };

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const ctx = {
    // Cordis effect contract (ticket 44): `execute` runs at apply. A plain
    // function's RETURN is the disposer; a generator YIELDS the disposer.
    // Both are collected so tests can stop the previous life's watcher.
    effect(execute: () => unknown) {
      const result = execute();
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") {
            disposers.push(step as () => void);
          }
        }
      } else if (typeof result === "function") {
        disposers.push(result as () => void);
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
        // Shipped rule (ticket 91): duplicate command name throws.
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
        // Shipped rule (ticket 91): duplicate tool name throws.
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
        return { childId: "child-1", messageId: "msg-child-1", dispose: async () => {} };
      },
      interrupt() {},
      async sendMessage() {
        return "msg-stub";
      },
    },
    agents: { get: (id: string) => boundAgents.get(id) },
    jobs: { list: () => [] },
    storageDomain: {
      open: shared.open,
    },
    fire,
    updates,
    bindAgent(agent: AgentLike & { session: { id: string } }) {
      boundAgents.set(agent.session.id, agent);
    },
    commandNames: () => [...commands.keys()],
    tool: (name: string) => tools.get(name),
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
    dispose() {
      for (const dispose of [...disposers].reverse()) dispose();
      disposers.length = 0;
    },
  };
  return ctx as unknown as InboxCtx;
}

function readCheckpoints(
  shared: ReturnType<typeof createSharedTables>,
): Map<string, InboxJobCheckpoint> {
  const out = new Map<string, InboxJobCheckpoint>();
  const table = shared.tables.get(INBOX_TABLE_NAME);
  if (table !== undefined) {
    for (const [key, value] of table) {
      out.set(key, value as InboxJobCheckpoint);
    }
  }
  return out;
}

/**
 * Write a queue file, creating the inbox root first.
 *
 * Ticket 162: the watcher creates its root inside a fire-and-forget async
 * IIFE, and `apply` never awaits it, so the root may not exist yet when a
 * test writes after `flushActivation()` — under full-suite load that loses
 * the race and the write dies with ENOENT. Creating the root here makes the
 * test own the directory instead of depending on the watcher's timing
 * (the watcher's own `mkdir` is recursive and tolerates an existing dir).
 */
async function writeQueue(root: string, lines: readonly string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "queue.jsonl"), lines.join("\n") + "\n", "utf8");
}

/**
 * Remove a per-test temp parent, retrying briefly.
 *
 * Ticket 162 (same cause as {@link writeQueue}): a watcher start or scan that
 * was already in flight when the test disposed can land its `mkdir`/write
 * while this `rm` runs, which Windows reports as ENOTEMPTY/EPERM rather than
 * succeeding.
 */
async function removeTempRoot(parent: string): Promise<void> {
  await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

interface InboxStatusFile {
  status?: string;
  claimedAt?: number;
  startedAt?: number;
  endedAt?: number;
  replyBytes?: number;
  error?: string;
}

async function readStatus(dir: string): Promise<InboxStatusFile> {
  return JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as InboxStatusFile;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function inboxWakeCount(agent: TestAgent): number {
  return agent.woken.map(textOf).filter((text) =>
    text.includes(INBOX_JOBS_HEADING),
  ).length;
}

describe("inbox end to end — the off switch (ticket 113, ADR-0023)", () => {
  it("a disabled or empty-dir inbox starts nothing: no watcher, no mkdir, no checkpoints", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dsh-inbox-off-"));
    const root = join(parent, "inbox");
    try {
      // inboxEnabled false with a directory configured: the watcher must
      // never start — the strongest observable proof is that the root is
      // never even created (the watcher mkdirs its root at start).
      const offStore = createSharedTables();
      const offCtx = createInboxCtx(offStore);
      pluginApply(offCtx as never, volatileConfig({
          enabled: true,
          inboxEnabled: false,
          inboxDir: root,
  }));
      const offAgent = createAgent("s-1");
      offCtx.bindAgent(offAgent);
      offCtx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent: offAgent });
      await flushActivation();
      assert.equal(
        await dirExists(root),
        false,
        "a disabled inbox never creates its directory",
      );
      assert.equal(offStore.tables.size === 0 || offStore.tables.get(INBOX_TABLE_NAME) === undefined, true,
        "a disabled inbox writes no checkpoints");
      assert.equal(inboxWakeCount(offAgent), 0);

      // Enabled but NO directory: same totality — nothing to watch, so
      // nothing starts (and nothing crashes).
      const emptyStore = createSharedTables();
      const emptyCtx = createInboxCtx(emptyStore);
      pluginApply(emptyCtx as never, volatileConfig({
          enabled: true,
          inboxEnabled: true,
          inboxDir: "",
  }));
      const emptyAgent = createAgent("s-1");
      emptyCtx.bindAgent(emptyAgent);
      emptyCtx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent: emptyAgent,
      });
      await flushActivation();
      assert.equal(
        emptyStore.tables.get(INBOX_TABLE_NAME) === undefined ||
          emptyStore.tables.get(INBOX_TABLE_NAME)?.size === 0,
        true,
        "an empty-dir inbox writes no checkpoints",
      );
      assert.equal(inboxWakeCount(emptyAgent), 0);
    } finally {
      await removeTempRoot(parent);
    }
  });
});

describe("inbox end to end — the full pipeline (ticket 113, ADR-0023)", () => {
  it("queue line → claim → inbox wake → deliver_result closes the obligation through the dispatcher's reply", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dsh-inbox-e2e-"));
    const root = join(parent, "inbox");
    const shared = createSharedTables();
    const ctx = createInboxCtx(shared);
    try {
      pluginApply(ctx as never, volatileConfig({
          enabled: true,
          inboxEnabled: true,
          inboxDir: root,
          inboxRescanIntervalMs: 1000,
      }));
      const agent = createScopedAgent("s-1");
      ctx.bindAgent(agent as never);
      const started = ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent,
      });
      assert.equal(started.kind, "success");
      await flushActivation();
      // The watcher mkdirs its root at start — a real fs op, so poll rather
      // than assert.
      await pollUntil(() => dirExists(root));

      await writeQueue(root, [
        JSON.stringify({ jobId: "job-1", text: "Build the widget" }),
      ]);
      await pollUntil(async () => {
        const checkpoint = readCheckpoints(shared).get("job-1");
        return checkpoint?.state === "presented";
      });

      // The wake carries the composed inbox section: heading, job id, prompt.
      const wakeTexts = agent.woken.map(textOf).filter((text) =>
        text.includes(INBOX_JOBS_HEADING),
      );
      assert.equal(wakeTexts.length, 1, "exactly one inbox wake");
      const wake = wakeTexts[0] ?? "";
      assert.ok(wake.includes("### Inbox job job-1"), "the job id is named");
      assert.ok(wake.includes("Build the widget"), "the prompt rides the wake");

      // The todo id is discoverable from the checkpoint (the external
      // system's view of our state), then the dispatcher replies with it.
      const presented = readCheckpoints(shared).get("job-1");
      assert.ok(presented?.todoId, "the checkpoint carries the todo id");
      const deliver = agent.scopedTool("deliver_result");
      assert.ok(deliver, "deliver_result is registered on activation");
      const result = (await deliver.execute({
        text: "All done",
        todo_id: presented.todoId,
      })) as {
        ok?: boolean;
        delivered?: boolean;
        channel?: string;
        todo_completed?: unknown;
        reason?: string;
      };
      // ADR-0009: delivery is conversational. With no separate user-facing
      // send wired, the dispatcher's own reply IS the channel: the obligation
      // closes here, and the result must say so without pretending the user
      // has already seen it.
      assert.equal(result.ok, true);
      assert.equal(result.delivered, true);
      assert.equal(result.channel, "reply");
      assert.equal(result.todo_completed, presented.todoId);

      // The reply writer rides the `replied` resolution: reply.md is the done
      // signal, status.json carries the terminal outcome, and the checkpoint
      // closes so the boot rescan never re-presents the job.
      await pollUntil(async () => {
        const checkpoint = readCheckpoints(shared).get("job-1");
        return checkpoint?.state === "replied";
      });
      assert.equal(
        await readFile(join(root, "job-1", "reply.md"), "utf8"),
        "All done\n",
      );
      const status = await readStatus(join(root, "job-1"));
      assert.equal(status.status, "replied");
      assert.equal(typeof status.endedAt, "number");
      const replied = readCheckpoints(shared).get("job-1");
      assert.equal(replied?.state, "replied");
      assert.equal(typeof replied?.endedAtMs, "number");
    } finally {
      ctx.dispose();
      await removeTempRoot(parent);
    }
  });

  it("a worker error still writes the honest failed status and closes the checkpoint", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dsh-inbox-failed-"));
    const root = join(parent, "inbox");
    const jobDir = join(root, "job-err");
    const shared = createSharedTables();
    const ctx = createInboxCtx(shared);
    try {
      // The worker whose error must close the job. `spawn_worker` is retired,
      // so the setup uses the restart-side core seam instead: a live-at-crash
      // marker linked to the presented inbox job is rebuilt as a hold, then
      // reclaimed when the host announces the resumed child. That is the same
      // worker record a stock spawn would establish, with the inbox link.
      await mkdir(jobDir, { recursive: true });
      await writeFile(
        join(jobDir, "status.json"),
        JSON.stringify({ jobId: "job-err", status: "claimed", claimedAt: 1_000 }) +
          "\n",
        "utf8",
      );
      shared.tables.set(
        MARKER_TABLE_NAME,
        new Map<string, unknown>([
          [
            "w-err",
            {
              workerId: "w-err",
              parentSessionId: "s-1",
              streamKey: "err",
              title: "Widget worker",
              status: "running",
              transcriptRef: null,
              todoId: "todo-err",
              external: { kind: "inbox", jobId: "job-err", jobDir },
              startedAtMs: 1_000,
              updatedAtMs: 2_000,
            },
          ],
        ]),
      );
      shared.tables.set(
        WORKER_SESSION_TABLE_NAME,
        new Map<string, unknown>([
          ["w-err", { sessionId: "w-err", parentSessionId: "s-1" }],
        ]),
      );
      // Intake is off: only the durable link drives the terminal write.
      pluginApply(ctx as never, volatileConfig({ enabled: true }));
      const agent = createAgent("s-1");
      ctx.bindAgent(agent as never);
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
      await flushActivation();

      // Seed the presented checkpoint AFTER activation: the boot rescan must
      // not try to re-present it (there is no queue line to resolve). The
      // resolution writer updates this row when the worker errors.
      let inboxTable = shared.tables.get(INBOX_TABLE_NAME);
      if (inboxTable === undefined) {
        inboxTable = new Map<string, unknown>();
        shared.tables.set(INBOX_TABLE_NAME, inboxTable);
      }
      inboxTable.set("job-err", {
        jobId: "job-err",
        state: "presented",
        jobDir,
        sessionId: "s-1",
        todoId: "todo-err",
        claimedAtMs: 1_000,
        presentedAtMs: 2_000,
        endedAtMs: null,
        presentAttempts: 1,
      });

      // Announce the resumed child; composition is applied before reclaim.
      const probe = workerCompositionProbe();
      const worker: AgentLike = {
        session: {
          id: "w-err",
          header: {
            parentSession: "s-1",
            delegationDepth: 1,
            origin: "subagent",
          },
        },
        followup() {},
        inject() {},
        ctx: probe.ctx,
      };
      ctx.bindAgent(worker as AgentLike & { session: { id: string } });
      ctx.fire("agent/created", { agent: worker, source: "resume" });
      await pollUntil(() => probe.applied());

      // No delivery channel exists, but a worker ERROR is a terminal path the
      // reply writer owns: status.json {status:"failed"} + closed checkpoint.
      ctx.fire("subagent/end", {
        id: "w-err",
        stopReason: "error",
        lastAssistantMessage: [{ type: "text", text: "boom" }],
      });

      await pollUntil(async () => {
        const checkpoint = readCheckpoints(shared).get("job-err");
        return checkpoint?.state === "failed";
      });
      const status = await readStatus(jobDir);
      assert.equal(status.status, "failed");
      assert.equal(status.error, "boom");
      await assert.rejects(
        readFile(join(jobDir, "reply.md"), "utf8"),
        "the failed path writes no reply.md",
      );
      const terminal = readCheckpoints(shared).get("job-err");
      assert.equal(terminal?.state, "failed");
      assert.ok(terminal?.endedAtMs !== null, "the checkpoint is closed");
    } finally {
      ctx.dispose();
      await removeTempRoot(parent);
    }
  });

  it("no resolvable job dir refuses to write into the process cwd and keeps the checkpoint non-terminal", async () => {
    // The hook's one hard rule: `join("", jobId)` must never be used. This job
    // has no `jobDir` on its origin and no inbox root is configured, so the
    // writer refuses, warns once, and leaves the checkpoint for the boot
    // rescan instead of littering the process cwd with reply.md/status.json.
    const shared = createSharedTables();
    const ctx = createInboxCtx(shared);
    try {
      // A live-at-crash worker whose linked todo carries an inbox origin with
      // no directory. It is rebuilt as a ticket-59 hold, reattached when the
      // host announces the worker, and then fails — one terminal path that
      // fires the plugin's `onInboxJobResolved` hook.
      shared.tables.set(
        MARKER_TABLE_NAME,
        new Map<string, unknown>([
          [
            "w-nowhere",
            {
              workerId: "w-nowhere",
              parentSessionId: "s-1",
              streamKey: "nowhere",
              title: "Job with no directory",
              status: "running",
              transcriptRef: null,
              todoId: "todo-nowhere",
              external: {
                kind: "inbox",
                jobId: "job-nowhere",
                jobDir: "",
              },
              startedAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        ]),
      );
      shared.tables.set(
        WORKER_SESSION_TABLE_NAME,
        new Map<string, unknown>([
          ["w-nowhere", { sessionId: "w-nowhere", parentSessionId: "s-1" }],
        ]),
      );
      shared.tables.set(
        INBOX_TABLE_NAME,
        new Map<string, unknown>([
          [
            "job-nowhere",
            {
              jobId: "job-nowhere",
              state: "presented",
              jobDir: "",
              sessionId: "s-1",
              todoId: "todo-nowhere",
              claimedAtMs: 1_000,
              presentedAtMs: 2_000,
              endedAtMs: null,
              presentAttempts: 1,
            },
          ],
        ]),
      );

      // Inbox intake is OFF: `inboxRoot` is empty, so only the job's own
      // (empty) dir could resolve — and it must not fall back to the cwd.
      pluginApply(ctx as never, volatileConfig({ enabled: true }));
      const agent = createAgent("s-1");
      ctx.bindAgent(agent);
      ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
      await flushActivation();

      const probe = workerCompositionProbe();
      const worker: AgentLike = {
        session: {
          id: "w-nowhere",
          header: {
            parentSession: "s-1",
            delegationDepth: 1,
            origin: "subagent",
          },
        },
        followup() {},
        inject() {},
        ctx: probe.ctx,
      };
      ctx.bindAgent(worker as AgentLike & { session: { id: string } });
      ctx.fire("agent/created", { agent: worker, source: "resume" });
      await flushActivation();
      // Adoption + reclaim are async (the worker-session row round-trip).
      // Composition lands immediately before the reclaim, so it is the kept
      // replacement for the retired `check_workers` roster poll.
      await pollUntil(() => probe.applied());

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
      };
      try {
        ctx.fire("subagent/end", {
          id: "w-nowhere",
          stopReason: "error",
          lastAssistantMessage: [{ type: "text", text: "boom" }],
        });
        await flushActivation();
      } finally {
        console.warn = originalWarn;
      }

      const refusals = warnings.filter(
        (line) =>
          line.includes("job-nowhere") &&
          line.includes("refusing to write"),
      );
      assert.equal(refusals.length, 1, "the refusal is logged exactly once");
      assert.ok(
        refusals[0]?.includes("process cwd"),
        "the warning names the hazard it avoids",
      );

      // Nothing was written where the process runs.
      await assert.rejects(
        stat(join(process.cwd(), "reply.md")),
        "no reply.md may land in the process cwd",
      );
      await assert.rejects(
        stat(join(process.cwd(), "status.json")),
        "no status.json may land in the process cwd",
      );

      // The checkpoint stays non-terminal so the boot rescan can retry.
      const checkpoint = readCheckpoints(shared).get("job-nowhere");
      assert.equal(checkpoint?.state, "presented");
      assert.equal(checkpoint?.endedAtMs, null);
    } finally {
      ctx.dispose();
    }
  });

  it("restart re-presents a claimed-but-unreplied job: no double claim, no duplicate wake", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dsh-inbox-restart-"));
    const root = join(parent, "inbox");
    const shared = createSharedTables();

    // ── Life 1: claim + present the job, then the host dies. ──
    {
      const ctx = createInboxCtx(shared);
      try {
        pluginApply(ctx as never, volatileConfig({
            enabled: true,
            inboxEnabled: true,
            inboxDir: root,
            inboxRescanIntervalMs: 1000,
  }));
        const agent = createAgent("s-1");
      ctx.bindAgent(agent);
        ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
        await flushActivation();
        await writeQueue(root, [
          JSON.stringify({ jobId: "job-1", text: "Build the widget" }),
        ]);
        await pollUntil(async () => {
          const checkpoint = readCheckpoints(shared).get("job-1");
          return checkpoint?.state === "presented";
        });
        assert.equal(inboxWakeCount(agent), 1);
        const status = await readStatus(join(root, "job-1"));
        assert.equal(status.status, "claimed");
        assert.ok(typeof status.claimedAt === "number");
      } finally {
        // Host death: the watcher's effect disposer runs (fs.watch stops).
        ctx.dispose();
      }
    }

    // ── Life 2: fresh context, SAME tables, SAME session id. ──
    {
      const ctx = createInboxCtx(shared);
      try {
        pluginApply(ctx as never, volatileConfig({
            enabled: true,
            inboxEnabled: true,
            inboxDir: root,
            inboxRescanIntervalMs: 1000,
  }));
        const agent = createAgent("s-1");
      ctx.bindAgent(agent);
        ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
        await flushActivation();

        // The boot rescan re-presents the orphaned job: the fresh core's
        // ledger is empty, so the owner check passes and the job is
        // presented a SECOND time — never a third.
        await pollUntil(async () => {
          const checkpoint = readCheckpoints(shared).get("job-1");
          return checkpoint?.presentAttempts === 2;
        });
        // No double claim: the status file's claim stamp is life 1's.
        const status = await readStatus(join(root, "job-1"));
        assert.equal(status.status, "claimed");
        const life1ClaimedAt = status.claimedAt;
        await pollUntil(async () => {
          const recheck = await readStatus(join(root, "job-1"));
          return recheck.claimedAt === life1ClaimedAt;
        });
        // Exactly one fresh wake in this life (the re-presentation).
        assert.equal(
          inboxWakeCount(agent),
          1,
          "the re-presented job wakes once",
        );
        const checkpoint = readCheckpoints(shared).get("job-1");
        assert.equal(checkpoint?.state, "presented");
        assert.equal(checkpoint?.sessionId, "s-1");
      } finally {
        ctx.dispose();
        await removeTempRoot(parent);
      }
    }
  });

});

describe("inbox end to end — no dispatcher at claim (ticket 113 N1a)", () => {
  it("a claimed job with zero live dispatchers stays held: no wake until a later activation presents it exactly once", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dsh-inbox-hold-"));
    const root = join(parent, "inbox");
    const shared = createSharedTables();
    const ctx = createInboxCtx(shared);
    try {
      pluginApply(ctx as never, volatileConfig({
          enabled: true,
          inboxEnabled: true,
          inboxDir: root,
          inboxRescanIntervalMs: 1000,
  }));
      // Bound for wake routing, but never activated: ZERO live dispatcher
      // sessions while the watcher claims the job.
      const agent = createAgent("s-1");
      ctx.bindAgent(agent);
      await flushActivation();

      await writeQueue(root, [
        JSON.stringify({ jobId: "job-1", text: "Build the widget" }),
      ]);
      // The watcher claims on disk and records the claimed checkpoint; the
      // present half of the claim finds no live session and must no-op.
      await pollUntil(async () => {
        const checkpoint = readCheckpoints(shared).get("job-1");
        return checkpoint?.state === "claimed";
      });
      // A real window for any hypothetical eager presenter, then pin the
      // honest dormant posture (ADR-0023 decision 4).
      await new Promise((resolve) => setTimeout(resolve, 150));
      const held = readCheckpoints(shared).get("job-1");
      assert.equal(held?.state, "claimed");
      assert.equal(held?.sessionId, null, "an unclaimed-by-session job has no owner");
      assert.equal(held?.todoId, null);
      assert.equal(held?.presentAttempts, 0);
      assert.equal(
        inboxWakeCount(agent),
        0,
        "no wake without a live dispatcher session",
      );
      const heldStatus = await readStatus(join(root, "job-1"));
      assert.equal(heldStatus.status, "claimed");

      // A later activation is the presentation opportunity: the boot rescan
      // re-presents the held job exactly once.
      const started = ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent,
      });
      assert.equal(started.kind, "success");
      await flushActivation();
      await pollUntil(async () => {
        const checkpoint = readCheckpoints(shared).get("job-1");
        return (
          checkpoint?.state === "presented" && checkpoint?.presentAttempts === 1
        );
      });
      const presented = readCheckpoints(shared).get("job-1");
      assert.equal(presented?.sessionId, "s-1");
      assert.ok(presented?.todoId, "the presentation created the ledger item");
      assert.equal(
        inboxWakeCount(agent),
        1,
        "exactly one wake — after activation, never before",
      );
      const wakeTexts = agent.woken
        .map(textOf)
        .filter((text) => text.includes(INBOX_JOBS_HEADING));
      assert.ok(
        wakeTexts[0]?.includes("### Inbox job job-1"),
        "the held job's prompt rides the post-activation wake",
      );
      // Presentation never re-claims: the disk claim stamp is the claim's.
      const afterStatus = await readStatus(join(root, "job-1"));
      assert.equal(afterStatus.status, "claimed");
      assert.equal(afterStatus.claimedAt, heldStatus.claimedAt);
    } finally {
      ctx.dispose();
      await removeTempRoot(parent);
    }
  });
});


describe("inbox end to end — boot rescan adopts disk truth (ticket 113 N2)", () => {
  it("a job dir whose files already show a terminal outcome is adopted, never re-presented", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dsh-inbox-adopt-"));
    const root = join(parent, "inbox");
    const shared = createSharedTables();
    const ctx = createInboxCtx(shared);
    try {
      // Crash-window job: the reply write landed but the checkpoint update
      // never did — a non-empty reply.md IS the protocol's done signal.
      const dir1 = join(root, "job-1");
      await mkdir(dir1, { recursive: true });
      await writeFile(join(dir1, "reply.md"), "already answered\n", "utf8");
      await writeFile(
        join(dir1, "status.json"),
        `${JSON.stringify({ jobId: "job-1", status: "claimed", claimedAt: 111 }, null, 2)}\n`,
        "utf8",
      );
      // Status-only job: status.json replied with no reply.md at all.
      const dir2 = join(root, "job-2");
      await mkdir(dir2, { recursive: true });
      await writeFile(
        join(dir2, "status.json"),
        `${JSON.stringify({ jobId: "job-2", status: "replied", endedAt: 222 }, null, 2)}\n`,
        "utf8",
      );
      // Prior claimed checkpoint rows — what WE recorded before the crash.
      const seed = (jobId: string, jobDir: string): InboxJobCheckpoint => ({
        jobId,
        state: "claimed",
        jobDir,
        sessionId: null,
        todoId: null,
        claimedAtMs: 1000,
        presentedAtMs: null,
        endedAtMs: null,
        presentAttempts: 0,
      });
      shared.tables.set(
        INBOX_TABLE_NAME,
        new Map<string, unknown>([
          ["job-1", seed("job-1", dir1)],
          ["job-2", seed("job-2", dir2)],
        ]),
      );

      pluginApply(ctx as never, volatileConfig({
          enabled: true,
          inboxEnabled: true,
          inboxDir: root,
          inboxRescanIntervalMs: 1000,
  }));
      const agent = createAgent("s-1");
      ctx.bindAgent(agent);
      const started = ctx.runCommand({
        commandId: DISPATCHER_START_COMMAND,
        agent,
      });
      assert.equal(started.kind, "success");
      await flushActivation();

      // The boot rescan ADOPTS both rows into the disk's terminal outcome.
      await pollUntil(() => {
        const checkpoints = readCheckpoints(shared);
        return (
          checkpoints.get("job-1")?.state === "replied" &&
          checkpoints.get("job-2")?.state === "replied"
        );
      });
      for (const jobId of ["job-1", "job-2"]) {
        const adopted = readCheckpoints(shared).get(jobId);
        assert.equal(adopted?.state, "replied", `${jobId} adopted as replied`);
        assert.ok(
          typeof adopted?.endedAtMs === "number",
          `${jobId} is closed`,
        );
        assert.equal(
          adopted?.presentAttempts,
          0,
          `${jobId} was never presented`,
        );
        assert.equal(adopted?.sessionId, null);
        assert.equal(adopted?.todoId, null);
      }
      assert.equal(
        inboxWakeCount(agent),
        0,
        "a disk-terminal job is never re-presented",
      );
      // The reply file is the external system's truth — untouched.
      assert.equal(
        await readFile(join(dir1, "reply.md"), "utf8"),
        "already answered\n",
      );
    } finally {
      ctx.dispose();
      await removeTempRoot(parent);
    }
  });
});

