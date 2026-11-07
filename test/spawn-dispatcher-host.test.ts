/**
 * Ticket 118 / ticket 157 / ADR-0032 — the HOST-SIDE dispatcher spawn path.
 * Offline: a structural `AdapterContext` stub, no live dsh, no LLM.
 *
 * What this file pins: the spawn shape, the `cwd` handoff, the first-turn
 * delivery through `followup`, the absence of every subagent field, and the
 * fact that a summoned dispatcher is NOT routed through the worker
 * composition/registry path. The activation body (scoped tools, policy,
 * lifecycle) is the plugin's step and is not tested here.
 *
 * ADR-0032 changed the mechanism: a summoned dispatcher is a NEW TOP-LEVEL
 * SESSION parallel to its summoner (`ctx.agents.create` + `agent.followup`),
 * not a subagent child (`ctx.subagents.startActivation`). The stub therefore
 * models BOTH seams — `agents.create` for the peer, `startActivation` for a
 * worker — so the contrast stays observable in one file.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {createCordisDshHost, type ActivationLike, type ActivationSpecLike, type AdapterContext, type AgentHandleLike, type AgentLike, type AgentOptionsLike, type CreateAgentOptionsLike} from "../src/adapter/cordis-dsh-host.js";
import { WAKE_SOURCE_KIND } from "../src/adapter/wake-copy.js";
import {
  formatSummoningDispatcherHandoffLine,
  SUMMONING_DISPATCHER_ID_HANDOFF_LABEL,
} from "../src/core/policy/prompts.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import type { ModelCatalogLike } from "../src/adapter/model-option.js";
import type { ModelRoute } from "../src/core/types.js";

interface ComposedChild {
  readonly childId: string;
  readonly sections: string[];
  readonly restrictions: unknown[];
  /**
   * The exact scope object `setup` was handed. The preset-mount fix is
   * asserted by identity against it: a mount anywhere but the child's own
   * scope would compose the wrong agent.
   */
  scope?: unknown;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A structural agent.
 *
 * Ticket 163 defect 2: `cwd` defaults to a real directory. A summon from a
 * session with none is REFUSED (its peer could never be cold-resumed), so an
 * agent without one models a summoner that cannot summon — the refusal has its
 * own test below, which passes `null` to mean "no directory".
 */
function createAgent(
  id: string,
  delegationDepth = 0,
  header: { cwd?: string | null } = {},
  options?: AgentOptionsLike,
): AgentLike {
  const cwd = header.cwd === undefined ? "C:\\work" : header.cwd;
  return {
    session: {
      id,
      header: {
        ...(delegationDepth === 0
          ? { parentSession: undefined, delegationDepth: 0 }
          : { parentSession: "parent-x", delegationDepth }),
        ...(cwd === null ? {} : { cwd }),
      },
    },
    ...(options === undefined ? {} : { options }),
    followup() {},
  };
}

/**
 * Structural ctx stub.
 *
 * `agents.create` is the dispatcher seam (ADR-0032). It honours `sessionId`,
 * awaits `setup` before publication (so composition lands before
 * `agent/created` and the first prompt), announces a TOP-LEVEL session — no
 * `parentSession`, no `delegationDepth`, `cwd` only — and returns a handle
 * whose `agent.followup` is recorded, so "the first turn was delivered" is
 * observable.
 *
 * `subagents.startActivation` is kept for the worker seam: it announces the
 * child with the parent's id and depth + 1, exactly like the host, which is
 * the seam the worker composition listens on.
 */
