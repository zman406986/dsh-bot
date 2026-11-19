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
 *   <inboxDir>/<jobId>/claim.lock  our exclusive-claim marker (never removed after a
 *                                successful claim: it is the crash-safe "claimed forever" row)
 *
 * A queue line whose job carries a status.json in any state other than
 * absent/`queued`, or a non-empty `reply.md`, is skipped: it was already
 * claimed (by us in a previous run — the boot rescan owns those — or by
 * another consumer) or finished. `images` entries are tolerated and parsed
 * but not surfaced: the wake turn presents text material only (attachments
 * stay outside the shipped scope).
 *
 * ## Second-round audit hardening (all external input is untrusted)
 *
 * - **Containment.** A queue line's `dir` is a RELATIVE hint only. Absolute
 *   paths, drive-absolute paths, UNC/device paths, `..` components, symlinks
 *   and junctions are rejected, and the canonical target (realpath) must be
 *   exactly `<realpath(root)>/<jobId>` — never another job's directory.
 *   Recorded checkpoint dirs take the same check when a root is configured;
 *   with the inbox disabled/empty they are accepted only as absolute, real
 *   (non-symlink) directories named after the job id, so a recorded job is
 *   still resolvable without ever falling back to the process cwd.
 * - **Bounded reads.** `queue.jsonl`, `prompt.md`, `job.json`, `status.json`
 *   and `reply.md` are size-capped before reading, the queue also has a line
 *   cap, `images` is truncated, and a scan resolves at most `limit` entries.
 *   Every overflow skips the entry with a logged reason; the watcher never
 *   throws into its scan loop.
 * - **Job ids.** Only `^[A-Za-z0-9_-]{1,64}$` ids are accepted. The same set
 *   is the durable checkpoint key grammar, so a claimed job is always
 *   recordable (see `inboxCheckpointKey` for the encoded fallback used if the
 *   accepted grammar ever broadens).
 * - **Exclusive claim.** A claim takes a `claim.lock` with an exclusive
 *   create, then re-reads `status.json`/`reply.md` under the lock and only
 *   then writes `claimed`. A terminal status or a non-empty reply is never
 *   overwritten.
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
 *   row. A crash between the two leaves a claimed job our checkpoint does
 *   not know — it is never re-presented (the external system sees
 *   `status.json: claimed` forever). The inverse order would double-claim
 *   instead, which the ticket forbids.
 * - A malformed queue line (unparsable JSON, unsafe/missing jobId, an unsafe
 *   directory, an oversized file, or no resolvable prompt text) is skipped
 *   and surfaced through `onError` — the watcher never crashes, and the line
 *   is never retried (it stays in the file; re-writing the file is the
 *   external system's business).
 * - At most `limit` (default 50) jobs are resolved/claimed per pass; a larger
 *   backlog is picked up by the following rescan, keeping each wake batch
 *   bounded.
 */

import { mkdir, readFile, realpath, rename, lstat, unlink, writeFile } from "node:fs/promises";
import { watch as watchFs, type FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** Accepted job-id grammar: also the durable per-record checkpoint key grammar. */
export const INBOX_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Longest accepted job id. */
export const INBOX_MAX_JOB_ID_LENGTH = 64;
/** Queue file size ceiling (bytes). Over it the whole pass is skipped. */
export const INBOX_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
/** Queue line ceiling. Over it the whole pass is skipped. */
export const INBOX_QUEUE_MAX_LINES = 10_000;
/** prompt.md size ceiling (bytes). */
export const INBOX_PROMPT_MAX_BYTES = 1024 * 1024;
/** job.json size ceiling (bytes). */
export const INBOX_JOB_JSON_MAX_BYTES = 64 * 1024;
/** status.json size ceiling (bytes). */
export const INBOX_STATUS_JSON_MAX_BYTES = 16 * 1024;
/** reply.md size ceiling (bytes). */
export const INBOX_REPLY_MAX_BYTES = 1024 * 1024;
/** Attachment list ceiling (tolerated, not surfaced). */
export const INBOX_MAX_IMAGES = 32;
/** One attachment path's display ceiling (chars). */
export const INBOX_IMAGE_PATH_MAX_CHARS = 4096;
/** Default resolved/claimed jobs per scan. */
export const INBOX_DEFAULT_LIMIT = 50;

/** Where a job's prompt text actually came from. */
export type InboxPromptSource = "prompt.md" | "queue.jsonl" | "job.json" | "unknown";

/** One claimable job as resolved from the queue. */
export interface InboxQueueEntry {
  readonly jobId: string;
  /** Canonical job directory: `<realpath(root)>/<jobId>` (never anywhere else). */
  readonly dir: string;
  /** Resolved prompt: prompt.md over entry.text over job.json.text. */
  readonly text: string;
  /** Which source {@link text} came from (used for honest truncation pointers). */
  readonly source: InboxPromptSource;
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

/** True when `value` is a job id safe to use as a path segment/checkpoint key. */
export function isValidInboxJobId(value: unknown): boolean {
  return typeof value === "string" && INBOX_JOB_ID_PATTERN.test(value);
}

/**
 * Display-safe rendering of an external job id. A job id never travels raw
 * into a wake heading or a ledger title: newlines and Markdown heading
 * markers are replaced and the result is length-bounded. Valid ids are
 * returned unchanged.
 */
export function sanitizeInboxJobId(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  if (isValidInboxJobId(raw)) return raw;
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, INBOX_MAX_JOB_ID_LENGTH);
  return cleaned.length > 0 ? cleaned : "job";
}

function encodedKeyChecksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/**
 * Durable checkpoint key for one job id.
 *
 * The storage-domain per-record layout requires keys to match
 * `[A-Za-z0-9_-]+`. Every id the queue grammar accepts already matches, so
 * this is the identity in the shipped path; an id that ever reaches here
 * outside that grammar is encoded (base64url + a checksum tag) instead of
 * being rejected by the store — the failure mode the audit found:
 * `status.json` claimed, no checkpoint row, so a boot rescan never sees the
 * job again. The checksum keeps an ordinary id that merely LOOKS like an
 * encoded key from being decoded by mistake.
 */
export function inboxCheckpointKey(jobId: string): string {
  if (INBOX_JOB_ID_PATTERN.test(jobId)) return jobId;
  const body = Buffer.from(jobId, "utf8").toString("base64url");
  return `enc_${body}_${encodedKeyChecksum(jobId)}`;
}

/** Inverse of {@link inboxCheckpointKey}; unknown shapes are returned as-is. */
export function inboxJobIdFromCheckpointKey(key: string): string {
  if (!key.startsWith("enc_")) return key;
  const at = key.lastIndexOf("_");
  if (at <= 4 || at === key.length - 1) return key;
  const body = key.slice(4, at);
  const tag = key.slice(at + 1);
  try {
    const decoded = Buffer.from(body, "base64url").toString("utf8");
    return encodedKeyChecksum(decoded) === tag ? decoded : key;
  } catch {
    return key;
  }
}

/** Resolution outcome for a job directory (never a cwd-relative path). */
export interface InboxDirResolution {
  readonly dir: string | null;
  readonly reason: string;
}

function unsafeQueueDirReason(raw: string): string | null {
  if (raw.length === 0) return "empty path";
  if (raw.includes("\0")) return "NUL byte";
  if (/^[A-Za-z]:/u.test(raw)) return "drive-absolute path";
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return "UNC or device path";
  if (raw.startsWith("\\") || raw.startsWith("/")) return "absolute path";
  if (raw.includes(":")) return "colon in path";
  const parts = raw.split(/[\\/]+/u);
  if (parts.some((part) => part === "..")) return "'..' traversal component";
  return null;
}

function unsafeRecordedDirReason(raw: string): string | null {
  if (raw.includes("\0")) return "NUL byte";
  if (/^\\\\[.?]\\/u.test(raw) || raw.startsWith("\\\\.\\")) return "device path";
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return "UNC path";
  const parts = raw.split(/[\\/]+/u);
  if (parts.some((part) => part === "..")) return "'..' traversal component";
  return null;
}

function sameName(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** lstat + realpath check: a real directory (never a symlink/junction). */
async function inspectDirectory(
  path: string,
): Promise<{ readonly ok: true; readonly real: string } | { readonly ok: false; readonly reason: string }> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { ok: false, reason: "does not exist" };
  }
  if (info.isSymbolicLink()) return { ok: false, reason: "symlink/junction target" };
  if (!info.isDirectory()) return { ok: false, reason: "not a directory" };
  const real = await realpathOrNull(path);
  if (real === null) return { ok: false, reason: "realpath failed" };
  return { ok: true, real };
}

/** True when `targetReal` is exactly `<rootReal>/<jobId>` (one segment, no escape). */
function isJobDirUnderRoot(rootReal: string, targetReal: string, jobId: string): boolean {
  const rel = relative(rootReal, targetReal);
  if (rel.length === 0 || isAbsolute(rel)) return false;
  const segments = rel.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  return segments.length === 1 && sameName(segments[0] as string, jobId);
}

async function resolveFallbackJobDir(rootReal: string, jobId: string): Promise<InboxDirResolution> {
  const target = join(rootReal, jobId);
  const inspected = await inspectDirectory(target);
  if (inspected.ok) {
    if (!isJobDirUnderRoot(rootReal, inspected.real, jobId)) {
      return { dir: null, reason: "job dir resolves outside the inbox root" };
    }
    return { dir: inspected.real, reason: "" };
  }
  if (inspected.reason === "does not exist") {
    // The claim creates it; the lexical path is under the canonical root and
    // the id is a single validated segment, so it cannot escape.
    return { dir: target, reason: "" };
  }
  return { dir: null, reason: inspected.reason };
}

/**
 * Resolve a queue line's optional `dir` hint into a canonical job directory
 * that is provably `<realpath(root)>/<jobId>`. The hint is relative-only and
 * cannot escape the root; a missing hint (or a hint that does not exist yet)
 * falls back to the protocol's own `<root>/<jobId>`.
 */
export async function resolveQueueJobDir(
  root: string,
  jobId: string,
  rawDir: string,
): Promise<InboxDirResolution> {
  if (!isValidInboxJobId(jobId)) {
    return { dir: null, reason: "unsafe job id" };
  }
  if (root.trim().length === 0) return { dir: null, reason: "empty inbox root" };
  if (!isAbsolute(root)) return { dir: null, reason: "inbox root is not absolute" };
  const rootReal = await realpathOrNull(root);
  if (rootReal === null) return { dir: null, reason: "inbox root is not resolvable" };

  const hint = rawDir.trim();
  if (hint.length > 0) {
    const unsafe = unsafeQueueDirReason(hint);
    if (unsafe !== null) return { dir: null, reason: `unsafe dir hint (${unsafe})` };
    const candidate = resolve(rootReal, hint);
    const inspected = await inspectDirectory(candidate);
    if (inspected.ok) {
      if (!isJobDirUnderRoot(rootReal, inspected.real, jobId)) {
        return {
          dir: null,
          reason: "dir hint is not this job's directory under the inbox root",
        };
      }
      return { dir: inspected.real, reason: "" };
    }
    if (inspected.reason !== "does not exist") {
      return { dir: null, reason: inspected.reason };
    }
    // A stale hint (e.g. a path from another machine) falls back to the
    // protocol directory — never to the hint itself.
  }
  return resolveFallbackJobDir(rootReal, jobId);
}

/**
 * Resolve a RECORDED checkpoint directory. With a configured root the same
 * containment rule as a queue hint applies. With no root configured (the
 * inbox was disabled/cleared before this restart) the recorded absolute path
 * is still usable — but only when it is a real directory whose own name is
 * the job id. Never returns a cwd-relative path.
 */
export async function resolveRecordedJobDir(
  root: string,
  jobId: string,
  recordedDir: string,
): Promise<InboxDirResolution> {
  if (!isValidInboxJobId(jobId)) {
    return { dir: null, reason: "unsafe job id" };
  }
  const raw = recordedDir.trim();
  if (raw.length === 0) {
    if (root.trim().length === 0) {
      return { dir: null, reason: "no recorded dir and no inbox root" };
    }
    if (!isAbsolute(root)) return { dir: null, reason: "inbox root is not absolute" };
    const rootReal = await realpathOrNull(root);
    if (rootReal === null) return { dir: null, reason: "inbox root is not resolvable" };
    return resolveFallbackJobDir(rootReal, jobId);
  }
  const unsafe = unsafeRecordedDirReason(raw);
  if (unsafe !== null) return { dir: null, reason: `unsafe recorded dir (${unsafe})` };
  if (!isAbsolute(raw)) return { dir: null, reason: "recorded dir is not absolute" };

  const inspected = await inspectDirectory(raw);
  if (!inspected.ok) {
    if (inspected.reason === "does not exist") {
      if (root.trim().length === 0) {
        // No root to contain against: accept the absolute, traversal-free path
        // only when its final segment IS the job id (the disabled-at-restart
        // claim case creates the recorded directory on first use).
        if (!sameName(basename(raw), jobId)) {
          return { dir: null, reason: "recorded dir is not named after the job id" };
        }
        return { dir: raw, reason: "" };
      }
      // The queue resolves the protocol path before the claim creates it (and
      // a recorded dir may have been cleaned up between runs). Fall back to
      // the protocol directory under the canonical root; never to a cwd path.
      if (!isAbsolute(root)) return { dir: null, reason: "inbox root is not absolute" };
      const rootReal = await realpathOrNull(root);
      if (rootReal === null) return { dir: null, reason: "inbox root is not resolvable" };
      return resolveFallbackJobDir(rootReal, jobId);
    }
    return { dir: null, reason: inspected.reason };
  }

  if (root.trim().length === 0) {
    if (!sameName(basename(inspected.real), jobId)) {
      return { dir: null, reason: "recorded dir is not named after the job id" };
    }
    return { dir: inspected.real, reason: "" };
  }

  if (!isAbsolute(root)) return { dir: null, reason: "inbox root is not absolute" };
  const rootReal = await realpathOrNull(root);
  if (rootReal === null) return { dir: null, reason: "inbox root is not resolvable" };
  if (!isJobDirUnderRoot(rootReal, inspected.real, jobId)) {
    return {
      dir: null,
      reason: "recorded dir is not this job's directory under the inbox root",
    };
  }
  return { dir: inspected.real, reason: "" };
}

type CappedRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly reason: string }
  | { readonly kind: "oversized"; readonly bytes: number }
  | { readonly kind: "ok"; readonly text: string };

