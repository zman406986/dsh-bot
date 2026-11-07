import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDshHost } from "../src/core/fake-host.js";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import {
  createMultitask,
  type InboxJobResolution,
  type Multitask,
} from "../src/core/multitask.js";
import { AWAIT_INVALID_TIMEOUT_DETAIL } from "../src/core/settle-records.js";
import {
  createDispatcherTools,
  HOST_SPAWN_TOOL_CANDIDATES,
  withheldHostSpawnTools,
  withholdHostSpawnTools,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import {AWAIT_AGENT_TOOL, CHECK_WORKERS_TOOL, DELIVER_RESULT_TOOL, DISPATCHER_TOOL_NAMES, SEND_PEER_TOOL, SPAWN_WORKER_TOOL, STEER_WORKER_TOOL, STOP_WORKER_TOOL} from "../src/core/policy/prompts.js";
import { toRegisterableTool } from "../src/adapter/dispatcher-tools.js";
import type {CheckWorkersToolResult, DeliverResultToolResult, SpawnWorkerToolResult, SteerWorkerToolResult, StopWorkerToolResult} from "../src/core/tool-results.js";
import type {
  ModelOptionPurpose,
  ModelOptionResolution,
  SpawnRequest,
  SpawnResult,
} from "../src/core/types.js";

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
  resolveModel?: (
    raw: string,
    purpose: ModelOptionPurpose,
  ) => Promise<ModelOptionResolution>;
}): Promise<{
  host: FakeDshHost;
  multitask: Multitask;
  tools: DispatcherToolDef[];
  /** Ticket 285: every SpawnRequest the tool handed to the core, in order. */
  spawnRequests: SpawnRequest[];
  getSessionId: () => string | null;
}> {
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  // Ticket 285: a recording wrapper over the REAL core. Both hops of the
  // worker-model path are asserted in this file: the tool-to-core request
  // (recorded here) and, since Task 9, the core-to-host
  // `SpawnOptions.model` the fake host records in `spawnCalls`.
  const spawnRequests: SpawnRequest[] = [];
  const recordingCore: Multitask = {
    ...multitask,
    async spawnWorker(request: SpawnRequest): Promise<SpawnResult> {
      spawnRequests.push(request);
      return multitask.spawnWorker(request);
    },
  };
  let sessionId: string | null = "session-1";
  const tools = createDispatcherTools({
    multitask: recordingCore,
    getSessionId: () => sessionId,
    ...(options?.deliverToUser !== undefined
      ? { deliverToUser: options.deliverToUser }
      : {}),
    ...(options?.recentActivity !== undefined
      ? { recentActivity: options.recentActivity }
      : {}),
    ...(options?.resolveModel !== undefined
      ? { resolveModel: options.resolveModel }
      : {}),
  });
  return {
    host,
    multitask,
    tools,
    spawnRequests,
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

  // Ticket 285: the opt-in worker model. spawn_worker takes `model` and
  // nothing else — worker_model belongs to spawn_dispatcher alone.
  it("declares an optional model and NO worker_model", async () => {
    const { tools } = await setup();
    const parameters = byName(tools, SPAWN_WORKER_TOOL).parameters as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { type: string; required?: boolean }>;
    };
    assert.equal(parameters.type, "object");
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      "model",
      "prompt",
      "stream_key",
      "title",
      "todo_id",
    ]);
    assert.equal(parameters.properties.model?.type, "string");
    assert.notEqual(parameters.properties.model?.required, true);
    // A worker cannot set the leader's worker default.
    assert.equal("worker_model" in parameters.properties, false);
  });

  it("passes the resolved model route through on the worker spawn request", async () => {
    const seen: string[] = [];
    const { host, spawnRequests, tools } = await setup({
      resolveModel: async (raw) => {
        seen.push(raw);
        return {
          kind: "resolved",
          route: { provider: "pD", model: "mD" },
        };
      },
    });
    const result = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "model-stream",
      title: "Model work",
      prompt: "Do it.",
      model: "  pD/mD  ",
    })) as SpawnWorkerToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    // Trimmed before the resolver sees it; the resolved route is what the
    // core and, through the core's forwarding, the host receive.
    assert.deepEqual(seen, ["pD/mD"]);
    assert.equal(host.spawnCalls.length, 1);
    assert.deepEqual(spawnRequests[0]?.model, {
      provider: "pD",
      model: "mD",
    });
    // Task 9: Multitask.spawnWorker forwards the route to the host seam,
    // which is what turns it into the worker's activation agentOptions.
    assert.deepEqual(host.spawnCalls[0]?.opts.model, {
      provider: "pD",
      model: "mD",
    });
    assert.equal(result.model_fallbacks, undefined);
  });

  it("a model fallback still spawns, adds model_fallbacks, and says so in the ack", async () => {
    const { host, spawnRequests, tools } = await setup({
      resolveModel: async () => ({
        kind: "fallback",
        requested: "nope",
        reason: "unknown-model",
      }),
    });
    const result = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "model-stream",
      title: "Model work",
      prompt: "Do it.",
      model: "nope",
    })) as SpawnWorkerToolResult;

    assert.ok(result.ok, "a fallback never refuses the spawn");
    if (!result.ok) return;
    assert.equal(host.spawnCalls.length, 1);
    assert.equal("model" in (spawnRequests[0] ?? {}), false);
    assert.deepEqual(result.model_fallbacks, [
      {
        option: "model",
        requested: "nope",
        reason: "unknown-model",
      },
    ]);
    assert.ok(
      result.ack.includes(
        'Model "nope" was not used (not in the model catalog); this worker uses the inherited route.',
      ),
      result.ack,
    );
  });

  it("with no model option: no resolver call, no model key, no fallback fields", async () => {
    let resolverCalls = 0;
    const { host, spawnRequests, tools } = await setup({
      resolveModel: async () => {
        resolverCalls += 1;
        return { kind: "absent" };
      },
    });
    const result = (await byName(tools, SPAWN_WORKER_TOOL).execute({
      stream_key: "plain-stream",
      title: "Plain work",
      prompt: "Do it.",
    })) as SpawnWorkerToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(resolverCalls, 0);
    assert.equal("model" in (host.spawnCalls[0]?.opts ?? {}), false);
    assert.equal("model" in (spawnRequests[0] ?? {}), false);
    assert.equal(result.model_fallbacks, undefined);
  });

  // Ticket 285: a missing resolver is a wiring bug and must throw BEFORE the
  // ledger entry is created, so a bad wiring cannot leave an orphan todo.
  it("a non-empty model with no resolver throws before creating a todo", async () => {
    const { host, multitask, tools } = await setup();
    await assert.rejects(
      () =>
        byName(tools, SPAWN_WORKER_TOOL).execute({
          stream_key: "model-stream",
          title: "Model work",
          prompt: "Do it.",
          model: "pD/mD",
        }),
      /no model resolver is wired/,
    );
    assert.equal(host.spawnCalls.length, 0);
    assert.deepEqual(multitask.listTodos("session-1"), []);
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

describe("dispatcher tools — foreign-worker fence", () => {
  async function foreignRunningWorker(
    multitask: Multitask,
  ): Promise<string> {
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-2",
        streamKey: "foreign-stream",
        title: "Someone else's worker",
        prompt: "Go.",
      }),
    );
    multitask.noteTurnStarted(workerId);
    return workerId;
  }

  it("steer refuses another dispatcher's live worker with the silent shape", async () => {
    const { multitask, tools } = await setup();
    const workerId = await foreignRunningWorker(multitask);

    const result = (await byName(tools, STEER_WORKER_TOOL).execute({
      worker_id: workerId,
      message: "Do something else.",
    })) as { ok: boolean; reason?: string; detail?: string };
    assert.deepEqual(result, {
      ok: false,
      reason: "unknown-worker",
      detail: `unknown worker: ${workerId}`,
    });
  });

  it("steer refuses another dispatcher's dormant (durable-row) worker too", async () => {
    // A dormant worker has NO roster record; the durable row is the only
    // ownership evidence. The id must still read as unknown to this session.
    const host = new FakeDshHost();
    const multitask = createMultitask(host, {
      findDurableWorker: (workerId) =>
        workerId === "foreign-dormant"
          ? { parentSessionId: "session-2" }
          : undefined,
    });
    const tools = createDispatcherTools({
      multitask,
      getSessionId: () => "session-1",
    });

    const result = (await byName(tools, STEER_WORKER_TOOL).execute({
      worker_id: "foreign-dormant",
      message: "One more thing.",
    })) as { ok: boolean; reason?: string; detail?: string };
    assert.deepEqual(result, {
      ok: false,
      reason: "unknown-worker",
      detail: "unknown worker: foreign-dormant",
    });
  });

  it("stop refuses another dispatcher's worker without interrupting it", async () => {
    const { host, multitask, tools } = await setup();
    const workerId = await foreignRunningWorker(multitask);

    const result = (await byName(tools, STOP_WORKER_TOOL).execute({
      worker_id: workerId,
    })) as StopWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "already-settled");
    assert.equal(result.detail, `unknown worker: ${workerId}`);
    assert.equal(host.interruptCalls.length, 0, "a foreign worker was interrupted");
    assert.equal(multitask.getWorker(workerId)?.status, "running");
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
    // Readable-status display fields are additive; the model-facing note is
    // unchanged.
    assert.equal(result.worker_id, workerId);
    assert.equal(result.title, "Cancel me");
    assert.equal(result.mode, "stopped");
    assert.equal(host.interruptCalls.length, 1);
  });

  it("steer_worker keeps its model-facing note and adds worker_id/title", async () => {
    const { multitask, tools } = await setup();
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "s-1",
        title: "Rewrite auth docs",
        prompt: "Go.",
      }),
    );
    multitask.noteTurnStarted(workerId);

    const result = (await byName(tools, STEER_WORKER_TOOL).execute({
      worker_id: workerId,
      message: "focus on the failing test first",
    })) as SteerWorkerToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(
      result.note,
      'Correction parked for "Rewrite auth docs". It will fold in at the next step boundary and continue from where it is — no restart. If you send another correction before delivery, only the latest applies.',
      "model-facing copy stays byte-identical",
    );
    assert.equal(result.worker_id, workerId);
    assert.equal(result.title, "Rewrite auth docs");
    assert.equal(result.dormant, undefined);
  });

});