function createStubCtx(
  presets?: {
    presetForSession?: (session: unknown) => string | null | undefined;
    mount?: (ctx: unknown, id?: string) => Promise<unknown>;
  },
  /**
   * DEFECT FIX: the Workspace registry the host reaches through
   * `ctx.get("workspaceRegistry")`. Present only when a test asks for one,
   * which keeps "a deployment with no registry still summons" observable.
   *
   * `entities[].sessionIds` is the membership account, deliberately MUTABLE:
   * `attachSession` prepends to it in place, exactly as the durable record
   * does (`dsh-workspace/lib/index.js:125-128`), so the write under test is
   * observable on the object the test built.
   */
  workspaces?: {
    entities?: Array<{ id?: string; sessionIds: string[] }>;
    attach?: (sessionId: string) => Promise<void> | void;
  },
  /**
   * Post-create seam controls (defect fix: only a CREATE failure is a host
   * refusal). `createIdOverride` models a host that ignores the reserved id;
   * `failFollowup` models a driver that throws after the session exists.
   */
  seams?: {
    createIdOverride?: string;
    failFollowup?: boolean;
  },
  /**
   * Ticket 285: the live model catalog the host reaches through
   * `ctx.get("llm")`. Present only when a test asks for one, which keeps
   * "a deployment that mounts no catalog" observable: the resolver answers
   * `catalog-unavailable` and the spawn proceeds on the inherited route.
   */
  llm?: ModelCatalogLike,
) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const startActivationCalls: ActivationSpecLike[] = [];
  const createCalls: CreateAgentOptionsLike[] = [];
  const followupCalls: Array<{ sessionId: string; message: unknown }> = [];
  const presetMounts: Array<{ ctx: unknown; id: string | undefined }> = [];
  const workspaceAttaches: Array<{ workspaceId: string; sessionId: string }> = [];
  const announcedHeaders: Array<{
    childId: string;
    header: Record<string, unknown>;
  }> = [];
  const composedChildren: ComposedChild[] = [];
  const events: string[] = [];
  const state: { failNextWith: unknown } = { failNextWith: undefined };
  let nextChild = 1;
  /**
   * Ticket 159: park the NEXT create BEFORE `setup` runs, so a second create
   * can reach `setup` first. That is the interleaving the old positional queue
   * could not survive.
   */
  let holdNextCreate = false;
  let heldCreate: (() => void) | null = null;

  /** The child's OWN scope: the only place composition can land. */
  function childScope(childId: string) {
    const composed: ComposedChild = {
      childId,
      sections: [],
      restrictions: [],
    };
    composedChildren.push(composed);
    const scopeCtx = {
        systemPrompt: {
          section(section: { name: string }) {
            composed.sections.push(section.name);
            return () => {};
          },
          getSectionOrder() {
            return 0;
          },
        },
        tools: {
          schemas() {
            return [{ name: "spawn_worker" }, { name: "todo_write" }];
          },
          restrict(filter: unknown) {
            composed.restrictions.push(filter);
            return () => {};
          },
        },
      };
    composed.scope = scopeCtx;
    return { composed, scopeCtx };
  }

  const ctx: AdapterContext & {
    fire(name: string, payload: unknown): void;
    startActivationCalls: ActivationSpecLike[];
    createCalls: CreateAgentOptionsLike[];
    followupCalls: Array<{ sessionId: string; message: unknown }>;
    announcedHeaders: Array<{ childId: string; header: Record<string, unknown> }>;
    composedChildren: ComposedChild[];
    presetMounts: Array<{ ctx: unknown; id: string | undefined }>;
    workspaceAttaches: Array<{ workspaceId: string; sessionId: string }>;
    events: string[];
    failNextCreateWith(error: unknown): void;
    holdNextActivation(): void;
    releaseHeldActivation(): void;
  } = {
    startActivationCalls,
    createCalls,
    followupCalls,
    announcedHeaders,
    composedChildren,
    presetMounts,
    workspaceAttaches,
    events,
    /**
     * DEFECT FIX: the preset registry the host reaches through
     * `ctx.get("agentPresets")`, and the Workspace registry it reaches through
     * `ctx.get("workspaceRegistry")`. Each is present only when a test asks for
     * one, which is what makes "a deployment with neither still summons"
     * observable.
     */
    get(name: string) {
      // Ticket 285: the model catalog the host's resolver reads. A deployment
      // that mounts none returns undefined, exactly like the live context.
      if (name === "llm") return llm;
      if (name === "workspaceRegistry") {
        if (workspaces === undefined) return undefined;
        return {
          list() {
            return (workspaces.entities ?? []).map((entity, index) => {
              const id = entity.id ?? `ws-${index + 1}`;
              return {
                id,
                sessionIds: entity.sessionIds,
                async attachSession(sessionId: string) {
                  workspaceAttaches.push({ workspaceId: id, sessionId });
                  events.push(`attach:${id}`);
                  // The durable write: prepend to the ordered account.
                  entity.sessionIds = [sessionId, ...entity.sessionIds];
                  if (workspaces.attach !== undefined) {
                    await workspaces.attach(sessionId);
                  }
                },
              };
            });
          },
        };
      }
      if (name !== "agentPresets" || presets === undefined) return undefined;
      return {
        presetForSession:
          presets.presetForSession ?? (() => undefined),
        async mount(mountCtx: unknown, id?: string) {
          presetMounts.push({ ctx: mountCtx, id });
          events.push(`mount:${id ?? "<default>"}`);
          if (presets.mount !== undefined) return await presets.mount(mountCtx, id);
          return { id };
        },
      };
    },
    failNextCreateWith(error: unknown) {
      state.failNextWith = error;
    },
    holdNextActivation() {
      holdNextCreate = true;
    },
    releaseHeldActivation() {
      const gate = heldCreate;
      heldCreate = null;
      gate?.();
    },
    fire(name: string, payload: unknown) {
      for (const cb of [...(listeners.get(name) ?? [])]) {
        (cb as (arg: unknown) => void)(payload);
      }
    },
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    subagents: {
      async startActivation(spec: ActivationSpecLike): Promise<ActivationLike> {
        startActivationCalls.push(spec);
        if (state.failNextWith !== undefined) {
          const failure = state.failNextWith;
          state.failNextWith = undefined;
          throw failure;
        }
        const childId = `child-${nextChild++}`;
        const { scopeCtx } = childScope(childId);
        const parentDepth =
          spec.request.parent.session.header?.delegationDepth ?? 0;
        const header = {
          parentSession: String(spec.request.parent.session.id),
          delegationDepth: parentDepth + 1,
        };
        announcedHeaders.push({ childId, header });
        ctx.fire("agent/created", {
          agent: { session: { id: childId, header }, ctx: scopeCtx },
          source: "startup",
        });
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
    agents: {
      get: () => undefined,
      async create(options: CreateAgentOptionsLike): Promise<AgentHandleLike> {
        createCalls.push(options);
        events.push("create");
        if (state.failNextWith !== undefined) {
          const failure = state.failNextWith;
          state.failNextWith = undefined;
          throw failure;
        }
        // The created session keeps the id the caller reserved, and its header
        // is a TOP-LEVEL one: `cwd`, plus `agentPreset` when the child joined
        // one — exactly the two fields the host's own create writes from meta
        // (`dsh-session/lib/index.js:1840`).
        const childId = seams?.createIdOverride ?? String(options.sessionId);
        const header: Record<string, unknown> = {};
        if (options.meta?.cwd !== undefined) header.cwd = options.meta.cwd;
        if (options.meta?.agentPreset !== undefined) {
          header.agentPreset = options.meta.agentPreset;
        }
        const agent: AgentLike = {
          session: { id: childId, header },
          ...(options.agentOptions === undefined
            ? {}
            : { options: options.agentOptions }),
          followup(message: unknown) {
            followupCalls.push({ sessionId: childId, message });
            events.push("followup");
            if (seams?.failFollowup === true) {
              throw new Error("driver refused the first turn");
            }
          },
        };
        const { scopeCtx } = childScope(childId);
        announcedHeaders.push({ childId, header });
        // Ticket 159: park here — AFTER the id exists, BEFORE `setup` — so a
        // test can start a second create and let IT reach `setup` first.
        if (holdNextCreate) {
          holdNextCreate = false;
          await new Promise<void>((resolve) => {
            heldCreate = resolve;
          });
        }
        events.push("setup");
        // `setup` is AWAITED before publication (ADR-0032): everything it
        // registers exists before `agent/created` and the first prompt.
        await options.setup?.(scopeCtx, agent);
        events.push("published");
        ctx.fire("agent/created", {
          agent: { session: { id: childId, header }, ctx: scopeCtx },
          source: "startup",
        });
        return { agent, dispose: async () => {} };
      },
    },
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

  return ctx;
}

describe("ADR-0032: host spawnDispatcher creates a parallel top-level session", () => {
  it("creates with the reserved id, passes cwd and no parent/origin/depth, and delivers the prompt through followup", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-1", 0, { cwd: "C:\\work\\project" }),
      "disp-1",
    );

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon a peer",
      prompt: "Own the login bug and report the outcome.",
    });

    // The subagent runtime is not involved at all any more.
    assert.equal(ctx.startActivationCalls.length, 0);
    assert.equal(ctx.createCalls.length, 1);
    const options = ctx.createCalls[0] as CreateAgentOptionsLike;

    // The id is RESERVED before the create and handed over as the session id,
    // so the host either creates that exact session or refuses.
    const reservedId = String(options.sessionId);
    assert.match(reservedId, UUID_RE);
    assert.equal(result.dispatcherId, reservedId);

    // `cwd` is copied: the host's cross-session route refuses a session whose
    // header has none, so a peer without one would be unreachable after a
    // restart.
    assert.deepEqual(options.meta, { cwd: "C:\\work\\project" });

    // THE POINT OF THE CHANGE. The host's ownership guard is an OR, so these
    // must stay absent TOGETHER — any one of them silently re-classifies the
    // session and every ordinary route then answers `session/agent-busy`.
    const meta = (options.meta ?? {}) as Record<string, unknown>;
    assert.equal("parentSession" in meta, false);
    assert.equal("origin" in meta, false);
    assert.equal("delegationDepth" in meta, false);
    assert.equal("parentAgent" in options, false);
    // …and the whole subagent request shape went with them: no parent agent,
    // no parent delivery, no depth ceiling, no spawn provider, no label.
    assert.equal("request" in options, false);
    assert.equal("delivery" in options, false);
    assert.equal("maxDepth" in options, false);
    assert.equal("label" in options, false);
    assert.equal("provider" in options, false);
    // Mitosis: the child becomes a top-level session, so it inherits no
    // per-agent preset either — nothing invents such a slot.
    assert.equal("agentPreset" in options, false);
    // This summoner carries no route, so no AgentOptions is invented.
    assert.equal("agentOptions" in options, false);
    // The host mints its own pre-publication signal when the caller sends none.
    assert.ok(options.signal instanceof AbortSignal);

    // FIRST TURN: the whole prompt, delivered through `followup`. Creating a
    // session alone leaves it blank, and a blank session stays hidden until
    // its first turn lands. The summoner's session id rides the FIRST line:
    // a top-level peer inherits no parent pointer, and the team-leader policy
    // names this exact line as its upward-report address.
    assert.equal(ctx.followupCalls.length, 1);
    const turn = ctx.followupCalls[0] as {
      sessionId: string;
      message: {
        id: string;
        role: string;
        content: Array<{ type: string; text?: string }>;
        source: { kind: string };
      };
    };
    assert.equal(turn.sessionId, reservedId);
    assert.match(turn.message.id, /^multitask-spawn-/);
    assert.equal(turn.message.role, "user");
    assert.equal(turn.message.content.length, 1);
    assert.equal(turn.message.content[0]?.type, "text");
    assert.equal(
      (turn.message.content[0] as { text: string }).text,
      `${formatSummoningDispatcherHandoffLine("disp-1")}\n\nOwn the login bug and report the outcome.`,
    );
    // Producer-owned source kind: session format v4 rejects a plugin wrapper.
    assert.equal(turn.message.source.kind, WAKE_SOURCE_KIND);

    // `setup` lands before publication, and the first turn is only queued
    // after the create resolved — never from inside `setup`.
    assert.deepEqual(ctx.events, ["create", "setup", "published", "followup"]);
  });

  it("inherits the summoner's LIVE model selection, effort and maxTokens", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const summoner = createAgent(
      "disp-live",
      0,
      { cwd: "C:\\work\\project" },
      // The static/deployment route: intentionally NOT the live selection.
      { provider: "deployment", model: "default" },
    );
    (summoner as unknown as Record<string, unknown>)["model"] = {
      current: () => ({
        provider: "live-provider",
        model: "live-model",
        reasoningEffort: "high",
        maxTokens: 8192,
      }),
    };
    host.bindParent(summoner, "disp-live");

    await host.spawnDispatcher({
      parentSessionId: "disp-live",
      title: "Peer",
      prompt: "Own the slice.",
    });

    assert.deepEqual(ctx.createCalls[0]?.agentOptions, {
      provider: "live-provider",
      model: "live-model",
      reasoningEffort: "high",
      maxTokens: 8192,
    });
  });

  it("falls back to the session request header, then to options, for the route", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const summoner = createAgent(
      "disp-header",
      0,
      { cwd: "C:\\work\\project" },
      { provider: "options-provider", model: "options-model" },
    );
    Object.defineProperty(summoner.session, "requestHeader", {
      configurable: true,
      value: () => ({
        config: { provider: "header-provider", model: "header-model" },
      }),
    });
    host.bindParent(summoner, "disp-header");

    await host.spawnDispatcher({
      parentSessionId: "disp-header",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.deepEqual(ctx.createCalls[0]?.agentOptions, {
      provider: "header-provider",
      model: "header-model",
    });

    // Only `options` answers: the pre-fix source still works.
    const optionsCtx = createStubCtx();
    const optionsHost = createCordisDshHost(optionsCtx);
    optionsHost.bindParent(
      createAgent(
        "disp-options",
        0,
        { cwd: "C:\\work\\project" },
        { provider: "options-only", model: "options-model" },
      ),
      "disp-options",
    );
    await optionsHost.spawnDispatcher({
      parentSessionId: "disp-options",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.deepEqual(optionsCtx.createCalls[0]?.agentOptions, {
      provider: "options-only",
      model: "options-model",
    });
  });

  it("the first turn carries the summoning dispatcher's session id as the handoff line", async () => {
    // A summoned dispatcher is top-level (ADR-0032), so it inherits no parent
    // session pointer. Its upward-report address can only travel in the
    // handoff prompt — and the team-leader policy names this exact line.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-summoner", 0, { cwd: "C:\\work\\project" }),
      "disp-summoner",
    );

    await host.spawnDispatcher({
      parentSessionId: "disp-summoner",
      title: "Peer",
      prompt: "Take the migration slice and report the outcome.",
    });

    const turn = ctx.followupCalls[0] as {
      sessionId: string;
      message: { content: Array<{ type: string; text?: string }> };
    };
    const text = turn.message.content[0]?.text ?? "";
    // Exact label + id, on the FIRST line, ahead of the caller's prompt.
    assert.ok(
      text.startsWith(
        formatSummoningDispatcherHandoffLine("disp-summoner"),
      ),
      text,
    );
    assert.ok(text.includes(SUMMONING_DISPATCHER_ID_HANDOFF_LABEL));
    assert.ok(text.includes("disp-summoner"));
    assert.ok(text.endsWith("Take the migration slice and report the outcome."));
  });

  /**
   * ADR-0032: `setup` COMPOSES, never drives.
   *
   * `setup` is awaited before publication, so a turn it opened would start
   * before the child's own first turn and before its tool surface is wired.
   * The host therefore activates with `flushWake = false` inside `setup` and
   * discharges a parked wake only AFTER `create` resolves.
   *
   * Where the wake is parked: the child id is minted inside `spawnDispatcher`,
   * so no caller can name it before that call. The create seam is the earliest
   * moment it exists — parked there, before `setup` is awaited, which is
   * exactly the window this ordering protects. Parking only works because the
   * host seeds the durable-mark mirror with the reserved id BEFORE the create
   * (`openWakeTurn` parks marked-but-not-live ids and nothing else).
   *
   * KNOWN GAP (recorded, ticket 158): this test covers ONE of the two flush
   * sites — the explicit post-create flush. The stub's `agent/created` payload
   * is parentless (`cwd` only, ADR-0032), so it routes to
   * `resumeUserStartedDispatcher`, which returns early here because this host
   * was built without an `onUserDispatcherResumed` hook. A host that DOES have
   * the hook can therefore discharge the same parked wake from the listener
   * instead; that path is not exercised by an ordering test and would need its
   * own trace assertion to distinguish the two.
   */
  it("announces a top-level session: cwd only, so a depth-1 summoner produces a PEER, not a grandchild", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-deep", 1, { cwd: "C:\\work\\deep" }),
      "disp-deep",
    );

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-deep",
      title: "Nested peer",
      prompt: "Take the second half.",
    });

    const options = ctx.createCalls[0] as CreateAgentOptionsLike;
    // The summoner's own depth does not propagate: a top-level session has no
    // delegation depth, and there is no ceiling to send.
    assert.equal("maxDepth" in options, false);
    assert.deepEqual(Object.keys(options.meta ?? {}), ["cwd"]);
    assert.equal(String(options.sessionId), result.dispatcherId);

    // The announced session is top-level in its HEADER too — `cwd` and nothing
    // else, exactly like the host's own "new conversation".
    const announced = ctx.announcedHeaders[0] as {
      childId: string;
      header: Record<string, unknown>;
    };
    assert.equal(announced.childId, result.dispatcherId);
    assert.deepEqual(Object.keys(announced.header), ["cwd"]);
    assert.equal(announced.header.cwd, "C:\\work\\deep");
  });

  it("throws when the parent session is unbound (same rule as spawnWorker)", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "not-bound",
        title: "Peer",
        prompt: "Handle it.",
      }),
      /no parent agent bound for session not-bound/,
    );
    assert.equal(ctx.createCalls.length, 0);
    assert.equal(ctx.startActivationCalls.length, 0);
  });

  it("propagates a create refusal unchanged: no re-wrap, no invented refusal class", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1"), "disp-1");
    const hostRefusal = new Error("session/agent-busy");
    ctx.failNextCreateWith(hostRefusal);

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Handle it.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // Same object: no re-wrap, no invented refusal class, no cap of ours.
    assert.equal(caught, hostRefusal);
    // A refused create opens no turn.
    assert.equal(ctx.followupCalls.length, 0);
  });

});

