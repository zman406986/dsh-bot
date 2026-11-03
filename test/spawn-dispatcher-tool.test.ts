/**
 * Ticket 118 chunk 2 — the `spawn_dispatcher` TOOL only. Offline: FakeDshHost,
 * no live dsh, no LLM, no real timers.
 *
 * Chunk 1 (host seam, `test/spawn-dispatcher-host.test.ts`) owns the spawn
 * request shape and the depth derivation. Chunk 3 (activation path) owns
 * `activateSpawnedDispatcher`, scoped registration, policy injection and
 * lifecycle insertion. What is pinned here is exactly the tool:
 *
 *  - it is on the dispatcher surface and DENIED for workers;
 *  - it calls the injected host seam with the REGISTRATION CLOSURE's session
 *    id (there is no parent argument) and with the exec signal when present;
 *  - it returns `{ ok: true, dispatcher_id, title, note }`, and the note says
 *    peer / message_agent / do-not-wait;
 *  - it touches NO worker path: no stream key, no roster entry, no todo, no
 *    durability marker;
 *  - refusals are only what is real: `invalid-args` for an empty title or
 *    prompt, `host-refused` carrying the host's own text for everything the
 *    host throws (`ACTIVATION_LIMIT_REACHED`, the depth ceiling, an unbound
 *    parent). No recursion limit, no dispatcher cap, no generation counter.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  readExecSignal,
  type DispatcherToolDef,
} from "../src/core/tools.js";
import {
  DISPATCHER_TOOL_NAMES,
  SPAWN_DISPATCHER_TOOL,
  TOOL_DESCRIPTIONS,
} from "../src/core/policy/prompts.js";
import type { SpawnDispatcherToolResult } from "../src/core/tool-results.js";
import {
  buildWorkerToolFilter,
  WORKER_DENIED_TOOL_CANDIDATES,
} from "../src/worker/tool-barrier.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
} from "../src/core/types.js";

interface Rig {
  readonly host: FakeDshHost;
  readonly multitask: Multitask;
  readonly tools: DispatcherToolDef[];
  readonly spawnDispatcherCalls: DispatcherSpawnOptions[];
  readonly tool: DispatcherToolDef;
  setSessionId(sessionId: string | null): void;
}

/**
 * Build the dispatcher tool set over FakeDshHost with the seam wired to the
 * fake host's own `spawnDispatcher` (the live shape chunk 3 will use). An
 * optional `hostError` makes the seam throw, standing in for the host's own
 * refusals without inventing any refusal class of ours.
 */
function rig(options?: {
  hostError?: unknown;
  omitSeam?: boolean;
}): Rig {
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  let sessionId: string | null = "disp-1";
  const spawnDispatcherCalls: DispatcherSpawnOptions[] = [];

  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => sessionId,
    ...(options?.omitSeam === true
      ? {}
      : {
          spawnDispatcher: async (
            opts: DispatcherSpawnOptions,
          ): Promise<DispatcherSpawnResult> => {
            spawnDispatcherCalls.push(opts);
            if (options?.hostError !== undefined) throw options.hostError;
            return host.spawnDispatcher(opts);
          },
        }),
  });
  const tool = tools.find((entry) => entry.name === SPAWN_DISPATCHER_TOOL);
  assert.ok(tool, `missing tool: ${SPAWN_DISPATCHER_TOOL}`);
  return {
    host,
    multitask,
    tools,
    spawnDispatcherCalls,
    tool,
    setSessionId: (next) => {
      sessionId = next;
    },
  };
}

describe("ticket 118: spawn_dispatcher — registration and visibility", () => {
  it("is the eighth dispatcher tool, registered last", () => {
    assert.equal(SPAWN_DISPATCHER_TOOL, "spawn_dispatcher");
    assert.equal(DISPATCHER_TOOL_NAMES.length, 8);
    assert.equal(DISPATCHER_TOOL_NAMES[7], SPAWN_DISPATCHER_TOOL);
  });

  it("declares title and prompt required, both provider-valid, nothing else", () => {
    const r = rig();
    const parameters = r.tool.parameters as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { type: string; required?: boolean }>;
    };
    assert.equal(parameters.type, "object");
    assert.equal(parameters.additionalProperties, false);
    // No stream_key and no todo_id: a dispatcher is not a work stream.
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      "prompt",
      "title",
    ]);
    assert.equal(parameters.properties.title?.required, true);
    assert.equal(parameters.properties.prompt?.required, true);
    assert.equal(parameters.properties.title?.type, "string");
    assert.equal(parameters.properties.prompt?.type, "string");
    assert.ok(r.tool.description.length > 20);
    assert.equal(r.tool.description, TOOL_DESCRIPTIONS[SPAWN_DISPATCHER_TOOL]);
  });

  it("is DENIED for workers — a worker spawns no agent (ADR-0003 leaf rule)", () => {
    assert.ok(WORKER_DENIED_TOOL_CANDIDATES.includes(SPAWN_DISPATCHER_TOOL));
    const known = new Set([...DISPATCHER_TOOL_NAMES, "bash"]);
    const filter = buildWorkerToolFilter(known);
    assert.ok(filter.deny.includes(SPAWN_DISPATCHER_TOOL));
    assert.ok(!filter.deny.includes("bash"));
  });
});

