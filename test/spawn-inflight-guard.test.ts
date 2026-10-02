import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryDurability } from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import type { SpawnOptions, SpawnResult } from "../src/core/types.js";

/**
 * Ticket 109 — per-stream in-flight guard closing the spawn check-then-set
 * window (ticket 05 / ADR-0019 uniqueness domain `(parentSessionId, streamKey)`).
 *
 * `spawnWorker` used to check stream-key uniqueness, then `await
 * host.spawnWorker`, then register — two concurrent spawns with the same key
 * could both pass the check. The core now reserves the key synchronously at
 * the point the check passes and releases it on every terminal path, so
 * exactly one of two concurrent spawns wins and the loser gets the existing
 * `duplicate-stream-key` refusal. No new public API; error names unchanged.
 */

/** Host whose next spawn fails once — proves the reservation is released. */
class FailingSpawnHost extends FakeDshHost {
  failNext = false;
  override async spawnWorker(prompt: string, opts: SpawnOptions): Promise<string> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("host spawn exploded");
    }
    return super.spawnWorker(prompt, opts);
  }
}

function spawnRequest(
  parentSessionId: string,
  streamKey: string,
  title: string,
): Parameters<ReturnType<typeof createMultitask>["spawnWorker"]>[0] {
  return { parentSessionId, streamKey, title, prompt: "Do the work." };
}

function refuseDetail(result: SpawnResult): string {
  assert.ok(!result.ok, "expected a refusal");
  return result.detail;
}

describe("spawn in-flight guard — concurrency (ticket 109)", () => {
  it("two concurrent spawns on one stream key: exactly one wins, the other is refused as duplicate", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const results = await Promise.all([
      multitask.spawnWorker(spawnRequest("s1", "build", "A")),
      multitask.spawnWorker(spawnRequest("s1", "build", "B")),
    ]);

    const okResults = results.filter((r) => r.ok);
    const refused = results.find((r): r is Extract<SpawnResult, { ok: false }> => !r.ok);
    assert.equal(okResults.length, 1, "exactly one spawn succeeded");
    assert.ok(refused);
    assert.equal(
      refused.reason,
      "duplicate-stream-key",
      "the existing duplicate error, unchanged name",
    );
    assert.match(refuseDetail(refused), /spawn in flight/);
    assert.equal(
      host.spawnCalls.length,
      1,
      "the duplicate was refused before reaching the host — window closed",
    );
  });

  it("the reservation is keyed by (parentSessionId, streamKey) — sibling sessions never collide", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);

    const results = await Promise.all([
      multitask.spawnWorker(spawnRequest("s-a", "build", "For A")),
      multitask.spawnWorker(spawnRequest("s-b", "build", "For B")),
    ]);

    assert.equal(results.filter((r) => r.ok).length, 2, "both sessions spawn");
    assert.equal(host.spawnCalls.length, 2);
  });
});

describe("spawn in-flight guard — reservation release (ticket 109)", () => {
  it("a completed spawn frees the reservation — reusing the key succeeds", async () => {
    const host = new FakeDshHost();
    const multitask = createMultitask(host);
    const first = await multitask.spawnWorker(spawnRequest("s1", "build", "A"));
    assert.ok(first.ok);
    const firstId = first.ok ? first.workerId : null;
    assert.ok(firstId);
    host.fireSettled({ workerId: firstId, status: "completed", report: "done" });

    const second = await multitask.spawnWorker(spawnRequest("s1", "build", "B"));

    assert.ok(second.ok, "the terminal worker freed the key; no stale reservation");
  });

  it("a failing host spawn releases the reservation — retrying the same key succeeds", async () => {
    const host = new FailingSpawnHost();
    const multitask = createMultitask(host);
    host.failNext = true;

    await assert.rejects(
      multitask.spawnWorker(spawnRequest("s1", "build", "A")),
      /host spawn exploded/,
    );

    const retry = await multitask.spawnWorker(spawnRequest("s1", "build", "B"));
    assert.ok(retry.ok, "the failed spawn left no reservation behind");
  });

  it("an unknown-state hold still refuses, and resolving it re-opens the stream", async () => {
    // Process 1: a live worker whose marker outlives it (crash simulation).
    const durability = createInMemoryDurability();
    const hostA = new FakeDshHost();
    const coreA = createMultitask(hostA, { durability });
    const spawned = await coreA.spawnWorker(spawnRequest("s1", "build", "A"));
    assert.ok(spawned.ok);
    const workerId = spawned.ok ? spawned.workerId : null;
    assert.ok(workerId);
    coreA.noteTurnStarted(workerId);

    // Process 2: a fresh core rebuilds from markers — live marker becomes a
    // hold on the stream key (ticket 59).
    const hostB = new FakeDshHost();
    const coreB = createMultitask(hostB, { durability });
    const rebuild = await coreB.rebuildFromDurability("s1");
    assert.equal(rebuild.unknownState.length, 1);
    const holdId = rebuild.unknownState[0]?.workerId;
    assert.ok(holdId);

    const refused = await coreB.spawnWorker(spawnRequest("s1", "build", "B"));
    assert.ok(!refused.ok);
    assert.equal(
      refused.reason,
      "stream-key-held-by-unknown-state",
      "hold refusal semantics unchanged by the in-flight guard",
    );

    // Resolving the hold releases the key; the guard must not wedge it.
    assert.ok(await coreB.releaseUnknownStateHold(holdId));
    const afterResolve = await coreB.spawnWorker(spawnRequest("s1", "build", "C"));
    assert.ok(afterResolve.ok);
  });
});
