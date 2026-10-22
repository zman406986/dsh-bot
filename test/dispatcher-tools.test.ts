import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import {
  AWAIT_AGENT_TOOL,
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_DISPATCHER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
} from "../src/core/policy/prompts.js";
import type {
  CheckWorkersToolResult,
  DeliverResultToolResult,
  SpawnWorkerToolResult,
  SteerWorkerToolResult,
  StopWorkerToolResult,
} from "../src/core/tool-results.js";
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

async function setup(options?: {
  deliverToUser?: (text: string, paths?: readonly string[]) => Promise<boolean>;
  recentActivity?: (workerId: string) => string | null;
}): Promise<{
  host: FakeDshHost;
  multitask: Multitask;
  tools: DispatcherToolDef[];
  getSessionId: () => string | null;
}> {
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  let sessionId: string | null = "session-1";
  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => sessionId,
    ...(options?.deliverToUser !== undefined
      ? { deliverToUser: options.deliverToUser }
      : {}),
    ...(options?.recentActivity !== undefined
      ? { recentActivity: options.recentActivity }
      : {}),
  });
  return {
    host,
    multitask,
    tools,
    getSessionId: () => sessionId,
  };
}

describe("dispatcher tools — spawn_worker", () => {
  it("maps 1:1 onto Multitask.spawnWorker and returns a do-not-wait ack", async () => {
    const { host, multitask, tools } = await setup();
    const spawn = byName(tools, SPAWN_WORKER_TOOL);
    const result = (await spawn.execute({
      stream_key: "todo-1",
      title: "Summarize RFCs",
      prompt: "Summarize the three auth RFCs.",
      todo_id: "t-1",
    })) as SpawnWorkerToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.stream_key, "todo-1");
    assert.equal(result.title, "Summarize RFCs");
    assert.ok(result.ack.includes("background"));
    assert.ok(result.ack.includes("do not need to wait"));
    assert.ok(result.ack.includes("poll"));

    assert.equal(host.spawnCalls.length, 1);
    assert.equal(host.spawnCalls[0]?.prompt, "Summarize the three auth RFCs.");
    assert.equal(multitask.getWorker(result.worker_id)?.todoId, "t-1");
  });

  it("duplicate stream key is refused without a host call", async () => {
    const { host, tools } = await setup();
    const spawn = byName(tools, SPAWN_WORKER_TOOL);
    const args = {
      stream_key: "s-1",
      title: "First",
      prompt: "Do it.",
    };
    await spawn.execute(args);
    const second = (await spawn.execute(args)) as SpawnWorkerToolResult;
    assert.ok(!second.ok);
    if (second.ok) return;
    assert.equal(second.reason, "duplicate-stream-key");
    assert.ok(second.detail.includes("s-1"));
    assert.equal(host.spawnCalls.length, 1);
  });

  it("requires a bound dispatcher session", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => null,
    });
    await assert.rejects(
      () =>
        byName(tools, SPAWN_WORKER_TOOL).execute({
          stream_key: "s",
          title: "t",
          prompt: "p",
        }),
      /no dispatcher session/,
    );
  });
});

describe("dispatcher tools — check_workers", () => {
  it("returns elapsed, tool count, transcript, and nullable activity", async () => {
    const { host, multitask, tools } = await setup({
      recentActivity: (id) => (id === "fake-worker-1" ? "reading notes" : null),
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
    multitask.noteToolCall(workerId);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "Done.",
      transcriptRef: "child-9",
    });

    const check = byName(tools, CHECK_WORKERS_TOOL);
    const result = (await check.execute({})) as CheckWorkersToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.equal(row.worker_id, workerId);
    assert.equal(row.status, "completed");
    assert.equal(row.tool_call_count, 1);
    assert.equal(row.transcript_ref, "child-9");
    assert.equal(row.recent_activity, "reading notes");
    assert.ok(typeof row.elapsed_ms === "number" && row.elapsed_ms >= 0);
    assert.ok(result.summary.includes("transcript: child-9"));
  });

  it("unknown worker_id is refused", async () => {
    const { tools } = await setup();
    const result = (await byName(tools, CHECK_WORKERS_TOOL).execute({
      worker_id: "nope",
    })) as CheckWorkersToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "unknown-worker");
  });
});

