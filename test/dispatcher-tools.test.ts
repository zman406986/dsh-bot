import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createMultitask,
  type InboxJobResolution,
  type Multitask,
} from "../src/core/multitask.js";
import {
  createDispatcherTools,
  DISPATCHER_WITHHELD_HOST_TOOLS,
  HOST_SPAWN_TOOL_CANDIDATES,
  withheldHostSpawnTools,
  withholdHostSpawnTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import {
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
} from "../src/core/policy/prompts.js";
import { toRegisterableTool } from "../src/adapter/dispatcher-tools.js";
import type { DeliverResultToolResult } from "../src/core/tool-results.js";
import type { SpawnResult } from "../src/core/types.js";

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

function byName(tools: DispatcherToolDef[], name: string): DispatcherToolDef {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

/**
 * The local dispatcher fixture kept by this file: the three kept tools over
 * the real core. The removed spawn/check/steer/stop/await handlers used to
 * share it; only `deliver_result` still exercises a handler from here.
 */
async function setup(options?: {
  deliverToUser?: (text: string, paths?: readonly string[]) => Promise<boolean>;
}): Promise<{
  host: FakeDshHost;
  multitask: Multitask;
  tools: DispatcherToolDef[];
}> {
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => "session-1",
    ...(options?.deliverToUser !== undefined
      ? { deliverToUser: options.deliverToUser }
      : {}),
  });
  return { host, multitask, tools };
}

