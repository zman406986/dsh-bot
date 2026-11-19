import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryDurability } from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import {
  MAX_DELIVERY_REDRIVES,
  type TodoItem,
} from "../src/core/todo-reconciler.js";

/**
 * Turn-end redrive — the delivery budget must be a DURABLE lifetime bound
 * (auto-continue fix, Decision 4 core half; design note red-test plan file 4).
 *
 * The defect: drainWake (multitask.ts:2315-2322) charges a missed delivery in
 * the ledger but never mirrors the attempt onto the durable marker, while
 * redriveUndelivered's attempt mirror (:2362-2377) does. A charge spent on a
 * drained wake therefore evaporates at the next restart (the observed
 * 694-markers-stuck-at-1 leak), and cancelTurn clearing the in-memory
 * pendingRedrive flag makes the loss permanent.
 *
 * Desired behavior is asserted through EXISTING public seams only — the
 * observable outcome (charges survive a fresh-core rebuild), never an import
 * of the not-yet-existing persistRedriveCharges. S8 offline: FakeDshHost +
 * createInMemoryDurability held across fresh createMultitask instances.
 *
 * Also pins review RC3: the LIVE auto-redrive chain terminates WITHOUT any
 * restart. wakeBus.isBusy is origin-blind (user, host-notice and auto-redrive
 * running edges alike set busy), so the perpetuity bound is the DURABLE
 * redrive budget, not a user-vs-auto gate.
 */

const SESSION = "s-turn-end";

/** Spawn a linked worker, take its running edge, settle it undelivered. */
async function spawnSettled(
  core: Multitask,
  host: FakeDshHost,
): Promise<string> {
  core.createTodo({ sessionId: SESSION, id: "todo-1", title: "Research" });
  const spawned = await core.spawnWorker({
    parentSessionId: SESSION,
    streamKey: "stream-1",
    title: "Research",
    prompt: "go",
    todoId: "todo-1",
  });
  assert.equal(spawned.ok, true);
  assert.ok(spawned.ok);
  core.noteTurnStarted(spawned.workerId);
  host.fireSettled({
    workerId: spawned.workerId,
    status: "completed",
    report: "done",
  });
  return spawned.workerId;
}

function todoOf(core: Multitask): TodoItem {
  const todo = core.todos.get("todo-1");
  assert.ok(todo, "todo-1 should exist");
  return todo;
}

