/**
 * Ticket 113 / ADR-0023 — the inbox watcher adapter (wire protocol + scan).
 *
 * Offline only (S8): a real temp-dir filesystem exercises the protocol
 * exactly as an external system would write it — queue.jsonl lines, per-job
 * prompt.md/job.json/reply.md/status.json — and the watcher runs against it
 * with a MANUAL scheduler wherever timing would otherwise be flaky (the
 * rescan fallback and the watch debounce are injectable for exactly this).
 * One test uses real timers to pin the fs.watch event path end-to-end.
 * No network, no LLM, no dsh.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {atomicWriteFile, claimInboxJob, readInboxQueue, startInboxWatcher, writeInboxCancelled, writeInboxFailed, writeInboxReply, type InboxQueueEntry, type InboxWatcherHandle} from "../src/adapter/inbox-watcher.js";

/** Manual scheduler: timers are recorded, never real. */
function createManualSchedule() {
  const armed: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const id = nextId++;
    armed.push({ fn, ms, id });
    return () => {
      const at = armed.findIndex((entry) => entry.id === id);
      if (at >= 0) armed.splice(at, 1);
    };
  };
  return {
    schedule,
    pending: (): number => armed.length,
    stop: (): void => {
      armed.splice(0, armed.length);
    },
  };
}

async function createInboxDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "inbox-watcher-"));
}

