import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import {
  DISPATCHER_TOOL_NAMES,
} from "../src/core/policy/prompts.js";
import {
  registerDispatcherTools,
  resolveExecSessionId,
  toRegisterableTool,
  type RegisterableTool,
} from "../src/adapter/dispatcher-tools.js";
import type { AdapterContext } from "../src/adapter/cordis-dsh-host.js";

function createToolsCaptureCtx(): AdapterContext & {
  registered: RegisterableTool[];
  disposers: Array<() => void>;
} {
  const registered: RegisterableTool[] = [];
  const disposers: Array<() => void> = [];
  return {
    registered,
    disposers,
    tools: {
      schemas: () => registered.map((tool) => ({ name: tool.name })),
      register(definition: unknown) {
        const tool = definition as RegisterableTool;
        registered.push(tool);
        const dispose = () => {
          const at = registered.indexOf(tool);
          if (at >= 0) registered.splice(at, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    subagents: {
      async startContinuable() {
        return { childId: "child-stub" };
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
          table: () => ({
            get: () => undefined,
            entries: () => new Map().entries(),
            async put() {},
            async delete() {
              return false;
            },
          }),
          async close() {},
          name: "stub",
        };
      },
    },
  };
}

describe("adapter dispatcher tool registration", () => {
  it("registers the six tools when ctx.tools.register exists", () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const disposers = registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
    });
    assert.equal(disposers.length, 6);
    assert.deepEqual(
      ctx.registered.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    // Each tool has a description and parameters for the model.
    for (const tool of ctx.registered) {
      assert.ok(tool.description.length > 20);
      assert.ok(tool.parameters !== undefined);
      assert.ok(typeof tool.execute === "function");
      assert.ok(typeof tool.output.render === "function");
    }
    for (const dispose of disposers) dispose();
    assert.equal(ctx.registered.length, 0);
  });

  it("is a no-op when tools or register are unavailable", () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const bare = {} as AdapterContext;
    assert.deepEqual(
      registerDispatcherTools({
        ctx: bare,
        multitask,
        getSessionId: () => null,
      }),
      [],
    );
  });

  it("execute on a registerable tool hits the Multitask core", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
    });
    const spawn = ctx.registered.find((tool) => tool.name === "spawn_worker");
    assert.ok(spawn);
    const value = (await spawn.execute({
      stream_key: "s-1",
      title: "Title",
      prompt: "Prompt.",
    })) as { ok: boolean; ack: string };
    assert.equal(value.ok, true);
    assert.ok(value.ack.includes("background"));
    assert.equal(host.spawnCalls.length, 1);
  });

  it("render prefers ack / summary / note over raw JSON", () => {
    const rendered = toRegisterableTool({
      name: "x",
      description: "d",
      parameters: { type: "object" },
      async execute() {
        return { ok: true, ack: "Started in the background." };
      },
    }).output.render({}, { ok: true, ack: "Started in the background." });
    assert.deepEqual(rendered, [
      { type: "text", text: "Started in the background." },
    ]);
  });

  it("passes recentActivity through to check rows (ticket 29)", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "session-1",
      recentActivity: (workerId) =>
        workerId.startsWith("fake-worker") ? "bash: npm test" : null,
    });
    const result = (await multitask.spawnWorker({
      parentSessionId: "session-1",
      streamKey: "t-1",
      title: "Summarize RFCs",
      prompt: "Go.",
    })) as { ok: true; workerId: string };
    assert.ok(result.ok);
    const check = ctx.registered.find((tool) => tool.name === "check_workers");
    assert.ok(check);
    const value = (await check.execute({})) as {
      ok: boolean;
      rows: Array<{ worker_id: string; recent_activity: string | null }>;
    };
    assert.equal(value.ok, true);
    assert.equal(value.rows.length, 1);
    assert.equal(value.rows[0]?.worker_id, result.workerId);
    assert.equal(value.rows[0]?.recent_activity, "bash: npm test");
  });
});

describe("per-session routing (ADR-0019)", () => {
  it("resolveExecSessionId reads common exec shapes", () => {
    assert.equal(
      resolveExecSessionId({ agent: { session: { id: "a1" } } }),
      "a1",
    );
    assert.equal(resolveExecSessionId({ session: { id: "a2" } }), "a2");
    assert.equal(resolveExecSessionId({ sessionId: "a3" }), "a3");
    assert.equal(resolveExecSessionId(undefined), null);
    assert.equal(resolveExecSessionId("string"), null);
    assert.equal(resolveExecSessionId({ agent: { session: {} } }), null);
  });

  it("handlers route to the session that registered them, whatever the exec says", async () => {
    const ctx = createToolsCaptureCtx();
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    registerDispatcherTools({
      ctx,
      multitask,
      getSessionId: () => "disp-1",
    });
    const spawn = ctx.registered.find((tool) => tool.name === "spawn_worker");
    assert.ok(spawn);

    // No execute-time gate (ADR-0019): the closed-over session id is the
    // authority; visibility is the fence, not a refusal copy.
    const routed = (await spawn.execute(
      { stream_key: "s", title: "T", prompt: "P" },
      { agent: { session: { id: "someone-else" } } },
    )) as { ok: boolean };
    assert.equal(routed.ok, true);
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(host.spawnCalls[0]?.opts.parentSessionId, "disp-1");

    // Unresolvable exec: same routing, same session.
    const again = (await spawn.execute(
      { stream_key: "s2", title: "T", prompt: "P" },
      undefined,
    )) as { ok: boolean };
    assert.equal(again.ok, true);
    assert.equal(host.spawnCalls.length, 2);
    assert.equal(host.spawnCalls[1]?.opts.parentSessionId, "disp-1");
  });

  it("two registrations route independently per session", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const ctxA = createToolsCaptureCtx();
    const ctxB = createToolsCaptureCtx();
    registerDispatcherTools({
      ctx: ctxA,
      multitask,
      getSessionId: () => "disp-a",
    });
    registerDispatcherTools({
      ctx: ctxB,
      multitask,
      getSessionId: () => "disp-b",
    });
    const spawnA = ctxA.registered.find((tool) => tool.name === "spawn_worker");
    const spawnB = ctxB.registered.find((tool) => tool.name === "spawn_worker");
    assert.ok(spawnA);
    assert.ok(spawnB);

    await spawnA.execute(
      { stream_key: "shared", title: "A", prompt: "P" },
      undefined,
    );
    await spawnB.execute(
      { stream_key: "shared", title: "B", prompt: "P" },
      undefined,
    );
    assert.deepEqual(
      host.spawnCalls.map((call) => call.opts.parentSessionId),
      ["disp-a", "disp-b"],
    );

    // Same stream key within ONE session still refuses.
    const refused = (await spawnA.execute(
      { stream_key: "shared", title: "A2", prompt: "P" },
      undefined,
    )) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "duplicate-stream-key");
  });
});
