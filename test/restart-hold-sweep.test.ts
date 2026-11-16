/**
 * Lane A2c2 — the dispatcher restart sweep that releases unknown-state holds
 * (ticket 59), after it was found to destroy the dormant-worker cold-resume
 * path (ticket 142). Core only: no plugin wiring, no model-facing tool.
 *
 * Pins, against the observable core surface:
 * 1. a BARE live-at-crash marker (no wake identity anywhere) is stale: ONE
 *    sweep drops the hold, its durable marker and the stream occupancy, after
 *    which the stream key dispatches again;
 * 2. a marker WITH a durable `worker_sessions` row is dormant-resumable, so
 *    the sweep preserves hold, marker and wake row, the stream stays fenced,
 *    and a send still cold-resumes the worker (the ticket-142 owner ruling);
 * 3. the same holds when only the adapter's synchronous wake mirror answers —
 *    the sweep runs BEFORE `refreshWorkerSessionMarks` on activation, so
 *    mirror evidence is real evidence;
 * 4. a live worker, its durable rows, and a sibling session's hold are never
 *    touched (ADR-0019 scope fence);
 * 5. a second sweep is a no-op: empty result and no store writes;
 * 6. marker-first ordering is intact: a refused marker drop keeps a genuinely
 *    stale hold and reports `hold-release-failed`; the next sweep retries it;
 * 7. an unreadable wake row proves nothing, so the hold is kept (fail-safe).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInMemoryDurability,
  type InMemoryDurability,
} from "../src/core/durability.js";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask, type Multitask } from "../src/core/multitask.js";
import type {
  SpawnOptions,
  SpawnRequest,
  SpawnResult,
} from "../src/core/types.js";

const SESSION = "session-restart";
const SIBLING = "session-sibling";

/**
 * FakeDshHost mints `fake-worker-N` from 1 in EVERY instance, so the fresh
 * core after a simulated restart would reuse the crash-time ids. A prefix
 * keeps the two "processes" distinct, exactly like real child session ids.
 */
class ProcessHost extends FakeDshHost {
  readonly #prefix: string;
  #next = 0;

  constructor(prefix: string) {
    super();
    this.#prefix = prefix;
  }

  override async spawnWorker(
    prompt: string,
    opts: SpawnOptions,
  ): Promise<string> {
    const workerId = `${this.#prefix}-worker-${++this.#next}`;
    opts.onWorkerId?.(workerId);
    this.spawnCalls.push({ prompt, opts, workerId });
    return workerId;
  }
}

function spawnRequest(
  parentSessionId: string,
  streamKey: string,
): SpawnRequest {
  return {
    parentSessionId,
    streamKey,
    title: `Work ${streamKey}`,
    prompt: "Do the work.",
  };
}

function unwrapSpawn(result: SpawnResult): string {
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.workerId;
}

async function spawnLive(
  multitask: Multitask,
  parentSessionId: string,
  streamKey: string,
): Promise<string> {
  const workerId = unwrapSpawn(
    await multitask.spawnWorker(spawnRequest(parentSessionId, streamKey)),
  );
  multitask.noteTurnStarted(workerId);
  return workerId;
}

/**
 * Process 1: live workers whose markers outlive the core that spawned them
 * (a crash). The store keeps their markers AND their `worker_sessions` wake
 * rows — the shape a ticket-142-era process leaves behind.
 */
async function crashWithLiveWorkers(
  durability: InMemoryDurability,
  requests: readonly SpawnRequest[],
): Promise<string[]> {
  const pre = createMultitask(new ProcessHost("crash"), { durability });
  const workerIds: string[] = [];
  for (const request of requests) {
    workerIds.push(
      await spawnLive(pre, request.parentSessionId, request.streamKey),
    );
  }
  return workerIds;
}

/**
 * Process 2: a fresh core over the same store, rebuilt from markers. The
 * wake mirror starts COLD (a fresh host), exactly like the plugin: it is
 * wired to `findDurableWorker` and warmed only by
 * `refreshWorkerSessionMarks` — which on activation runs AFTER the sweep.
 */