/** Write one queue.jsonl carrying the given entries. */
async function writeQueue(
  root: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(root, "queue.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

/** Deadline poll for async filesystem states (real-timer tests only). */
async function pollUntil(
  probe: () => boolean,
  deadlineMs = 5_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return probe();
}

describe("inbox watcher — queue resolution (ticket 113, ADR-0023)", () => {
  it("resolves prompt.md over entry.text over job.json.text, in queue order", async () => {
    const root = await createInboxDir();
    try {
      await mkdir(join(root, "j-md"), { recursive: true });
      await mkdir(join(root, "j-json"), { recursive: true });
      await writeFile(join(root, "j-md", "prompt.md"), "from prompt.md", "utf8");
      await writeFile(
        join(root, "j-json", "job.json"),
        JSON.stringify({ text: "from job.json" }),
        "utf8",
      );
      await writeQueue(root, [
        { jobId: "j-md", text: "from queue line" },
        { jobId: "j-json", text: "" },
        { jobId: "j-line", text: "from queue line only" },
      ]);
      const { entries, skipped, malformed } = await readInboxQueue(root);
      assert.equal(malformed, 0);
      assert.equal(skipped, 0);
      assert.deepEqual(
        entries.map((entry) => [entry.jobId, entry.text]),
        [
          ["j-md", "from prompt.md"],
          ["j-json", "from job.json"],
          ["j-line", "from queue line only"],
        ],
      );
      // dir fallback: no entry.dir → <root>/<jobId>.
      assert.equal(entries[0]?.dir, join(root, "j-md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe("inbox watcher — job-dir writes (ticket 113, ADR-0023)", () => {
  it("never re-claims a job that is already claimed or replied", async () => {
    // Claiming twice would present the same prompt to a dispatcher again, or
    // overwrite an answer the user already has.
    const root = await createInboxDir();
    try {
      await mkdir(join(root, "j-claimed"), { recursive: true });
      await writeFile(join(root, "j-claimed", "status.json"), JSON.stringify({ status: "claimed" }), "utf8");
      await mkdir(join(root, "j-done"), { recursive: true });
      await writeFile(join(root, "j-done", "reply.md"), "already answered", "utf8");
      await mkdir(join(root, "j-queued"), { recursive: true });
      await writeFile(join(root, "j-queued", "status.json"), JSON.stringify({ status: "queued" }), "utf8");
      await writeQueue(root, [
        { jobId: "j-claimed", text: "x" },
        { jobId: "j-done", text: "x" },
        { jobId: "j-queued", text: "explicit queued is claimable" },
        { jobId: "j-fresh", text: "x" },
      ]);
      const { entries, skipped } = await readInboxQueue(root);
      assert.equal(skipped, 2, "claimed and replied jobs are skipped");
      assert.deepEqual(
        entries.map((entry) => entry.jobId).sort(),
        ["j-fresh", "j-queued"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("claim writes status.json {status:'claimed', claimedAt} atomically", async () => {
    const root = await createInboxDir();
    try {
      const entry: InboxQueueEntry = {
        jobId: "j-1",
        dir: join(root, "j-1"),
        text: "work",
        images: [],
      };
      await claimInboxJob(entry, 1234);
      const status = JSON.parse(
        await readFile(join(root, "j-1", "status.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(status.status, "claimed");
      assert.equal(status.claimedAt, 1234);
      assert.equal(status.jobId, "j-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reply writes a non-empty reply.md plus {status:'replied'} with byte count", async () => {
    const root = await createInboxDir();
    try {
      const dir = join(root, "j-1");
      await mkdir(dir, { recursive: true });
      await writeInboxReply(dir, "j-1", "  All done.  ", 100, 200);
      const reply = await readFile(join(dir, "reply.md"), "utf8");
      assert.equal(reply, "All done.\n", "trimmed and newline-terminated");
      const status = JSON.parse(
        await readFile(join(dir, "status.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(status.status, "replied");
      assert.equal(status.startedAt, 100);
      assert.equal(status.endedAt, 200);
      assert.equal(status.replyBytes, Buffer.byteLength("All done.\n", "utf8"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("failed and cancelled write status.json only — never a reply.md", async () => {
    const root = await createInboxDir();
    try {
      const failedDir = join(root, "j-f");
      await mkdir(failedDir, { recursive: true });
      await writeInboxFailed(failedDir, "j-f", "boom ".repeat(500), null, 300);
      assert.equal(existsSync(join(failedDir, "reply.md")), false);
      const failed = JSON.parse(
        await readFile(join(failedDir, "status.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(failed.status, "failed");
      assert.ok(
        String(failed.error).length <= 2000,
        "the error body is clamped",
      );

      const cancelDir = join(root, "j-c");
      await mkdir(cancelDir, { recursive: true });
      await writeInboxCancelled(cancelDir, "j-c", "user asked", 5, 6);
      const cancelled = JSON.parse(
        await readFile(join(cancelDir, "status.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.reason, "user asked");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomicWriteFile leaves no tmp residue", async () => {
    const root = await createInboxDir();
    try {
      await atomicWriteFile(join(root, "f.txt"), "hello");
      const listing = await readdir(root);
      assert.deepEqual(listing, ["f.txt"]);
      assert.equal(await readFile(join(root, "f.txt"), "utf8"), "hello");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe("inbox watcher — startInboxWatcher (ticket 113, ADR-0023)", () => {
  it("scanOnce claims queued jobs in order, hands them to onJob, and skips claimed ones next pass", async () => {
    const root = await createInboxDir();
    const schedule = createManualSchedule();
    let watcher: InboxWatcherHandle | null = null;
    try {
      const claimed: string[] = [];
      watcher = startInboxWatcher({
        root,
        rescanIntervalMs: 5000,
        onJob: (entry) => claimed.push(entry.jobId),
        onError: () => assert.fail("no errors expected"),
        schedule: schedule.schedule,
      });
      // `ready` settles after the initial sweep — which sees an empty inbox —
      // so the direct scans below are the only passes that can claim.
      await watcher.ready;
      await writeQueue(root, [
        { jobId: "j-1", text: "first" },
        { jobId: "j-2", text: "second" },
      ]);
      let report = await watcher.scanOnce();
      assert.ok(report);
      assert.deepEqual(claimed, ["j-1", "j-2"]);
      assert.equal(report.claimed.length, 2);
      assert.equal(report.skipped, 0);

      report = await watcher.scanOnce();
      assert.ok(report);
      assert.equal(report.claimed.length, 0, "claimed jobs are not re-claimed");
      assert.equal(report.skipped, 2, "…they are counted as skipped");
      assert.deepEqual(claimed, ["j-1", "j-2"], "no duplicate onJob");

      watcher.stop();
      assert.equal(schedule.pending(), 0, "stop cancels every armed timer");
      assert.equal(await watcher.scanOnce(), null, "scan after stop is a no-op");
      watcher.stop(); // idempotent
    } finally {
      watcher?.stop();
      schedule.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the startup sweep claims jobs queued before start; ready settles after it", async () => {
    const root = await createInboxDir();
    const schedule = createManualSchedule();
    let watcher: InboxWatcherHandle | null = null;
    try {
      await writeQueue(root, [
        { jobId: "j-boot", text: "queued before boot" },
      ]);
      const claimed: string[] = [];
      watcher = startInboxWatcher({
        root,
        rescanIntervalMs: 5000,
        onJob: (entry) => claimed.push(entry.jobId),
        onError: () => assert.fail("no errors expected"),
        schedule: schedule.schedule,
      });
      await watcher.ready;
      assert.deepEqual(
        claimed,
        ["j-boot"],
        "ready means the initial sweep already claimed boot-queued jobs",
      );
      assert.ok(
        schedule.pending() > 0,
        "the rescan fallback is armed (a watch debounce may also be pending)",
      );
      const report = await watcher.scanOnce();
      assert.ok(report);
      assert.equal(report.claimed.length, 0);
      assert.equal(report.skipped, 1);
    } finally {
      watcher?.stop();
      schedule.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

});
