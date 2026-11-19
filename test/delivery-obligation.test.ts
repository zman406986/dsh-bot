import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import { formatLedgerLine } from "../src/core/policy/assembler.js";
import { emptyReportPlaceholder } from "../src/core/report-clamp.js";
import {
  MAX_DELIVERY_REDRIVES,
  reconcileTodos,
  type TodoItem,
} from "../src/core/todo-reconciler.js";
import type { WakeEvent } from "../src/core/wake-bus.js";

// Portable host discovery (copied from test/stock-worker-model-default.test.ts:22-77):
// src/plugin.ts statically imports @deepseek-ai/dsh-scope, which is not a repo
// dependency — resolve it from the installed host. DSH_HOST_DIR overrides;
// otherwise repo-local module resolution, then the global npm root. When no
// usable host is found every suite skips with a reason and the process exits 0.
const requireFromTest = createRequire(import.meta.url);

/** The installed @deepseek-ai/dsh package directory, or undefined. */
function findHostDir(): string | undefined {
  const override = process.env.DSH_HOST_DIR;
  if (override !== undefined && override !== "") {
    const dir = resolve(override);
    return existsSync(join(dir, "package.json")) ? dir : undefined;
  }
  try {
    return dirname(requireFromTest.resolve("@deepseek-ai/dsh/package.json"));
  } catch { /* not installed repo-locally; fall through to the global npm root */ }
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot === "") return undefined;
    const requireFromGlobal = createRequire(join(globalRoot, "dsh-host-probe.js"));
    return dirname(requireFromGlobal.resolve("@deepseek-ai/dsh/package.json"));
  } catch { return undefined; }
}

const hostDir = findHostDir();
let skip: string | false = hostDir !== undefined ? false
  : process.env.DSH_HOST_DIR
    ? `DSH_HOST_DIR (${process.env.DSH_HOST_DIR}) does not point at an installed dsh host`
    : "no installed dsh host found (repo-local module resolution or global npm root); set DSH_HOST_DIR to the @deepseek-ai/dsh package directory";