/** Size-checked read; symlinks and non-regular files are refused. */
async function readFileCapped(path: string, maxBytes: number): Promise<CappedRead> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { kind: "missing" };
  }
  if (info.isSymbolicLink()) return { kind: "unsafe", reason: "symlink" };
  if (!info.isFile()) return { kind: "unsafe", reason: "not a regular file" };
  if (info.size > maxBytes) return { kind: "oversized", bytes: info.size };
  try {
    return { kind: "ok", text: await readFile(path, "utf8") };
  } catch {
    return { kind: "missing" };
  }
}

type CappedJsonRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe"; readonly reason: string }
  | { readonly kind: "oversized"; readonly bytes: number }
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly value: Record<string, unknown> };

async function readJsonCapped(path: string, maxBytes: number): Promise<CappedJsonRead> {
  const read = await readFileCapped(path, maxBytes);
  if (read.kind !== "ok") return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}

/**
 * Read queue.jsonl under both ceilings. An overflow is a whole-pass problem
 * (the file cannot be trusted line-by-line), so the caller skips the pass.
 */
async function readQueueFile(
  root: string,
): Promise<{ readonly text: string; readonly problem: string | null }> {
  if (root.trim().length === 0) return { text: "", problem: "empty inbox root" };
  if (!isAbsolute(root)) return { text: "", problem: "inbox root is not absolute" };
  const read = await readFileCapped(join(root, "queue.jsonl"), INBOX_QUEUE_MAX_BYTES);
  if (read.kind === "missing") return { text: "", problem: null };
  if (read.kind === "unsafe") return { text: "", problem: `queue.jsonl: ${read.reason}` };
  if (read.kind === "oversized") {
    return {
      text: "",
      problem: `queue.jsonl is ${read.bytes} bytes (cap ${INBOX_QUEUE_MAX_BYTES}); skipping`,
    };
  }
  const lines = read.text.split("\n");
  if (lines.length > INBOX_QUEUE_MAX_LINES) {
    return {
      text: "",
      problem: `queue.jsonl has ${lines.length} lines (cap ${INBOX_QUEUE_MAX_LINES}); skipping`,
    };
  }
  return { text: read.text, problem: null };
}

