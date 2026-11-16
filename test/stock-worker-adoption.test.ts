/**
 * Lane A2a regression: a child the STOCK `subagent` tool spawned — no
 * `childId` reservation, so `pendingSpawns` is 0 — is a first-class worker.
 *
 * What a stock announcement must prove here, in order:
 * (a) it is COMPOSED on the child's own scope at `agent/created` (worker
 *     persona section + tool barrier);
 * (b) it appears in the core worker roster with a linked todo;
 * (c) its `agent/status: running` edge is accepted by the REAL lifecycle
 *     listener (the host resolves the worker id, the FSM and the linked todo
 *     advance);
 * (d) its `subagent/end` passes the host ownership gate and flows through the
 *     one settle path (FSM terminal, settle event, todo open on completed /
 *     cancelled on aborted, terminal roster row).
 *
 * NOT tested here: the stock completion NOTICE the host pushes to the parent.
 * The fake emits no notice; that stays an unverified host behavior.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCordisDshHost,
  type ActivationLike,
  type AdapterContext,
  type AgentLike,
  type CordisDshHost,
} from "../src/adapter/cordis-dsh-host.js";
import { bindDispatcherLifecycle } from "../src/adapter/parent-agent.js";
import { subagentLabelOf } from "../src/adapter/peer-label.js";
import type { HostSessionProjectionsLike } from "../src/adapter/session-kind-projection.js";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type { SettledEvent } from "../src/core/types.js";
import { createWorkerAgentDef } from "../src/worker/agent-def.js";
import { WORKER_PERSONA_SECTION } from "../src/worker/preset.js";

const PARENT_ID = "disp-1";
const CHILD_ID = "stock-child-1";
const STOCK_LABEL = "Stock widget audit";

interface Composed {
  sections: string[];
  restrictions: Array<{ deny?: readonly string[]; allow?: readonly string[] }>;
  localTools: unknown[];
}

type StubCtx = AdapterContext & {
  fire(name: string, ...payloads: unknown[]): void;
  bindAgent(agent: AgentLike): void;
};

interface Rig {
  ctx: StubCtx;
  host: CordisDshHost;
  multitask: Multitask;
  durability: InMemoryDurability;
  composed: Composed;
  parent: AgentLike;
  child: AgentLike;
  settled: SettledEvent[];
  dispose(): void;
}

/**
 * Minimal Cordis bus stub. `startActivation` is deliberately unusable: a
 * stock spawn is modelled by announcing the child the way the host's stock
 * provider does — `agent/created` with the header the provider wrote — so the
 * test exercises the listener, never a fake spawn helper.
 */
function createStubCtx(): StubCtx {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const agents = new Map<string, AgentLike>();
  const ctx: StubCtx = {
    fire(name, ...payloads) {
      for (const cb of listeners.get(name) ?? []) {
        (cb as (...args: unknown[]) => void)(...payloads);
      }
    },
    bindAgent(agent) {
      agents.set(String(agent.session.id), agent);
    },
    on(name, cb) {
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
    subagents: {
      async startActivation(): Promise<ActivationLike> {
        throw new Error("the stock-child test announces the child directly");
      },
      interrupt() {},
      async sendMessage() {
        return undefined;
      },
    },
    agents: {
      get(id) {
        return agents.get(String(id));
      },
    },
    jobs: {
      list() {
        return [];
      },
    },
    storageDomain: {
      async open() {
        throw new Error("the storage domain is unused by this test rig");
      },
    },
  };
  return ctx;
}

/**
 * The child's scoped world. `schemas` models the surface a stock child
 * inherits from its parent (dispatcher verbs included) so the barrier has
 * something real to deny; `restrict` and `register` record what composition
 * applied.
 */
function createChildScope(composed: Composed): unknown {
  return {
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
        return [
          { name: "present" },
          { name: "subagent" },
          { name: "check_workers" },
          { name: "steer_worker" },
          { name: "stop_worker" },
          { name: "deliver_result" },
          { name: "read" },
        ];
      },
      restrict(filter: {
        deny?: readonly string[];
        allow?: readonly string[];
      }) {
        composed.restrictions.push(filter);
        return () => {};
      },
      register(definition: unknown) {
        composed.localTools.push(definition);
        return () => {};
      },
    },
  };
}

