/**
 * Ticket 32 — dormant/activated composition polish (design-17 §3, §7, §8).
 *
 * Offline only (S8): a fake host context (persistent marker table, recording
 * settings scope, recording user-questions seam) drives the real plugin
 * apply(); the real client store/view model consumes the mirrored snapshots.
 * No network, no LLM, no running dsh.
 *
 * Fake-vs-host (ticket 91): the fake `commands.register` / `tools.register`
 * throw on a duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-commands/lib/index.js:82`,
 * `@deepseek-ai/dsh-tools/lib/index.js:2538`) — the dormant-registration
 * matrix below must hold under the real fail-loud registries.
 *
 * Fake-vs-host (ticket 93): the fake settings provider models the shipped
 * scope contract — `register(ns, schema, options?)` returns the owner scope
 * (`@deepseek-ai/dsh-settings/lib/index.js:281-315`) while
 * `installSection(...)` returns VOID (`:327-343`;
 * `lib/types/index.d.ts:228`).
 *
 * Four composition contracts:
 * 1. **Activation copy** — the presence hint is appended exactly once to the
 *    success copy, and the host copy and the client locale faces stay one
 *    localized unit (identical en string; zh present and distinct).
 * 2. **Dormant registration matrix** — a dormant boot (tickets 27–31 all
 *    landed) registers nothing visible beyond the two commands: no tools, no
 *    roster publish, no access prompt, no restart notice, and no new
 *    listeners.
 * 3. **Deactivation honesty** — the panel path ages to "unavailable" after
 *    session end, and re-activation republishes a fresh roster (design-17
 *    §3.2 "what does the user come back to").
 * 4. **Locale + literal sweep** — the enlarged dictionary validates, every
 *    client key resolves, and no component carries a hard-coded user-facing
 *    sentence that bypasses the dictionary (tickets 27–31 additions).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { apply as pluginApply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import {
  ACTIVATION_PRESENCE_HINT,
  DISPATCHER_RESOLVE_COMMAND,
  DISPATCHER_START_COMMAND,
  DISPATCHER_START_SUCCESS,
  DISPATCHER_STEER_COMMAND,
  MARKER_TABLE_NAME,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
} from "../src/adapter/index.js";
import type { DurableWorkerMarker } from "../src/core/durability.js";
import {
} from "../src/core/roster-snapshot.js";
import { ACCESS_CLASSES } from "../src/core/access-types.js";
import {
  ROSTER_FINISHED_COUNT_KEY,
  ROSTER_SECTION_IDS,
  ROSTER_SECTION_KEYS,
  describeRosterPanel,
  rosterBlockedKey,
  rosterViewCopyKey,
} from "../src/client/roster-store.js";
import {
  TOOLVIEW_DEGRADED_KEY,
  TOOLVIEW_FIELD_KEYS,
} from "../src/client/toolviews.js";
import {
  LOCALE_NAMESPACE,
  localeDictionary,
  validateLocaleDictionary,
} from "../src/client/overlay.js";

/** Drain the async rebuild chain queued by activation (ticket 31). */
async function flushActivation(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface TestAgent extends AgentLike {
  readonly injected: unknown[];
}

function createAgent(id: string): TestAgent {
  const injected: unknown[] = [];
  return {
    session: { id, header: { parentSession: null, delegationDepth: 0 } },
    followup() {},
    inject(message: unknown) {
      injected.push(message);
    },
    injected,
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block.text ?? "").join("");
}

/**
 * Host context for the composition matrix: a persistent marker table, a
 * settings scope recording every mirrored update, a recording user-questions
 * seam, and a plain listener-count surface. Everything tickets 27–31 touch is
 * observable here, so "dormant registers nothing new" is asserted rather than
 * assumed.
 */
function createCompositionCtx() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const tables = new Map<string, Map<string, unknown>>();
  const updates: unknown[] = [];
  const claimedNamespaces = new Set<string>();
  const asks: unknown[] = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
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
    // Ticket 23/30 seam: the access prompt pump must stay inert while dormant.
    userQuestions: {
      async ask(question: unknown) {
        asks.push(question);
        return undefined;
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
          table: makeTable,
          async close() {},
          name: "stub",
        };
      },
    },
    // Test surface.
    fire,
    updates,
    asks,
    commandNames: () => [...commands.keys()],
    toolNames: () => [...tools.keys()],
    tool: (name: string) => tools.get(name),
    listenerCount: () => {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
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
  return ctx as unknown as AdapterContext & {
    fire(name: string, payload: unknown): void;
    readonly updates: unknown[];
    readonly asks: unknown[];
    commandNames(): string[];
    toolNames(): string[];
    listenerCount(): number;
    runCommand(invocation: {
      commandId: string;
      agent?: AgentLike;
    }): CommandResultLike;
  };
}