export interface ReadInboxQueueOptions {
  /** Resolve at most this many claimable entries. Default 50. */
  readonly limit?: number;
  /** Honest skip reasons (never carries queue text). */
  readonly onProblem?: (reason: string) => void;
}

/**
 * Read queue.jsonl and resolve the claimable jobs, in queue order.
 * Never throws for per-line problems — those count as `malformed`, and every
 * reason is reported through `onProblem`/`problems`.
 */
export async function readInboxQueue(
  root: string,
  options: ReadInboxQueueOptions = {},
): Promise<{
  entries: InboxQueueEntry[];
  skipped: number;
  malformed: number;
  problems: readonly string[];
}> {
  const problems: string[] = [];
  const problem = (reason: string): void => {
    problems.push(reason);
    try {
      options.onProblem?.(reason);
    } catch {
      // An observer that throws must not break the scan.
    }
  };
  const requestedLimit = options.limit;
  const limit =
    typeof requestedLimit === "number" &&
    Number.isFinite(requestedLimit) &&
    requestedLimit >= 1
      ? Math.floor(requestedLimit)
      : INBOX_DEFAULT_LIMIT;

  const queue = await readQueueFile(root);
  if (queue.problem !== null) {
    problem(queue.problem);
    return { entries: [], skipped: 0, malformed: 1, problems };
  }

  const entries: InboxQueueEntry[] = [];
  let skipped = 0;
  let malformed = 0;
  let lineNumber = 0;
  for (const line of queue.text.split("\n")) {
    lineNumber += 1;
    if (entries.length >= limit) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      problem(`queue line ${lineNumber}: unparsable JSON`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed += 1;
      problem(`queue line ${lineNumber}: not a JSON object`);
      continue;
    }
    const entry = parsed as Record<string, unknown>;

    const rawJobId = entry["jobId"];
    if (typeof rawJobId !== "string" || !isValidInboxJobId(rawJobId)) {
      malformed += 1;
      problem(`queue line ${lineNumber}: unsafe or missing jobId`);
      continue;
    }
    const jobId = rawJobId;

    const rawDirValue = entry["dir"];
    if (
      rawDirValue !== undefined &&
      rawDirValue !== null &&
      typeof rawDirValue !== "string"
    ) {
      malformed += 1;
      problem(`queue line ${lineNumber} (${jobId}): dir is not a string`);
      continue;
    }
    const rawDir = typeof rawDirValue === "string" ? rawDirValue : "";
    const resolvedDir = await resolveQueueJobDir(root, jobId, rawDir);
    if (resolvedDir.dir === null) {
      malformed += 1;
      problem(`queue line ${lineNumber} (${jobId}): ${resolvedDir.reason}`);
      continue;
    }
    const dir = resolvedDir.dir;

    const statusRead = await readJsonCapped(
      join(dir, "status.json"),
      INBOX_STATUS_JSON_MAX_BYTES,
    );
    if (statusRead.kind === "oversized") {
      malformed += 1;
      problem(`job ${jobId}: status.json is oversized; skipping`);
      continue;
    }
    if (statusRead.kind === "unsafe") {
      malformed += 1;
      problem(`job ${jobId}: status.json ${statusRead.reason}; skipping`);
      continue;
    }
    const status = statusRead.kind === "ok" ? statusRead.value : null;
    if (status !== null && status["status"] !== "queued") {
      skipped += 1;
      continue;
    }

    try {
      await lstat(join(dir, "claim.lock"));
      skipped += 1;
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        skipped += 1;
        continue;
      }
    }

    const replyRead = await readFileCapped(join(dir, "reply.md"), INBOX_REPLY_MAX_BYTES);
    if (replyRead.kind === "oversized") {
      skipped += 1;
      problem(`job ${jobId}: reply.md is oversized; treating the job as done`);
      continue;
    }
    if (replyRead.kind === "unsafe") {
      skipped += 1;
      problem(`job ${jobId}: reply.md ${replyRead.reason}; treating the job as done`);
      continue;
    }
    if (replyRead.kind === "ok" && replyRead.text.trim().length > 0) {
      skipped += 1;
      continue;
    }

    const promptRead = await readFileCapped(
      join(dir, "prompt.md"),
      INBOX_PROMPT_MAX_BYTES,
    );
    if (promptRead.kind === "oversized") {
      malformed += 1;
      problem(`job ${jobId}: prompt.md is oversized; skipping`);
      continue;
    }
    if (promptRead.kind === "unsafe") {
      malformed += 1;
      problem(`job ${jobId}: prompt.md ${promptRead.reason}; skipping`);
      continue;
    }
    const promptMd = promptRead.kind === "ok" ? promptRead.text.trim() : "";

    const jobRead = await readJsonCapped(
      join(dir, "job.json"),
      INBOX_JOB_JSON_MAX_BYTES,
    );
    if (jobRead.kind === "oversized") {
      malformed += 1;
      problem(`job ${jobId}: job.json is oversized; skipping`);
      continue;
    }
    if (jobRead.kind === "unsafe") {
      malformed += 1;
      problem(`job ${jobId}: job.json ${jobRead.reason}; skipping`);
      continue;
    }
    const jobJson = jobRead.kind === "ok" ? jobRead.value : null;

    // Structured text fields must be strings. Stringifying a number/object
    // would silently turn malformed external data into a task prompt.
    const rawText = entry["text"];
    if (rawText !== undefined && typeof rawText !== "string") {
      malformed += 1;
      problem(`job ${jobId}: entry.text is not a string; skipping`);
      continue;
    }
    const entryText = typeof rawText === "string" ? rawText.trim() : "";

    const jobTextValue = jobJson?.["text"];
    if (jobTextValue !== undefined && typeof jobTextValue !== "string") {
      malformed += 1;
      problem(`job ${jobId}: job.json.text is not a string; skipping`);
      continue;
    }
    const jobText = typeof jobTextValue === "string" ? jobTextValue.trim() : "";

    let text = "";
    let source: InboxPromptSource = "unknown";
    if (promptMd.length > 0) {
      text = promptMd;
      source = "prompt.md";
    } else if (entryText.length > 0) {
      text = entryText;
      source = "queue.jsonl";
    } else if (jobText.length > 0) {
      text = jobText;
      source = "job.json";
    }
    if (text.length === 0) {
      // A job with no resolvable prompt is not presentable — honest skip.
      malformed += 1;
      problem(`job ${jobId}: no resolvable prompt text`);
      continue;
    }

    const rawImages = entry["images"];
    const images = Array.isArray(rawImages)
      ? rawImages
          .filter((value): value is string => typeof value === "string")
          .slice(0, INBOX_MAX_IMAGES)
          .map((value) => value.slice(0, INBOX_IMAGE_PATH_MAX_CHARS))
      : [];

    entries.push({ jobId, dir, text, source, images });
  }
  return { entries, skipped, malformed, problems };
}