describe("dispatcher tools — deliver_result", () => {
  it("delivers then marks the todo completed (S4)", async () => {
    const delivered: string[] = [];
    const { multitask, tools } = await setup({
      deliverToUser: async (text) => {
        delivered.push(text);
        return true;
      },
    });
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-1",
      title: "Summarize RFCs",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "t-1",
        title: "Summarize RFCs",
        prompt: "Go.",
        todoId: "t-1",
      }),
    );
    multitask.noteTurnStarted(workerId);

    const result = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "Here's the third-RFC summary…",
      todo_id: "t-1",
    })) as DeliverResultToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.delivered, true);
    assert.equal(result.channel, "send");
    assert.equal(result.todo_completed, "t-1");
    assert.deepEqual(delivered, ["Here's the third-RFC summary…"]);
    const todo = multitask.listTodos("session-1").find((t) => t.id === "t-1");
    assert.equal(todo?.status, "completed");
    assert.equal(todo?.delivered, true);

    // The explicit send channel keeps its existing success copy.
    const renderable = toRegisterableTool(byName(tools, DELIVER_RESULT_TOOL));
    const blocks = renderable.output.render({}, result);
    assert.equal(
      blocks[0]?.text,
      "Delivered to the user. Todo completed: t-1.",
    );
  });

  it("failed send does not mark the todo completed", async () => {
    const { multitask, tools } = await setup({
      deliverToUser: async () => false,
    });
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-1",
      title: "Task",
    });
    const result = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "hello",
      todo_id: "t-1",
    })) as DeliverResultToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.delivered, false);
    assert.equal(result.todo_completed, null);
    assert.equal(result.reason, "send-failed");
    const todo = multitask.listTodos("session-1").find((t) => t.id === "t-1");
    assert.equal(todo?.delivered, false);
  });

  it("a todo from another dispatcher is refused silently and never marked", async () => {
    const delivered: string[] = [];
    const { multitask, tools } = await setup({
      deliverToUser: async (text) => {
        delivered.push(text);
        return true;
      },
    });
    multitask.createTodo({
      sessionId: "session-2",
      id: "t-foreign",
      title: "Someone else's obligation",
    });

    const result = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "Not mine to deliver.",
      todo_id: "t-foreign",
    })) as DeliverResultToolResult;
    assert.deepEqual(result, {
      ok: false,
      delivered: false,
      todo_completed: null,
      reason: "unknown-target",
      detail:
        'No todo entry "t-foreign" in this session — nothing was delivered and nothing was marked completed.',
    });
    assert.deepEqual(delivered, [], "a foreign todo must not reach the user send");
    const todo = multitask.listTodos("session-2").find((t) => t.id === "t-foreign");
    assert.equal(todo?.delivered, false);
  });

  it("with no user-facing channel: records for the reply and completes the todo", async () => {
    const { multitask, tools } = await setup();
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-1",
      title: "Task",
    });

    const result = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "The answer the user needs to hear.",
      todo_id: "t-1",
    })) as DeliverResultToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.delivered, true);
    assert.equal(result.channel, "reply");
    assert.equal(result.todo_completed, "t-1");
    assert.equal(result.todo_title, "Task");
    assert.match(result.detail ?? "", /say it in your reply/i);
    assert.doesNotMatch(result.detail ?? "", /already (seen|read)/i);

    const todo = multitask.listTodos("session-1").find((t) => t.id === "t-1");
    assert.equal(todo?.delivered, true, "the reply is the channel");
    assert.equal(todo?.status, "completed");

    // The adapter renderer must state the truth: recorded for the reply, never
    // "Delivered to the user".
    const renderable = toRegisterableTool(byName(tools, DELIVER_RESULT_TOOL));
    const blocks = renderable.output.render({}, result);
    assert.equal(blocks[0]?.type, "text");
    assert.match(blocks[0]?.text ?? "", /^Result recorded — say it in your reply/);
    assert.match(blocks[0]?.text ?? "", /todo "Task" marked done/);
    assert.doesNotMatch(blocks[0]?.text ?? "", /Delivered to the user/);
  });

  it("a no-channel delivery of an inbox job fires the replied hook with the text", async () => {
    // The shipped plugin never wires deliverToUser, so an inbox job's only
    // reply path is this one: the tool marks the item delivered and the core
    // fires `replied`, which the plugin's writer turns into reply.md.
    const host = new FakeDshHost();
    const resolutions: InboxJobResolution[] = [];
    const multitask = createMultitask(host, {
      onInboxJobResolved: (resolution) => {
        resolutions.push(resolution);
      },
    });
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => "session-1",
    });
    const presented = multitask.enqueueExternalJob({
      sessionId: "session-1",
      jobId: "job-1",
      jobDir: "/jobs/job-1",
      promptText: "Build the widget",
    });
    assert.ok(presented.ok);
    if (!presented.ok) return;

    const result = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "All done",
      todo_id: presented.todoId,
    })) as DeliverResultToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.channel, "reply");

    assert.equal(resolutions.length, 1);
    const resolution = resolutions[0];
    assert.ok(resolution);
    assert.equal(resolution.kind, "replied");
    assert.equal(resolution.jobId, "job-1");
    assert.equal(resolution.jobDir, "/jobs/job-1");
    assert.equal(
      resolution.kind === "replied" ? resolution.replyText : "",
      "All done",
    );
  });

  it("a no-channel delivery does not leave the obligation open (regression)", async () => {
    const { host, multitask, tools } = await setup();
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-1",
      title: "Task",
    });
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "t-1",
        title: "Task",
        prompt: "Go.",
        todoId: "t-1",
      }),
    );
    multitask.noteTurnStarted(workerId);
    host.fireSettled({ workerId, status: "completed", report: "done" });
    multitask.drainWake("session-1");

    const delivered = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "Done.",
      todo_id: "t-1",
    })) as DeliverResultToolResult;
    assert.ok(delivered.ok);

    // Nothing is owed any more: a redrive pass finds no open item.
    const report = multitask.redriveUndelivered("session-1");
    assert.deepEqual(report.redriven, []);
    assert.deepEqual(report.lost, []);
    assert.equal(multitask.todos.get("t-1")?.delivered, true);
  });
});

describe("dispatcher tools — the registered surface", () => {
  it("carries exactly the three kept DISPATCHER_TOOL_NAMES", async () => {
    const { tools } = await setup();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    assert.equal(tools.length, 3);
  });

  it("no removed dispatcher verb is registered any more (structural)", async () => {
    const { tools } = await setup();
    for (const removed of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "await_agent",
      "send_peer",
      "reply_to_dispatcher",
    ]) {
      assert.ok(
        !tools.some((tool) => tool.name === removed),
        `removed tool is still registered: ${removed}`,
      );
    }
  });
});

