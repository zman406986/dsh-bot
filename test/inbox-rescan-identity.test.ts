/** Ticket 304: canonical path spelling never replaces an accepted job identity. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { apply, INBOX_JOBS_HEADING } from "../src/plugin.js";
import {
  DISPATCHER_START_COMMAND,
  INBOX_TABLE_NAME,
  type CommandDefinitionLike,
  type InboxJobCheckpoint,
} from "../src/adapter/index.js";
import {
  claimInboxJob,
  inboxCheckpointKey,
  readInboxQueue,
} from "../src/adapter/inbox-watcher.js";

/** Real plugin/lifecycle/boot rescan; only the host services and KV backend are fake. */
function activationFixture(checkpoints: readonly InboxJobCheckpoint[]) {
  const tables = new Map<string, Map<string, unknown>>([
    [INBOX_TABLE_NAME, new Map(checkpoints.map((row) => [row.jobId, row]))],
  ]);
  const commands = new Map<string, CommandDefinitionLike>();
  const disposers: Array<() => void> = [];
  const scoped = new Map<string, unknown>();
  const wakes: unknown[] = [];
  let finishPresentation!: () => void;
  const presented = new Promise<void>((resolve) => { finishPresentation = resolve; });
  const agent = {
    session: { id: "s-1", header: { parentSession: null, delegationDepth: 0 } },
    followup(message: unknown) { wakes.push(message); },
    inject() {},
    ctx: { tools: {
      schemas: () => [...scoped.keys()].map((name) => ({ name })),
      register(definition: { name: string }) {
        scoped.set(definition.name, definition);
        return () => { scoped.delete(definition.name); };
      },
    } },
  };
  const ctx = {
    effect(execute: () => unknown) {
      const result = execute();
      if (typeof result === "function") disposers.push(result as () => void);
      else if (typeof result === "object" && result !== null && Symbol.iterator in result) {
        for (const dispose of result as Iterable<unknown>) {
          if (typeof dispose === "function") disposers.push(dispose as () => void);
        }
      }
    },
    inject() {},
    get() { return undefined; },
    on() { return () => {}; },
    commands: { register(definition: CommandDefinitionLike) {
      commands.set(definition.name, definition);
      return () => { commands.delete(definition.name); };
    } },
    tools: { schemas: () => [], register: () => () => {} },
    subagents: {
      async startActivation() {
        throw new Error("inbox rescan must not spawn a worker");
      },
      interrupt() {},
      async sendMessage() { throw new Error("inbox rescan must not send to a worker"); },
    },
    agents: { get: (id: string) => id === "s-1" ? agent : undefined },
    jobs: { list: () => [] },
    storageDomain: { async open() { return {
      async table(name: string) {
        let table = tables.get(name);
        if (table === undefined) { table = new Map(); tables.set(name, table); }
        const bound = table;
        return {
          get: (key: string) => bound.get(key),
          entries: () => bound.entries(),
          async put(key: string, value: unknown) {
            bound.set(key, value);
            if (name === INBOX_TABLE_NAME &&
                (value as InboxJobCheckpoint).state === "presented" &&
                (value as InboxJobCheckpoint).jobId === checkpoints.at(-1)?.jobId) finishPresentation();
          },
          async delete(key: string) { return bound.delete(key); },
        };
      },
      async close() {},
      name: "offline-304",
    }; } },
  };
  return {
    tables, wakes, presented,
    async start(root: string) {
      // Intake is OFF: only the actual activation rescan runs, with no watcher/timer.
      apply(ctx as never, {
        enabled: { get: () => true },
        inboxEnabled: { get: () => false },
        inboxDir: { get: () => root },
      });
      const command = commands.get(DISPATCHER_START_COMMAND);
      assert.ok(command, "real activation command registered");
      const result = await command.handler({ agent } as never);
      assert.equal(result.kind, "success");
    },
    dispose() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ text?: string }> }).content;
  return Array.isArray(content) ? content.map((block) => block.text ?? "").join("") : "";
}