/**
 * Atomically write the job's status.json. `payload` is merged with the
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

/** Atomic write: tmp file + rename, so a reader never sees a partial file. */
export async function atomicWriteFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "replied",
  "failed",
  "cancelled",
]);

function isTerminalStatus(value: unknown): boolean {
  return typeof value === "string" && TERMINAL_STATUSES.has(value);
}

/**
 * Claim one job exclusively. Returns true only for the caller that won the
 * job; false when another claimer holds it, the disk already shows a
 * terminal outcome, a non-empty reply exists, or the entry is unsafe.
 *
 * `root` (when given) re-runs the containment check against the canonical
 * inbox root; the watcher always passes it so a mutated entry cannot redirect
 * the claim after resolution.
 */
export async function claimInboxJob(
  entry: InboxQueueEntry,
  nowMs: number,
  root = "",
): Promise<boolean> {
  if (!isValidInboxJobId(entry.jobId)) return false;
  const resolved = await resolveRecordedJobDir(root, entry.jobId, entry.dir);
  if (resolved.dir === null) return false;
  const dir = resolved.dir;

  await mkdir(dir, { recursive: true });

  // Exclusive create: exactly one claimer wins. The lock is deliberately left
  // behind after a successful claim: it is the crash marker that keeps a job
  // whose status write died from being re-claimed forever.
  const lockPath = join(dir, "claim.lock");
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({ jobId: entry.jobId, atMs: nowMs })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  let claimed = false;
  try {
    const status = await readJsonCapped(
      join(dir, "status.json"),
      INBOX_STATUS_JSON_MAX_BYTES,
    );
    if (status.kind === "oversized" || status.kind === "unsafe") return false;
    if (status.kind === "ok" && status.value["status"] !== "queued") {
      return false;
    }
    const reply = await readFileCapped(join(dir, "reply.md"), INBOX_REPLY_MAX_BYTES);
    if (reply.kind === "oversized" || reply.kind === "unsafe") return false;
    if (reply.kind === "ok" && reply.text.trim().length > 0) return false;
    await writeStatus(dir, entry.jobId, { status: "claimed", claimedAt: nowMs });
    claimed = true;
    return true;
  } finally {
    if (!claimed) {
      // This claimer did not win the job; release the lock so a later pass
      // can retry once the interfering state is gone.
      try {
        await unlink(lockPath);
      } catch {
        // Already gone / locked down; the next pass retries.
      }
    }
  }
}