describe("ticket 118: spawn_dispatcher — success shape", () => {
  it("the note names it a peer, points at message_agent, and says do not wait", async () => {
    const r = rig();
    const result = (await r.tool.execute({
      title: "Own the login bug",
      prompt: "Take the login bug end to end.",
    })) as SpawnDispatcherToolResult;
    assert.ok(result.ok);
    if (!result.ok) return;

    const note = result.note;
    // Peer, not worker.
    assert.ok(note.includes("peer dispatcher"), note);
    // The address is the id the caller just received.
    assert.ok(note.includes(result.dispatcher_id), note);
    assert.ok(note.includes("message_agent"), note);
    // Do-not-wait, and it must be TRUE: await_agent is workers-only.
    assert.ok(note.includes("Do not wait on it"), note);
    assert.ok(note.includes("not awaitable"), note);
    // A summoned dispatcher is a dispatcher: it answers its own user in its own
    // chat, and reports back to the summoner because it was asked (owner ruling
    // 2026-10-29, ADR-0032 open question 1). Not a mute relay.
    assert.ok(note.includes("answers that user directly"), note);
    assert.ok(!note.includes("cannot talk to the user"), note);
  });

  it("trims the title and prompt before handing them to the host", async () => {
    const r = rig();
    await r.tool.execute({
      title: "  Padded title  ",
      prompt: "   Do the work.   ",
    });
    assert.equal(r.spawnDispatcherCalls[0]?.title, "Padded title");
    assert.equal(r.spawnDispatcherCalls[0]?.prompt, "Do the work.");
  });

  it("forwards the exec abort signal so a stopped turn cancels the spawn", async () => {
    const r = rig();
    const controller = new AbortController();
    await r.tool.execute(
      { title: "Peer", prompt: "Handle it." },
      { signal: controller.signal },
    );
    assert.equal(r.spawnDispatcherCalls[0]?.signal, controller.signal);
    assert.equal(readExecSignal({ signal: controller.signal }), controller.signal);
  });

});

describe("ticket 118: spawn_dispatcher — no worker path", () => {
  it("creates no stream key, no roster entry, no todo, and no worker spawn", async () => {
    const r = rig();
    const before = r.multitask.listTodos("disp-1").length;

    const result = (await r.tool.execute({
      title: "Peer",
      prompt: "Handle it.",
    })) as SpawnDispatcherToolResult;
    assert.ok(result.ok);

    // Nothing entered the worker path…
    assert.equal(r.host.spawnCalls.length, 0);
    assert.equal(r.multitask.listWorkers("disp-1").length, 0);
    assert.equal(r.multitask.getWorker(result.dispatcher_id), undefined);
    // …the ledger is untouched (a dispatcher is not a work stream)…
    assert.equal(r.multitask.listTodos("disp-1").length, before);
    // …and the spawn was recorded only on the dispatcher lane.
    assert.equal(r.host.dispatcherSpawnCalls.length, 1);
  });

});

describe("ticket 118: spawn_dispatcher — refusals are only what is real", () => {
  it("surfaces ACTIVATION_LIMIT_REACHED from the host unchanged, with no invented class", async () => {
    const r = rig({
      hostError: new Error(
        "ACTIVATION_LIMIT_REACHED: active subagent limit reached",
      ),
    });
    const result = (await r.tool.execute({
      title: "Peer",
      prompt: "Handle it.",
    })) as SpawnDispatcherToolResult;

    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "host-refused");
    assert.ok(result.detail.includes("ACTIVATION_LIMIT_REACHED"), result.detail);
    assert.ok(result.detail.includes("active subagent limit reached"));
  });

  it("never reports a refusal class of our own: only invalid-args and host-refused exist", async () => {
    const r = rig({ hostError: new Error("anything") });
    const reasons = new Set<string>();
    for (const args of [
      { title: "", prompt: "p" },
      { title: "t", prompt: "" },
      { title: "t", prompt: "p" },
    ]) {
      const result = (await r.tool.execute(args)) as SpawnDispatcherToolResult;
      if (!result.ok) reasons.add(result.reason);
    }
    assert.deepEqual([...reasons].sort(), ["host-refused", "invalid-args"]);
    // ADR-0025's forbidden vocabulary must not exist anywhere in this tool.
    for (const forbidden of [
      "recursion-limit",
      "dispatcher-cap",
      "generation",
      "budget",
    ]) {
      assert.ok(!r.tool.description.toLowerCase().includes(forbidden));
    }
  });

  it("throws when no spawn seam is wired — a wiring bug is never a spawn refusal", async () => {
    const r = rig({ omitSeam: true });
    await assert.rejects(
      () => r.tool.execute({ title: "Peer", prompt: "Handle it." }),
      /no dispatcher-spawn seam is wired/,
    );
  });

  it("requires a bound dispatcher session", async () => {
    const r = rig();
    r.setSessionId(null);
    await assert.rejects(
      () => r.tool.execute({ title: "Peer", prompt: "Handle it." }),
      /no dispatcher session/,
    );
  });
});