function createRig(): Rig {
  const durability = createInMemoryDurability();
  const ctx = createStubCtx();
  const composed: Composed = { sections: [], restrictions: [], localTools: [] };
  /**
   * The `subagent` projection a real child carries. The plugin's adoption
   * hook reads this exact projection for the todo title; the core only ever
   * sees the resulting label (or null).
   */
  const projections: HostSessionProjectionsLike = {
    snapshot() {
      return {
        values: {
          subagent: { mode: "continuable", label: STOCK_LABEL, seq: 1 },
        },
      };
    },
  };
  const child = {
    session: {
      id: CHILD_ID,
      header: {
        parentSession: PARENT_ID,
        delegationDepth: 1,
        origin: "subagent",
      },
    },
    ctx: createChildScope(composed),
    followup() {},
  } as unknown as AgentLike;
  const parent = {
    session: { id: PARENT_ID, header: { delegationDepth: 0 } },
    followup() {},
  } as unknown as AgentLike;
  ctx.bindAgent(parent);
  ctx.bindAgent(child);

  let multitask: Multitask | undefined;
  const host = createCordisDshHost(ctx, {
    markers: durability,
    workerAgentDef: createWorkerAgentDef("en"),
    // Lane A2b owns the worker-local tool list; this lane only proves the
    // composition seam runs. An empty list keeps the assertion about the
    // barrier and persona, not about reply_to_dispatcher.
    workerLocalTools: () => [],
    // Mirrors the plugin wiring: the same `subagent.label` read, the same
    // one narrow core method.
    onStockWorkerAdopted: (workerId, parentSessionId, childSession) => {
      multitask?.adoptSpawnedWorker({
        workerId,
        parentSessionId,
        label: subagentLabelOf(projections, childSession),
      });
    },
  });
  multitask = createMultitask(host, { durability });
  const lifecycle = bindDispatcherLifecycle(ctx, host, multitask, {
    policyEnabled: false,
  });
  const settled: SettledEvent[] = [];
  host.onWorkerSettled((event) => {
    settled.push(event);
  });
  const activated = lifecycle.activate(parent);
  assert.equal(activated.ok, true);

  return {
    ctx,
    host,
    multitask,
    durability,
    composed,
    parent,
    child,
    settled,
    dispose() {
      lifecycle.unbind();
    },
  };
}

function announce(rig: Rig): void {
  rig.ctx.fire("agent/created", { agent: rig.child, source: "startup" });
}