/**
 * Reply (done) signal: non-empty reply.md + status.json {status:"replied"}.
 * Refuses (returns false) when the job already has a non-empty reply, a
 * terminal status, or an unsafe job id — a terminal answer is never
 * overwritten by a replay.
 */
export async function writeInboxReply(
  dir: string,
  jobId: string,
  replyText: string,
  startedAtMs: number | null,
  nowMs: number,
): Promise<boolean> {
  if (!isValidInboxJobId(jobId)) return false;
  if (replyText.trim().length === 0) return false;
  const existingReply = await readFileCapped(join(dir, "reply.md"), INBOX_REPLY_MAX_BYTES);
  if (
    existingReply.kind === "oversized" ||
    existingReply.kind === "unsafe" ||
    (existingReply.kind === "ok" && existingReply.text.trim().length > 0)
  ) {
    return false;
  }
  const status = await readJsonCapped(
    join(dir, "status.json"),
    INBOX_STATUS_JSON_MAX_BYTES,
  );
  if (
    status.kind === "oversized" ||
    status.kind === "unsafe" ||
    (status.kind === "ok" && isTerminalStatus(status.value["status"]))
  ) {
    return false;
  }
  const text = `${replyText.trim()}\n`;
  await atomicWriteFile(join(dir, "reply.md"), text);
  await writeStatus(dir, jobId, {
    status: "replied",
    startedAt: startedAtMs,
    endedAt: nowMs,
    replyBytes: Buffer.byteLength(text, "utf8"),
  });
  return true;
}

