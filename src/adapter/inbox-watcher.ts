/**
 * Inbox watcher — the adapter half of the opt-in file intake (ticket 113,
 * ADR-0023). This is the first `fs` dependency in `src/`: filesystem
 * watching lives in the adapter only, never core (ADR-0023 consequence 1).
 *
 * ## Wire protocol (MIT-inspired pattern, adapted — no upstream code)
 *
 *   <inboxDir>/queue.jsonl       one JSON object per line: {jobId, text, dir?, images?, ...}
 *   <inboxDir>/<jobId>/job.json  optional job detail (queue line wins where both exist)
 *   <inboxDir>/<jobId>/prompt.md full prompt — takes priority over entry.text
 *   <inboxDir>/<jobId>/reply.md  plugin-written reply; NON-EMPTY = done
 *   <inboxDir>/<jobId>/status.json  lifecycle: queued? → claimed → replied | failed | cancelled
 *
 * A queue line whose job carries a status.json in any state other than
 * absent/`queued`, or a non-empty `reply.md`, is skipped: it was already
 * claimed (by us in a previous run — the boot rescan owns those — or by
 * another consumer) or finished. `images` entries are tolerated and parsed
 * but not surfaced: the wake turn presents text material only (attachments
 * stay outside the shipped scope).
 *
 * ## Multi-dispatcher routing policy (ticket 113)
 *
 * The watcher does NOT choose the session. The plugin routes every claimed
 * job deterministically: exactly one live dispatcher session → that
 * session; several → the EARLIEST-ACTIVATED live session
 * (`lifecycle.dispatcherSessionIds()[0]` — the map is insertion-ordered);
 * none → the job stays claimed-but-unpresented in our checkpoint and is
 * re-presented on the next activation (honest dormant posture, ADR-0023
 * decision 4). Rationale: one job, one presentation, ever — a background
 * rank wake must not fan out across sibling dispatchers, and the earliest
 * activation is the stable, reproducible choice that does not depend on
 * wake timing.
 *
 * ## Known honest limitations (documented, accepted)
 *
 * - Crash window: a claim writes `status.json` first, then the checkpoint
   row. A crash between the two leaves a claimed job our checkpoint does
   not know — it is never re-presented (the external system sees
   `status.json: claimed` forever). The inverse order would double-claim
   instead, which the ticket forbids.
 * - A malformed queue line (unparsable JSON, missing jobId, or no resolvable
   prompt text) is skipped and surfaced through `onError` — the watcher
   never crashes, and the line is never retried (it stays in the file;
   re-writing the file is the external system's business).
 * - At most `limit` (default 50) jobs are claimed per pass; a larger
   backlog is picked up by the following rescan, keeping each wake batch
   bounded.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { watch as watchFs, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

/** One claimable job as resolved from the queue. */
export interface InboxQueueEntry {
  readonly jobId: string;
  /** Job directory (entry.dir when it exists on disk, else <root>/<jobId>). */
  readonly dir: string;
  /** Resolved prompt: prompt.md over entry.text over job.json.text. */
  readonly text: string;
  /** Attachment paths from the queue line — parsed, not surfaced (see header). */
  readonly images: readonly string[];
}

/** What one scan pass found. */
export interface InboxScanReport {
  /** Jobs claimed THIS pass (claimed → handed to `onJob`). */
  readonly claimed: readonly InboxQueueEntry[];
  /** Queue lines skipped because the job was already claimed or finished. */
  readonly skipped: number;
  /** Unparsable/unusable queue lines (surfaced through `onError`). */
  readonly malformed: number;
}

