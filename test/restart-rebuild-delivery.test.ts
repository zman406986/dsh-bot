/**
 * Restart rebuild — durable delivery state (auto-continue fix, design note
 * Decision 2; red-test plan file 2). PURE CORE, S8 offline.
 *
 * rebuildFromDurability's terminal branch must restore what the marker
 * durably says about delivery instead of resurrecting every settled row as
 * an owed in_progress obligation:
 *   delivered:true                  -> completed/delivered (acked tombstone)
 *   delivered absent (legacy row)   -> completed/delivered (grandfathered)
 *   delivered:false, attempts >= MAX -> lost ("max-redrives")
 *   delivered:false, under budget   -> owed (in_progress/delivered:false),
 *                                      but never auto-woken by the rebuild.
 *
 * Fixture per the note: createInMemoryDurability seeded with terminal
 * markers, held across a fresh createMultitask instance = simulated restart.
 * FakeDshHost records wake requests; no plugin import, no network/LLM.
 *
 * `delivered` is the design's NEW optional marker field. Seeding it through
 * a widened local row type keeps this file compiling against today's
 * DurableWorkerMarker (which has no such field and ignores it at rebuild —
 * hence red on the assertions below, not on types).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInMemoryDurability,
  type DurableWorkerMarker,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { MAX_DELIVERY_REDRIVES } from "../src/core/todo-reconciler.js";

const SESSION = "dispatcher-restart";

/** Marker row as the fix defines it: optional durable delivery ack. */
type SeededMarker = DurableWorkerMarker & { readonly delivered?: boolean };

interface Seed {
  readonly workerId: string;
  readonly todoId: string;
  readonly redriveAttempts: number;
  /** Omitted = legacy pre-fix row (the grandfather discriminator). */
  readonly delivered?: boolean;
}

/** The four terminal rows the design note's red-test plan prescribes. */
const FOUR_ROWS: readonly Seed[] = [
  { workerId: "w-acked", todoId: "todo-acked", redriveAttempts: 0, delivered: true },
  { workerId: "w-owed", todoId: "todo-owed", redriveAttempts: 0, delivered: false },
  { workerId: "w-legacy", todoId: "todo-legacy", redriveAttempts: 1 },
  {
    workerId: "w-exhausted",
    todoId: "todo-exhausted",
    redriveAttempts: MAX_DELIVERY_REDRIVES,
    delivered: false,
  },
];

function seedTerminalMarkers(
  durability: InMemoryDurability,
  seeds: readonly Seed[],
): void {
  const now = Date.now();
  for (const seed of seeds) {
    const base: DurableWorkerMarker = {
      workerId: seed.workerId,
      parentSessionId: SESSION,
      streamKey: seed.todoId,
      title: `work ${seed.todoId}`,
      status: "completed",
      transcriptRef: `child-${seed.workerId}`,
      todoId: seed.todoId,
      redriveAttempts: seed.redriveAttempts,
      startedAtMs: now - 60_000,
      updatedAtMs: now,
    };
    const marker: SeededMarker =
      seed.delivered === undefined
        ? base
        : { ...base, delivered: seed.delivered };
    durability.writeWorkerMarker(marker);
  }
}

/** Fresh core over the surviving store = the process after a restart. */
function freshCore(durability: InMemoryDurability): {
  host: FakeDshHost;
  core: Multitask;
} {
  const host = new FakeDshHost();
  const core = createMultitask(host, { durability });
  return { host, core };
}

function ledgerProjection(core: Multitask) {
  return core
    .listTodos(SESSION)
    .map((todo) => ({ id: todo.id, status: todo.status, delivered: todo.delivered }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe("restart rebuild — durable delivery state (Decision 2)", () => {
  it("acked and legacy rows restore completed/delivered, exhausted restores lost, only owed stays owed", async () => {
    const durability = createInMemoryDurability();
    seedTerminalMarkers(durability, FOUR_ROWS);
    const { core } = freshCore(durability);

    await core.rebuildFromDurability(SESSION);

    // Today all four resurrect as in_progress/delivered=false — the defect.
    assert.deepEqual(ledgerProjection(core), [
      { id: "todo-acked", status: "completed", delivered: true },
      { id: "todo-exhausted", status: "lost", delivered: false },
      { id: "todo-legacy", status: "completed", delivered: true },
      { id: "todo-owed", status: "in_progress", delivered: false },
    ]);
    const exhausted = core
      .listTodos(SESSION)
      .find((todo) => todo.id === "todo-exhausted");
    assert.equal(exhausted?.dispositionReason, "max-redrives");
  });

  it("only the under-budget owed item is landed-undelivered and chargeable", async () => {
    const durability = createInMemoryDurability();
    seedTerminalMarkers(durability, FOUR_ROWS);
    const { core } = freshCore(durability);
    await core.rebuildFromDurability(SESSION);

    // A redrive-turn wake is the turn an already-spent attempt paid for
    // (ticket 197): reconcile reports landed-undelivered without charging,
    // so this is a side-effect-free view of the obligation.
    const view = core.reconcileTodos(SESSION, {
      sessionId: SESSION,
      source: "timer",
      settledWorkers: [],
      deliveryRedrive: true,
    });
    assert.deepEqual(
      view.landedUndelivered.map((todo) => todo.id),
      ["todo-owed"],
    );

    // The explicit turn-end pass (a REAL turn just ended) may charge and wake.
    const report = core.redriveUndelivered(SESSION);
    assert.deepEqual(
      report.redriven.map((todo) => todo.id),
      ["todo-owed"],
    );
    assert.deepEqual(
      report.lost.map((todo) => todo.id),
      [],
    );
  });

  it("control: every terminal row still restores (#300) and rebuild touches no marker bytes", async () => {
    const durability = createInMemoryDurability();
    seedTerminalMarkers(durability, FOUR_ROWS);
    const before = structuredClone([...durability.markers.entries()]);
    const { core } = freshCore(durability);

    const report = await core.rebuildFromDurability(SESSION);

    assert.deepEqual(
      report.restored.map((record) => record.workerId).sort(),
      ["w-acked", "w-exhausted", "w-legacy", "w-owed"],
    );
    assert.equal(report.unknownState.length, 0);
    // Code-only amnesty: grandfathering and lost derive from the row as
    // written; the rebuild performs no marker writes or deletes.
    assert.deepEqual([...durability.markers.entries()], before);
  });

  it("control: rebuild opens no wake; the owed item wakes only on the explicit turn-end pass", async () => {
    const durability = createInMemoryDurability();
    seedTerminalMarkers(durability, FOUR_ROWS);
    const { host, core } = freshCore(durability);

    await core.rebuildFromDurability(SESSION);

    // Mere rebuild/activation must not open a turn (Decision 3's core half).
    assert.equal(core.wakeBus.peek(SESSION), undefined);
    assert.equal(core.wakeBus.peekPending(SESSION), undefined);
    assert.equal(core.drainWake(SESSION), undefined);
    assert.deepEqual(host.wakeCalls, []);

    // A real turn-end redrive is the legitimate bounded continuation.
    const report = core.redriveUndelivered(SESSION);
    assert.ok(report.redriven.length > 0);
    assert.equal(core.wakeBus.peek(SESSION)?.deliveryRedrive, true);
    assert.deepEqual(host.wakeCalls, [SESSION]);
  });
});