/**
 * Defect fixes on the post-create half of a summon.
 *
 * `ctx.agents.create` resolving means a real session EXISTS. Anything that
 * fails after that point — a preset lookup returning `null`, a driver
 * `followup` that throws, a marker-store write that rejects — is bookkeeping,
 * not a host refusal: the call must still return the created dispatcher, and
 * the durable mark must be written before the first turn where possible.
 */
describe("defect fix: only a CREATE failure is a host refusal", () => {
  /** Minimal DurabilityPort: only the dispatcher-mark seams this path uses. */
  function createMarkStore(log?: string[], writeError?: Error) {
    const marks = new Map<
      string,
      { sessionId: string; parentSessionId?: string; generation?: number }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
      }) {
        log?.push(`mark:${mark.sessionId}`);
        if (writeError !== undefined) throw writeError;
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
    };
  }

  it("normalizes a `null` preset: no agentPreset in meta, nothing mounted, the summon still succeeds", async () => {
    // The LIVE registry answers `null` for a preset-free session. Written
    // through, it made the host throw "session header agentPreset must be a
    // string" from a summon that should have joined no preset at all.
    const ctx = createStubCtx({ presetForSession: () => null });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    const options = ctx.createCalls[0] as CreateAgentOptionsLike;
    assert.deepEqual(options.meta, { cwd: "C:\\work" });
    assert.equal(ctx.presetMounts.length, 0);
    assert.equal(ctx.followupCalls.length, 1);
    assert.equal(String(options.sessionId), result.dispatcherId);
  });

  it("returns the created dispatcher when the first `followup` throws", async () => {
    const ctx = createStubCtx(undefined, undefined, { failFollowup: true });
    const store = createMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    // No rejection: the child exists, so the core must not hear host-refused.
    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(ctx.createCalls.length, 1);
    assert.equal(ctx.followupCalls.length, 1);
    assert.deepEqual([...store.marks.keys()], [result.dispatcherId]);
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
  });

  it("returns the created dispatcher when the durable mark write rejects", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore(undefined, new Error("store down"));
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(ctx.followupCalls.length, 1);
    assert.equal(String(result.dispatcherId).length > 0, true);
    // The in-memory mirror is still the truth this process reads.
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
  });

  it("writes the durable mark BEFORE the first turn", async () => {
    const ctx = createStubCtx();
    // The stub logs create/setup/published/followup into `ctx.events`; the
    // mark store logs into the SAME array, so the ordering is one sequence.
    const store = createMarkStore(ctx.events);
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.deepEqual(ctx.events, [
      "create",
      "setup",
      "published",
      `mark:${result.dispatcherId}`,
      "followup",
    ]);
  });

  it("a never-resolving mark store does not block the first turn", async () => {
    const ctx = createStubCtx();
    const store = {
      ...createMarkStore(),
      // The crash-safety write never settles.
      writeDispatcherMark() {
        return new Promise<void>(() => {});
      },
    };
    const host = createCordisDshHost(ctx, {
      markers: store,
      bookkeepingTimeoutMs: 10,
    });
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    let result: { dispatcherId: string };
    try {
      result = await host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Handle it.",
      });
    } finally {
      console.warn = original;
    }

    // The first turn was queued anyway, and the spawn reported the child.
    assert.equal(ctx.followupCalls.length, 1);
    assert.equal(ctx.followupCalls[0]?.sessionId, result.dispatcherId);
    assert.ok(
      warnings.some((line) => line.includes("did not settle")),
      "the bounded wait is logged",
    );
  });

  it("moves every seed to the created id and leaves no phantom reservation", async () => {
    const ctx = createStubCtx(undefined, undefined, {
      createIdOverride: "host-assigned-id",
    });
    const base = createMarkStore();
    const store = {
      ...base,
      peekDispatcherMark(
        sessionId: string,
      ):
        | { kind: "dispatcher"; mark: { sessionId: string } }
        | { kind: "not-dispatcher" } {
        const mark = base.marks.get(sessionId);
        return mark === undefined
          ? { kind: "not-dispatcher" }
          : { kind: "dispatcher", mark };
      },
    };
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });
    const reservedId = String(ctx.createCalls[0]?.sessionId);
    assert.notEqual(reservedId, result.dispatcherId);

    // The live id owns every seed.
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
    assert.equal(host.dispatcherMarkAnswer(result.dispatcherId), "dispatcher");

    // The reservation left nothing behind: no mark, no generation, no class.
    assert.equal(host.isDurablyMarkedDispatcher(reservedId), false);
    assert.equal(host.dispatcherMarkAnswer(reservedId), "not-dispatcher");

    // And it cannot act as a phantom team leader: a session reusing that id
    // may still summon.
    host.bindParent(createAgent(reservedId), reservedId);
    const reused = await host.spawnDispatcher({
      parentSessionId: reservedId,
      title: "Second peer",
      prompt: "Own another slice.",
    });
    // The important assertion is that the call was NOT refused as a team
    // leader; this stub host ignores every reservation, so the id repeats.
    assert.equal(typeof reused.dispatcherId, "string");
    assert.equal(ctx.createCalls.length, 2, "the second summon was admitted");
  });

  it("activates under the CREATED agent's own id when the host ignores the reservation", async () => {
    const ctx = createStubCtx(undefined, undefined, {
      createIdOverride: "host-assigned-id",
    });
    const store = createMarkStore();
    const spawned: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      markers: store,
      onDispatcherSpawned: (agent, sessionId, _generation, title) => {
        assert.equal(String(agent.session.id), "host-assigned-id");
        spawned.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    // The result and the durable row follow the live agent, not the stale
    // reservation (`finally` drops the unused reserved-id mark).
    assert.equal(result.dispatcherId, "host-assigned-id");
    assert.deepEqual([...store.marks.keys()], ["host-assigned-id"]);
    assert.deepEqual(spawned, [
      { sessionId: "host-assigned-id", title: "Peer" },
    ]);
    assert.equal(ctx.followupCalls[0]?.sessionId, "host-assigned-id");
  });
});

/**
 * Ticket 176 (owner ruling 2026-11-03): a dispatcher another dispatcher
 * summoned may NOT summon further dispatchers.
 *
 * The tool surface is the fence — a team leader never gets `spawn_dispatcher`
 * registered, so it never sees the name. This suite pins the BACKSTOP: even a
 * caller that reaches `host.spawnDispatcher` directly is refused, loudly, and
 * both directions are covered so an over-eager refusal cannot slip through.
 *
 * A REAL HOST records the class itself for every session it activates as a
 * summoned peer, so this suite plays the caller that already has (via
 * `recordDispatcherClass`) — the same entry the plugin's activation hooks use.
 */