describe("dispatcher tools — steer_worker / stop_worker", () => {
  it("steer parks a correction and returns a no-restart note", async () => {
    const { host, multitask, tools } = await setup();
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "s-1",
        title: "Docs rewrite",
        prompt: "Rewrite docs.",
      }),
    );
    multitask.noteTurnStarted(workerId);

    const result = (await byName(tools, STEER_WORKER_TOOL).execute({
      worker_id: workerId,
      message: "Focus on the third RFC only.",
    })) as SteerWorkerToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.note.includes("Docs rewrite"));
    assert.ok(result.note.includes("no restart"));
    assert.equal(host.interruptCalls.length, 1);
  });

  it("steer is refused when the worker is not running", async () => {
    const { multitask, tools } = await setup();
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "s-1",
        title: "Idle",
        prompt: "Go.",
      }),
    );
    // Still spawned — never started.
    const result = (await byName(tools, STEER_WORKER_TOOL).execute({
      worker_id: workerId,
      message: "too late",
    })) as SteerWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "not-running");
  });

  it("stop aborts and returns a silent-to-user note", async () => {
    const { host, multitask, tools } = await setup();
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "s-1",
        title: "Cancel me",
        prompt: "Go.",
      }),
    );
    multitask.noteTurnStarted(workerId);

    const result = (await byName(tools, STOP_WORKER_TOOL).execute({
      worker_id: workerId,
    })) as StopWorkerToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.note.includes("Stopped"));
    assert.equal(host.interruptCalls.length, 1);
  });

  it("stop after settle is refused", async () => {
    const { host, multitask, tools } = await setup();
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "s-1",
        title: "Done already",
        prompt: "Go.",
      }),
    );
    multitask.noteTurnStarted(workerId);
    host.fireSettled({
      workerId,
      status: "completed",
      report: "Done.",
    });
    const result = (await byName(tools, STOP_WORKER_TOOL).execute({
      worker_id: workerId,
    })) as StopWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "already-settled");
  });
});

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
    assert.equal(result.delivered, true);
    assert.equal(result.todo_completed, "t-1");
    assert.deepEqual(delivered, ["Here's the third-RFC summary…"]);
    const todo = multitask.listTodos("session-1").find((t) => t.id === "t-1");
    assert.equal(todo?.status, "completed");
    assert.equal(todo?.delivered, true);
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
    assert.equal(result.delivered, false);
    assert.equal(result.todo_completed, null);
    const todo = multitask.listTodos("session-1").find((t) => t.id === "t-1");
    assert.equal(todo?.delivered, false);
  });

  it("without an injectable send, still marks delivered after the tool call", async () => {
    const { multitask, tools } = await setup();
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-2",
      title: "Inline",
    });
    const result = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "All set.",
      todo_id: "t-2",
    })) as DeliverResultToolResult;
    assert.ok(result.ok);
    assert.equal(result.delivered, true);
    assert.equal(result.todo_completed, "t-2");
  });
});

describe("dispatcher tools — FakeDshHost stays green", () => {
  it("all dispatcher tools run against FakeDshHost without host extensions", async () => {
    const { host, multitask, tools } = await setup({
      deliverToUser: async () => true,
    });
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        SPAWN_WORKER_TOOL,
        CHECK_WORKERS_TOOL,
        STEER_WORKER_TOOL,
        STOP_WORKER_TOOL,
        DELIVER_RESULT_TOOL,
        MESSAGE_AGENT_TOOL,
        AWAIT_AGENT_TOOL,
        SPAWN_DISPATCHER_TOOL,
      ],
    );
    // spawn_dispatcher is in the shape but not exercised here: its seam is
    // injected (chunk 3 wires the live one), so its own suite owns it
    // (test/spawn-dispatcher-tool.test.ts).

    const spawn = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "demo",
      title: "Long fake worker",
      prompt: "Pretend to work for minutes.",
    })) as SpawnWorkerToolResult;
    assert.ok(spawn.ok);
    if (!spawn.ok) return;
    // First real activity (as the adapter would note on agent/status running).
    multitask.noteTurnStarted(spawn.worker_id);

    const check = (await byName(tools, CHECK_WORKERS_TOOL).execute(
      {},
    )) as CheckWorkersToolResult;
    assert.ok(check.ok);

    const steer = (await byName(tools, STEER_WORKER_TOOL).execute({
      worker_id: spawn.worker_id,
      message: "Focus on RFC 3.",
    })) as SteerWorkerToolResult;
    assert.ok(steer.ok);

    const deliver = (await byName(tools, DELIVER_RESULT_TOOL).execute({
      text: "RFC 3 summary ready.",
    })) as DeliverResultToolResult;
    assert.ok(deliver.ok);

    const stop = (await byName(tools, STOP_WORKER_TOOL).execute({
      worker_id: spawn.worker_id,
    })) as StopWorkerToolResult;
    assert.ok(stop.ok);

    // Fake host recorded only the existing seams.
    assert.equal(host.spawnCalls.length, 1);
    assert.ok(host.interruptCalls.length >= 2);
  });
});

describe("dispatcher tools — the registered surface (tickets 116/117)", () => {
  it("carries exactly DISPATCHER_TOOL_NAMES: eight tools, send_peer retired", async () => {
    const { tools } = await setup();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    assert.ok(!tools.some((tool) => tool.name === SEND_PEER_TOOL));
    assert.ok(tools.some((tool) => tool.name === AWAIT_AGENT_TOOL));
  });
});