async function readTextIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readJsonIfPresent(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Atomic write: tmp file + rename, so a reader never sees a partial file. */
export async function atomicWriteFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

/**
 * Write the job's status.json atomically. `payload` is merged with the
 * identity fields the protocol carries on every state.
 */
async function writeStatus(
  dir: string,
  jobId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await atomicWriteFile(
    join(dir, "status.json"),
    `${JSON.stringify({ jobId, ...payload }, null, 2)}\n`,
  );
}

/**
 * Read queue.jsonl and resolve the claimable jobs, in queue order.
 * Never throws for per-line problems — those count as `malformed`.
 */
export async function readInboxQueue(root: string): Promise<{
  entries: InboxQueueEntry[];
  skipped: number;
  malformed: number;
}> {
  const queueText = await readTextIfPresent(join(root, "queue.jsonl"));
  const entries: InboxQueueEntry[] = [];
  let skipped = 0;
  let malformed = 0;
  for (const line of queueText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      malformed += 1;
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    const jobId = String(entry.jobId ?? "").trim();
    if (jobId.length === 0) {
      malformed += 1;
      continue;
    }
    // Directory normalization: a stale entry.dir (e.g. a path from another
    // machine) falls back to <root>/<jobId> so we never claim into a place
    // the external system did not prepare.
    const rawDir = String(entry.dir ?? "").trim();
    const dir =
      rawDir.length > 0 && (await pathExists(rawDir))
        ? resolve(rawDir)
        : join(root, jobId);
    const status = await readJsonIfPresent(join(dir, "status.json"));
    if (status !== null && status.status !== "queued") {
      skipped += 1;
      continue;
    }
    const reply = await readTextIfPresent(join(dir, "reply.md"));
    if (reply.trim().length > 0) {
      skipped += 1;
      continue;
    }
    const promptMd = (await readTextIfPresent(join(dir, "prompt.md"))).trim();
    const jobJson = await readJsonIfPresent(join(dir, "job.json"));
    const text =
      promptMd ||
      String(entry.text ?? "").trim() ||
      String(jobJson?.text ?? "").trim();
    if (text.length === 0) {
      // A job with no resolvable prompt is not presentable — honest skip.
      malformed += 1;
      continue;
    }
    const images = Array.isArray(entry.images)
      ? entry.images.map(String)
      : [];
    entries.push({ jobId, dir, text, images });
  }
  return { entries, skipped, malformed };
}

/** Claim one job: per-job dir + status.json {status:"claimed"} atomically. */
export async function claimInboxJob(
  entry: InboxQueueEntry,
  nowMs: number,
): Promise<void> {
  await mkdir(entry.dir, { recursive: true });
  await writeStatus(entry.dir, entry.jobId, {
    status: "claimed",
    claimedAt: nowMs,
  });
}

/** Reply (done) signal: non-empty reply.md + status.json {status:"replied"}. */
export async function writeInboxReply(
  dir: string,
  jobId: string,
  replyText: string,
  startedAtMs: number | null,
  nowMs: number,
): Promise<void> {
  const text = `${replyText.trim()}\n`;
  await atomicWriteFile(join(dir, "reply.md"), text);
  await writeStatus(dir, jobId, {
    status: "replied",
    startedAt: startedAtMs,
    endedAt: nowMs,
    replyBytes: Buffer.byteLength(text, "utf8"),
  });
}

/** Failure signal: status.json {status:"failed", error} — no reply.md. */
export async function writeInboxFailed(
  dir: string,
  jobId: string,
  error: string,
  startedAtMs: number | null,
  nowMs: number,
): Promise<void> {
  await writeStatus(dir, jobId, {
    status: "failed",
    startedAt: startedAtMs,
    endedAt: nowMs,
    error: error.slice(0, 2000),
  });
}

/** Cancel signal: status.json {status:"cancelled", reason} — no reply.md. */
export async function writeInboxCancelled(
  dir: string,
  jobId: string,
  reason: string,
  startedAtMs: number | null,
  nowMs: number,
): Promise<void> {
  await writeStatus(dir, jobId, {
    status: "cancelled",
    startedAt: startedAtMs,
    endedAt: nowMs,
    reason: reason.slice(0, 500),
  });
}

/** What the job dir itself says (ticket 113 boot rescan reads this). */
export interface InboxJobDiskState {
  /** status.json `status`, or null when absent/unparsable (never claimed). */
  readonly status: string | null;
  /** reply.md exists and is non-empty — the protocol's done signal. */
  readonly replyPresent: boolean;
}

/**
 * Read a job dir's on-disk lifecycle state. Never throws: a missing or
 * unparsable status.json reads as `null` (the job was never claimed on
 * disk), and an unreadable reply.md reads as not-done.
 */
export async function readInboxJobDiskState(
  dir: string,
): Promise<InboxJobDiskState> {
  const status = await readJsonIfPresent(join(dir, "status.json"));
  const statusValue =
    status !== null && typeof status.status === "string"
      ? status.status
      : null;
  const reply = await readTextIfPresent(join(dir, "reply.md"));
  return { status: statusValue, replyPresent: reply.trim().length > 0 };
}

/**
 * Re-resolve a claimed job's prompt at boot time (ticket 113 boot rescan):
 * `prompt.md` first; if absent, the job's queue line (claimed lines are
 * invisible to {@link readInboxQueue}, but the external system leaves them
 * in place). Null when neither carries text — the honest "cannot re-present"
 * answer for a job whose prompt sources are gone.
 */
export async function resolveInboxJobText(
  root: string,
  dir: string,
  jobId: string,
): Promise<string | null> {
  const promptMd = (await readTextIfPresent(join(dir, "prompt.md"))).trim();
  if (promptMd.length > 0) return promptMd;
  const queueText = await readTextIfPresent(join(root, "queue.jsonl"));
  for (const line of queueText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      const entry = parsed as Record<string, unknown>;
      if (String(entry.jobId ?? "").trim() !== jobId) continue;
      const text = String(entry.text ?? "").trim();
      if (text.length > 0) return text;
    } catch {
      // Unparsable lines are readInboxQueue's business; skip here.
    }
  }
  const jobJson = await readJsonIfPresent(join(dir, "job.json"));
  const text = String(jobJson?.text ?? "").trim();
  return text.length > 0 ? text : null;
}