type SnapshotLike = {
  schemaVersion: number;
  dispatcherSessionId: string;
  publishedAtMs: number;
  workers: Array<{
    workerId: string;
    status: string;
    delivered: boolean;
    blocked: unknown;
    title: string;
    todoId: string | null;
    startedAtMs: number;
    toolCallCount: number;
    kind: string;
  }>;
};

const RESTORED_MARKER: DurableWorkerMarker = {
  workerId: "w-restored",
  parentSessionId: "s-1",
  streamKey: "todo-restored",
  title: "Parser hardening",
  status: "completed",
  transcriptRef: "child-restored",
  todoId: null,
  startedAtMs: 1_000,
  updatedAtMs: 2_000,
};

async function seedMarkers(
  ctx: ReturnType<typeof createCompositionCtx>,
  markers: DurableWorkerMarker[],
): Promise<void> {
  const domain = await ctx.storageDomain.open();
  const table = domain.table(MARKER_TABLE_NAME);
  for (const marker of markers) {
    await table.put(marker.workerId, marker);
  }
}

describe("composition polish — activation copy (design-17 §7)", () => {
  it("appends the presence hint to the success copy exactly once, using the exact draft string", () => {
    // design-17 §7 `activation.presence-hint`, en — the sanctioned source as
    // amended by ticket 134 (the panel claim removed under ADR-0024).
    assert.equal(
      ACTIVATION_PRESENCE_HINT,
      "The dispatcher reports progress as it works; results arrive in this chat as they finish.",
    );
    assert.ok(
      DISPATCHER_START_SUCCESS.endsWith(ACTIVATION_PRESENCE_HINT),
      "the hint is appended at the end of the success copy",
    );
    const occurrences =
      DISPATCHER_START_SUCCESS.split(ACTIVATION_PRESENCE_HINT).length - 1;
    assert.equal(occurrences, 1, "the hint appears exactly once");
    // The pre-ticket-32 sentence is still there, once: this is an append.
    assert.equal(
      DISPATCHER_START_SUCCESS.split("Dispatcher active in this chat.").length - 1,
      1,
    );
    assert.equal(
      DISPATCHER_START_SUCCESS.split("use /dispatcher-steer to nudge a running worker.").length - 1,
      1,
    );
  });

  it("the command result carries the enlarged success copy on a real activation", async () => {
    const ctx = createCompositionCtx();
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    const result = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(result, {
      kind: "success",
      text: DISPATCHER_START_SUCCESS,
    });
    assert.ok(result.text?.includes(ACTIVATION_PRESENCE_HINT));
    await flushActivation();
  });

  it("the host copy and the client locale faces stay one localized unit", () => {
    // en parity: the dictionary carries the exact host string (not a retyped
    // near-miss), so a copy edit in one place fails here.
    assert.equal(
      localeDictionary.en["activation.presence-hint"],
      ACTIVATION_PRESENCE_HINT,
    );
    // zh face present, non-empty, and actually translated (not the en string).
    const zh = localeDictionary.zh["activation.presence-hint"];
    assert.equal(typeof zh, "string");
    assert.notEqual(zh, "");
    assert.notEqual(zh, ACTIVATION_PRESENCE_HINT);
    // design-17 §7 zh draft, as amended by ticket 134 (panel claim removed).
    assert.equal(
      zh,
      "调度器会在工作中随时汇报进度；结果完成后会直接送达本聊天。",
    );
    // The en face stays ASCII copy: no accidental zh bleed in the en string.
    assert.doesNotMatch(ACTIVATION_PRESENCE_HINT, /[\u4e00-\u9fff]/);
  });

  it("does not promise a push surface: the hint names the pull surface only", () => {
    // Ticket 134 / ADR-0024: no panel of ours is mounted in the native-dsh
    // posture, so the hint must not name one.
    assert.doesNotMatch(ACTIVATION_PRESENCE_HINT, /panel/i);
    assert.match(ACTIVATION_PRESENCE_HINT, /this chat/);
    for (const forbidden of [
      "notify",
      "notification",
      "alert",
      "toast",
      "banner",
      "badge",
      "push",
      "email",
    ]) {
      assert.equal(
        ACTIVATION_PRESENCE_HINT.toLowerCase().includes(forbidden),
        false,
        `presence hint must not promise "${forbidden}" (no push seam; design-17 §4.8)`,
      );
    }
  });
});