async function restart(
  durability: InMemoryDurability,
  parentSessionId = SESSION,
): Promise<{ host: FakeDshHost; core: Multitask }> {
  const host = new FakeDshHost();
  const core = createMultitask(host, {
    durability,
    findDurableWorker: (workerId) => {
      const parent = host.workerWakes.get(workerId);
      return parent === undefined ? undefined : { parentSessionId: parent };
    },
  });
  await core.rebuildFromDurability(parentSessionId);
  return { host, core };
}

/**
 * The activation's later half: `refreshWorkerSessionMarks` merges the store's
 * `worker_sessions` rows into the adapter's synchronous mirror (minus
 * tombstones, which this fixture never creates).
 */
function warmWakeMirror(
  host: FakeDshHost,
  durability: InMemoryDurability,
): void {
  for (const row of durability.workerSessions.values()) {
    host.workerWakes.set(row.sessionId, row.parentSessionId);
  }
}

/** A pre-142 / lost-row shape: the live marker with no wake identity. */
function stripWakeRow(
  durability: InMemoryDurability,
  workerId: string,
): void {
  assert.equal(
    durability.workerSessions.delete(workerId),
    true,
    "fixture: the wake row existed at the crash",
  );
}

describe("restart hold sweep — releases only genuinely stale holds", () => {
  it("drops a BARE live-status marker, its durable marker and the stream", async () => {
    const durability = createInMemoryDurability();
    const [workerId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-1"),
    ]);
    assert.ok(workerId !== undefined);
    assert.equal(durability.markers.get(workerId)?.streamKey, "stream-1");
    stripWakeRow(durability, workerId);

    const { host, core } = await restart(durability);
    assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
    // No wake identity: a send refuses, so the hold is genuinely stale.
    const refused = await core.steerWorker(workerId, "are you there?");
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? "" : refused.reason, "unknown-worker");
    assert.deepEqual(host.dormantWakeCalls, []);

    // Before the sweep the hold fences the stream, structurally (no spawn).
    const blocked = await core.spawnWorker(spawnRequest(SESSION, "stream-1"));
    assert.equal(
      blocked.ok ? "" : blocked.reason,
      "stream-key-held-by-unknown-state",
    );
    assert.equal(host.spawnCalls.length, 0);

    const swept = await core.sweepUnknownStateHolds(SESSION);
    assert.equal(swept.length, 1);
    assert.equal(swept[0]?.workerId, workerId);
    assert.equal(swept[0]?.streamKey, "stream-1");
    assert.deepEqual(swept[0]?.outcome, { ok: true });

    // Hold and marker gone; nothing was invented on the roster.
    assert.equal(core.listUnknownStateHolds(SESSION).length, 0);
    assert.equal(core.getWorker(workerId), undefined);
    assert.equal(durability.markers.has(workerId), false);

    // The actual hygiene: the stream key dispatches again after the restart.
    const reopened = await core.spawnWorker(spawnRequest(SESSION, "stream-1"));
    assert.ok(reopened.ok, "the sweep freed the stream for a re-dispatch");
  });

  it("preserves a marker with a durable worker_sessions row — it stays cold-resumable", async () => {
    const durability = createInMemoryDurability();
    const [workerId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-1"),
    ]);
    assert.ok(workerId !== undefined);

    const { host, core } = await restart(durability);
    // Fixture sanity: the crash left the wake row, and the mirror is cold —
    // only the store row can answer at sweep time.
    assert.equal(durability.workerSessions.has(workerId), true);
    assert.equal(host.workerWakes.has(workerId), false);
    assert.equal(core.listUnknownStateHolds(SESSION).length, 1);

    const swept = await core.sweepUnknownStateHolds(SESSION);
    assert.deepEqual(swept, [], "a dormant-resumable hold is not released");
    // Hold, marker and wake row all survive, and the stream stays fenced.
    assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
    assert.equal(durability.markers.has(workerId), true);
    assert.equal(durability.workerSessions.has(workerId), true);
    const fenced = await core.spawnWorker(spawnRequest(SESSION, "stream-1"));
    assert.equal(
      fenced.ok ? "" : fenced.reason,
      "stream-key-held-by-unknown-state",
    );

    // The activation's later half warms the mirror; the send then resumes it.
    warmWakeMirror(host, durability);
    const sent = await core.steerWorker(workerId, "Pick the migration back up.");
    assert.deepEqual(sent, { ok: true, dormant: true });
    assert.equal(host.dormantWakeCalls.length, 1);
    assert.equal(host.dormantWakeCalls[0]?.workerId, workerId);
    assert.ok(host.dormantWakeCalls[0]?.message.includes("[Parent correction]"));
    // Acceptance never consumed the row: still wake-able, still held (the
    // host's re-adoption is what resolves the hold, not the send).
    assert.equal(durability.workerSessions.has(workerId), true);
    assert.equal(core.getWorker(workerId), undefined);
    assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
  });

  it("preserves a hold the adapter's wake mirror already answers for", async () => {
    // The sweep runs BEFORE `refreshWorkerSessionMarks`; a mirror entry can
    // be the only evidence in hand, and it is exactly what the send fence
    // reads — so it must outrank the sweep.
    const durability = createInMemoryDurability();
    const [workerId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-1"),
    ]);
    assert.ok(workerId !== undefined);
    stripWakeRow(durability, workerId);

    const { host, core } = await restart(durability);
    host.workerWakes.set(workerId, SESSION);

    const swept = await core.sweepUnknownStateHolds(SESSION);
    assert.deepEqual(swept, []);
    assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
    assert.equal(durability.markers.has(workerId), true);

    const sent = await core.steerWorker(workerId, "continue");
    assert.deepEqual(sent, { ok: true, dormant: true });
    assert.equal(host.dormantWakeCalls.length, 1);
  });

  it("leaves a live worker, its durable rows, and a sibling session's hold alone", async () => {
    const durability = createInMemoryDurability();
    const [heldId, siblingHeldId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-held"),
      spawnRequest(SIBLING, "stream-sibling"),
    ]);
    assert.ok(heldId !== undefined && siblingHeldId !== undefined);

    const host = new FakeDshHost();
    const core = createMultitask(host, {
      durability,
      findDurableWorker: (workerId) => {
        const parent = host.workerWakes.get(workerId);
        return parent === undefined ? undefined : { parentSessionId: parent };
      },
    });
    await core.rebuildFromDurability(SESSION);
    await core.rebuildFromDurability(SIBLING);
    // A worker that is live under THIS session in the new process.
    const liveId = await spawnLive(core, SESSION, "stream-live");

    const swept = await core.sweepUnknownStateHolds(SESSION);
    assert.deepEqual(swept, [], "both holds are wake-able, so none is stale");

    // The live worker is untouched: roster, marker, wake row, host mirror.
    const live = core.getWorker(liveId);
    assert.ok(live);
    assert.equal(live?.status, "running");
    assert.equal(live?.streamKey, "stream-live");
    assert.equal(durability.markers.has(liveId), true);
    assert.equal(durability.workerSessions.has(liveId), true);
    assert.equal(host.workerWakes.get(liveId), SESSION);
    assert.equal(host.interruptCalls.length, 0);
    assert.equal(host.sendMessageCalls.length, 0);
    // Its stream is still fenced as LIVE, not released by the sweep.
    const liveBlocked = await core.spawnWorker(
      spawnRequest(SESSION, "stream-live"),
    );
    assert.equal(
      liveBlocked.ok ? "" : liveBlocked.reason,
      "duplicate-stream-key",
    );

    // A sibling session's hold is out of scope (ADR-0019) — and preserved.
    assert.equal(core.listUnknownStateHolds(SIBLING).length, 1);
    assert.equal(durability.markers.has(siblingHeldId), true);
    assert.equal(durability.workerSessions.has(siblingHeldId), true);
    // This session's own hold is still there too; only a stale one would go.
    assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
    assert.equal(durability.markers.has(heldId), true);
    assert.equal(durability.workerSessions.has(heldId), true);
  });

  it("a second sweep is a no-op — empty result and no store writes", async () => {
    const base = createInMemoryDurability();
    const drops: string[] = [];
    const durability: InMemoryDurability = {
      ...base,
      deleteWorkerMarker(workerId: string): void {
        drops.push(`marker:${workerId}`);
        base.markers.delete(workerId);
      },
      deleteWorkerSession(workerId: string): void {
        drops.push(`wake:${workerId}`);
        base.workerSessions.delete(workerId);
      },
    };
    const [workerId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-1"),
    ]);
    assert.ok(workerId !== undefined);
    stripWakeRow(durability, workerId);
    const { host, core } = await restart(durability);

    const first = await core.sweepUnknownStateHolds(SESSION);
    assert.equal(first.length, 1);
    assert.deepEqual(drops, [`marker:${workerId}`, `wake:${workerId}`]);

    const second = await core.sweepUnknownStateHolds(SESSION);
    assert.deepEqual(second, []);
    assert.deepEqual(
      drops,
      [`marker:${workerId}`, `wake:${workerId}`],
      "nothing held: the second sweep writes nothing",
    );
    assert.equal(host.interruptCalls.length, 0);
    assert.equal(host.sendMessageCalls.length, 0);
  });

  it("keeps a stale hold when the marker drop is refused, and the next sweep retries it", async () => {
    const base = createInMemoryDurability();
    let refuseDrop = false;
    const durability: InMemoryDurability = {
      ...base,
      deleteWorkerMarker(workerId: string): void {
        if (refuseDrop) throw new Error("marker store down");
        base.deleteWorkerMarker(workerId);
      },
    };
    const [workerId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-1"),
    ]);
    assert.ok(workerId !== undefined);
    // Bare marker: stale, so the release path is actually reached.
    stripWakeRow(durability, workerId);
    const { core } = await restart(durability);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      refuseDrop = true;
      const failed = await core.sweepUnknownStateHolds(SESSION);
      assert.equal(failed.length, 1);
      const outcome = failed[0]?.outcome;
      assert.equal(outcome?.ok, false);
      assert.equal(
        outcome?.ok ? "" : outcome?.reason,
        "hold-release-failed",
      );
      // Marker-first: the dropped marker is the precondition, so a refusal
      // leaves the hold in place and memory still agrees with disk.
      assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
      assert.equal(durability.markers.has(workerId), true);
      assert.ok(warnings.some((message) => message.includes("marker")));

      refuseDrop = false;
      const retried = await core.sweepUnknownStateHolds(SESSION);
      assert.equal(retried.length, 1);
      assert.deepEqual(retried[0]?.outcome, { ok: true });
      assert.equal(core.listUnknownStateHolds(SESSION).length, 0);
      assert.equal(durability.markers.has(workerId), false);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("keeps the hold when the wake row cannot be read — fail-safe", async () => {
    const base = createInMemoryDurability();
    const durability: InMemoryDurability = {
      ...base,
      readWorkerSession(): never {
        throw new Error("worker session store down");
      },
    };
    const [workerId] = await crashWithLiveWorkers(durability, [
      spawnRequest(SESSION, "stream-1"),
    ]);
    assert.ok(workerId !== undefined);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const { core } = await restart(durability);
      const swept = await core.sweepUnknownStateHolds(SESSION);
      assert.deepEqual(swept, [], "unreadable evidence is not proof of staleness");
      assert.equal(core.listUnknownStateHolds(SESSION).length, 1);
      assert.equal(durability.markers.has(workerId), true);
      assert.ok(
        warnings.some((message) => message.includes("could not be read")),
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
