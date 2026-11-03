import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import {AWAIT_AGENT_TOOL, CHECK_WORKERS_TOOL, DELIVER_RESULT_TOOL, DISPATCHER_TOOL_NAMES, SEND_PEER_TOOL, SPAWN_WORKER_TOOL, STOP_WORKER_TOOL} from "../src/core/policy/prompts.js";
import type {CheckWorkersToolResult, DeliverResultToolResult, SpawnWorkerToolResult, StopWorkerToolResult} from "../src/core/tool-results.js";
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
    multitask.createTodo({
      sessionId: "session-1",
      id: "t-1",
      title: "Summarize RFCs",
    });
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
    const { host, multitask, tools } = await setup();
    const spawn = byName(tools, SPAWN_WORKER_TOOL);
    const args = {
      stream_key: "s-1",
      title: "First",
      prompt: "Do it.",
    };
    const first = (await spawn.execute(args)) as SpawnWorkerToolResult;
    assert.ok(first.ok);
    if (!first.ok) return;
    const second = (await spawn.execute(args)) as SpawnWorkerToolResult;
    assert.ok(!second.ok);
    if (second.ok) return;
    assert.equal(second.reason, "duplicate-stream-key");
    assert.ok(second.detail.includes("s-1"));
    assert.equal(host.spawnCalls.length, 1);
    // The refusal prunes the entry the SECOND call created; the first
    // call's entry is untouched and stays linked to the live worker.
    const todos = multitask.listTodos("session-1");
    assert.equal(todos.length, 1);
    assert.equal(todos[0]?.workerId, first.worker_id);
  });

  // Ticket 151: the dispatcher ledger was never written in live use, so the
  // per-turn reminder stayed `(empty)`. Ruling 2026-10-28: the spawn itself
  // creates the linked entry from the title it is already given.
  it("without todo_id, creates exactly one linked ledger entry from the title", async () => {
    const { host, multitask, tools } = await setup();
    const result = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "rfc-work",
      title: "Summarize RFCs",
      prompt: "Summarize the three auth RFCs.",
    })) as SpawnWorkerToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(host.spawnCalls.length, 1);
    const todos = multitask.listTodos("session-1");
    assert.equal(todos.length, 1);
    const todo = todos[0];
    assert.ok(todo);
    assert.equal(todo.title, "Summarize RFCs");
    assert.equal(todo.streamKey, "rfc-work");
    assert.equal(todo.workerId, result.worker_id);
    assert.equal(todo.status, "pending");
  });

  it("an unknown todo_id is refused before spawn and the ledger stays untouched", async () => {
    const { host, multitask, tools } = await setup();
    const result = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "rfc-work",
      title: "Summarize RFCs",
      prompt: "Summarize the three auth RFCs.",
      todo_id: "typo-1",
    })) as SpawnWorkerToolResult;

    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "unknown-todo-id");
    assert.ok(result.detail.includes("typo-1"));
    assert.equal(host.spawnCalls.length, 0);
    assert.deepEqual(multitask.listTodos("session-1"), []);
  });

  // Ticket 151 review blocker: restore re-creates entries with their explicit
  // id (`multitask.ts` rebuild), which advances the ledger's generated
  // sequence. Without that, the next auto-created spawn would throw
  // "todo already exists: todo-1" before the host call and every spawn after
  // a restart would fail.
  it("a todo_id from another session is refused", async () => {
    const { host, multitask, tools } = await setup();
    multitask.createTodo({ sessionId: "session-2", id: "t-other", title: "Else" });
    const result = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "rfc-work",
      title: "Summarize RFCs",
      prompt: "Summarize the three auth RFCs.",
      todo_id: "t-other",
    })) as SpawnWorkerToolResult;

    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "unknown-todo-id");
    assert.equal(host.spawnCalls.length, 0);
    assert.deepEqual(multitask.listTodos("session-1"), []);
    assert.equal(multitask.listTodos("session-2")[0]?.workerId, null);
  });

  it("a todo_id already linked to a worker is refused", async () => {
    const { host, multitask, tools } = await setup();
    const spawn = byName(tools, SPAWN_WORKER_TOOL);
    const first = (await spawn.execute({
      stream_key: "first-stream",
      title: "First",
      prompt: "Do it.",
    })) as SpawnWorkerToolResult;
    assert.ok(first.ok);
    if (!first.ok) return;
    const linkedId = multitask
      .listTodos("session-1")
      .find((todo) => todo.workerId === first.worker_id)?.id;
    assert.ok(linkedId);

    const second = (await spawn.execute({
      stream_key: "second-stream",
      title: "Second",
      prompt: "Do it too.",
      todo_id: linkedId,
    })) as SpawnWorkerToolResult;
    assert.ok(!second.ok);
    if (second.ok) return;
    assert.equal(second.reason, "todo-already-linked");
    assert.equal(host.spawnCalls.length, 1);
    // The first entry still points at its own worker and its own stream.
    const todo = multitask.listTodos("session-1").find((t) => t.id === linkedId);
    assert.equal(todo?.workerId, first.worker_id);
    assert.equal(todo?.streamKey, "first-stream");
  });

  // Ticket 151 review fix: a throw AFTER the worker was registered and the
  // entry linked (the durability marker write) must not prune the entry —
  // the worker is live and the marker/roster point at it.
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