/** Failure signal: status.json {status:"failed", error} — no reply.md. */
export async function writeInboxFailed(
  dir: string,
  jobId: string,
  error: string,
  startedAtMs: number | null,
  nowMs: number,
): Promise<boolean> {
  return writeTerminalStatus(dir, jobId, "failed", {
    error: error.slice(0, 2000),
  }, startedAtMs, nowMs);
}

/** Cancel signal: status.json {status:"cancelled", reason} — no reply.md. */
export async function writeInboxCancelled(
  dir: string,
  jobId: string,
  reason: string,
  startedAtMs: number | null,
  nowMs: number,
): Promise<boolean> {
  return writeTerminalStatus(dir, jobId, "cancelled", {
    reason: reason.slice(0, 500),
  }, startedAtMs, nowMs);
}

/**
 * Shared terminal-status writer. A job that is already terminal on disk, or
 * whose reply.md is non-empty, is left untouched.
 */
async function writeTerminalStatus(
  dir: string,
  jobId: string,
  status: "failed" | "cancelled",
  payload: Record<string, unknown>,
  startedAtMs: number | null,
  nowMs: number,
): Promise<boolean> {
  if (!isValidInboxJobId(jobId)) return false;
  const existingStatus = await readJsonCapped(
    join(dir, "status.json"),
    INBOX_STATUS_JSON_MAX_BYTES,
  );
  if (
    existingStatus.kind === "oversized" ||
    existingStatus.kind === "unsafe" ||
    (existingStatus.kind === "ok" && isTerminalStatus(existingStatus.value["status"]))
  ) {
    return false;
  }
  const reply = await readFileCapped(join(dir, "reply.md"), INBOX_REPLY_MAX_BYTES);
  if (
    reply.kind === "oversized" ||
    reply.kind === "unsafe" ||
    (reply.kind === "ok" && reply.text.trim().length > 0)
  ) {
    return false;
  }
  await writeStatus(dir, jobId, {
    status,
    startedAt: startedAtMs,
    endedAt: nowMs,
    ...payload,
  });
  return true;
}