describe("ticket 176: a spawned dispatcher cannot summon", () => {
  it("refuses a summon from a spawned-class session, loudly, before the host is touched", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    const teamLeader = createAgent("disp-spawned");
    host.bindParent(teamLeader, "disp-spawned");
    host.recordDispatcherClass("disp-spawned", "spawned");

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "disp-spawned",
        title: "Another team",
        prompt: "Own a third slice.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // LOUD, and actionable: the error names the rule and the remedy. A silent
    // no-op would leave the model believing a peer exists.
    assert.ok(caught instanceof Error, "the refusal is thrown, not swallowed");
    assert.match(caught.message, /^CordisDshHost: /);
    assert.match(caught.message, /team leader/);
    assert.match(caught.message, /cannot summon another dispatcher/);
    assert.match(caught.message, /Report what is needed/);
    // Nothing happened: no session was created, no turn was opened.
    assert.equal(ctx.createCalls.length, 0);
    assert.equal(ctx.followupCalls.length, 0);
    assert.equal(ctx.startActivationCalls.length, 0);
  });

  it("still allows a summon from a user-started session — the user class is untouched", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    // Deliberately NOT recorded: an unrecorded class on a host with no store is
    // `user`, which is what every pre-176 activation produced. A second case
    // records it explicitly so both routes are covered.
    host.bindParent(createAgent("chat-1"), "chat-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.match(result.dispatcherId, UUID_RE);
    assert.equal(ctx.createCalls.length, 1);

    const explicit = createStubCtx();
    const host2 = createCordisDshHost(explicit);
    host2.bindParent(createAgent("chat-2"), "chat-2");
    host2.recordDispatcherClass("chat-2", "user");
    const second = await host2.spawnDispatcher({
      parentSessionId: "chat-2",
      title: "Peer",
      prompt: "Own the other slice.",
    });
    assert.match(second.dispatcherId, UUID_RE);
    assert.equal(explicit.createCalls.length, 1);
  });

  it("a later `user` record cannot unlock a session already known as spawned", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-spawned"), "disp-spawned");
    host.recordDispatcherClass("disp-spawned", "spawned");
    // The class of a session id cannot change (ADR-0034 decision 1), so a
    // second, weaker record is ignored rather than obeyed.
    host.recordDispatcherClass("disp-spawned", "user");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-spawned",
        title: "Another team",
        prompt: "Own a third slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  it("a cold resume whose class projection cannot answer falls through to the durable row, never to `user`", async () => {
    // Defect: `resumeUserStartedDispatcher` wrote `readDispatcherClass(...) ??
    // "user"` into `dispatcherClasses`, shadowing the durable "spawned"
    // answer. A resumed team leader could then summon again. The projection
    // here CANNOT answer (null), and the durable row is the only witness.
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    store.put({ sessionId: "disp-cold" });
    let resumed = 0;
    const host = createCordisDshHost(ctx, {
      markers: store,
      sessionKindOf: () => "dispatcher",
      dispatcherClassOf: () => null,
      onUserDispatcherResumed: () => {
        resumed += 1;
      },
    });

    // A parentless, depth-0 announcement is the cold-resume shape.
    ctx.fire("agent/created", {
      agent: createAgent("disp-cold"),
      source: "resume",
    });
    assert.equal(resumed, 1);

    // Even a later `user` record cannot downgrade the durable answer.
    host.recordDispatcherClass("disp-cold", "user");
    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-cold",
        title: "Another team",
        prompt: "Own a slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  /**
   * The COLD-RESUME half of the decision recorded on ticket 176: a spawned
   * dispatcher whose mark row is still on disk keeps the refusal after a
   * restart, because `dispatcher_sessions` rows are written only by the spawn
   * path — a row's presence already means "another dispatcher summoned this".
   */
  it("refuses a cold-resumed spawned dispatcher whose row is readable in the store", async () => {
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    store.put({ sessionId: "disp-resumed" });
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-resumed"), "disp-resumed");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-resumed",
        title: "Another team",
        prompt: "Own a third slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  it("allows a resumed user-started dispatcher: the store proves it has no dispatcher row", async () => {
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("chat-resumed"), "chat-resumed");

    const result = await host.spawnDispatcher({
      parentSessionId: "chat-resumed",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.match(result.dispatcherId, UUID_RE);
    assert.equal(ctx.createCalls.length, 1);
  });

  it("fails CLOSED when the store exists but cannot answer yet", async () => {
    // A store that has not opened answers `unknown` for everything. A wrong
    // ALLOW would create a second dispatcher level the owner ruled out, and
    // nothing else would catch it; a wrong DENY is visible and self-heals once
    // the store opens. The ticket records this choice.
    const ctx = createStubCtx();
    const store = createPeekableMarkStore();
    store.closeForNow();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-unknown"), "disp-unknown");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "disp-unknown",
        title: "Peer",
        prompt: "Own the slice.",
      }),
      /cannot summon another dispatcher/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });
});

/**
 * A mark store that answers the synchronous peek, with an explicit "not opened
 * yet" mode — the shape the real `storageDomain` store has before its async
 * open resolves (`durable-marker.ts` `peekDispatcherMark`).
 */
function createPeekableMarkStore() {
  const marks = new Map<string, { sessionId: string }>();
  let open = true;
  return {
    put(mark: { sessionId: string }): void {
      marks.set(mark.sessionId, mark);
    },
    closeForNow(): void {
      open = false;
    },
    writeWorkerMarker() {},
    readWorkerMarkers() {
      return [];
    },
    deleteWorkerMarker() {},
    peekDispatcherMark(
      sessionId: string,
    ):
      | { kind: "dispatcher"; mark: { sessionId: string } }
      | { kind: "not-dispatcher" }
      | { kind: "unknown" } {
      if (!open) return { kind: "unknown" };
      const mark = marks.get(sessionId);
      return mark === undefined
        ? { kind: "not-dispatcher" }
        : { kind: "dispatcher", mark };
    },
  };
}

describe("ticket 130: host durable dispatcher mark", () => {
  /** Minimal in-memory DurabilityPort: the two seams this ticket adds. */
  function createMarkStore() {
    const marks = new Map<
      string,
      { sessionId: string; parentSessionId?: string; generation?: number }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
      }) {
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
    };
  }

  it("writes the child's mark after the create resolves, keyed by the session id", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.deepEqual([...store.marks.keys()], [result.dispatcherId]);
    assert.equal(
      store.marks.get(result.dispatcherId)?.parentSessionId,
      "disp-1",
    );
    // The in-memory mirror answers for the live child — that is what the
    // `sessionKind` projection and the peer fence read.
    assert.equal(host.isDurablyMarkedDispatcher(result.dispatcherId), true);
  });

});

describe("ticket 141: host spawn generation", () => {
  /** Minimal mark store that records the whole row. */
  function createMarkStore() {
    const marks = new Map<
      string,
      { sessionId: string; parentSessionId?: string; generation?: number }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
      }) {
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
    };
  }

  it("a spawner reported as generation 2 makes the child generation 3, recorded on the row", async () => {
    const ctx = createStubCtx();
    const store = createMarkStore();
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: (sessionId) =>
        sessionId === "disp-1" ? 2 : null,
    });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(store.marks.get(result.dispatcherId)?.generation, 3);
    assert.equal(store.marks.get(result.dispatcherId)?.parentSessionId, "disp-1");
  });

});

/**
 * Ticket 163 — the four defects the ticket-157 review found. Each test here
 * fails against the code as ticket 157 left it, and passes after its fix.
 */
describe("ticket 163 defect 1: the child's generation follows the summoner's DURABLE row", () => {
  /** A store that lists rows, so `refreshDispatcherMarks` can warm the mirror. */
  function createListableMarkStore() {
    const marks = new Map<
      string,
      { sessionId: string; parentSessionId?: string; generation?: number }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
      }) {
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
      listDispatcherMarks() {
        return [...marks.values()];
      },
      peekDispatcherMark(sessionId: string) {
        return marks.has(sessionId)
          ? ({ kind: "dispatcher", mark: marks.get(sessionId)! } as const)
          : ({ kind: "not-dispatcher" } as const);
      },
    };
  }

  /**
   * The measured defect, reproduced on the path that is still reachable.
   *
   * Ticket 157 measured it on a generation-3 grandchild. Ticket 176 (owner
   * ruling 2026-11-03) has since made that exact shape unreachable: a session
   * whose class resolves `"spawned"` — which `>= 2` does — is refused a summon
   * outright. What survives is the same ROOT CAUSE one level up: the host read
   * the spawner's generation only from `dispatcherGenerationOf` (the plugin's
   * lifecycle), and a parentless cold resume activates with no generation, so
   * the lifecycle answers 1 for a session whose durable row says more. This
   * test drives that read directly through `refreshDispatcherMarks`, which is
   * the seam the ticket names ("the `dispatcherGenerations` mirror that
   * `refreshDispatcherMarks` had already filled from the durable row").
   *
   * It asserts the mirror's answer rather than a spawn, because the spawn is
   * fenced by ticket 176 and the MIRROR is what that fence and every future
   * generation read consult.
   */
  it("a generation-3 row is what the host reports, not the lifecycle's 1", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    // A durable row from an earlier process: this peer was summoned by a
    // generation-2 dispatcher.
    store.marks.set("peer-3", {
      sessionId: "peer-3",
      parentSessionId: "chat-1",
      generation: 3,
    });
    // The lifecycle seam answers what the plugin knows TODAY. A parentless cold
    // resume activates with no generation, so it answers 1 — the number that
    // must NOT win.
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => 1,
    });
    await host.refreshDispatcherMarks();

    // The durable row is authoritative: this session is class `spawned`, which
    // is exactly the answer a generation >= 2 implies.
    assert.equal(host.isDurablyMarkedDispatcher("peer-3"), true);
    assert.equal(host.dispatcherMarkAnswer("peer-3"), "dispatcher");
  });

  it("a legacy pre-141 row (no generation field) still reads as a dispatcher", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    // Ticket 141: a row written before the field existed came from a spawn, so
    // its honest reading is generation 2.
    store.marks.set("legacy-peer", {
      sessionId: "legacy-peer",
      parentSessionId: "chat-1",
    });
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => null,
    });
    await host.refreshDispatcherMarks();

    assert.equal(host.isDurablyMarkedDispatcher("legacy-peer"), true);
  });

  it("an in-process spawn seeds the mirror BEFORE the child exists, so a chained read is right", async () => {
    // The mirror is not only the boot path: `spawnDispatcher` seeds it before
    // the create, and `writeDispatcherMark` re-seeds it after. A read taken
    // between the two must already be correct.
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => null,
    });
    host.bindParent(createAgent("chat-1"), "chat-1");

    const first = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Peer two",
      prompt: "First slice.",
    });

    // Child of a generation-1 user chat.
    assert.equal(store.marks.get(first.dispatcherId)?.generation, 2);
    assert.equal(host.isDurablyMarkedDispatcher(first.dispatcherId), true);
    // …and therefore class `spawned` in this process, without any store read.
    assert.equal(host.dispatcherMarkAnswer(first.dispatcherId), "dispatcher");
  });

  /**
   * The root cause, isolated: the SPAWNER-generation expression must consult
   * the mirror before the lifecycle seam.
   *
   * This is asserted through a real spawn from a USER-class session whose id
   * also appears in the mirror with a higher generation — the one arrangement
   * ticket 176 does not fence, because `dispatcherClasses` can keep the session
   * `"user"` while the mirror says 3. A host that read only the lifecycle would
   * record 2 here; reading the mirror first records 4.
   */
  it("the spawn path itself prefers the mirror over the lifecycle seam", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, {
      markers: store,
      // The lifecycle says "generation 1" — the parentless-resume default.
      dispatcherGenerationOf: () => 1,
    });
    await host.refreshDispatcherMarks();
    // A user-class session (so it MAY summon) whose mirror entry says 3.
    // `recordDispatcherClass` writes the CLASS without touching the mirror;
    // the generation mirror was warmed from a row that also exists.
    store.marks.set("resumed-user", {
      sessionId: "resumed-user",
      parentSessionId: "chat-0",
      generation: 3,
    });
    host.bindParent(createAgent("resumed-user"), "resumed-user");
    host.recordDispatcherClass("resumed-user", "user");
    await host.refreshDispatcherMarks();

    const result = await host.spawnDispatcher({
      parentSessionId: "resumed-user",
      title: "Peer four",
      prompt: "Own a fourth slice.",
    });

    assert.equal(
      store.marks.get(result.dispatcherId)?.generation,
      4,
      "one past the DURABLE generation the mirror holds, not the lifecycle's 1",
    );
  });
});