let composeWakeText: typeof import("../src/plugin.js").composeWakeText;
if (hostDir !== undefined) {
  try {
    const hostRequire = createRequire(join(hostDir, "package.json"));
    const scopeUrl = pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-scope")).href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== "@deepseek-ai/dsh-scope") return nextResolve(specifier, context);
        return { url: scopeUrl, shortCircuit: true };
      },
    });
    ({ composeWakeText } = await import("../src/plugin.js"));
  } catch (error) {
    skip = `dsh host at ${hostDir} is not usable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Ticket 58 — the delivery-obligation layer (register deviations D-5, D-6).
 *
 * The defect this suite exists for: an `in_progress && !delivered` item whose
 * worker had settled persisted forever, was never escalated, and was never
 * reported as stuck. Every test here asserts a *bounded* outcome — redriven or
 * `lost` — plus the telemetry that makes either one explicable.
 */

const SESSION = "s-1";

function emptyWake(sessionId = SESSION): WakeEvent {
  return {
    sessionId,
    source: "timer",
    settledWorkers: [],
  };
}

/** Create a todo and spawn a worker linked to it in one step. */
async function spawnForTodo(
  multitask: Multitask,
  host: FakeDshHost,
  todoId = "todo-1",
  streamKey = "stream-1",
): Promise<string> {
  multitask.createTodo({ sessionId: SESSION, id: todoId, title: "Research" });
  const result = await multitask.spawnWorker({
    parentSessionId: SESSION,
    streamKey,
    title: "Research",
    prompt: "go",
    todoId,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  // Model the host's running edge: a worker that settles has taken a turn, so
  // its linked todo is already in_progress when the terminal event lands.
  multitask.noteTurnStarted(result.workerId);
  return result.workerId;
}

/** Take the item from settle to "still undelivered after its first chance". */
function settleUndelivered(
  host: FakeDshHost,
  workerId: string,
  report = "done",
): void {
  host.fireSettled({ workerId, status: "completed", report });
}

function todoOf(multitask: Multitask, todoId = "todo-1"): TodoItem {
  const todo = multitask.todos.get(todoId);
  assert.ok(todo, `todo ${todoId} should exist`);
  return todo;
}

describe("delivery obligation — no plugin settle wake; the first turn end is the first chance (D-5)", { skip }, () => {
  it("a settle opens no plugin wake and spends no attempt until the first turn end", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);

    settleUndelivered(host, workerId);
    // The stock completion notice is the parent-visible turn now; the plugin
    // opens no wake of its own for a settle, and the ledger is untouched
    // until the accounting point at the end of that turn.
    assert.equal(
      multitask.drainWake(SESSION),
      undefined,
      "the settle enqueues no plugin wake",
    );
    assert.equal(composeWakeText(multitask, SESSION), null, "nothing to present");
    assert.equal(todoOf(multitask).redriveAttempts, 0);

    // The end of that first turn is the first opportunity the plugin can see.
    // Failing to deliver there costs exactly one attempt — the previously
    // uncharged settle-wake chance has moved to the stock-notice turn.
    const report = multitask.redriveUndelivered(SESSION);
    assert.equal(report.redriven.length, 1);
    assert.equal(report.lost.length, 0);
    assert.equal(todoOf(multitask).redriveAttempts, 1);
    assert.equal(todoOf(multitask).status, "in_progress");
    assert.equal(todoOf(multitask).delivered, false);
  });
});

describe("delivery obligation — bounded redrive opens a turn (D-5)", { skip }, () => {
  it("a missed delivery costs one attempt and wakes the dispatcher", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    // The settle opens no plugin wake; the first turn end is the accounting
    // point and must charge the miss.
    const wakesBefore = host.wakeCalls.length;
    const report = multitask.redriveUndelivered(SESSION);

    assert.equal(report.redriven.length, 1);
    assert.equal(report.lost.length, 0);
    assert.equal(todoOf(multitask).redriveAttempts, 1);
    // The delivery mechanism must be the waking primitive: queueing context
    // would repeat D-4, where the notice waited for a user who never spoke.
    assert.equal(
      host.wakeCalls.length,
      wakesBefore + 1,
      "the redrive opens a turn",
    );
    assert.equal(host.wakeCalls.at(-1), SESSION);
  });

  it("is a cheap no-op when nothing is owed", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);
    multitask.markDelivered("todo-1");

    const wakesBefore = host.wakeCalls.length;
    const report = multitask.redriveUndelivered(SESSION);

    assert.deepEqual(report.redriven, []);
    assert.deepEqual(report.lost, []);
    assert.equal(
      host.wakeCalls.length,
      wakesBefore,
      "a delivered result is never redriven",
    );
    // And a delivered item is not silently re-opened by the pass either.
    assert.equal(todoOf(multitask).status, "completed");
  });
});

describe("delivery obligation — the bound is terminal (D-5)", { skip }, () => {
  it("exhausting the budget escalates to `lost`, which is NOT `completed`", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);

    // Spend the budget. Each pass that still finds the result undelivered
    // costs one attempt; the pass that finds the budget exhausted escalates.
    // The wake each pass opens is drained first: an undrained redrive turn is
    // the opportunity its already-spent attempt paid for, so a second pass
    // before delivery must not charge it again (peekPending).
    for (let attempt = 1; attempt <= MAX_DELIVERY_REDRIVES; attempt += 1) {
      const report = multitask.redriveUndelivered(SESSION);
      assert.equal(report.lost.length, 0, `attempt ${attempt} is inside the bound`);
      assert.equal(todoOf(multitask).redriveAttempts, attempt);
      assert.ok(multitask.drainWake(SESSION), `attempt ${attempt} opens a turn`);
      assert.equal(
        todoOf(multitask).redriveAttempts,
        attempt,
        "draining the paid turn spends no extra attempt",
      );
    }

    const wakesBefore = host.wakeCalls.length;
    const final = multitask.redriveUndelivered(SESSION);
    const todo = todoOf(multitask);

    assert.equal(final.redriven.length, 0, "past the bound there is no retry");
    assert.equal(final.lost.length, 1);
    assert.equal(todo.status, "lost");
    assert.equal(todo.delivered, false, "lost is NOT delivered");
    assert.equal(todo.disposition, "dropped");
    assert.equal(todo.dispositionReason, "max-redrives");
    // Deliberate: a pure escalation does not open another turn. The
    // dispatcher has already been given every attempt the bound allows, and
    // the loss rides the next turn's ledger line instead.
    assert.equal(host.wakeCalls.length, wakesBefore, "no wake for a pure loss");

    // Reportable, and distinguishable from a completed item on the reminder.
    const line = formatLedgerLine(todo);
    assert.ok(line.includes("lost"), line);
    assert.ok(line.includes("max-redrives"), line);
  });

  it("records a dropped disposition event so the loss is explicable", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { maxRedrives: 0 });
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);

    const report = multitask.redriveUndelivered(SESSION);
    assert.equal(report.lost.length, 1, "maxRedrives 0 escalates immediately");

    const events = multitask.todos.listDeliveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "dropped");
    assert.equal(events[0]?.reason, "max-redrives");
    assert.equal(events[0]?.todoId, "todo-1");
  });

  it("a `lost` item is retired after retention — escalation must not just replace one unbounded row with another", () => {
    const todos = [
      {
        id: "gone",
        sessionId: SESSION,
        title: "Lost work",
        status: "lost" as const,
        streamKey: "k",
        workerId: "w1",
        delivered: false,
        redriveAttempts: MAX_DELIVERY_REDRIVES,
        disposition: "dropped" as const,
        dispositionReason: "max-redrives" as const,
        external: null,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ];
    const report = reconcileTodos({
      wake: emptyWake(),
      todos,
      workers: [],
      nowMs: 100_000,
      completedRetentionMs: 1,
    });

    assert.deepEqual(
      report.mutations.map((mutation) => mutation.type),
      ["prune"],
    );
    assert.equal(
      report.mutations[0]?.type === "prune" && report.mutations[0].reason,
      "lost-retention",
    );
  });
});

describe("delivery obligation — the budget is a lifetime one (D-5)", { skip }, () => {
  it("attempts persist on the marker and survive a restart", async () => {
    const durability: InMemoryDurability = createInMemoryDurability();

    // Process 1: spawn, settle undelivered, spend one attempt, then crash.
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const workerId = await spawnForTodo(coreA, hostA);
    settleUndelivered(hostA, workerId);
    assert.equal(coreA.redriveUndelivered(SESSION).redriven.length, 1);

    const marker = durability.markers.get(workerId);
    assert.ok(marker);
    assert.equal(marker.redriveAttempts, 1, "the spent budget is durable");

    // Process 2: a fresh core rebuilt from markers only (ADR-0006).
    const hostB = new FakeDshHost();
    const coreB = createMultitask(hostB, { durability });
    const rebuild = await coreB.rebuildFromDurability(SESSION);
    assert.equal(rebuild.restored.length, 1);
    assert.equal(
      todoOf(coreB).redriveAttempts,
      1,
      "the restart continues the same budget instead of restarting it",
    );

    // And the next attempt continues the count rather than resetting it.
    coreB.redriveUndelivered(SESSION);
    assert.equal(todoOf(coreB).redriveAttempts, 2);
  });

  it("activation rebuilds a restored undelivered result WITHOUT opening a turn; the next turn-end redrive charges it", async () => {
    const durability = createInMemoryDurability();

    // A result that settled before the crash and was never delivered.
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const workerId = await spawnForTodo(coreA, hostA);
    settleUndelivered(hostA, workerId);

    // Activation (auto-continue fix Decision 3, owner ruling 2026-11-19):
    // rebuild from markers ONLY — the plugin no longer follows it with
    // redriveUndelivered. Mere open/resume must not fire a model turn with no
    // user message; the owed obligation waits for the next real turn.
    const hostB = new FakeDshHost();
    const coreB = createMultitask(hostB, { durability });
    await coreB.rebuildFromDurability(SESSION);

    assert.equal(hostB.wakeCalls.length, 0, "rebuild alone opens no turn");
    assert.equal(todoOf(coreB).status, "in_progress");
    assert.equal(todoOf(coreB).delivered, false, "the owed obligation survives");
    assert.equal(todoOf(coreB).redriveAttempts, 0);

    // The next REAL turn's end-of-turn redrive pass (parent-agent's isBusy
    // gate) is the first charge: one attempt, one wake — bounded continuation
    // of an active conversation, never a turn conjured by open/resume.
    const report = coreB.redriveUndelivered(SESSION);
    assert.equal(report.redriven.length, 1);
    assert.equal(hostB.wakeCalls.length, 1, "the turn-end redrive opens the turn");
    assert.equal(todoOf(coreB).redriveAttempts, 1);
  });

  it("a pre-fix legacy marker reads as zero attempts and is grandfathered as delivered (Decision 2 amnesty)", async () => {
    const durability = createInMemoryDurability();
    durability.markers.set("w-legacy", {
      workerId: "w-legacy",
      parentSessionId: SESSION,
      streamKey: "legacy-key",
      title: "Half-written record",
      status: "completed",
      transcriptRef: "w-legacy",
      todoId: "todo-legacy",
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
      // no redriveAttempts — pre-ticket-58 shape; no delivered — pre-fix shape
    });

    const host = new FakeDshHost();
    const core = createMultitask(host, { durability });
    await core.rebuildFromDurability(SESSION);

    assert.equal(
      todoOf(core, "todo-legacy").redriveAttempts,
      0,
      "an absent field is not an error and not an unlimited budget",
    );
    // Legacy amnesty (auto-continue fix Decision 2): a pre-fix terminal row
    // has no `delivered` field; rebuild grandfathers it as presented —
    // completed/delivered, no obligation, no redrive, no wake. Deliberate:
    // the unbounded re-presentation of ~1933 legacy rows IS the defect.
    assert.equal(todoOf(core, "todo-legacy").status, "completed");
    assert.equal(todoOf(core, "todo-legacy").delivered, true);
    const report = core.redriveUndelivered(SESSION);
    assert.deepEqual(report.redriven, [], "a grandfathered row is never redriven");
    assert.deepEqual(report.lost, []);
    assert.equal(host.wakeCalls.length, 0, "legacy amnesty opens no turn");
  });
});

describe("delivery obligation — telemetry (D-6)", { skip }, () => {
  it("records `delivered` with its reason", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    multitask.drainWake(SESSION);
    multitask.markDelivered("todo-1");

    const events = multitask.todos.listDeliveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "delivered");
    assert.equal(events[0]?.reason, "delivered-to-user");
    assert.equal(todoOf(multitask).dispositionReason, "delivered-to-user");
  });

  it("records `superseded` for a result from a worker the todo no longer points at", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.createTodo({ sessionId: SESSION, id: "todo-1", title: "Research" });

    const first = await multitask.spawnWorker({
      parentSessionId: SESSION,
      streamKey: "stream-1",
      title: "Research",
      prompt: "go",
      todoId: "todo-1",
    });
    assert.ok(first.ok);
    // Re-dispatch the same todo onto a second worker (a new stream key).
    const second = await multitask.spawnWorker({
      parentSessionId: SESSION,
      streamKey: "stream-2",
      title: "Research",
      prompt: "go again",
      todoId: "todo-1",
    });
    assert.ok(second.ok);
    assert.equal(todoOf(multitask).workerId, second.workerId);

    // The first worker finally reports. Nobody is waiting for it any more.
    settleUndelivered(host, first.workerId);
    // The plugin no longer enqueues a settle wake, so feed the notice straight
    // onto the bus to pin the reconciler's superseded telemetry.
    multitask.wakeBus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      workerId: first.workerId,
      status: "completed",
      title: "Research",
      resultText: "done",
    });
    const drained = multitask.drainWake(SESSION);
    assert.ok(drained);

    const superseded = multitask.todos
      .listDeliveryEvents()
      .filter((event) => event.disposition === "superseded");
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0]?.reason, "superseded-by-redispatch");
    assert.equal(superseded[0]?.workerId, first.workerId);
    // Crucially it is not mistaken for the current worker's result.
    assert.equal(
      drained.reconcile.landedUndelivered.length,
      0,
      "a superseded result does not become the live item's pending delivery",
    );
  });

  it("escalates an item whose worker we no longer hold (worker_gone)", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    multitask.createTodo({
      sessionId: SESSION,
      id: "todo-1",
      title: "Research",
      status: "in_progress",
      streamKey: "stream-1",
    });
    // A structural link to a worker this core never held: nothing will ever
    // settle it, so waiting is pointless and silence would be a lie.
    multitask.todos.linkWorker("todo-1", "ghost-worker", "stream-1");

    const report = multitask.redriveUndelivered(SESSION);

    assert.equal(report.redriven.length, 0);
    assert.equal(report.lost.length, 1);
    assert.equal(todoOf(multitask).status, "lost");
    assert.equal(todoOf(multitask).dispositionReason, "worker-gone");
  });

  it("records an aborted stream as dropped, not as lost", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    multitask.noteTurnStarted(workerId);
    await multitask.abortWorker(workerId);

    const events = multitask.todos.listDeliveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.disposition, "dropped");
    assert.equal(
      events[0]?.reason,
      "worker-aborted",
      "nothing was owed, so this is not a delivery failure",
    );
  });
});

describe("delivery obligation — one redrive turn costs one attempt (ticket 197)", { skip }, () => {
  it("draining the paid redrive wake does not spend a second attempt", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);
    // The settle opens no plugin wake; the first turn end is the accounting
    // point, so this pass spends the first attempt.
    const report = multitask.redriveUndelivered(SESSION);
    assert.equal(report.redriven.length, 1);
    assert.equal(todoOf(multitask).redriveAttempts, 1);
    assert.equal(durability.markers.get(workerId)?.redriveAttempts, 1);

    // That redrive opened a turn. Draining it IS the opportunity the spent
    // attempt paid for, so it must not charge the same todo again.
    const drained = multitask.drainWake(SESSION);
    assert.ok(drained, "the redrive wake is ready");
    assert.equal(drained.wake.source, "timer");
    assert.equal(todoOf(multitask).redriveAttempts, 1);
    assert.equal(drained.reconcile.toRedrive.length, 0);
    assert.equal(drained.reconcile.lost.length, 0);
    assert.equal(drained.reconcile.landedUndelivered.length, 1);
    assert.equal(
      durability.markers.get(workerId)?.redriveAttempts,
      1,
      "the ledger and the durable marker agree",
    );
  });

  it("a redriven result keeps its result notice and transcript pointer across restart", async () => {
    const durability = createInMemoryDurability();

    // Process 1: settle undelivered, spend the first attempt, drain its wake.
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const workerId = await spawnForTodo(coreA, hostA);
    hostA.fireSettled({
      workerId,
      status: "completed",
      report: "result",
      transcriptRef: "worker-transcript",
    });
    assert.equal(coreA.redriveUndelivered(SESSION).redriven.length, 1);
    coreA.drainWake(SESSION);

    // Process 2: rebuild from the marker and redrive the recovered result.
    const hostB = new FakeDshHost();
    const recovered = createMultitask(hostB, { durability });
    await recovered.rebuildFromDurability(SESSION);
    const report = recovered.redriveUndelivered(SESSION);
    assert.equal(report.redriven.length, 1);
    assert.equal(todoOf(recovered).redriveAttempts, 2);
    assert.equal(durability.markers.get(workerId)?.redriveAttempts, 2);

    const wakeText = composeWakeText(recovered, SESSION);
    assert.notEqual(
      wakeText,
      null,
      "the recovery wake must retain the result notice",
    );
    assert.ok(
      wakeText?.includes("worker-transcript"),
      "the recovery wake keeps the transcript pointer",
    );
    assert.equal(
      todoOf(recovered).redriveAttempts,
      2,
      "draining the paid turn spends no extra attempt",
    );
    assert.equal(
      durability.markers.get(workerId)?.redriveAttempts,
      2,
      "the ledger and the durable marker agree after the drain",
    );
  });

  it("the lifetime bound still escalates after the allowed redrive turns", async () => {
    const durability = createInMemoryDurability();
    const host = new FakeDshHost();
    const multitask = createMultitask(host, { durability });
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId);

    for (let attempt = 1; attempt <= MAX_DELIVERY_REDRIVES; attempt += 1) {
      assert.equal(multitask.redriveUndelivered(SESSION).redriven.length, 1);
      const drained = multitask.drainWake(SESSION);
      assert.ok(drained);
      assert.equal(
        todoOf(multitask).redriveAttempts,
        attempt,
        "one attempt per opened redrive turn",
      );
      assert.equal(
        todoOf(multitask).status,
        "in_progress",
        "a paid turn is not a fresh miss",
      );
    }

    // The spent lifetime budget survives a restart: rebuild itself derives
    // `lost` from the durable attempts (auto-continue fix Decision 2) instead
    // of handing the obligation a fresh allowance — the escalation no longer
    // waits for a post-restart redrive pass.
    const hostB = new FakeDshHost();
    const recovered = createMultitask(hostB, { durability });
    await recovered.rebuildFromDurability(SESSION);
    assert.equal(todoOf(recovered).redriveAttempts, MAX_DELIVERY_REDRIVES);
    assert.equal(todoOf(recovered).status, "lost", "exhaustion rebuilds as lost");
    assert.equal(todoOf(recovered).dispositionReason, "max-redrives");

    // lost stays lost: the next pass neither retries nor silently re-escalates,
    // and opens no wake.
    const wakesBefore = hostB.wakeCalls.length;
    const final = recovered.redriveUndelivered(SESSION);
    assert.equal(final.redriven.length, 0);
    assert.equal(final.lost.length, 0, "no silent re-escalation after restart");
    assert.equal(todoOf(recovered).status, "lost");
    assert.equal(hostB.wakeCalls.length, wakesBefore, "a lost item opens no turn");
  });
});

describe("delivery obligation — a queued settle is the first opportunity (duplicate-wake repair)", { skip }, () => {
  const REAL_REPORT =
    "Migration finished: 42 handlers audited, 7 fixes landed, and the smoke suite is green.";

  // The core no longer enqueues a settle wake (the stock completion notice
  // opens the turn). These pins are about the bus/reconcile accounting for a
  // settle notice, so they supply that notice on the bus directly.
  function queueSettleNotice(
    multitask: Multitask,
    workerId: string,
    resultText = REAL_REPORT,
  ): void {
    multitask.wakeBus.enqueueWorkerSettled({
      parentSessionId: SESSION,
      workerId,
      status: "completed",
      title: "Research",
      resultText,
    });
  }

  it("a settle queued mid-turn is not charged as a missed redrive", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    // The dispatcher turn is still running, so the settle notice lands in the
    // bus's pending batch instead of a ready wake.
    multitask.wakeBus.noteTurnStarted(SESSION);
    settleUndelivered(host, workerId, REAL_REPORT);
    queueSettleNotice(multitask, workerId);

    // peekPending sees that queued settle; redrive must reconcile against it
    // rather than a fabricated empty wake.
    const queued = multitask.wakeBus.peekPending(SESSION);
    assert.ok(queued, "the queued settle is visible to the redrive pass");
    assert.equal(queued.settledWorkers.length, 1);
    assert.equal(queued.settledWorkers[0]?.workerId, workerId);

    const report = multitask.redriveUndelivered(SESSION);
    assert.equal(report.redriven.length, 0, "the queued settle is its own chance");
    assert.equal(report.lost.length, 0);
    assert.equal(todoOf(multitask).redriveAttempts, 0, "no attempt is spent");
    assert.equal(host.wakeCalls.length, 0, "a mid-turn redrive does not interrupt");
  });

  it("turn end flushes the queued settle with the real report", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    multitask.wakeBus.noteTurnStarted(SESSION);
    settleUndelivered(host, workerId, REAL_REPORT);
    queueSettleNotice(multitask, workerId);
    multitask.redriveUndelivered(SESSION);

    multitask.wakeBus.noteTurnEnded(SESSION);
    assert.equal(host.wakeCalls.length, 1, "turn end opens the queued settle wake");

    const text = composeWakeText(multitask, SESSION);
    assert.ok(text, "the flushed settle composes a wake");
    assert.ok(text.includes(REAL_REPORT), "the wake carries the real report");
    assert.ok(text.includes("## Settled workers"), "it is a first-time settle");
    assert.ok(
      !text.includes("Re-presented — already shown, not yet delivered"),
      "a first presentation is not re-presented",
    );
    assert.ok(
      !text.includes(emptyReportPlaceholder()),
      "the empty-report placeholder never stands in for a real report",
    );
    assert.equal(todoOf(multitask).redriveAttempts, 0);
  });

  it("the next redrive wake re-presents the real report, never the placeholder", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    settleUndelivered(host, workerId, REAL_REPORT);
    queueSettleNotice(multitask, workerId);
    // First presentation: the settle wake is drained but the result is not
    // delivered to the user.
    multitask.drainWake(SESSION);
    assert.equal(todoOf(multitask).redriveAttempts, 0);

    const redrive = multitask.redriveUndelivered(SESSION);
    assert.equal(redrive.redriven.length, 1);
    assert.equal(todoOf(multitask).redriveAttempts, 1);

    const text = composeWakeText(multitask, SESSION);
    assert.ok(text, "the redrive wake composes");
    const representedAt = text.indexOf(
      "## Re-presented — already shown, not yet delivered",
    );
    const reportAt = text.indexOf(REAL_REPORT);
    assert.ok(representedAt >= 0, "the distinct re-presented block is present");
    assert.ok(reportAt > representedAt, "the real report rides that block");
    assert.ok(
      text.indexOf("## Settled workers") < representedAt,
      "it is not smuggled in as a first-time settle",
    );
    assert.ok(
      !text.includes(emptyReportPlaceholder()),
      "the placeholder is gone now that the settle record supplies the report",
    );
    assert.equal(
      todoOf(multitask).redriveAttempts,
      1,
      "draining the paid redrive turn spends no second attempt",
    );
  });

  it("a delivered todo drops its queued settle and opens no further wake", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    multitask.wakeBus.noteTurnStarted(SESSION);
    settleUndelivered(host, workerId, REAL_REPORT);
    queueSettleNotice(multitask, workerId);

    // The core call deliver_result makes. The settle is queued but not yet
    // delivered; closing the obligation must discard it.
    assert.equal(multitask.markDelivered("todo-1"), true);
    multitask.wakeBus.noteTurnEnded(SESSION);

    assert.equal(host.wakeCalls.length, 0, "delivery drops the queued settle");
    assert.equal(multitask.drainWake(SESSION), undefined);
    const report = multitask.redriveUndelivered(SESSION);
    assert.equal(report.redriven.length, 0, "a delivered result is never redriven");
    assert.equal(report.lost.length, 0);
    assert.equal(host.wakeCalls.length, 0, "no wake follows completion");
    assert.equal(
      composeWakeText(multitask, SESSION),
      null,
      "nothing remains to present",
    );
  });

  it("a settle arriving after delivery is not presented", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    multitask.wakeBus.noteTurnStarted(SESSION);
    assert.equal(multitask.markDelivered("todo-1"), true);

    // The worker finishes after the ledger entry was already delivered.
    settleUndelivered(host, workerId, REAL_REPORT);
    multitask.wakeBus.noteTurnEnded(SESSION);

    assert.equal(host.wakeCalls.length, 0, "a post-delivery settle stays silent");
    assert.equal(multitask.drainWake(SESSION), undefined);
    assert.equal(multitask.redriveUndelivered(SESSION).redriven.length, 0);
    assert.equal(composeWakeText(multitask, SESSION), null);
  });

  it("a re-presented result never falls back to the empty-report placeholder", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    // A completed worker that genuinely produced no text: the settle record
    // stores the placeholder, so the re-presentation path must re-word the
    // absence instead of repeating "produced no text output" as if the result
    // had never existed.
    settleUndelivered(host, workerId, "");
    queueSettleNotice(multitask, workerId, "");
    multitask.drainWake(SESSION);

    assert.equal(multitask.redriveUndelivered(SESSION).redriven.length, 1);
    const text = composeWakeText(multitask, SESSION);
    assert.ok(text, "the redrive wake composes");
    assert.ok(
      text.includes("## Re-presented — already shown, not yet delivered"),
      "the distinct block is used",
    );
    assert.ok(
      !text.includes(emptyReportPlaceholder()),
      "the completed-report placeholder never stands in for a re-presentation",
    );
    assert.ok(
      text.includes("no longer held in this process"),
      "the honest fallback names why the stored text is absent",
    );
  });

  it("a late abort cannot reopen or prune an already-delivered obligation", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const workerId = await spawnForTodo(multitask, host);
    multitask.wakeBus.noteTurnStarted(SESSION);
    assert.equal(multitask.markDelivered("todo-1"), true);

    // deliver_result can land while the worker still runs. A later abort is
    // post-completion: it must not wake, cancel, or prune the delivered row.
    host.fireSettled({ workerId, status: "aborted", report: "" });
    multitask.wakeBus.noteTurnEnded(SESSION);

    assert.equal(host.wakeCalls.length, 0, "no wake after completion");
    assert.equal(todoOf(multitask).status, "completed");
    assert.equal(todoOf(multitask).delivered, true);
    assert.equal(
      multitask.todos
        .listDeliveryEvents()
        .some((event) => event.disposition === "dropped"),
      false,
      "a delivered result is never recorded as dropped",
    );
    assert.equal(multitask.redriveUndelivered(SESSION).redriven.length, 0);
  });
});