describe("composition polish — dormant registration matrix (design-17 §3.2/§8)", () => {
  it("dormant boot registers nothing visible beyond the two commands (tickets 27–31 add nothing)", async () => {
    const ctx = createCompositionCtx();
    pluginApply(ctx, volatileConfig({ enabled: true }));

    // Stock dsh: the first top-level session is not repurposed.
    const agent = createAgent("s-1");
    ctx.fire("agent/session-start", { agent });
    await flushActivation();
    assert.equal(agent.injected.length, 0, "no capture, no policy inject");

    // Visible host surface: exactly the three commands, no tools.
    assert.deepEqual(ctx.commandNames().sort(), [
      DISPATCHER_RESOLVE_COMMAND,
      DISPATCHER_STEER_COMMAND,
      // "dsh-bot" sorts after the dispatcher- names (ADR-0030 rename); the
      // withdrawn dispatcher-stop (ticket 101) is gone (ticket 129).
      DISPATCHER_START_COMMAND,
    ]);
    assert.deepEqual(ctx.toolNames(), []);

    // 0.2.1 removed the settings mirror entirely; dormant boot registers no
    // publish path at all, so nothing can reach a client surface.
    assert.deepEqual(ctx.updates, []);
    // Ticket 23/30 (access prompts) stay inert without an activation.
    assert.deepEqual(ctx.asks, []);
    // Ticket 31: no restart notice is injected before an activation exists.
    assert.equal(
      agent.injected.filter((m) => textOf(m).includes("## Restart")).length,
      0,
    );
    // Listener baseline: the passive plumbing is exactly five listeners
    // (2 lifecycle + 3 host: `subagent/end`, `session/event`, `agent/created`
    // — the last is the worker-composition seam and must stay passive while
    // no spawn is in flight).
    assert.equal(ctx.listenerCount(), 5);
  });

  it("an unrelated settings write while dormant does not surface a roster", async () => {
    const ctx = createCompositionCtx();
    pluginApply(ctx, volatileConfig({ enabled: true }));
    ctx.fire("agent/status", {
      agent: { session: { id: "someone-else" } },
      status: "running",
    });
    await flushActivation();
    assert.deepEqual(ctx.updates, []);
    assert.deepEqual(ctx.toolNames(), []);
  });

  it("activation is what raises the surface: tools appear, nothing is mirrored", async () => {
    const ctx = createCompositionCtx();
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await flushActivation();

    assert.deepEqual(ctx.toolNames().sort(), [
      "await_agent",
      "check_workers",
      "deliver_result",
      "message_agent",
      "request_access",
      "spawn_dispatcher",
      "spawn_worker",
      "steer_worker",
      "stop_worker",
    ]);
    // The roster view now comes from the core through check_workers; no
    // settings document is written.
    assert.deepEqual(ctx.updates, [], "no settings mirror exists to write to");
    const check = ctx.tool("check_workers");
    assert.ok(check);
    const roster = (await check.execute({})) as {
      ok: boolean;
      rows: Array<{ worker_id: string }>;
    };
    assert.deepEqual(roster.rows, [], "the empty roster reads back");
  });
});