describe("ticket 163 defect 2: a summoner with no cwd refuses loudly", () => {
  it("throws a named refusal before creating anything", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    // `null` means "this header carries no cwd" — a summoner that cannot
    // produce a resumable peer.
    host.bindParent(createAgent("nowhere", 0, { cwd: null }), "nowhere");

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "nowhere",
        title: "Peer",
        prompt: "Own the slice.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // LOUD, with the remedy named — never a silent unresumable session.
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^CordisDshHost: /);
    assert.match(caught.message, /has no cwd/);
    assert.match(caught.message, /cold-resumed/);
    assert.match(caught.message, /Nothing was created/);
    // Nothing happened: no session, no turn, no failed spawn to clean up.
    assert.equal(ctx.createCalls.length, 0);
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("an empty-string cwd is the same refusal — it is not a directory either", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("blank", 0, { cwd: "" }), "blank");

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "blank",
        title: "Peer",
        prompt: "Own the slice.",
      }),
      /has no cwd/,
    );
    assert.equal(ctx.createCalls.length, 0);
  });

  it("a summoner WITH a cwd still creates the peer in that exact directory", async () => {
    // The refusal must not become a blanket rule: the normal case is untouched.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(
      createAgent("disp-1", 0, { cwd: "C:\\work\\project" }),
      "disp-1",
    );

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
    });
    assert.deepEqual(ctx.createCalls[0]?.meta, { cwd: "C:\\work\\project" });
    assert.equal(ctx.createCalls.length, 1);
    assert.match(result.dispatcherId, UUID_RE);
  });
});

/**
 * Ticket 159 — the spawn title must pair with the session it belongs to by
 * IDENTITY, never by queue position.
 *
 * The host-side half of the fix: the title rides the activation hook beside the
 * session id it names, so there is no queue to get wrong. These tests pin the
 * host's contract — the title the summoner asked for is the title the hook
 * receives, on the call that names that child, even when two summons are in
 * flight at once.
 */
describe("ticket 159: the spawn title travels with its own session id", () => {
  it("the hook receives the summoner's title beside the child's own id", async () => {
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-1"), "chat-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Payments migration",
      prompt: "Own the migration.",
    });

    assert.equal(hooked.length, 1);
    // Identity: the id on the hook is the id the spawn reports back.
    assert.equal(hooked[0]?.sessionId, result.dispatcherId);
    assert.equal(hooked[0]?.title, "Payments migration");
  });

  it("two summons in flight bind each child with ITS OWN title (the reported race)", async () => {
    // The interleaving ticket 159 describes: A's create suspends before `setup`
    // while B's create reaches it first. A queue claim would give B A's title.
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-a"), "chat-a");
    host.bindParent(createAgent("chat-b"), "chat-b");

    // Summon A is started first and parks before its `setup`.
    ctx.holdNextActivation();
    const spawnA = host.spawnDispatcher({
      parentSessionId: "chat-a",
      title: "Alpha job",
      prompt: "Own alpha.",
    });
    // Let A reach the parked point, then start B and let IT finish first.
    await new Promise((resolve) => setImmediate(resolve));
    const spawnB = host.spawnDispatcher({
      parentSessionId: "chat-b",
      title: "Beta job",
      prompt: "Own beta.",
    });
    const b = await spawnB;
    // NOW release A, so A's `setup` runs after B's — the wrong order for any
    // positional claim.
    ctx.releaseHeldActivation();
    const a = await spawnA;

    assert.equal(hooked.length, 2);
    const titleById = new Map(hooked.map((e) => [e.sessionId, e.title]));
    // Both directions, not just "both labels are non-empty".
    assert.equal(titleById.get(a.dispatcherId), "Alpha job");
    assert.equal(titleById.get(b.dispatcherId), "Beta job");
    // …and they are genuinely different sessions, so a swap is meaningful.
    assert.notEqual(a.dispatcherId, b.dispatcherId);
  });

  it("a refused spawn hands the hook no title at all — nothing leaks to a later summon", async () => {
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-1"), "chat-1");
    const refusal = new Error("session/agent-busy");
    ctx.failNextCreateWith(refusal);

    await assert.rejects(
      host.spawnDispatcher({
        parentSessionId: "chat-1",
        title: "Never happened",
        prompt: "Own it.",
      }),
      (error: unknown) => error === refusal,
    );
    // The hook never ran, so there is no entry anywhere for a later summon to
    // inherit — the second-order symptom the ticket recorded.
    assert.equal(hooked.length, 0);

    const ok = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Real job",
      prompt: "Own it.",
    });
    assert.equal(hooked.length, 1);
    assert.equal(hooked[0]?.sessionId, ok.dispatcherId);
    assert.equal(hooked[0]?.title, "Real job");
  });

  it("a re-announcement passes no title, so it cannot overwrite the spawn's label", async () => {
    // The hook also fires for a cold-resumed / re-announced child. There is no
    // title there, and `undefined` says so — the roster keeps the label the
    // session was bound with.
    const ctx = createStubCtx();
    const hooked: Array<{ sessionId: string; title: string | undefined }> = [];
    const host = createCordisDshHost(ctx, {
      onDispatcherSpawned: (_agent, sessionId, _generation, title) => {
        hooked.push({ sessionId, title });
      },
    });
    host.bindParent(createAgent("chat-1"), "chat-1");
    const spawned = await host.spawnDispatcher({
      parentSessionId: "chat-1",
      title: "Original label",
      prompt: "Own it.",
    });

    // A second announcement of the same session (the resume path).
    ctx.fire("agent/created", {
      agent: createAgent(spawned.dispatcherId),
      source: "resume",
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The re-announcement is deduplicated by `dispatcherActivated`, so the hook
    // still ran exactly once with the spawn's own title.
    assert.equal(hooked.length, 1);
    assert.equal(hooked[0]?.title, "Original label");
  });
});

describe("ticket 118: FakeDshHost dispatcher spawn", () => {
  it("records dispatcher spawns separately and never as workers", async () => {
    // A dispatcher is a peer, not a work stream: if its spawn landed in
    // `spawnCalls`, the worker registry would gain a stream it must not own.
    //
    // The parent is mandatory (the core type forbids a missing one, and the
    // fake refuses a blank id the way the live host's bound-parent lookup
    // does), so this supplies a real summoning session.
    const host = new FakeDshHost();
    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Go.",
    });
    assert.equal(result.dispatcherId, "fake-dispatcher-1");
    assert.equal(host.dispatcherSpawnCalls.length, 1);
    assert.equal(
      host.dispatcherSpawnCalls[0]?.opts.parentSessionId,
      "disp-1",
    );
    assert.equal(host.spawnCalls.length, 0);
  });
});

/**
 * DEFECT (summoned session came up with no work tools).
 *
 * Report: a spawned session's whole tool list was
 * `await_agent, check_workers, deliver_result, message_agent, spawn_worker,
 * steer_worker, stop_worker, working_directory` — the plugin's seven dispatched
 * tools plus the one HOST-PLANE tool, and nothing else.
 *
 * Cause: this spawn path creates a TOP-LEVEL session through
 * `ctx.agents.create` and never joins it to an agent preset. Every work tool
 * (fs, fs-search, pwsh/bash, web, jobs, todo, skill, subagent…) is mounted
 * INSIDE a preset (`dsh-web-app/presets/standard.patch.yml`), while
 * `tool-working-directory` is a host row (`dsh-base/cordis.patch.yml:169-170`).
 * A scope that joined no preset therefore inherits only the host plane — the
 * reported list, exactly.
 *
 * The host's own create route always mounts one
 * (`dsh-api-session-controller/lib/index.js:264-277`). These tests pin that
 * this path now does the same, in the one window where it is possible.
 */