/**
 * A core rebuilt over a live marker (a crash-time hold), optionally with a
 * marker store that refuses the release drop. The hold id is not on the
 * roster — that is what makes it an unknown-state hold.
 */
async function rebuiltHold(options: { failRelease?: boolean } = {}): Promise<{
  multitask: Multitask;
  tools: DispatcherToolDef[];
  workerId: string;
}> {
  const durability = createInMemoryDurability();
  const coreA = createMultitask(new FakeDshHost(), { durability });
  const spawned = await coreA.spawnWorker({
    parentSessionId: "session-1",
    streamKey: "held-stream",
    title: "Held work",
    prompt: "Go.",
  });
  if (!spawned.ok) throw new Error(spawned.detail);
  coreA.noteTurnStarted(spawned.workerId);

  const store: InMemoryDurability =
    options.failRelease === true
      ? {
          ...durability,
          deleteWorkerMarker: () =>
            Promise.reject(new Error("marker store down")),
        }
      : durability;
  const multitask = createMultitask(new FakeDshHost(), { durability: store });
  const rebuild = await multitask.rebuildFromDurability("session-1");
  assert.equal(rebuild.unknownState.length, 1, "the live marker is a hold");
  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => "session-1",
  });
  return { multitask, tools, workerId: spawned.workerId };
}

