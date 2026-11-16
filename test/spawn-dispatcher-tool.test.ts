/**
 * Ticket 118 chunk 2 — the `spawn_dispatcher` TOOL only. Offline: FakeDshHost,
 * no live dsh, no LLM, no real timers.
 *
 * Chunk 1 (host seam, `test/spawn-dispatcher-host.test.ts`) owns the spawn
 * request shape. Chunk 3 (activation path) owns
 * `activateSummonedDispatcher`, scoped registration, policy injection and
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
 *    prompt, `host-refused` carrying the host's own text for anything the
 *    host's `agents.create` raises. No recursion limit, no dispatcher cap, no
 *    generation counter. ADR-0032 made this a top-level session, so the
 *    subagent runtime's pool limit and `maxDepth` refusal are not on this path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  createDispatcherTools,
  readExecSignal,
  toToolParametersSchema,
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
import {
  registerDispatcherTools,
  type RegisterableTool,
} from "../src/adapter/dispatcher-tools.js";
import type { ToolsLike } from "../src/adapter/cordis-dsh-host.js";
import type {
  DispatcherSpawnOptions,
  DispatcherSpawnResult,
  ModelOptionPurpose,
  ModelOptionResolution,
} from "../src/core/types.js";

/** Ticket 285: one call the handler made into the injected model resolver. */
interface ResolveModelCall {
  readonly raw: string;
  readonly purpose: ModelOptionPurpose;
}