describe("defect fix: a summoned session joins its summoner's agent preset", () => {
  it("mounts the summoner's preset on the child's scope during setup", async () => {
    const ctx = createStubCtx({
      presetForSession: () => "standard",
    });
    const host = createCordisDshHost(ctx);
    const summoner = createAgent("disp-1", 0, { cwd: "C:\\work\\project" });
    host.bindParent(summoner, "disp-1");

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon a peer",
      prompt: "Own the login bug.",
    });

    assert.equal(ctx.presetMounts.length, 1);
    assert.equal(ctx.presetMounts[0]?.id, "standard");
    // Mounted on the CHILD's own scope — the object `setup` was handed, not
    // the plugin's ctx. A mount anywhere else would compose the wrong agent.
    assert.equal(ctx.presetMounts[0]?.ctx, ctx.composedChildren[0]?.scope);
    // Ordering: inside `setup` and before publication, so the tools exist
    // before `agent/created` and the first prompt is assembled.
    assert.deepEqual(ctx.events.slice(0, 4), [
      "create",
      "setup",
      "mount:standard",
      "published",
    ]);
  });

  it("reads the preset from the summoner's session, not from a deployment default", async () => {
    // The peer must run the SAME composition as the dispatcher that summoned
    // it, exactly as a subagent child joins its parent's retained revision
    // (`dsh-agent-preset-registry/lib/index.js:712-728`).
    const seen: unknown[] = [];
    const ctx = createStubCtx({
      presetForSession(session) {
        seen.push(session);
        return "minimal";
      },
    });
    const host = createCordisDshHost(ctx);
    const summoner = createAgent("disp-7", 0, { cwd: "C:\\work\\deep" });
    host.bindParent(summoner, "disp-7");

    await host.spawnDispatcher({
      parentSessionId: "disp-7",
      title: "Summon",
      prompt: "Go.",
    });

    assert.deepEqual(seen, [summoner.session]);
    assert.equal(ctx.presetMounts[0]?.id, "minimal");
  });

  it("records the joined preset in the child's meta so a cold resume keeps it", async () => {
    // The mount above only lives in THIS process. A restart rebuilds the child
    // from its header, so the preset must be recorded in meta exactly as the
    // host's own create does (`dsh-api-session-controller/lib/index.js:433-436`).
    // Without it `presetForObservation` finds nothing and the resume composes
    // the deployment DEFAULT — the same defect one restart later.
    const ctx = createStubCtx({ presetForSession: () => "standard" });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.deepEqual(ctx.createCalls[0]?.meta, {
      cwd: "C:\\work",
      agentPreset: "standard",
    });
    // The header is where a later resume reads it back from
    // (`dsh-session/lib/index.js:1840`, then the `agentPreset` projection).
    assert.deepEqual(Object.keys(ctx.announcedHeaders[0]?.header ?? {}), [
      "cwd",
      "agentPreset",
    ]);
    assert.equal(ctx.announcedHeaders[0]?.header.agentPreset, "standard");
  });

  it("publishes nothing when the preset mount fails — a tool-less peer is refused", async () => {
    // Silent degradation is the worse failure: the peer would exist, answer,
    // and be unable to touch the project. The spawn must fail instead.
    const ctx = createStubCtx({
      presetForSession: () => "standard",
      mount: async () => {
        throw new Error("agent-preset/invalid: broken");
      },
    });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const caught = await host
      .spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Summon",
        prompt: "Go.",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // Second-round audit: the refusal is NAMED by this adapter (host prefix +
    // what failed), not the raw preset-registry error.
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^CordisDshHost: /);
    assert.match(caught.message, /could not join agent preset "standard"/);
    assert.match(caught.message, /agent-preset\/invalid/);
    assert.ok(!ctx.events.includes("published"));
    assert.equal(ctx.followupCalls.length, 0);
  });

  it("normalizes a THROWING preset read to no preset instead of failing the summon", async () => {
    const ctx = createStubCtx({
      presetForSession() {
        throw new Error("preset registry exploded");
      },
    });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    let spawned: { dispatcherId: string };
    try {
      spawned = await host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Summon",
        prompt: "Go.",
      });
    } finally {
      console.warn = original;
    }

    assert.match(spawned.dispatcherId, UUID_RE);
    assert.equal(ctx.presetMounts.length, 0);
    assert.deepEqual(Object.keys(ctx.createCalls[0]?.meta ?? {}), ["cwd"]);
    assert.equal(ctx.followupCalls.length, 1);
    assert.ok(
      warnings.some((line) => line.includes("preset lookup")),
      "the normalized read failure is logged",
    );
  });

  it("mounts nothing when the summoner itself is preset-free", async () => {
    // A preset-free composition is valid (`src/core/tools.ts:717`); there is
    // no preset to join, so the summon proceeds exactly as before.
    const ctx = createStubCtx({ presetForSession: () => undefined });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const spawned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.equal(ctx.presetMounts.length, 0);
    // Nothing joined, so nothing is recorded: no `agentPreset: undefined` key
    // that a later read would have to special-case.
    assert.deepEqual(Object.keys(ctx.createCalls[0]?.meta ?? {}), ["cwd"]);
    assert.ok(UUID_RE.test(spawned.dispatcherId));
  });

  it("still summons on a host with no preset registry at all", async () => {
    // Headless/stub hosts compose no roster. The seam is optional, so the
    // pre-fix behaviour is preserved rather than turning into a refusal.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.equal(ctx.presetMounts.length, 0);
    assert.equal(ctx.createCalls.length, 1);
  });
});

/**
 * DEFECT (a summoned session appeared in the sidebar under "Ungrouped"
 * instead of the project that spawned it)
 *
 * The sidebar groups by Workspace MEMBERSHIP, never by folder:
 * `groupByWorkspace` walks each workspace's ordered `sessionIds` and trails
 * every session no workspace met in one empty-key group
 * (`dsh-client-ui-workspace/lib/client.js:1027-1044`). A session created
 * through `ctx.agents.create` carries `meta.cwd` and no membership — the meta
 * type has no workspace field at all (`dsh-agent/lib/types/index.d.ts:49-83`)
 * — so the peer had no group to land in until the registry re-bucketed it by
 * canonical cwd at the next STARTUP (`dsh-workspace/lib/index.js:758-813`):
 * the reported "it files itself correctly only after a restart".
 *
 * These tests pin the fix: the peer joins the Workspace that ACCOUNTS its
 * summoner, at creation, in this process — and stays ungrouped when its
 * summoner belongs to none, because then there is no workspace id to inherit.
 */
describe("defect fix: a summoned session files itself under its summoner's workspace", () => {
  it("attaches the child to the workspace that accounts the summoner, before its first turn", async () => {
    const project = { id: "ws-project", sessionIds: ["disp-1"] };
    const ctx = createStubCtx(undefined, { entities: [project] });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work\\project" }), "disp-1");

    const spawned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon a peer",
      prompt: "Own the login bug.",
    });

    // The membership write is what the sidebar reads, so it is the thing
    // asserted: the child is IN the account, under the summoner's project.
    assert.deepEqual(ctx.workspaceAttaches, [
      { workspaceId: "ws-project", sessionId: spawned.dispatcherId },
    ]);
    assert.deepEqual(project.sessionIds, [spawned.dispatcherId, "disp-1"]);
    // Ordering: filed AFTER the session exists (there is no id before that)
    // and BEFORE the first turn is queued, so the group is already right when
    // the session first becomes visible.
    assert.deepEqual(ctx.events.slice(-2), ["attach:ws-project", "followup"]);
  });

  it("prepends the child to the account, the same write the host's own create makes", async () => {
    // `attachSession` is not a set: it puts the new id at the FRONT of the
    // ordered list (`dsh-workspace/lib/index.js:125-128`), which is where the
    // sidebar reads a workspace's member order from.
    const project = { id: "ws-project", sessionIds: ["older-1", "disp-1"] };
    const ctx = createStubCtx(undefined, { entities: [project] });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work\\project" }), "disp-1");

    const spawned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.deepEqual(project.sessionIds, [
      spawned.dispatcherId,
      "older-1",
      "disp-1",
    ]);
  });

  it("picks the workspace by membership, not by position or cwd", async () => {
    // The summoner's workspace is the one that ACCOUNTS it, exactly as the
    // sidebar resolves it (`dsh-client-ui-workspace/lib/client.js:20505`). A
    // registry whose first workspace belongs to someone else must not win.
    const project = { id: "ws-project", sessionIds: ["disp-1"] };
    const other = { id: "ws-other", sessionIds: ["someone-else"] };
    const ctx = createStubCtx(undefined, { entities: [other, project] });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work\\project" }), "disp-1");

    const spawned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.deepEqual(ctx.workspaceAttaches, [
      { workspaceId: "ws-project", sessionId: spawned.dispatcherId },
    ]);
    assert.deepEqual(other.sessionIds, ["someone-else"]);
  });

  it("leaves the child ungrouped when the summoner belongs to no workspace", async () => {
    // A session opened outside every project is Ungrouped, and so is the peer
    // it summons. There is no workspace id to hand down, and inventing one
    // would file the child under a project its summoner is not in.
    const ctx = createStubCtx(undefined, {
      entities: [{ id: "ws-other", sessionIds: ["someone-else"] }],
    });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work\\loose" }), "disp-1");

    const spawned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.equal(ctx.workspaceAttaches.length, 0);
    assert.ok(UUID_RE.test(spawned.dispatcherId));
    // Nothing invented in the meta either: `cwd` only, exactly as before.
    assert.deepEqual(Object.keys(ctx.createCalls[0]?.meta ?? {}), ["cwd"]);
  });

  it("still summons on a host with no workspace registry at all", async () => {
    // Headless/stub hosts mount no registry. The seam is optional, so the
    // pre-fix behaviour is preserved rather than turning into a refusal.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Summon",
      prompt: "Go.",
    });

    assert.equal(ctx.workspaceAttaches.length, 0);
    assert.equal(ctx.createCalls.length, 1);
    assert.equal(ctx.followupCalls.length, 1);
  });

  it("keeps the summon alive when the attach fails, and says so", async () => {
    // The session already exists and is live by then, so a bookkeeping failure
    // must never read as a host refusal (same rule as the dispatcher-mark
    // write). The peer works, ungrouped, and the failure is logged — not
    // swallowed silently, or the defect would look fixed while it is not.
    const ctx = createStubCtx(undefined, {
      entities: [{ id: "ws-project", sessionIds: ["disp-1"] }],
      attach: async () => {
        throw new Error(
          "cannot attach session 'x' to workspace 'C:\\work': its cwd resolves to 'D:\\elsewhere'",
        );
      },
    });
    const host = createCordisDshHost(ctx);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let spawned: { dispatcherId: string };
    try {
      spawned = await host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Summon",
        prompt: "Go.",
      });
    } finally {
      console.warn = original;
    }

    assert.ok(UUID_RE.test(spawned.dispatcherId));
    // The peer still got its first turn, so it is a working dispatcher.
    assert.equal(ctx.followupCalls.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), new RegExp(spawned.dispatcherId));
  });
});