test("activation preserves a valid literal id that looks like an encoded checkpoint key",
  { timeout: 5_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-inbox-304-literal-"));
    let fixture: ReturnType<typeof activationFixture> | undefined;
    try {
      const literalId = "enc_am9iLTE_026ab639";
      for (const jobId of [literalId, "sentinel"]) {
        await mkdir(join(root, jobId));
        await writeFile(join(root, jobId, "prompt.md"), "offline material", "utf8");
      }
      await writeFile(join(root, "queue.jsonl"), [literalId, "sentinel"]
        .map((jobId) => JSON.stringify({ jobId })).join("\n") + "\n", "utf8");
      const queue = await readInboxQueue(root);
      assert.equal(queue.entries.length, 2);
      for (const entry of queue.entries) assert.equal(await claimInboxJob(entry, 7, root), true);
      fixture = activationFixture(queue.entries.map((entry) => ({
        jobId: inboxCheckpointKey(entry.jobId), jobDir: entry.dir, state: "claimed",
        sessionId: null, todoId: null, claimedAtMs: 7, presentedAtMs: null,
        endedAtMs: null, presentAttempts: 0,
      })));
      await fixture.start(root);
      await fixture.presented;
      const checkpoints = fixture.tables.get(INBOX_TABLE_NAME)!;
      assert.equal((checkpoints.get(literalId) as InboxJobCheckpoint).state, "presented",
        "an accepted encoded-looking literal id must not be decoded into a different job");
      assert.deepEqual([...checkpoints.keys()], [literalId, "sentinel"]);
      const wake = fixture.wakes.map(textOf).join("\n");
      assert.ok(wake.includes(`### Inbox job ${literalId}`));
      assert.ok(!wake.includes("### Inbox job job-1"));
    } finally {
      fixture?.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

test("activation refuses an invalid decoded identity instead of trusting a valid directory basename",
  { timeout: 5_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-inbox-304-invalid-"));
    let fixture: ReturnType<typeof activationFixture> | undefined;
    try {
      const invalidKey = inboxCheckpointKey("bad.id");
      const invalidDir = join(root, "valid-looking");
      const sentinelDir = join(root, "sentinel");
      for (const dir of [invalidDir, sentinelDir]) {
        await mkdir(dir);
        await writeFile(join(dir, "prompt.md"), "offline material", "utf8");
      }
      const row = (jobId: string, jobDir: string): InboxJobCheckpoint => ({
        jobId, jobDir, state: "claimed", sessionId: null, todoId: null,
        claimedAtMs: 7, presentedAtMs: null, endedAtMs: null, presentAttempts: 0,
      });
      const invalid = row(invalidKey, invalidDir);
      fixture = activationFixture([invalid, row("sentinel", sentinelDir)]);
      await fixture.start(root);
      // The last row's presentation is a deterministic completion signal for
      // processing the earlier invalid row; no sleep/poll or private rescan call.
      await fixture.presented;
      const checkpoints = fixture.tables.get(INBOX_TABLE_NAME)!;
      assert.deepEqual([...checkpoints.keys()], [invalidKey, "sentinel"]);
      assert.deepEqual(checkpoints.get(invalidKey), invalid, "invalid row is not advanced");
      assert.equal(checkpoints.has("valid-looking"), false, "basename cannot invent an identity");
      const wakes = fixture.wakes.map(textOf).filter((text) => text.includes(INBOX_JOBS_HEADING));
      assert.equal(wakes.length, 1, "only the valid sentinel job wakes the dispatcher");
      assert.ok(wakes[0]!.includes("### Inbox job sentinel"));
      assert.ok(!wakes[0]!.includes("### Inbox job valid-looking"));
    } finally {
      fixture?.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

test("activation preserves the accepted job-1 identity for canonical Windows Job-1",
  { timeout: 5_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-inbox-304-"));
    let fixture: ReturnType<typeof activationFixture> | undefined;
    try {
      const canonicalDir = join(root, "Job-1");
      await mkdir(canonicalDir);
      try {
        await realpath(join(root, "job-1"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        t.skip("test filesystem is case-sensitive");
        return;
      }
      await writeFile(join(canonicalDir, "prompt.md"), "offline material", "utf8");
      await writeFile(join(root, "queue.jsonl"),
        `${JSON.stringify({ jobId: "job-1", text: "queue material" })}\n`, "utf8");
      const queue = await readInboxQueue(root);
      assert.equal(queue.malformed, 0);
      assert.equal(queue.entries.length, 1, "real queue reader accepts equivalent casing");
      const entry = queue.entries[0]!;
      assert.equal(entry.jobId, "job-1");
      assert.equal(basename(entry.dir), "Job-1");
      assert.equal(entry.dir, await realpath(canonicalDir));
      assert.equal(await claimInboxJob(entry, 7, root), true, "real claim retains containment");
      assert.equal(JSON.parse(await readFile(join(entry.dir, "status.json"), "utf8")).jobId, "job-1");
      // Exact shape written by onInboxJobClaimed, not a reimplementation of rescan.
      fixture = activationFixture([{
        jobId: inboxCheckpointKey(entry.jobId), jobDir: entry.dir, state: "claimed",
        sessionId: null, todoId: null, claimedAtMs: 7, presentedAtMs: null,
        endedAtMs: null, presentAttempts: 0,
      }]);
      await fixture.start(root);
      await fixture.presented;
      const checkpoints = fixture.tables.get(INBOX_TABLE_NAME)!;
      assert.deepEqual([...checkpoints.keys()], ["job-1"], "one job retains one durable identity");
      const checkpoint = checkpoints.get("job-1") as InboxJobCheckpoint;
      assert.equal(checkpoint.state, "presented");
      assert.equal(checkpoint.jobDir, entry.dir, "canonical directory stays unchanged");
      assert.equal(checkpoint.claimedAtMs, 7);
      assert.equal(checkpoint.presentAttempts, 1);
      assert.ok(checkpoint.todoId);
      const wakes = fixture.wakes.map(textOf).filter((text) => text.includes(INBOX_JOBS_HEADING));
      assert.equal(wakes.length, 1);
      assert.ok(wakes[0]!.includes("### Inbox job job-1"), "wake uses accepted identity");
      assert.ok(wakes[0]!.includes(`${checkpoint.todoId} · pending · Inbox job job-1`),
        "public ledger reminder keeps the original job identity");
    } finally {
      fixture?.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