describe("ticket 179 — the host's fork verb is withheld per surface", () => {
  it("withholds only subagent_fork; stock subagent and control verbs stay visible", () => {
    assert.deepEqual([...DISPATCHER_WITHHELD_HOST_TOOLS], ["subagent_fork"]);
    for (const visible of [
      "subagent",
      "list_agents",
      "send_message",
      "interrupt_agent",
      "list_subagent_models",
    ]) {
      assert.ok(
        !DISPATCHER_WITHHELD_HOST_TOOLS.includes(visible),
        `dispatcher surface would lose a stock verb: ${visible}`,
      );
    }
    // The WORKER barrier keeps the whole spawn set; that is a separate list.
    assert.deepEqual([...HOST_SPAWN_TOOL_CANDIDATES], [
      "subagent",
      "subagent_fork",
      "list_subagent_models",
    ]);
  });

  it("intersects the candidates with the names actually live on the surface", () => {
    // A preset-mounted surface (`standard` / `cordis` / `ptc`).
    assert.deepEqual(
      withheldHostSpawnTools(
        new Set(["subagent", "subagent_fork", "list_subagent_models", "read"]),
      ),
      ["subagent_fork"],
    );
    // A surface without the fork row: nothing to subtract.
    assert.deepEqual(
      withheldHostSpawnTools(new Set(["subagent", "list_subagent_models"])),
      [],
    );
    // `minimal` mounts neither: the answer is empty, never a guessed deny.
    assert.deepEqual(withheldHostSpawnTools(new Set(["read", "bash"])), []);
    assert.deepEqual(withheldHostSpawnTools(new Set()), []);
  });

  it("restricts the surface with exactly the live candidates and returns the disposer", () => {
    const filters: Array<{ allow?: readonly string[]; deny?: readonly string[] }> =
      [];
    const lifted: string[] = [];
    const surface = {
      schemas: () => [
        { name: "subagent" },
        { name: "subagent_fork" },
        { name: "list_subagent_models" },
        { name: "read" },
      ],
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
        filters.push(filter);
        return () => {
          lifted.push("restriction");
        };
      },
    };
    const dispose = withholdHostSpawnTools(surface);
    assert.ok(dispose);
    assert.deepEqual(filters, [{ deny: ["subagent_fork"] }]);
    dispose();
    assert.deepEqual(lifted, ["restriction"]);
  });

  it("never names a tool the host does not know (restrict throws on unknown names)", () => {
    let restricted = false;
    const dispose = withholdHostSpawnTools({
      // Only the plain spawn verb is mounted, like a preset with the fork row off.
      schemas: () => [{ name: "subagent" }],
      restrict(filter) {
        restricted = filter.deny !== undefined;
        return () => {};
      },
    });
    assert.equal(dispose, null);
    assert.equal(restricted, false);
  });

  it("is a no-op on a surface without restrict (stub hosts), an empty intersection, or an unreadable surface", () => {
    // No restrict: the fallback registration shape, nothing to subtract from.
    assert.equal(withholdHostSpawnTools({ schemas: () => [] }), null);
    // Nothing live: the host rejects an empty filter outright.
    const calls: unknown[] = [];
    assert.equal(
      withholdHostSpawnTools({
        schemas: () => [{ name: "read" }],
        restrict(filter) {
          calls.push(filter);
          return () => {};
        },
      }),
      null,
    );
    // Unreadable surface: never guess a deny list.
    assert.equal(
      withholdHostSpawnTools({
        schemas: () => {
          throw new Error("no scope");
        },
        restrict(filter) {
          calls.push(filter);
          return () => {};
        },
      }),
      null,
    );
    assert.deepEqual(calls, []);
  });

  it("passes the scope through to schemas (a preset's tools live on the agent plane)", () => {
    const scopes: unknown[] = [];
    const agent = { session: { id: "s-1" } };
    withholdHostSpawnTools(
      {
        schemas(scope) {
          scopes.push(scope);
          return [{ name: "subagent_fork" }];
        },
        restrict() {
          return () => {};
        },
      },
      agent,
    );
    assert.deepEqual(scopes, [agent]);
  });
});
