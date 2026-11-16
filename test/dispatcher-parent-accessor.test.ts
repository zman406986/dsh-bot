/**
 * Lane C4 — the adapter exposes the summoning parent of a spawned team
 * leader, for the final-answer push.
 *
 * The parent is the SAME record the spawn already writes (no second store):
 * the in-memory `dispatcherMarks` mirror (seeded before the child exists, then
 * written by `writeDispatcherMark`) and, across a restart, the durable
 * `dispatcher_sessions` row's `parentSessionId`. This file pins both halves
 * against the REAL `CordisDshHost` over a structural stub ctx — offline, no
 * live dsh, no LLM.
 *
 * Also pinned: a user-started dispatcher and an unknown session answer
 * `undefined` (the field is a session id, never a guessed mapping), and a
 * marker row from before ticket 138 has no parent to answer with.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  type ActivationLike,
  type ActivationSpecLike,
  type AdapterContext,
  type AgentHandleLike,
  type AgentLike,
  type CreateAgentOptionsLike,
} from "../src/adapter/cordis-dsh-host.js";
import type { DurabilityPort } from "../src/core/durability.js";

/** A top-level dispatcher-shaped agent, with the cwd a summon requires. */
function createAgent(id: string): AgentLike {
  return {
    session: {
      id,
      header: { delegationDepth: 0, cwd: "C:\\work" },
    },
    followup() {},
  };
}

/**
 * The parts of `AdapterContext` this accessor's paths touch: the agent create
 * seam (the summoned child), the event bus (`ctx.on` registrations), and the
 * structurally required services. Nothing here reaches a subagent service.
 */
function createStubCtx(): AdapterContext {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const ctx = {
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb as (payload: unknown) => void);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    subagents: {
      async startActivation(_spec: ActivationSpecLike): Promise<ActivationLike> {
        throw new Error("the dispatcher summon must not use startActivation (ADR-0032)");
      },
      interrupt() {},
      async sendMessage() {
        return "stub-message";
      },
    },
    agents: {
      get: () => undefined,
      async create(spec: CreateAgentOptionsLike): Promise<AgentHandleLike> {
        const agent = createAgent(spec.sessionId);
        await spec.setup?.({}, agent);
        return { agent, dispose: async () => {} };
      },
    },
    jobs: { list: () => [] },
    storageDomain: {},
  };
  return ctx as unknown as AdapterContext;
}

interface MarkRow {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly generation?: number;
}

/**
 * The durable mark surface `dispatcherParentOf` reads on the cold path plus
 * the boot warm-up's `listDispatcherMarks`. Rows are keyed by session id, like
 * the real table; a missing row answers `"not-dispatcher"`.
 */
function createMarkStore(rows: MarkRow[] = []): {
  store: DurabilityPort;
  rows: Map<string, MarkRow>;
} {
  const byId = new Map<string, MarkRow>(rows.map((row) => [row.sessionId, { ...row }]));
  const store = {
    writeDispatcherMark(row: MarkRow) {
      byId.set(row.sessionId, { ...row });
    },
    readDispatcherMark(sessionId: string) {
      return byId.get(sessionId);
    },
    listDispatcherMarks() {
      return [...byId.values()];
    },
    peekDispatcherMark(sessionId: string) {
      const row = byId.get(sessionId);
      return row === undefined
        ? { kind: "not-dispatcher" as const }
        : { kind: "dispatcher" as const, mark: row };
    },
  } as unknown as DurabilityPort;
  return { store, rows: byId };
}

describe("lane C4: dispatcherParentOf", () => {
  it("a spawned dispatcher answers with its summoning session id (in-memory path)", async () => {
    const host = createCordisDshHost(createStubCtx());
    host.bindParent(createAgent("disp-1"), "disp-1");

    const result = await host.spawnDispatcher({
      parentSessionId: "disp-1",
      title: "Peer",
      prompt: "Handle it.",
    });

    assert.equal(host.dispatcherParentOf(result.dispatcherId), "disp-1");
    // The summoner is a user-started dispatcher, not a spawned one.
    assert.equal(host.dispatcherParentOf("disp-1"), undefined);
  });

  it("a session restored after a restart answers from its durable mark", async () => {
    const { store } = createMarkStore([
      { sessionId: "leader-9", parentSessionId: "disp-1", generation: 2 },
      // A pre-138 row: identity is durable, but no summoner was recorded.
      { sessionId: "old-leader", generation: 2 },
    ]);
    const host = createCordisDshHost(createStubCtx(), { markers: store });

    // BEFORE the boot warm-up: the synchronous peek is the cold read.
    assert.equal(host.dispatcherParentOf("leader-9"), "disp-1");

    await host.refreshDispatcherMarks();
    assert.equal(host.dispatcherParentOf("leader-9"), "disp-1");
    assert.equal(host.dispatcherParentOf("old-leader"), undefined);
    assert.equal(host.dispatcherParentOf("never-seen"), undefined);
  });

  it("a user-started dispatcher and an unknown session answer undefined", () => {
    const host = createCordisDshHost(createStubCtx());
    host.recordDispatcherClass("user-disp", "user");

    assert.equal(host.dispatcherParentOf("user-disp"), undefined);
    assert.equal(host.dispatcherParentOf("unknown-session"), undefined);
  });
});