describe("dispatcher tools — stop_worker and crash-time holds (ticket 59)", () => {
  it("releases a hold and says the worker was never reachable", async () => {
    const { multitask, tools, workerId } = await rebuiltHold();

    const result = (await byName(tools, STOP_WORKER_TOOL).execute({
      worker_id: workerId,
    })) as StopWorkerToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.mode, "released-hold");
    assert.match(result.note, /never reachable/);
    assert.equal(multitask.listUnknownStateHolds("session-1").length, 0);
  });

  it("reports a failed release instead of falling through to unknown-worker", async () => {
    const { multitask, tools, workerId } = await rebuiltHold({
      failRelease: true,
    });

    const result = (await byName(tools, STOP_WORKER_TOOL).execute({
      worker_id: workerId,
    })) as StopWorkerToolResult;
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "hold-release-failed");
    assert.match(result.detail, /Could not release the hold — the store did not confirm/);
    assert.equal(
      multitask.listUnknownStateHolds("session-1").length,
      1,
      "the hold and its stream key are still in place",
    );
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

    // Nothing is owed any more: a redrive pass finds no open item and the
    // worker stage is `ended`, not `waiting-for-delivery`.
    const report = multitask.redriveUndelivered("session-1");
    assert.deepEqual(report.redriven, []);
    assert.deepEqual(report.lost, []);
    assert.equal(multitask.todos.get("t-1")?.delivered, true);

    const check = (await byName(tools, CHECK_WORKERS_TOOL).execute(
      {},
    )) as CheckWorkersToolResult;
    assert.ok(check.ok);
    if (!check.ok) return;
    assert.equal(check.rows[0]?.stage, "ended");
  });

});

