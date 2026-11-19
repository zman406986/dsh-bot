import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxWatcher } from "../src/adapter/inbox-watcher.js";

function manualSchedule(_fn: () => void, _ms: number): () => void {
  return () => {};
}

test("a locked orphan does not consume the limit before a later job", async () => {
  const root = await mkdtemp(join(tmpdir(), "inbox-orphan-lock-"));
  const orphanLock = "orphan lock must remain untouched\n";
  try {
    await mkdir(join(root, "orphan"), { recursive: true });
    await writeFile(join(root, "orphan", "claim.lock"), orphanLock, "utf8");
    await writeFile(
      join(root, "queue.jsonl"),
      [
        JSON.stringify({ jobId: "orphan", text: "stuck after a crash" }),
        JSON.stringify({ jobId: "healthy", text: "later work" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const seen: string[] = [];
    const errors: string[] = [];
    const watcher = startInboxWatcher({
      root,
      limit: 1,
      rescanIntervalMs: 1000,
      schedule: manualSchedule,
      onJob: (entry) => seen.push(entry.jobId),
      onError: (error, context) => errors.push(context + ": " + String(error)),
    });
    try {
      await watcher.ready;
      const first = await watcher.scanOnce();
      const second = await watcher.scanOnce();

      assert.deepEqual(seen, ["healthy"], "the later healthy job is presented once");
      assert.ok(first);
      assert.ok(first.claimed.length <= 1, "each explicit pass stays bounded");
      assert.equal(second?.claimed.length, 0, "a later rescan does not duplicate it");
      assert.equal(
        await readFile(join(root, "orphan", "claim.lock"), "utf8"),
        orphanLock,
        "the orphan lock is never deleted or rewritten",
      );
      assert.deepEqual(errors, []);
    } finally {
      watcher.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Keep the production default implicit: this catches a cap before lock eligibility.
test("default batches progress past 50 orphan locks without re-claiming them", async () => {
  const root = await mkdtemp(join(tmpdir(), "inbox-orphan-default-"));
  const orphanIds = Array.from({ length: 50 }, (_, index) => "orphan-" + index);
  const healthyIds = Array.from({ length: 51 }, (_, index) => "healthy-" + index);
  const lockText = "prior claim; do not change\n";
  try {
    for (const [index, jobId] of orphanIds.entries()) {
      const dir = join(root, jobId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "claim.lock"), lockText, "utf8");
      if (index % 2 === 0) {
        await writeFile(join(dir, "status.json"), JSON.stringify({ status: "queued" }), "utf8");
      }
    }
    await writeFile(
      join(root, "queue.jsonl"),
      [...orphanIds, ...healthyIds].map((jobId) => JSON.stringify({ jobId, text: "work" })).join("\n") + "\n",
      "utf8",
    );
    const seen: string[] = [];
    const errors: string[] = [];
    const watcher = startInboxWatcher({
      root,
      rescanIntervalMs: 1000,
      schedule: manualSchedule,
      onJob: (entry) => seen.push(entry.jobId),
      onError: (error, context) => errors.push(context + ": " + String(error)),
    });
    try {
      await watcher.ready;
      assert.deepEqual(seen, healthyIds.slice(0, 50), "startup claims only the first default batch");
      const next = await watcher.scanOnce();
      assert.deepEqual(next?.claimed.map((entry) => entry.jobId), ["healthy-50"]);
      const last = await watcher.scanOnce();
      assert.deepEqual(last?.claimed, [], "later scans do not repeat claimed work");
      assert.deepEqual(seen, healthyIds, "each healthy job is delivered exactly once, in order");
      for (const jobId of orphanIds) {
        assert.equal(await readFile(join(root, jobId, "claim.lock"), "utf8"), lockText);
      }
      assert.deepEqual(errors, []);
    } finally {
      watcher.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