/** What the job dir itself says (ticket 113 boot rescan reads this). */
export interface InboxJobDiskState {
  /** status.json `status`, or null when absent/unparsable (never claimed). */
  readonly status: string | null;
  /**
   * reply.md exists and is non-empty — the protocol's done signal. An
   * oversized/unreadable reply is treated as present (never re-present a job
   * whose answer we refused to read).
   */
  readonly replyPresent: boolean;
}

/**
 * Read a job dir's on-disk lifecycle state. Never throws: a missing or
 * unparsable status.json reads as `null` (the job was never claimed on
 * disk), and an unreadable reply.md reads as done.
 */
export async function readInboxJobDiskState(
  dir: string,
): Promise<InboxJobDiskState> {
  const status = await readJsonCapped(
    join(dir, "status.json"),
    INBOX_STATUS_JSON_MAX_BYTES,
  );
  const statusValue =
    status.kind === "ok" && typeof status.value["status"] === "string"
      ? status.value["status"]
      : null;
  const reply = await readFileCapped(join(dir, "reply.md"), INBOX_REPLY_MAX_BYTES);
  return {
    status: statusValue,
    replyPresent:
      reply.kind === "oversized" ||
      reply.kind === "unsafe" ||
      (reply.kind === "ok" && reply.text.trim().length > 0),
  };
}

/** Resolved prompt text plus the source it came from. */
export interface ResolvedInboxJobText {
  readonly text: string;
  readonly source: InboxPromptSource;
}

/**
 * Re-resolve a claimed job's prompt at boot time (ticket 113 boot rescan):
 * `prompt.md` first; if absent, the job's queue line (claimed lines are
 * invisible to {@link readInboxQueue}, but the external system leaves them
 * in place). Null when neither carries text — the honest "cannot re-present"
 * answer for a job whose prompt sources are gone.
 *
 * An empty root never reads `queue.jsonl` relative to the process cwd.
 */
export async function resolveInboxJobText(
  root: string,
  dir: string,
  jobId: string,
): Promise<ResolvedInboxJobText | null> {
  if (!isValidInboxJobId(jobId)) return null;

  const promptRead = await readFileCapped(
    join(dir, "prompt.md"),
    INBOX_PROMPT_MAX_BYTES,
  );
  if (promptRead.kind === "oversized" || promptRead.kind === "unsafe") return null;
  const promptMd = promptRead.kind === "ok" ? promptRead.text.trim() : "";
  if (promptMd.length > 0) return { text: promptMd, source: "prompt.md" };

  if (root.trim().length > 0) {
    const queue = await readQueueFile(root);
    if (queue.text.length > 0) {
      for (const line of queue.text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            continue;
          }
          const entry = parsed as Record<string, unknown>;
          if (entry["jobId"] !== jobId) continue;
          const text = entry["text"];
          if (typeof text === "string" && text.trim().length > 0) {
            return { text: text.trim(), source: "queue.jsonl" };
          }
        } catch {
          // Unparsable lines are readInboxQueue's business; skip here.
        }
      }
    }
  }

  const jobRead = await readJsonCapped(
    join(dir, "job.json"),
    INBOX_JOB_JSON_MAX_BYTES,
  );
  if (jobRead.kind === "oversized" || jobRead.kind === "unsafe") return null;
  if (jobRead.kind === "ok") {
    const value = jobRead.value["text"];
    if (typeof value === "string" && value.trim().length > 0) {
      return { text: value.trim(), source: "job.json" };
    }
  }
  return null;
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
  /** Max jobs resolved/claimed per pass. Default 50. */
  readonly limit?: number;
}