interface Rig {
  readonly host: FakeDshHost;
  readonly multitask: Multitask;
  readonly tools: DispatcherToolDef[];
  readonly spawnDispatcherCalls: DispatcherSpawnOptions[];
  /** Ticket 285: resolver calls this tool made, in order. */
  readonly resolveModelCalls: ResolveModelCall[];
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
  resolveModel?: (
    raw: string,
    purpose: ModelOptionPurpose,
  ) => Promise<ModelOptionResolution>;
}): Rig {
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  let sessionId: string | null = "disp-1";
  const spawnDispatcherCalls: DispatcherSpawnOptions[] = [];
  const resolveModelCalls: ResolveModelCall[] = [];
  const resolveModel = options?.resolveModel;

  const tools = createDispatcherTools({
    multitask,
    getSessionId: () => sessionId,
    ...(resolveModel !== undefined
      ? {
          resolveModel: (
            raw: string,
            purpose: ModelOptionPurpose,
          ): Promise<ModelOptionResolution> => {
            resolveModelCalls.push({ raw, purpose });
            return resolveModel(raw, purpose);
          },
        }
      : {}),
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
    resolveModelCalls,
    tool,
    setSessionId: (next) => {
      sessionId = next;
    },
  };
}

/**
 * Capture surface for the ADAPTER path — the layer `src/plugin.ts` actually
 * calls. The rig above builds the core tool set directly, so it can prove the
 * HANDLER resolves, but not that `registerDispatcherTools` forwards the
 * resolver dependency the plugin supplies.
 */
function adapterToolsCapture(): {
  readonly ctx: { readonly tools: ToolsLike };
  readonly registered: RegisterableTool[];
} {
  const registered: RegisterableTool[] = [];
  return {
    ctx: {
      tools: {
        schemas: () => registered.map((tool) => ({ name: tool.name })),
        register(definition: unknown): () => void {
          const tool = definition as RegisterableTool;
          registered.push(tool);
          return () => {
            const at = registered.indexOf(tool);
            if (at >= 0) registered.splice(at, 1);
          };
        },
      },
    },
    registered,
  };
}

describe("ticket 118: spawn_dispatcher — registration and visibility", () => {
  it("is the last of the three custom dispatcher tools", () => {
    assert.equal(SPAWN_DISPATCHER_TOOL, "spawn_dispatcher");
    // Three custom verbs: deliver_result, message_agent, spawn_dispatcher.
    // (Workers/status/steering/stopping are the preset's stock tools and are
    // deliberately NOT in this list.)
    assert.equal(DISPATCHER_TOOL_NAMES.length, 3);
    assert.equal(
      DISPATCHER_TOOL_NAMES[DISPATCHER_TOOL_NAMES.length - 1],
      SPAWN_DISPATCHER_TOOL,
    );
  });

  it("declares title and prompt required, model and worker_model optional, nothing else", () => {
    const r = rig();
    const parameters = r.tool.parameters as {
      type: string;
      additionalProperties: boolean;
      properties: Record<
        string,
        { type: string; required?: boolean; description?: string }
      >;
    };
    assert.equal(parameters.type, "object");
    assert.equal(parameters.additionalProperties, false);
    // No stream_key and no todo_id: a dispatcher is not a work stream.
    // Ticket 285: model and worker_model are the two optional routing args.
    assert.deepEqual(Object.keys(parameters.properties).sort(), [
      "model",
      "prompt",
      "title",
      "worker_model",
    ]);
    assert.equal(parameters.properties.title?.required, true);
    assert.equal(parameters.properties.prompt?.required, true);
    assert.equal(parameters.properties.title?.type, "string");
    assert.equal(parameters.properties.prompt?.type, "string");
    // Ticket 285: both model args are optional strings. The serialized
    // parent-level required array stays ["title", "prompt"] in authored
    // property order, so the pre-285 contract is untouched.
    assert.equal(parameters.properties.model?.type, "string");
    assert.notEqual(parameters.properties.model?.required, true);
    assert.equal(parameters.properties.worker_model?.type, "string");
    assert.notEqual(parameters.properties.worker_model?.required, true);
    const serialized = toToolParametersSchema(r.tool.parameters) as {
      additionalProperties: boolean;
      required: string[];
    };
    assert.equal(serialized.additionalProperties, false);
    assert.deepEqual(serialized.required, ["title", "prompt"]);
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
  it("the note names it a peer, points at message_agent, and says do not wait or poll", async () => {
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
    // Do-not-wait, re-derived for push-only completion: there is no wait verb
    // left at all (await_agent is retired), so the note must say the answer
    // arrives as its own message on a fresh turn and that polling is wrong.
    assert.ok(note.includes("Do not wait or poll"), note);
    assert.ok(note.includes("starts a new turn"), note);
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

/**
 * Ticket 285: the opt-in model arguments. The tool resolves each non-empty
 * value through the injected resolver, hands the resolved route(s) to the
 * seam, and adds a fallback notice when a value was rejected. A fallback is
 * still a successful spawn — never a refusal.
 */
describe("ticket 285: spawn_dispatcher — model options", () => {
  it("resolves model and worker_model and passes both routes to the seam", async () => {
    const r = rig({
      resolveModel: async (raw) =>
        raw === "pB/mB"
          ? { kind: "resolved", route: { provider: "pB", model: "mB" } }
          : { kind: "resolved", route: { provider: "pC", model: "mC" } },
    });
    const result = (await r.tool.execute({
      title: "Peer",
      prompt: "Handle it.",
      model: "pB/mB",
      worker_model: "pC/mC",
    })) as SpawnDispatcherToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(r.spawnDispatcherCalls[0]?.model, {
      provider: "pB",
      model: "mB",
    });
    assert.deepEqual(r.spawnDispatcherCalls[0]?.workerModel, {
      provider: "pC",
      model: "mC",
    });
    // The purpose tells the resolver which fallback wording to use.
    assert.deepEqual(r.resolveModelCalls, [
      { raw: "pB/mB", purpose: "leader" },
      { raw: "pC/mC", purpose: "worker-default" },
    ]);
    // A resolved value is not a fallback: no structured field, no note line.
    assert.equal(result.model_fallbacks, undefined);
    assert.ok(!result.note.includes("was not used"), result.note);
  });

  it("a model fallback passes no route and carries the notice + a note line", async () => {
    const r = rig({
      resolveModel: async () => ({
        kind: "fallback",
        requested: "nope/nope",
        reason: "unknown-model",
      }),
    });
    const result = (await r.tool.execute({
      title: "Peer",
      prompt: "Handle it.",
      model: "nope/nope",
    })) as SpawnDispatcherToolResult;

    assert.ok(result.ok, "a fallback never refuses the spawn");
    if (!result.ok) return;
    const call = r.spawnDispatcherCalls[0];
    assert.ok(call);
    assert.equal("model" in call, false, "a fallback passes no route");
    assert.equal("workerModel" in call, false);
    assert.deepEqual(result.model_fallbacks, [
      { option: "model", requested: "nope/nope", reason: "unknown-model" },
    ]);
    assert.ok(result.note.includes("was not used"), result.note);
    assert.ok(result.note.includes("not in the model catalog"), result.note);
    assert.ok(result.note.includes('Leader model "nope/nope"'), result.note);
  });

  it("both values falling back -> two notices and two note lines", async () => {
    const r = rig({
      resolveModel: async (_raw, purpose) =>
        purpose === "leader"
          ? { kind: "fallback", requested: "pB/mB", reason: "unknown-model" }
          : {
              kind: "fallback",
              requested: "pC/mC",
              reason: "catalog-unavailable",
            },
    });
    const result = (await r.tool.execute({
      title: "Peer",
      prompt: "Handle it.",
      model: "pB/mB",
      worker_model: "pC/mC",
    })) as SpawnDispatcherToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.model_fallbacks, [
      { option: "model", requested: "pB/mB", reason: "unknown-model" },
      {
        option: "worker_model",
        requested: "pC/mC",
        reason: "catalog-unavailable",
      },
    ]);
    assert.ok(result.note.includes('Leader model "pB/mB"'), result.note);
    assert.ok(result.note.includes('Worker model "pC/mC"'), result.note);
    assert.ok(result.note.includes("the model catalog is unavailable"));
  });

  it("empty or whitespace-only values are omitted: no resolver call, no route, no note", async () => {
    const r = rig({
      resolveModel: async () => {
        throw new Error("the resolver must not be called for an empty value");
      },
    });
    const result = (await r.tool.execute({
      title: "Peer",
      prompt: "Handle it.",
      model: "   ",
      worker_model: "",
    })) as SpawnDispatcherToolResult;

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(r.resolveModelCalls, []);
    const call = r.spawnDispatcherCalls[0];
    assert.ok(call);
    assert.equal("model" in call, false);
    assert.equal("workerModel" in call, false);
    assert.equal(result.model_fallbacks, undefined);
  });

  it("throws the wiring error when a non-empty value has no resolver", async () => {
    const r = rig();
    await assert.rejects(
      () =>
        r.tool.execute({
          title: "Peer",
          prompt: "Handle it.",
          model: "pB/mB",
        }),
      /no model resolver is wired/,
    );
    assert.equal(r.spawnDispatcherCalls.length, 0);
  });
});

/**
 * Ticket 285 (PLAN Task 6): the ADAPTER must forward the resolver.
 *
 * `src/plugin.ts` supplies the live dependency to `registerDispatcherTools`,
 * not to `createDispatcherTools`; a dependency silently dropped between the
 * two turns every model argument into the handler's wiring error at execute
 * time. This pins the forwarding itself, with the two purposes the tool uses.
 */
describe("ticket 285: adapter registration forwards the model resolver", () => {
  it("registerDispatcherTools passes resolveModel through for both purposes", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const capture = adapterToolsCapture();
    const resolveModelCalls: ResolveModelCall[] = [];
    const spawnDispatcherCalls: DispatcherSpawnOptions[] = [];

    registerDispatcherTools({
      ctx: capture.ctx,
      multitask,
      getSessionId: () => "disp-1",
      resolveModel: async (raw, purpose) => {
        resolveModelCalls.push({ raw, purpose });
        return raw === "pB/mB"
          ? { kind: "resolved", route: { provider: "pB", model: "mB" } }
          : { kind: "resolved", route: { provider: "pC", model: "mC" } };
      },
      spawnDispatcher: async (opts) => {
        spawnDispatcherCalls.push(opts);
        return host.spawnDispatcher(opts);
      },
    });

    const tool = capture.registered.find(
      (entry) => entry.name === SPAWN_DISPATCHER_TOOL,
    );
    assert.ok(tool, `missing tool: ${SPAWN_DISPATCHER_TOOL}`);
    const result = (await tool.execute({
      title: "Peer",
      prompt: "Handle it.",
      model: "pB/mB",
      worker_model: "pC/mC",
    })) as SpawnDispatcherToolResult;

    assert.ok(result.ok);
    assert.deepEqual(resolveModelCalls, [
      { raw: "pB/mB", purpose: "leader" },
      { raw: "pC/mC", purpose: "worker-default" },
    ]);
    assert.deepEqual(spawnDispatcherCalls[0]?.model, {
      provider: "pB",
      model: "mB",
    });
    assert.deepEqual(spawnDispatcherCalls[0]?.workerModel, {
      provider: "pC",
      model: "mC",
    });
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