describe("turn-end redrive — durable lifetime budget across drains/cancels/restarts", () => {
  it("a drain-path charge survives cancelTurn + rebuild, exhausts to lost, and stays lost across a further restart", async () => {
    const durability = createInMemoryDurability();

    // Process 1: settle undelivered, then a real user turn drains its wake.
    // enqueueUserWake models the host-opened user turn (the bus seam existing
    // restart tests use); the drain is that turn's end-of-turn accounting.
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const workerId = await spawnSettled(coreA, hostA);
    assert.equal(durability.markers.get(workerId)?.redriveAttempts, 0);

    coreA.wakeBus.enqueueUserWake(SESSION);
    const drained = coreA.drainWake(SESSION);
    assert.ok(drained, "the user wake is ready to drain");
    assert.equal(drained.wake.source, "user");
    // Control (green today): the drain charges the missed delivery in memory.
    assert.equal(drained.reconcile.toRedrive.length, 1);
    assert.equal(todoOf(coreA).redriveAttempts, 1);

    // RED today: the drain-path charge is never mirrored, so the marker still
    // reads 0 and the spent attempt evaporates at the next restart.
    assert.equal(
      durability.markers.get(workerId)?.redriveAttempts,
      1,
      "the drain-path charge is durable immediately",
    );

    // The turn is cancelled: cancelTurn clears busy + pendingRedrive. The
    // durable charge must survive it — obligations re-derive from markers.
    coreA.wakeBus.noteTurnStarted(SESSION);
    coreA.wakeBus.cancelTurn(SESSION);
    assert.equal(coreA.wakeBus.isBusy(SESSION), false);

    // Process 2: fresh core rebuilt from markers only (simulated restart).
    const hostB = new FakeDshHost();
    const coreB = createMultitask(hostB, { durability });
    const rebuildB = await coreB.rebuildFromDurability(SESSION);
    assert.equal(rebuildB.restored.length, 1);
    // RED today: the restart hands the obligation a fresh budget (0, not 1).
    assert.equal(
      todoOf(coreB).redriveAttempts,
      1,
      "cancel + restart keep the spent attempt",
    );

    // The next real turn end redrives: charge 2 (the bound) + exactly one wake.
    const wakesB = hostB.wakeCalls.length;
    const second = coreB.redriveUndelivered(SESSION);
    assert.equal(second.redriven.length, 1);
    assert.equal(second.lost.length, 0);
    // RED today: the reset budget charges to 1, not to the bound.
    assert.equal(todoOf(coreB).redriveAttempts, MAX_DELIVERY_REDRIVES);
    assert.equal(
      durability.markers.get(workerId)?.redriveAttempts,
      MAX_DELIVERY_REDRIVES,
    );
    assert.equal(hostB.wakeCalls.length, wakesB + 1, "the redrive opens one turn");

    // #197 kept (control, green today): draining the paid redrive wake is that
    // attempt's delivery opportunity, not a fresh miss — no second charge.
    const paid = todoOf(coreB).redriveAttempts;
    const paidDrain = coreB.drainWake(SESSION);
    assert.ok(paidDrain);
    assert.equal(paidDrain.wake.deliveryRedrive, true);
    assert.equal(paidDrain.reconcile.toRedrive.length, 0);
    assert.equal(todoOf(coreB).redriveAttempts, paid);
    assert.equal(durability.markers.get(workerId)?.redriveAttempts, paid);

    // The following pass finds the budget exhausted: lost, and NO wake.
    // RED today: the reset budget still has an attempt left, so this pass
    // redrives again and opens another turn instead of escalating.
    const beforeLoss = hostB.wakeCalls.length;
    const final = coreB.redriveUndelivered(SESSION);
    assert.equal(final.redriven.length, 0, "past the bound there is no retry");
    assert.equal(final.lost.length, 1);
    assert.equal(todoOf(coreB).status, "lost");
    assert.equal(todoOf(coreB).dispositionReason, "max-redrives");
    assert.equal(hostB.wakeCalls.length, beforeLoss, "a pure loss opens no turn");

    // Process 3: exhaustion itself survives the restart — the rebuilt core
    // restores the item as lost (derived from the durable attempts), and the
    // next pass neither re-charges nor silently re-escalates it.
    const hostC = new FakeDshHost();
    const coreC = createMultitask(hostC, { durability });
    await coreC.rebuildFromDurability(SESSION);
    // RED today: rebuild restores in_progress and the pass below re-escalates.
    assert.equal(todoOf(coreC).status, "lost", "exhaustion survives the rebuild");
    assert.equal(todoOf(coreC).redriveAttempts, MAX_DELIVERY_REDRIVES);
    const markerBefore = durability.markers.get(workerId);
    assert.ok(markerBefore);
    const wakesC = hostC.wakeCalls.length;
    const after = coreC.redriveUndelivered(SESSION);
    assert.deepEqual(after.redriven, []);
    assert.deepEqual(after.lost, [], "no silent re-escalation after restart");
    assert.equal(hostC.wakeCalls.length, wakesC, "no wake");
    assert.equal(todoOf(coreC).redriveAttempts, MAX_DELIVERY_REDRIVES, "no re-charge");
    assert.equal(
      durability.markers.get(workerId)?.updatedAtMs,
      markerBefore.updatedAtMs,
      "no marker rewrite",
    );
  });

  it("the LIVE auto-redrive chain terminates without restart: repeated turn-end drains exhaust the durable budget to lost, and lost stays lost", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    const workerId = await spawnSettled(core, host);

    // ONE core, ONE process — no rebuild anywhere below. Each iteration is
    // one auto-redrive turn of the live loop (the observed 390/392-auto-turn
    // shape): the turn-end pass charges one attempt and opens the next turn;
    // that turn drains its paid wake (#197: the drain is the attempt's
    // delivery opportunity, not a fresh miss). Nothing distinguishes these
    // auto turns from user turns at the isBusy gate — the durable budget is
    // the only bound.
    for (let attempt = 1; attempt <= MAX_DELIVERY_REDRIVES; attempt += 1) {
      const wakesBefore = host.wakeCalls.length;
      const report = core.redriveUndelivered(SESSION);
      assert.equal(report.redriven.length, 1, `auto turn ${attempt} is inside the bound`);
      assert.equal(report.lost.length, 0);
      assert.equal(todoOf(core).redriveAttempts, attempt);
      assert.equal(
        durability.markers.get(workerId)?.redriveAttempts,
        attempt,
        "every live charge is durable immediately — no restart needed to persist it",
      );
      assert.equal(host.wakeCalls.length, wakesBefore + 1, "the pass opens exactly one turn");

      const drained = core.drainWake(SESSION);
      assert.ok(drained, "the opened auto turn drains its paid wake");
      assert.equal(drained.wake.deliveryRedrive, true);
      assert.equal(drained.reconcile.toRedrive.length, 0, "#197: no second charge on the paid drain");
      assert.equal(todoOf(core).redriveAttempts, attempt);
    }

    // The next turn-end pass finds the durable budget exhausted: lost is
    // terminal, and a pure escalation opens NO further wake — the live chain
    // ends here, without any restart.
    const wakesAtLoss = host.wakeCalls.length;
    const final = core.redriveUndelivered(SESSION);
    assert.equal(final.redriven.length, 0, "past the bound there is no retry");
    assert.equal(final.lost.length, 1);
    assert.equal(todoOf(core).status, "lost");
    assert.equal(todoOf(core).delivered, false, "lost is NOT delivered");
    assert.equal(todoOf(core).dispositionReason, "max-redrives");
    assert.equal(host.wakeCalls.length, wakesAtLoss, "the loss opens no turn");
    assert.equal(core.drainWake(SESSION), undefined, "no wake is left to open another turn");

    // lost stays lost: further turn-end passes (the reconciler charge loop)
    // skip the terminal row — no re-charge, no re-escalation, no wake, and
    // the durable marker is not rewritten.
    const markerAtLoss = durability.markers.get(workerId);
    assert.ok(markerAtLoss);
    assert.equal(markerAtLoss.redriveAttempts, MAX_DELIVERY_REDRIVES);
    assert.equal(markerAtLoss.delivered, false, "a lost row is not an ack tombstone");
    for (let pass = 0; pass < 3; pass += 1) {
      const again = core.redriveUndelivered(SESSION);
      assert.deepEqual(again.redriven, []);
      assert.deepEqual(again.lost, [], "no silent re-escalation of a lost row");
      const reconcile = core.reconcileTodos(SESSION);
      assert.equal(reconcile.toRedrive.length, 0, "the reconciler charge loop skips lost");
      assert.equal(reconcile.lost.length, 0);
      assert.equal(todoOf(core).status, "lost");
      assert.equal(todoOf(core).redriveAttempts, MAX_DELIVERY_REDRIVES);
    }
    assert.equal(host.wakeCalls.length, wakesAtLoss, "no further redrive wake ever fires");
    assert.equal(
      durability.markers.get(workerId)?.updatedAtMs,
      markerAtLoss.updatedAtMs,
      "no marker rewrite after the loss",
    );
  });

  it("control: the redrive pass's own mirror stays durable (the behavior the drain path must join)", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    const workerId = await spawnSettled(core, host);

    const wakes = host.wakeCalls.length;
    const report = core.redriveUndelivered(SESSION);

    assert.equal(report.redriven.length, 1);
    assert.equal(todoOf(core).redriveAttempts, 1);
    assert.equal(
      durability.markers.get(workerId)?.redriveAttempts,
      1,
      "the redrive mirror persists its charge (existing behavior preserved)",
    );
    assert.equal(host.wakeCalls.length, wakes + 1);
  });

  it("control: #197 kept — draining the paid redrive wake spends no second attempt", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    const workerId = await spawnSettled(core, host);
    assert.equal(core.redriveUndelivered(SESSION).redriven.length, 1);

    const drained = core.drainWake(SESSION);

    assert.ok(drained);
    assert.equal(drained.wake.deliveryRedrive, true);
    assert.equal(drained.reconcile.toRedrive.length, 0);
    assert.equal(todoOf(core).redriveAttempts, 1);
    assert.equal(durability.markers.get(workerId)?.redriveAttempts, 1);
  });
});