export interface InboxWatcherOptions {
  /** The watched directory (the external system's store — never written by us beyond per-job claim/reply files). */
  readonly root: string;
  /** Fallback rescan interval in ms (config `inboxRescanIntervalMs`, min 1000). */
  readonly rescanIntervalMs: number;
  /** Called for every job claimed THIS pass (already claimed on disk). */
  readonly onJob: (entry: InboxQueueEntry) => void;
  /** Honest surfacing for malformed lines / scan-claim failures. Never fatal. */
  readonly onError: (error: unknown, context: string) => void;
  /**
   * Injectable one-shot scheduler (watch debounce + rescan interval re-arm).
   * Default uses real timers. Tests inject a manual scheduler — no real
   * timer may stay armed past a test.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Injectable clock. Defaults to Date.now. */
  readonly now?: () => number;
  /** Max jobs claimed per pass. Default 50. */
  readonly limit?: number;
}

export interface InboxWatcherHandle {
  /** Stop watching and cancel every armed timer. Idempotent. */
  stop(): void;
  /**
   * Run one scan-claim pass now. Directly callable so tests can drive the
   * protocol deterministically without waiting on timers.
   */
  scanOnce(): Promise<InboxScanReport | null>;
}

/** Watch-event debounce: coalesce a burst of fs events into one scan. */
const WATCH_DEBOUNCE_MS = 25;

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  // Never hold the host process open just for the inbox fallback.
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Start the inbox watcher: `fs.watch` (event-driven) plus a rescan-interval
 * fallback (ADR-0023 decision 1), both funneling into the same guarded
 * scan-claim pass. The dir is created if missing (upstream-compatible
 * posture); watch errors surface through `onError` and stop the watch —
 * the interval fallback keeps the intake alive.
 */
export function startInboxWatcher(
  options: InboxWatcherOptions,
): InboxWatcherHandle {
  const root = options.root;
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? Date.now;
  const limit = options.limit ?? 50;
  let stopped = false;
  let scanning = false;
  let scanPending = false;
  let cancelWatchDebounce: (() => void) | null = null;
  let cancelRescan: (() => void) | null = null;
  let fsWatcher: FSWatcher | null = null;

  const fail = (error: unknown, context: string): void => {
    try {
      options.onError(error, context);
    } catch {
      // An observer that throws must not break the watcher loop either.
    }
  };

  async function scanOnce(): Promise<InboxScanReport | null> {
    if (stopped || scanning) return null;
    scanning = true;
    try {
      const { entries, skipped, malformed } = await readInboxQueue(root);
      if (malformed > 0) {
        fail(
          new Error(
            `inbox: skipped ${malformed} malformed queue line(s) in ${root}`,
          ),
          "scan",
        );
      }
      const claimed: InboxQueueEntry[] = [];
      for (const entry of entries) {
        if (claimed.length >= limit) break;
        try {
          await claimInboxJob(entry, now());
        } catch (error) {
          fail(error, `claim ${entry.jobId}`);
          continue;
        }
        claimed.push(entry);
        try {
          options.onJob(entry);
        } catch (error) {
          fail(error, `onJob ${entry.jobId}`);
        }
      }
      return { claimed, skipped, malformed };
    } catch (error) {
      fail(error, "scan");
      return null;
    } finally {
      scanning = false;
    }
  }

  /** Debounced scan: a burst of fs events produces at most one queued scan. */
  function scheduleScan(): void {
    if (stopped || scanPending) return;
    scanPending = true;
    cancelWatchDebounce = schedule(() => {
      scanPending = false;
      cancelWatchDebounce = null;
      void scanOnce();
    }, WATCH_DEBOUNCE_MS);
  }

  function armRescan(): void {
    if (stopped) return;
    cancelRescan = schedule(() => {
      cancelRescan = null;
      void scanOnce().then(() => {
        armRescan();
      });
    }, Math.max(1000, options.rescanIntervalMs));
  }

  void (async () => {
    try {
      await mkdir(root, { recursive: true });
    } catch (error) {
      fail(error, "ensure dir");
    }
    if (stopped) return;
    try {
      fsWatcher = watchFs(root, { persistent: false }, () => scheduleScan());
      fsWatcher.on("error", (error: Error) => {
        fail(error, "fs.watch");
        // The interval fallback owns intake from here; drop the dead watch.
        fsWatcher = null;
      });
    } catch (error) {
      fail(error, "start fs.watch");
    }
    // Initial sweep: jobs queued before we started are picked up now.
    void scanOnce().then(() => armRescan());
  })();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelWatchDebounce?.();
      cancelWatchDebounce = null;
      cancelRescan?.();
      cancelRescan = null;
      if (fsWatcher !== null) {
        // fs.watch errors after close() are prevented by the null guard; the
        // "error" handler also already cleared the reference on a dead watch.
        fsWatcher.close();
        fsWatcher = null;
      }
    },
    scanOnce,
  };
}