describe("composition polish — deactivation honesty (design-17 §3.2)", () => {
  it("session end unbinds the surface; re-activation rebuilds a fresh roster", async () => {
    const ctx = createCompositionCtx();
    await seedMarkers(ctx, [RESTORED_MARKER]);
    pluginApply(ctx, volatileConfig({ enabled: true }));
    const agent = createAgent("s-1");

    // First activation: the durable rebuild lands before the roster is read,
    // so the restored terminal row is already there.
    ctx.runCommand({ commandId: DISPATCHER_START_COMMAND, agent });
    await flushActivation();
    const check = ctx.tool("check_workers");
    assert.ok(check, "activation raised the tool surface");
    const first = (await check.execute({})) as {
      ok: boolean;
      rows: Array<{ worker_id: string }>;
    };
    assert.ok(
      first.rows.some((row) => row.worker_id === "w-restored"),
      "restored row is on the roster after the rebuild",
    );

    // Session end: the dispatcher unbinds and its tool surface disappears.
    ctx.fire("agent/disposed", { agent });
    assert.deepEqual(ctx.toolNames(), [], "the activated tool surface is gone");

    // Re-activation raises a new surface over the same core state.
    const again = ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.deepEqual(again, {
      kind: "success",
      text: DISPATCHER_START_SUCCESS,
    });
    await flushActivation();
    const checkAgain = ctx.tool("check_workers");
    assert.ok(checkAgain, "re-activation raises the surface again");
    const second = (await checkAgain.execute({})) as {
      ok: boolean;
      rows: Array<{ worker_id: string }>;
    };
    assert.ok(
      second.rows.some((row) => row.worker_id === "w-restored"),
      "the rebuilt roster is readable again",
    );
  });
});