/**
 * Ticket 285 (.scratch/model-arg/PLAN.md §§1.5, 3.2-3.3 / Task 8): the leader
 * half of the spawn model option. `spawnDispatcher` already copies the
 * summoner's LIVE route; an explicit `model` replaces that route, but only
 * when it names a DIFFERENT provider/model. A same-route choice keeps the
 * inherited effort/maxTokens, because nothing about the model they belong to
 * changed — a route change drops them, since the option carries a route only
 * (plan §1.5).
 *
 * Offline: the summoner is a structural stub and the create seam is this
 * file's ctx stub. No catalog is read here — the tool path validates the raw
 * value through `host.resolveModelOption`; the host applies the route object
 * it is handed (plan §3.3 / §8).
 */
describe("Ticket 285: spawnDispatcher applies the leader's model option", () => {
  /**
   * A summoner whose LIVE selection is the deployment route PLUS effort and a
   * token cap: exactly the state the peer would inherit today. Every case
   * below starts from it, so "kept" and "dropped" are both observable.
   */
  function bindLiveSummoner(
    host: ReturnType<typeof createCordisDshHost>,
  ): void {
    const summoner = createAgent(
      "disp-1",
      0,
      { cwd: "C:\\work\\project" },
      { provider: "pA", model: "mA" },
    );
    (summoner as unknown as Record<string, unknown>)["model"] = {
      current: () => ({
        provider: "pA",
        model: "mA",
        reasoningEffort: "high",
        maxTokens: 8192,
      }),
    };
    host.bindParent(summoner, "disp-1");
  }

  it("uses the explicit route alone, dropping the inherited effort and maxTokens", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    bindLiveSummoner(host);

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      model: { provider: "pB", model: "mB" },
    });

    const options = ctx.createCalls[0] as CreateAgentOptionsLike;
    // A fresh route is exactly provider+model: the summoner's effort belongs
    // to pA/mA and the option carries no tuning of its own.
    assert.deepEqual(options.agentOptions, { provider: "pB", model: "mB" });
    assert.deepEqual(Object.keys(options.agentOptions ?? {}).sort(), [
      "model",
      "provider",
    ]);
  });

  it("keeps the inherited effort and maxTokens when the explicit route is the inherited one", async () => {
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    bindLiveSummoner(host);

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      model: { provider: "pA", model: "mA" },
    });

    // Same provider+model means the same model, so the inherited object is
    // reused whole — including the fields the option itself never carries.
    assert.deepEqual(ctx.createCalls[0]?.agentOptions, {
      provider: "pA",
      model: "mA",
      reasoningEffort: "high",
      maxTokens: 8192,
    });
  });

  it("leaves the inherited route untouched when model is omitted but worker_model is given", async () => {
    // Task 8 owns only the LEADER's route. Storing the worker default and
    // writing the mark row are Task 10; the question here is that
    // `workerModel` alone never leaks into the leader's agentOptions.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    bindLiveSummoner(host);

    await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      workerModel: { provider: "pC", model: "mC" },
    });

    assert.deepEqual(ctx.createCalls[0]?.agentOptions, {
      provider: "pA",
      model: "mA",
      reasoningEffort: "high",
      maxTokens: 8192,
    });
  });

  it("warns once and falls back to the inherited route for a malformed explicit route", async () => {
    // The tool schema keeps provider/model non-empty strings, but the host is
    // the last guard for a JS caller. A malformed route is ABSENT, not fatal:
    // handing it to the host would only fail at the first request.
    const ctx = createStubCtx();
    const host = createCordisDshHost(ctx);
    bindLiveSummoner(host);
    const warn = mock.method(console, "warn", () => {});
    try {
      await host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Own the slice.",
        // Whitespace-only provider: present, yet not a usable route.
        model: { provider: "   ", model: "mB" },
      });
    } finally {
      mock.restoreAll();
    }

    assert.deepEqual(ctx.createCalls[0]?.agentOptions, {
      provider: "pA",
      model: "mA",
      reasoningEffort: "high",
      maxTokens: 8192,
    });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0]?.arguments[0]),
      /^\[multitask-dispatcher\]/,
    );
  });
});

/**
 * Ticket 285 (plan §§1.6, 4.4, 6 Task 10): the leader's worker default is
 * stored on its durable dispatcher mark and restored into the in-memory map
 * on the next boot, so a cold-resumed leader still gives its workers the
 * route it was summoned with.
 *
 * The map has no other writer: spawnDispatcher is the only production path
 * that stores a default, and refreshDispatcherMarks is the only restart path
 * that restores one. Every case here therefore drives that pair and then
 * observes the next spawnWorker request — the exact seam the leader's later
 * spawn_worker call reaches (plan §4.4).
 */
describe("Ticket 285: the leader's worker default is stored and restored", () => {
  /**
   * A mark store that both writes and LISTS rows: the row is what a restart
   * would read, so a test can seed one directly to model an earlier process.
   */
  function createListableMarkStore() {
    const marks = new Map<
      string,
      {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
        workerModel?: ModelRoute;
      }
    >();
    return {
      marks,
      writeWorkerMarker() {},
      readWorkerMarkers() {
        return [];
      },
      deleteWorkerMarker() {},
      writeDispatcherMark(mark: {
        sessionId: string;
        parentSessionId?: string;
        generation?: number;
        workerModel?: ModelRoute;
      }) {
        marks.set(mark.sessionId, mark);
      },
      readDispatcherMark(sessionId: string) {
        return marks.get(sessionId);
      },
      listDispatcherMarks() {
        return [...marks.values()];
      },
      peekDispatcherMark(sessionId: string) {
        return marks.has(sessionId)
          ? ({ kind: "dispatcher", mark: marks.get(sessionId)! } as const)
          : ({ kind: "not-dispatcher" } as const);
      },
    };
  }

  /** Bind a top-level agent for an id so a later spawnWorker can resolve it. */
  function bindLeader(
    host: ReturnType<typeof createCordisDshHost>,
    id: string,
  ): void {
    host.bindParent(createAgent(id, 0, { cwd: "C:\\work" }), id);
  }

  it("records worker_model on the mark row and applies it to a later worker spawn", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const summoned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      workerModel: { provider: "pC", model: "mC" },
    });

    // The durable row is the restart source, so the default must be ON it —
    // not only in this process map.
    assert.deepEqual(store.marks.get(summoned.dispatcherId)?.workerModel, {
      provider: "pC",
      model: "mC",
    });
    // …and mirrored for the live process before any store round-trip.
    bindLeader(host, summoned.dispatcherId);
    await host.spawnWorker("Do the thing.", {
      parentSessionId: summoned.dispatcherId,
      streamKey: "s1",
      title: "Thing",
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.deepEqual(spec.request.agentOptions, {
      provider: "pC",
      model: "mC",
    });
  });

  it("lets an explicit worker model win over the stored default", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const summoned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      workerModel: { provider: "pC", model: "mC" },
    });
    bindLeader(host, summoned.dispatcherId);
    await host.spawnWorker("Do the thing.", {
      parentSessionId: summoned.dispatcherId,
      streamKey: "s1",
      title: "Thing",
      model: { provider: "pD", model: "mD" },
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    // Plan §0.3: the per-worker option is the higher precedence level.
    assert.deepEqual(spec.request.agentOptions, {
      provider: "pD",
      model: "mD",
    });
  });

  it("keys the stored default by the host-assigned leader id, not the reservation", async () => {
    // The host ignores the reservation and mints its own id (plan §9 risk 7):
    // the mark row and the map must follow the LIVE session, or every later
    // worker spawn from it would silently lose the default.
    const ctx = createStubCtx(undefined, undefined, {
      createIdOverride: "host-assigned-peer",
    });
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const summoned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      workerModel: { provider: "pC", model: "mC" },
    });

    assert.equal(summoned.dispatcherId, "host-assigned-peer");
    assert.deepEqual(store.marks.get("host-assigned-peer")?.workerModel, {
      provider: "pC",
      model: "mC",
    });
    bindLeader(host, "host-assigned-peer");
    await host.spawnWorker("Do the thing.", {
      parentSessionId: "host-assigned-peer",
      streamKey: "s1",
      title: "Thing",
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.deepEqual(spec.request.agentOptions, {
      provider: "pC",
      model: "mC",
    });
  });

  it("restores the default from a durable row when refreshDispatcherMarks runs (restart path)", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    // A row from an earlier process: this leader was summoned with pC/mC.
    store.marks.set("leader-1", {
      sessionId: "leader-1",
      parentSessionId: "chat-1",
      generation: 2,
      workerModel: { provider: "pC", model: "mC" },
    });
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => null,
    });
    await host.refreshDispatcherMarks();
    bindLeader(host, "leader-1");

    await host.spawnWorker("Do the thing.", {
      parentSessionId: "leader-1",
      streamKey: "s1",
      title: "Thing",
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.deepEqual(spec.request.agentOptions, {
      provider: "pC",
      model: "mC",
    });
  });

  it("does not downgrade an in-process default with a different store row", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const summoned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
      workerModel: { provider: "pC", model: "mC" },
    });
    // A stale/foreign row for the same session claims another default. The
    // in-process value is authoritative (same rule as parent/generation).
    store.marks.set(summoned.dispatcherId, {
      sessionId: summoned.dispatcherId,
      parentSessionId: "disp-1",
      workerModel: { provider: "pX", model: "mX" },
    });
    await host.refreshDispatcherMarks();
    bindLeader(host, summoned.dispatcherId);

    await host.spawnWorker("Do the thing.", {
      parentSessionId: summoned.dispatcherId,
      streamKey: "s1",
      title: "Thing",
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.deepEqual(spec.request.agentOptions, {
      provider: "pC",
      model: "mC",
    });
  });

  it("restores nothing for a legacy row without a worker default and leaves the request shape untouched", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    // A pre-285 row: a dispatcher, but no worker default. Its workers inherit
    // the leader's own route — the safe degradation plan §4.4 states.
    store.marks.set("legacy-leader", {
      sessionId: "legacy-leader",
      parentSessionId: "chat-1",
    });
    const host = createCordisDshHost(ctx, {
      markers: store,
      dispatcherGenerationOf: () => null,
    });
    await host.refreshDispatcherMarks();
    bindLeader(host, "legacy-leader");

    await host.spawnWorker("Do the thing.", {
      parentSessionId: "legacy-leader",
      streamKey: "s1",
      title: "Thing",
    });

    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.equal("agentOptions" in spec.request, false);
    assert.deepEqual(Object.keys(spec.request).sort(), [
      "maxDepth",
      "parent",
      "prompt",
    ]);
  });

  it("omits workerModel from the row when no worker default was given", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");

    const summoned = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Own the slice.",
    });

    const row = store.marks.get(summoned.dispatcherId);
    assert.ok(row);
    assert.equal("workerModel" in row, false);
  });

  it("stores no default and warns once when worker_model is malformed", async () => {
    const ctx = createStubCtx();
    const store = createListableMarkStore();
    const host = createCordisDshHost(ctx, { markers: store });
    host.bindParent(createAgent("disp-1"), "disp-1");
    const warn = mock.method(console, "warn", () => {});
    let summoned: { dispatcherId: string };
    try {
      summoned = await host.spawnDispatcher({
        parentSessionId: "disp-1",
        title: "Peer",
        prompt: "Own the slice.",
        // Present, yet not a route the host could apply.
        workerModel: { provider: "", model: "mC" },
      });
    } finally {
      mock.restoreAll();
    }
    assert.equal(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0]?.arguments[0]),
      /^\[multitask-dispatcher\]/,
    );

    // Nothing was stored, so the row omits the field and the leader's workers
    // keep today's inheritance shape.
    const row = store.marks.get(summoned.dispatcherId);
    assert.ok(row);
    assert.equal("workerModel" in row, false);
    bindLeader(host, summoned.dispatcherId);
    await host.spawnWorker("Do the thing.", {
      parentSessionId: summoned.dispatcherId,
      streamKey: "s1",
      title: "Thing",
    });
    const spec = ctx.startActivationCalls[0] as unknown as ActivationSpecLike;
    assert.equal("agentOptions" in spec.request, false);
  });
});