describe("dispatcher tools — await_agent timeout validation (ticket 194)", () => {
  it("refuses an explicit null timeout exactly like any other non-number", async () => {
    const { host, multitask, tools } = await setup();
    // A settled owned worker makes the regression fail fast: the buggy null
    // path would read this record with the default timeout and return
    // settled, while the fix refuses before any wait is armed.
    const workerId = unwrapSpawn(
      await multitask.spawnWorker({
        parentSessionId: "session-1",
        streamKey: "null-timeout",
        title: "Null timeout",
        prompt: "Go.",
      }),
    );
    host.fireSettled({ workerId, status: "completed", report: "Done." });

    const awaitAgent = byName(tools, AWAIT_AGENT_TOOL);
    const expected = {
      ok: false,
      reason: "invalid-timeout",
      detail: AWAIT_INVALID_TIMEOUT_DETAIL,
    };
    assert.deepEqual(
      await awaitAgent.execute({ target: workerId, timeout_ms: null }),
      expected,
    );
    assert.deepEqual(
      await awaitAgent.execute({ target: workerId, timeout_ms: "5000" }),
      expected,
    );
    assert.equal(multitask.settleRecords.waiterCount("session-1"), 0);
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

describe("ticket 179 — the host's raw spawn verbs are withheld per surface", () => {
  it("candidate list is the two spawn verbs plus their route-discovery companion", () => {
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
      ["subagent", "subagent_fork", "list_subagent_models"],
    );
    // Partial: only the fork verb was mounted.
    assert.deepEqual(withheldHostSpawnTools(new Set(["subagent_fork"])), [
      "subagent_fork",
    ]);
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
    assert.deepEqual(filters, [
      { deny: ["subagent", "subagent_fork", "list_subagent_models"] },
    ]);
    dispose();
    assert.deepEqual(lifted, ["restriction"]);
  });

  it("never names a tool the host does not know (restrict throws on unknown names)", () => {
    const seen: string[][] = [];
    withholdHostSpawnTools({
      // Only the spawn verb is mounted, like a preset with the fork row off.
      schemas: () => [{ name: "subagent" }],
      restrict(filter) {
        seen.push([...(filter.deny ?? [])]);
        return () => {};
      },
    });
    assert.deepEqual(seen, [["subagent"]]);
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
          return [{ name: "subagent" }];
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