describe("composition polish — locale validation + literal sweep (§8)", () => {
  it("the final enlarged dictionary validates with identical en/zh key sets", () => {
    assert.deepEqual(validateLocaleDictionary(localeDictionary), []);
    const en = Object.keys(localeDictionary.en).sort();
    const zh = Object.keys(localeDictionary.zh).sort();
    assert.deepEqual(zh, en, "identical key sets");
    assert.ok(en.length > 0);
    for (const key of en) {
      assert.equal(typeof localeDictionary.en[key], "string", `en ${key}`);
      assert.equal(typeof localeDictionary.zh[key], "string", `zh ${key}`);
      assert.notEqual(localeDictionary.en[key], "", `en ${key} empty`);
      assert.notEqual(localeDictionary.zh[key], "", `zh ${key} empty`);
    }
  });

  it("every locale key the client code can request resolves in both faces", () => {
    const requested: string[] = [
      "roster.title",
      "roster.empty",
      "roster.unavailable",
      "roster.loading",
      "roster.landed",
      "roster.activity.toolcalls",
      "activation.presence-hint",
      ROSTER_FINISHED_COUNT_KEY,
      TOOLVIEW_DEGRADED_KEY,
      ...Object.values(ROSTER_SECTION_KEYS),
      ...Object.values(TOOLVIEW_FIELD_KEYS),
      // Blocked phrases are composed per access class; all must exist.
      ...ACCESS_CLASSES.map((accessClass) => rosterBlockedKey(accessClass)),
    ];
    for (const key of requested) {
      assert.equal(
        typeof localeDictionary.en[key],
        "string",
        `en face missing requested key ${key}`,
      );
      assert.equal(
        typeof localeDictionary.zh[key],
        "string",
        `zh face missing requested key ${key}`,
      );
    }
    // Roster section heads match the section ids one-for-one.
    assert.equal(Object.keys(ROSTER_SECTION_KEYS).length, ROSTER_SECTION_IDS.length);
  });

  it("the client render path carries no hard-coded user-facing sentence", () => {
    // Sweep the copy-rendering components (panel, toolviews, and the
    // ticket-47 settings card): any quoted literal
    // containing a space (a plausible English sentence) that is not a dotted
    // locale key is a dictionary bypass. Comments and the self-contained CSS
    // strings are stripped first (both legitimately carry prose/spaces and
    // neither is user-facing text). (The retired capsule component left the
    // list with its deletion — ticket 89.)
    for (const file of [
      "../src/client/panel.tsx",
      "../src/client/toolview-panel.tsx",
      "../src/client/settings-card.tsx",
    ]) {
      const raw = readFileSync(new URL(file, import.meta.url), "utf8");
      const withoutComments = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      const withoutCss = withoutComments.replace(
        /export const [A-Z_]+_CSS = `[\s\S]*?`;/,
        "",
      );
      const literals = [
        ...withoutCss.matchAll(/"([^"\\]|\\.)*"/g),
        ...withoutCss.matchAll(/'([^'\\]|\\.)*'/g),
      ].map((match) => match[0].slice(1, -1));
      const offenders = literals.filter((literal) => {
        if (!literal.includes(" ")) return false;
        // Dotted locale keys are lookups, not copy.
        if (/^[a-z][a-z0-9.-]*(\.[a-z0-9-]+)+$/.test(literal)) return false;
        return true;
      });
      assert.deepEqual(
        offenders,
        [],
        `${file} must localize every user-facing string; found literals: ${offenders.join(" | ")}`,
      );
    }
  });

  it("no shipped identifier from the contaminated reconstruction is present", () => {
    // Clean-room guard repeated at the composition layer (design-17 §10):
    // the copy/locale additions of tickets 27–32 must not carry them either.
    const surfaces = [
      JSON.stringify(localeDictionary),
      ACTIVATION_PRESENCE_HINT,
      DISPATCHER_START_SUCCESS,
    ].join("\n");
    for (const forbidden of [
      "sand",
      "executor",
      "MessageSubagent",
      "SAND_MULTITASK",
    ]) {
      assert.equal(
        surfaces.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `shipped copy must not contain "${forbidden}"`,
      );
    }
    assert.ok(LOCALE_NAMESPACE.length > 0);
  });
});

describe("composition polish — host duplicate-registration rule (ticket 91)", () => {
  it("apply throws the host duplicate-command error when a command name is taken", () => {
    const ctx = createCompositionCtx();
    ctx.commands.register({
      name: DISPATCHER_START_COMMAND,
      description: "foreign claimant",
      handler: () => ({ kind: "success", text: "foreign" }),
    });

    assert.throws(
      () => pluginApply(ctx, volatileConfig({ enabled: true })),
      new RegExp(
        `command "${DISPATCHER_START_COMMAND}" is already registered`,
      ),
    );
  });

  it("the fake tool registry throws the host duplicate-tool error on a taken name", () => {
    const ctx = createCompositionCtx();
    const tools = ctx.tools as unknown as {
      register(definition: {
        name: string;
        execute: () => Promise<unknown>;
      }): () => void;
    };
    tools.register({ name: "spawn_worker", execute: async () => ({}) });

    assert.throws(
      () =>
        tools.register({ name: "spawn_worker", execute: async () => ({}) }),
      /tool "spawn_worker" is already registered/,
    );
  });
});