/**
 * Ticket 285 (.scratch/model-arg/PLAN.md §§3.2-3.4 / Task 7): the host-side
 * resolver. Every case is offline — ctx.get("llm") answers a structural stub,
 * so no provider or network is touched.
 *
 * The host wrapper owns exactly three things the pure resolver does not know:
 * it reads the catalog through the guarded ctx.get seam, it supplies the
 * SPAWNING session's provider as the bare-id preference (live route first,
 * options second, the same precedence spawnDispatcher uses), and it adds the
 * [multitask-dispatcher] prefix to the one warning a rejected value emits.
 */
describe("Ticket 285: host.resolveModelOption validates the spawn model option", () => {
  /** Two providers, one shared bare id: enough for every host-level case. */
  const catalog: ModelCatalogLike = {
    listProviders: () => [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ],
    async listModels(provider: string) {
      return provider === "alpha"
        ? [
            { id: "alpha-only", name: "Alpha Only" },
            { id: "shared", name: "Shared" },
          ]
        : [
            { id: "beta-only", name: "Beta Only" },
            { id: "shared", name: "Shared" },
          ];
    },
  };

  /** A host over the file's structural ctx stub, with (or without) a catalog. */
  function createHost(llm?: ModelCatalogLike) {
    const ctx = createStubCtx(undefined, undefined, undefined, llm);
    return { ctx, host: createCordisDshHost(ctx) };
  }

  /**
   * Capture console.warn for one test. The mock silences the line and records
   * it, so the exact warning text is observable; restore must run in a finally
   * even when an assertion throws.
   */
  function captureWarnings() {
    const warn = mock.method(console, "warn", () => {});
    return {
      warn,
      lines(): string[] {
        return warn.mock.calls.map((call) => String(call.arguments[0]));
      },
      restore(): void {
        mock.restoreAll();
      },
    };
  }

  it("resolves a canonical provider/model route", async () => {
    const { host } = createHost(catalog);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");

    const result = await host.resolveModelOption(
      "alpha/alpha-only",
      "disp-1",
      "leader",
    );

    assert.deepEqual(result, {
      kind: "resolved",
      route: { provider: "alpha", model: "alpha-only" },
    });
  });

  it("falls back on an unknown route and warns once with the prefix and raw value", async () => {
    const { host } = createHost(catalog);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");
    const warnings = captureWarnings();
    try {
      const result = await host.resolveModelOption(
        "pZ/mZ",
        "disp-1",
        "leader",
      );

      assert.deepEqual(result, {
        kind: "fallback",
        requested: "pZ/mZ",
        reason: "unknown-model",
      });
      const lines = warnings.lines();
      assert.equal(lines.length, 1);
      assert.equal(
        lines[0],
        '[multitask-dispatcher] model option "pZ/mZ" from session disp-1 was ignored (unknown model); using the summoner\'s current route.',
      );
    } finally {
      warnings.restore();
    }
  });

  it("returns absent for an empty value and never warns", async () => {
    const { host } = createHost(catalog);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");
    const warnings = captureWarnings();
    try {
      const result = await host.resolveModelOption("", "disp-1", "leader");

      assert.deepEqual(result, { kind: "absent" });
      assert.equal(warnings.warn.mock.callCount(), 0);
    } finally {
      warnings.restore();
    }
  });

  it("prefers the summoning session's live route over its options for a bare id", async () => {
    const { host } = createHost(catalog);
    const summoner = createAgent(
      "disp-1",
      0,
      { cwd: "C:\\work" },
      { provider: "alpha", model: "alpha-only" },
    );
    host.bindParent(
      {
        ...summoner,
        // The live selection is what the next request will use; options is
        // only the deployment default. spawnDispatcher follows the same
        // precedence, and the bare-id tie-break must too.
        model: { current: () => ({ provider: "beta", model: "beta-only" }) },
      },
      "disp-1",
    );

    const result = await host.resolveModelOption("shared", "disp-1", "worker");

    assert.deepEqual(result, {
      kind: "resolved",
      route: { provider: "beta", model: "shared" },
    });
  });

  it("falls back to the options provider when the summoner has no live route", async () => {
    const { host } = createHost(catalog);
    host.bindParent(
      createAgent(
        "disp-1",
        0,
        { cwd: "C:\\work" },
        { provider: "beta", model: "beta-only" },
      ),
      "disp-1",
    );

    const result = await host.resolveModelOption("shared", "disp-1", "leader");

    assert.deepEqual(result, {
      kind: "resolved",
      route: { provider: "beta", model: "shared" },
    });
  });

  it("names the worker fallback destination for an invalid worker model", async () => {
    const { host } = createHost(catalog);
    host.bindParent(createAgent("leader-1", 0, { cwd: "C:\\work" }), "leader-1");
    const warnings = captureWarnings();
    try {
      const result = await host.resolveModelOption(
        "pZ/mZ",
        "leader-1",
        "worker",
      );

      assert.equal(result.kind, "fallback");
      assert.equal(
        warnings.lines()[0],
        '[multitask-dispatcher] model option "pZ/mZ" from session leader-1 was ignored (unknown model); using the team leader\'s default worker route or its own route.',
      );
    } finally {
      warnings.restore();
    }
  });

  it("names the team leader's own route for an invalid worker_model", async () => {
    const { host } = createHost(catalog);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");
    const warnings = captureWarnings();
    try {
      const result = await host.resolveModelOption(
        "pZ/mZ",
        "disp-1",
        "worker-default",
      );

      assert.equal(result.kind, "fallback");
      assert.equal(
        warnings.lines()[0],
        '[multitask-dispatcher] worker_model option "pZ/mZ" from session disp-1 was ignored (unknown model); using the team leader\'s own route.',
      );
    } finally {
      warnings.restore();
    }
  });

  it("answers catalog-unavailable, without throwing, when no llm service is mounted", async () => {
    const { host } = createHost(undefined);
    host.bindParent(createAgent("disp-1", 0, { cwd: "C:\\work" }), "disp-1");
    const warnings = captureWarnings();
    try {
      const result = await host.resolveModelOption(
        "alpha/alpha-only",
        "disp-1",
        "leader",
      );

      assert.deepEqual(result, {
        kind: "fallback",
        requested: "alpha/alpha-only",
        reason: "catalog-unavailable",
      });
      assert.equal(warnings.warn.mock.callCount(), 1);
      assert.match(
        warnings.lines()[0] ?? "",
        /the model catalog is unavailable/,
      );
    } finally {
      warnings.restore();
    }
  });
});