describe("stock-spawned worker adoption (lane A2a)", () => {
  it("composes, rosters, accepts a status edge, and settles as a worker", () => {
    const rig = createRig();
    try {
      announce(rig);

      // (a) Composition landed on the child's scope before the first turn.
      assert.ok(rig.composed.sections.includes(WORKER_PERSONA_SECTION));
      assert.equal(rig.composed.restrictions.length, 1);
      const deny = rig.composed.restrictions[0]?.deny ?? [];
      // The barrier is the intersection with the live surface: the stock
      // spawn verbs and the user-facing verbs must be gone; ordinary work
      // tools stay.
      for (const verb of ["present", "subagent", "deliver_result"]) {
        assert.ok(deny.includes(verb), `barrier must deny ${verb}`);
      }
      assert.equal(deny.includes("read"), false);

      // (b) Identity + registry: the exact id the stock runtime minted.
      assert.equal(rig.host.owns(CHILD_ID), true);
      assert.equal(rig.host.workerIdOf(CHILD_ID), CHILD_ID);
      const record = rig.multitask.getWorker(CHILD_ID);
      assert.ok(record !== undefined);
      assert.equal(record.status, "spawned");
      assert.equal(record.title, STOCK_LABEL);
      assert.ok(record.todoId !== null);

      // (b) Roster + linked ledger item, titled from subagent.label.
      const roster = rig.multitask.listWorkers(PARENT_ID);
      assert.equal(roster.length, 1);
      assert.equal(roster[0]?.workerId, CHILD_ID);
      assert.equal(roster[0]?.todoId, record.todoId);
      const todos = rig.multitask.listTodos(PARENT_ID);
      assert.equal(todos.length, 1);
      assert.equal(todos[0]?.title, STOCK_LABEL);
      assert.equal(todos[0]?.status, "pending");
      assert.equal(todos[0]?.workerId, CHILD_ID);

      // (b) The spawn path's durable rows exist, keyed by the child id.
      assert.equal(rig.durability.markers.get(CHILD_ID)?.status, "spawned");
      assert.equal(rig.durability.markers.get(CHILD_ID)?.title, STOCK_LABEL);
      assert.equal(
        rig.durability.workerSessions.get(CHILD_ID)?.parentSessionId,
        PARENT_ID,
      );

      // Adoption is idempotent: a repeated announcement never duplicates.
      assert.equal(
        rig.multitask.adoptSpawnedWorker({ workerId: CHILD_ID, parentSessionId: PARENT_ID }),
        false,
      );
      assert.equal(rig.multitask.listTodos(PARENT_ID).length, 1);

      // (c) The REAL lifecycle listener accepts the status edge.
      rig.ctx.fire("agent/status", { agent: rig.child, status: "running" });
      assert.equal(rig.multitask.getWorker(CHILD_ID)?.status, "running");
      assert.equal(rig.multitask.listTodos(PARENT_ID)[0]?.status, "in_progress");

      // (d) The ownership gate accepts the settle and the one settle path runs.
      rig.ctx.fire("subagent/end", {
        id: CHILD_ID,
        stopReason: "completed",
        lastAssistantMessage: [{ type: "text", text: "Audited the widget." }],
      });
      assert.equal(rig.settled.length, 1);
      assert.equal(rig.settled[0]?.workerId, CHILD_ID);
      assert.equal(rig.settled[0]?.status, "completed");
      assert.match(rig.settled[0]?.report ?? "", /Audited the widget\./);
      assert.equal(rig.multitask.getWorker(CHILD_ID)?.status, "completed");
      // completed means DELIVERED, not merely exited: the obligation stays open.
      assert.equal(rig.multitask.listTodos(PARENT_ID)[0]?.status, "in_progress");
      assert.equal(rig.multitask.listTodos(PARENT_ID)[0]?.delivered, false);
      assert.equal(rig.multitask.listWorkers(PARENT_ID)[0]?.status, "completed");
      // Terminal marker kept for delivery; wake identity dropped; live entry pruned.
      assert.equal(rig.durability.markers.get(CHILD_ID)?.status, "completed");
      assert.equal(rig.durability.workerSessions.has(CHILD_ID), false);
      assert.equal(rig.host.owns(CHILD_ID), false);
    } finally {
      rig.dispose();
    }
  });

  it("closes an aborted stock worker's todo and its durable obligation", () => {
    const rig = createRig();
    try {
      announce(rig);
      assert.ok(rig.multitask.getWorker(CHILD_ID) !== undefined);

      rig.ctx.fire("subagent/end", {
        id: CHILD_ID,
        stopReason: "aborted",
      });

      assert.equal(rig.settled.length, 1);
      assert.equal(rig.settled[0]?.status, "aborted");
      assert.equal(rig.multitask.getWorker(CHILD_ID)?.status, "aborted");
      // A cancelled item is closed and pruned (dsh has no cancelled status).
      assert.equal(rig.multitask.listTodos(PARENT_ID).length, 0);
      assert.equal(rig.durability.markers.has(CHILD_ID), false);
      assert.equal(rig.durability.workerSessions.has(CHILD_ID), false);
    } finally {
      rig.dispose();
    }
  });

  it("keeps settle ownership after the child agent was disposed", () => {
    const rig = createRig();
    try {
      announce(rig);
      rig.ctx.fire("agent/disposed", { agent: rig.child });
      // The live registry entry is pruned, but the in-process ownership proof
      // (spawnedWorkerIds) still accepts the terminal event.
      assert.equal(rig.host.owns(CHILD_ID), false);
      rig.ctx.fire("subagent/end", {
        id: CHILD_ID,
        stopReason: "completed",
        lastAssistantMessage: [{ type: "text", text: "done before dispose" }],
      });
      assert.equal(rig.settled.length, 1);
      assert.equal(rig.multitask.getWorker(CHILD_ID)?.status, "completed");
    } finally {
      rig.dispose();
    }
  });

  it("falls back to a short-id title when the subagent label is unreadable", () => {
    const rig = createRig();
    try {
      const workerId = "abcdef12-3456-7890-abcd-ef1234567890";
      assert.equal(
        rig.multitask.adoptSpawnedWorker({
          workerId,
          parentSessionId: PARENT_ID,
          label: null,
        }),
        true,
      );
      assert.equal(rig.multitask.getWorker(workerId)?.title, "Worker abcdef12");
      assert.equal(rig.multitask.listTodos(PARENT_ID)[0]?.title, "Worker abcdef12");
    } finally {
      rig.dispose();
    }
  });

  it("never adopts a child of an unbound session or a non-subagent child", () => {
    const rig = createRig();
    try {
      const outsider = {
        session: {
          id: "outside-child",
          header: { parentSession: "not-ours", delegationDepth: 1, origin: "subagent" },
        },
        ctx: createChildScope({
          sections: [],
          restrictions: [],
          localTools: [],
        }),
        followup() {},
      };
      rig.ctx.fire("agent/created", { agent: outsider, source: "startup" });
      assert.equal(rig.host.owns("outside-child"), false);

      const notSubagent = {
        session: {
          id: "headerless-child",
          header: { parentSession: PARENT_ID, delegationDepth: 1 },
        },
        ctx: createChildScope({
          sections: [],
          restrictions: [],
          localTools: [],
        }),
        followup() {},
      };
      rig.ctx.fire("agent/created", { agent: notSubagent, source: "startup" });
      assert.equal(rig.host.owns("headerless-child"), false);
      assert.equal(rig.multitask.listWorkers(PARENT_ID).length, 0);
      assert.equal(rig.multitask.listTodos(PARENT_ID).length, 0);
    } finally {
      rig.dispose();
    }
  });
});