export interface InboxWatcherHandle {
  /** Stop watching and cancel every armed timer. Idempotent. */
  stop(): void;
  /**
   * Settles once the watcher is armed: the root dir is ensured, `fs.watch`
   * is attached (or failed — errors go to `onError`), the initial sweep has
   * finished, and the rescan fallback is armed. Callers that drive the
   * watcher directly (tests, alternate schedulers) await this instead of
   * guessing how long the startup pass takes. Also settles on `stop()` and
   * never rejects.
   */
  readonly ready: Promise<void>;
  /**
   * Run one scan-claim pass now. Directly callable so tests can drive the
   * protocol deterministically without waiting on timers. Returns null when
   * stopped or when another pass (e.g. the initial sweep) is in flight.
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

/** An inert handle: refuses to start, reports why, never touches the fs. */
function inertHandle(onError: (error: unknown, context: string) => void): InboxWatcherHandle {
  try {
    onError(
      new Error(
        "inbox watcher refused to start: the root must be a non-empty absolute path",
      ),
      "start",
    );
  } catch {
    // An observer that throws must not break the caller either.
  }
  return {
    ready: Promise.resolve(),
    stop(): void {},
    scanOnce: async (): Promise<InboxScanReport | null> => null,
  };
}

/**
 * Start the inbox watcher: `fs.watch` (event-driven) plus a rescan-interval
 * fallback (ADR-0023 decision 1), both funneling into the same guarded
 * scan-claim pass. The dir is created if missing (upstream-compatible
 * posture); watch errors surface through `onError` and stop the watch —
 * the interval fallback keeps the intake alive.
 *
 * An empty or non-absolute root is refused HERE, not by the caller: a
 * relative root would silently resolve under the process cwd.
 */
export function startInboxWatcher(
  options: InboxWatcherOptions,
): InboxWatcherHandle {
  const root = options.root.trim();
  if (root.length === 0 || !isAbsolute(root)) {
    return inertHandle(options.onError);
  }
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? Date.now;
  const limit = options.limit ?? INBOX_DEFAULT_LIMIT;
  let stopped = false;
  let scanning = false;
  let scanPending = false;
  let cancelWatchDebounce: (() => void) | null = null;
  let cancelRescan: (() => void) | null = null;
  let fsWatcher: FSWatcher | null = null;
  let readySettled = false;
  let settleReady!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolveReady();
    };
  });

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
      const { entries, skipped, malformed } = await readInboxQueue(root, {
        limit,
        onProblem: (reason) => fail(new Error(`inbox: ${reason}`), "scan skip"),
      });
      if (malformed > 0) {
        fail(
          new Error(
            `inbox: skipped ${malformed} malformed queue line(s) in ${root}`,
          ),
          "scan",
        );
      }
      const claimed: InboxQueueEntry[] = [];
      let skippedCount = skipped;
      for (const entry of entries) {
        if (claimed.length >= limit) break;
        let won: boolean;
        try {
          won = await claimInboxJob(entry, now(), root);
        } catch (error) {
          fail(error, `claim ${entry.jobId}`);
          continue;
        }
        if (!won) {
          skippedCount += 1;
          continue;
        }
        claimed.push(entry);
        try {
          options.onJob(entry);
        } catch (error) {
          fail(error, `onJob ${entry.jobId}`);
        }
      }
      return { claimed, skipped: skippedCount, malformed };
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

  /** Close the live watch handle exactly once; safe after an error/stop. */
  function closeFsWatcher(): void {
    if (fsWatcher === null) return;
    const watcher = fsWatcher;
    fsWatcher = null;
    try {
      watcher.close();
    } catch {
      // Already dead (the error path may have closed it first).
    }
  }

  void (async () => {
    try {
      await mkdir(root, { recursive: true });
    } catch (error) {
      fail(error, "ensure dir");
    }
    if (stopped) {
      settleReady();
      return;
    }
    try {
      fsWatcher = watchFs(root, { persistent: false }, () => scheduleScan());
      fsWatcher.on("error", (error: Error) => {
        fail(error, "fs.watch");
        // The interval fallback owns intake from here; drop the dead watch
        // AND release its handle — an unclosed handle keeps the host alive
        // after dispose (and blocks root removal on Windows).
        closeFsWatcher();
      });
    } catch (error) {
      fail(error, "start fs.watch");
    }
    // Initial sweep: jobs queued before we started are picked up now. The
    // `ready` promise settles only after it finished, so a caller that drives
    // `scanOnce` directly never races an in-flight startup pass.
    await scanOnce();
    if (stopped) {
      settleReady();
      return;
    }
    armRescan();
    settleReady();
  })();

  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelWatchDebounce?.();
      cancelWatchDebounce = null;
      cancelRescan?.();
      cancelRescan = null;
      // The "error" handler also closes on a dead watch; this guard makes
      // the double case safe.
      closeFsWatcher();
      settleReady();
    },
    scanOnce,
  };
}
