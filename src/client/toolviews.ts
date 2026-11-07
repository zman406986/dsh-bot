/**
 * Per-tool call views (ticket 24; readable-status-display anatomy).
 *
 * The shipped `tool.call.toolview` slot is KEYED by wire tool name (Finding 5,
 * `dsh-client-ui-tool` contract/slots.d.ts:9-23): a key the shipped
 * composition already covers is replaced, not shared; an UNCLAIMED key falls
 * back to the generic tool row. The dispatcher tool names (eight since
 * ticket 118; nine keys claimed here with the retained historical
 * `send_peer`) have been plugin-owned and none is claimed by any shipped
 * `dsh-client-ui-*` package, so claiming them is additive-safe.
 *
 * Every row has THREE levels and no more:
 *
 * 1. **One primary sentence** — what happened, with no field label and no
 *    UUID (`Started "Rewrite auth docs"`, `Delivered to you`,
 *    `Couldn't steer worker …7f3a — no worker with that id in this chat.`).
 * 2. **At most two self-describing facts**, separated by ` · `, with
 *    false/zero/null/duplicate facts omitted (`2m 5s`, `7 tool calls`,
 *    `todo 7 completed`). Booleans are NEVER rendered as `true`/`false`:
 *    `ok` selects the primary sentence, `delivered` becomes a sentence or an
 *    honest refusal, `priority:false` is omitted, `todo_completed:null` is
 *    omitted.
 * 3. **A nested Details area** (`<details><summary>Details</summary><dl>`) —
 *    the only place full ids, stream keys, transcript refs, message ids, raw
 *    reason codes and times live.
 *
 * Subject resolution is title → kind + short ref. The full id is details
 * only; the visible line never leads with `session-` or a UUID. Rows from
 * older transcripts (no adapter `display` projection) degrade to short refs.
 *
 * This module is pure registration data + pure payload parsing: no React,
 * no DOM, no Cordis. Tests assert it directly (offline, S8). The component
 * factory that consumes these models lives in `toolview-panel.tsx`; the
 * row's stylesheet lives in `toolview-styles.ts`.
 *
 * All copy is locale-keyed. Parsers never build an English sentence; a fact
 * is either raw text (an instruction the model wrote, a short ref, a
 * duration) or a locale key plus values resolved by the renderer.
 */

import {
  AWAIT_AGENT_TOOL,
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
  MESSAGE_AGENT_TOOL,
  SEND_PEER_TOOL,
  SPAWN_DISPATCHER_TOOL,
  SPAWN_WORKER_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
} from "../core/policy/prompts.js";
import { LOCALE_NAMESPACE } from "./overlay.js";
import {
  displaySubject,
  formatDuration,
  shortRef,
  statusWordKey
} from "./status-format.js";

/**
 * The shipped keyed slot for per-tool call renderings. dsh-owned; never an
 * invented slot name (design-16 §5 slot-name rule).
 */
export const TOOL_CALL_TOOLVIEW_SLOT = "tool.call.toolview";

/**
 * The wire tool names this face claims, in registration order — the eight
 * dispatcher tools plus the retained historical `send_peer` key (ticket 152).
 */
export const TOOLVIEW_TOOL_NAMES: readonly string[] = [
  SPAWN_WORKER_TOOL,
  CHECK_WORKERS_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  DELIVER_RESULT_TOOL,
  MESSAGE_AGENT_TOOL,
  AWAIT_AGENT_TOOL,
  SPAWN_DISPATCHER_TOOL,
  SEND_PEER_TOOL,
];

/**
 * Toolview keys claimed by the shipped composition per the 0.1.5-rc.1
 * catalog (research Finding 5). We must never claim one of these.
 */
export const SHIPPED_CLAIMED_TOOLVIEW_KEYS: readonly string[] = [
  "cordis_define",
  "cordis_run",
];

/** Registration options for one keyed toolview entry (Finding 5 shape). */
export interface ToolviewRegistrationOptions {
  /** The shipped slot key this entry renders into. */
  readonly name: string;
  /** The keyed cell: exactly the wire tool name. */
  readonly key: string;
  /** Locale namespace declared on the entry so the kit's `t` seat binds. */
  readonly locale: string;
}

/** Build the keyed registration options for one dispatcher tool. */
export function toolviewRegistration(
  toolName: string,
): ToolviewRegistrationOptions {
  return {
    name: TOOL_CALL_TOOLVIEW_SLOT,
    key: toolName,
    locale: LOCALE_NAMESPACE,
  };
}

/** Locale keys for the labels inside the nested Details area. */
export const TOOLVIEW_DETAIL_KEYS = {
  worker: "toolview.detail.worker",
  dispatcher: "toolview.detail.dispatcher",
  target: "toolview.detail.target",
  todo: "toolview.detail.todo",
  stream: "toolview.detail.stream",
  transcript: "toolview.detail.transcript",
  message: "toolview.detail.message",
  status: "toolview.detail.status",
  reason: "toolview.detail.reason",
  elapsed: "toolview.detail.elapsed",
  settled: "toolview.detail.settled",
  waited: "toolview.detail.waited",
  mode: "toolview.detail.mode",
  call: "toolview.detail.call",
} as const;

/** Locale key for the degraded row copy. */
export const TOOLVIEW_DEGRADED_KEY = "toolview.degraded";

/** Locale key for the Details summary. */
export const TOOLVIEW_DETAILS_KEY = "toolview.details";

/** Locale keys for the generic subject nouns used by refusal sentences. */
export const TOOLVIEW_SUBJECT_KEYS = {
  worker: "toolview.subject.worker",
  agent: "toolview.subject.agent",
  dispatcher: "toolview.subject.dispatcher",
  todo: "toolview.subject.todo",
} as const;

/**
 * The props a toolview entry is handed by the renderer. The exact prop face
 * is renderer-controlled, so the parsers below treat this defensively: any
 * deviation degrades to a safe row, never a throw.
 */
export interface ToolCallPayload {
  readonly args: unknown;
  readonly result: unknown;
}

/** One label/value pair inside the nested Details area. */
export interface ToolviewDetail {
  readonly labelKey: string;
  readonly value: string;
}

/**
 * One localized fact. Parsers stay locale-free: `text` is a raw value the
 * model wrote (an instruction, a short ref, a duration), while `copy` and
 * `count` carry locale keys the renderer resolves through its `t` seat.
 */
export type ToolviewFact =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "copy";
      readonly key: string;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly kind: "count"; readonly keyBase: string; readonly count: number };

/**
 * One `check_workers` roster row, ordered the readable way: title first, one
 * human status word, facts (elapsed, tool calls), an optional activity line,
 * and the short ref last. `statusLabel` stays the raw core FSM vocabulary for
 * `data-status`; `statusWordKey` is the ONE visible word.
 */
export interface ToolviewStatusRow {
  readonly workerId: string;
  readonly title: string;
  readonly statusLabel: string | null;
  readonly statusWordKey: string | null;
  readonly facts: readonly ToolviewFact[];
  readonly activity: string | null;
  readonly shortRef: string;
}

/** The row's human state; also the raw `data-status` value on the row. */
export type ToolviewState =
  | "starting"
  | "working"
  | "adjusting"
  | "done"
  | "failed"
  | "stopped";

/**
 * Parsed view outcome: `degraded` renders the safe degraded row (malformed,
 * partial, or foreign payload); `detail` renders the three-level row.
 */
export type ToolviewModel =
  | { readonly kind: "degraded" }
  | {
      readonly kind: "detail";
      readonly state: ToolviewState;
      /** Locale key for the one primary sentence. */
      readonly primaryKey: string;
      /** Values substituted into `primaryKey` (lowercase placeholders only). */
      readonly primaryValues: Readonly<Record<string, string>>;
      /**
       * Locale key for the refusal cause. The renderer resolves it and
       * substitutes `{cause}`; raw reason enums never render outside details.
       */
      readonly causeKey: string | null;
      /** Title, or kind + short ref; never a full id. */
      readonly subject: string | null;
      /** Generic subject noun key when no id/title produced a subject. */
      readonly subjectKey: string | null;
      /** At most two self-describing facts. */
      readonly facts: readonly ToolviewFact[];
      /** Full ids/streams/transcripts/reasons/times — details only. */
      readonly details: readonly ToolviewDetail[];
      readonly statusRows: readonly ToolviewStatusRow[];
    };

/** Max characters of any single rendered value (compact rows). */
export const TOOLVIEW_TEXT_CLAMP_CHARS = 160;

const DEGRADED: ToolviewModel = { kind: "degraded" };

/** Narrow to a plain object record (arrays are not records here). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Non-empty string, verbatim. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Boolean or null. Booleans select copy; they never render as text. */
function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Finite non-negative number or null. */
function asCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

/**
 * Collapse whitespace and clamp to the compact-row budget. Null for
 * missing/empty values so the fact is omitted entirely.
 */
function clampText(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  if (flat.length <= TOOLVIEW_TEXT_CLAMP_CHARS) return flat;
  return `${flat.slice(0, TOOLVIEW_TEXT_CLAMP_CHARS)}…`;
}

/** A raw-text fact (model-written instruction, short ref, duration). */
function textFact(text: string | null | undefined): ToolviewFact | null {
  if (typeof text !== "string" || text.length === 0) return null;
  return { kind: "text", text };
}

/** A localized fact copied from the dictionary. */
function copyFact(
  key: string,
  values: Readonly<Record<string, string>> = {},
): ToolviewFact {
  return { kind: "copy", key, values };
}

/** A pluralized count fact (`.one` / `.other`). */
function countFact(keyBase: string, count: number): ToolviewFact {
  return { kind: "count", keyBase, count };
}

/** Stable identity for de-duplicating facts (never user-visible). */
function factIdentity(fact: ToolviewFact): string {
  switch (fact.kind) {
    case "text":
      return `text:${fact.text}`;
    case "copy":
      return `copy:${fact.key}:${JSON.stringify(fact.values)}`;
    case "count":
      return `count:${fact.keyBase}:${fact.count}`;
  }
}

/** Keep at most two distinct facts, in order. */
function capFacts(facts: readonly (ToolviewFact | null)[]): ToolviewFact[] {
  const out: ToolviewFact[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (out.length >= 2) break;
    if (fact === null) continue;
    const identity = factIdentity(fact);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(fact);
  }
  return out;
}

/** Build the Details list, omitting empty values and exact duplicates. */
function detailsOf(
  entries: readonly (readonly [string, string | null | undefined])[],
): ToolviewDetail[] {
  const out: ToolviewDetail[] = [];
  const seen = new Set<string>();
  for (const [labelKey, raw] of entries) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const identity = `${labelKey}\u0000${raw}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({ labelKey, value: raw });
  }
  return out;
}

/** One resolved display subject: text plus the raw id for details. */
interface ResolvedSubject {
  readonly text: string | null;
  readonly id: string | null;
  readonly kind: string | null;
  /** True when the visible text is a title (not a short ref). */
  readonly titled: boolean;
}

interface SubjectInput {
  readonly result?: Record<string, unknown> | null;
  readonly args?: Record<string, unknown> | null;
  readonly id?: string | null;
  readonly title?: string | null;
  readonly kind: string;
}

/** The adapter's `display` projection (JSON-only: id/kind/title). */
function displaySubjectOf(
  result: Record<string, unknown> | null,
): { readonly id: string | null; readonly kind: string | null; readonly title: string | null } | null {
  const display = asRecord(result?.display);
  const subject = asRecord(display?.subject);
  if (subject === null) return null;
  return {
    id: asString(subject.id),
    kind: asString(subject.kind),
    title: asString(subject.title),
  };
}

/**
 * Resolve a row subject: adapter display title → result title → argument
 * title → kind + short ref. Never a full id.
 */
function resolveSubject(input: SubjectInput): ResolvedSubject {
  const display = displaySubjectOf(input.result ?? null);
  const id =
    asString(input.id) ??
    asString(display?.id) ??
    null;
  const kind =
    asString(display?.kind) ??
    input.kind;
  const title =
    asString(display?.title) ??
    asString(input.title) ??
    null;
  const text = displaySubject({ title, id, kind });
  return {
    text,
    id,
    kind,
    titled: title !== null && text !== null && text === title.trim(),
  };
}

/** Refusal cause mapping: every reason enum → one human phrase key. */
const REFUSAL_CAUSES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [SPAWN_WORKER_TOOL]: {
    "duplicate-stream-key": "toolview.cause.duplicate-stream-key",
    "unknown-todo-id": "toolview.cause.unknown-todo-id",
    "todo-already-linked": "toolview.cause.todo-already-linked",
  },
  [CHECK_WORKERS_TOOL]: {
    "unknown-worker": "toolview.cause.unknown-worker",
  },
  [STEER_WORKER_TOOL]: {
    "unknown-worker": "toolview.cause.unknown-worker",
    "not-running": "toolview.cause.not-running",
  },
  [STOP_WORKER_TOOL]: {
    "already-settled": "toolview.cause.already-settled",
  },
  [DELIVER_RESULT_TOOL]: {
    "unknown-target": "toolview.cause.unknown-todo",
    "no-delivery-channel": "toolview.cause.no-delivery-channel",
    "send-failed": "toolview.cause.send-failed",
  },
  [MESSAGE_AGENT_TOOL]: {
    "unknown-target": "toolview.cause.unknown-agent",
    "self-target": "toolview.cause.self-target",
    "not-running": "toolview.cause.not-running",
    "inbox-full": "toolview.cause.inbox-full",
    "rate-limited": "toolview.cause.rate-limited",
    "invalid-envelope": "toolview.cause.invalid-envelope",
  },
  [AWAIT_AGENT_TOOL]: {
    "unknown-target": "toolview.cause.unknown-worker",
    "self-target": "toolview.cause.self-target",
    "not-awaitable": "toolview.cause.not-awaitable",
    "too-many-waits": "toolview.cause.too-many-waits",
    "invalid-timeout": "toolview.cause.invalid-timeout",
  },
  [SPAWN_DISPATCHER_TOOL]: {
    "invalid-args": "toolview.cause.invalid-args",
    "host-refused": "toolview.cause.host-refused",
  },
  [SEND_PEER_TOOL]: {
    "unknown-target": "toolview.cause.unknown-dispatcher",
    "self-target": "toolview.cause.self-target",
    "inbox-full": "toolview.cause.inbox-full",
    "message-id-reuse": "toolview.cause.message-id-reuse",
    "invalid-envelope": "toolview.cause.invalid-envelope",
  },
};

/** Primary-sentence key per tool's refusal shape. */
const REFUSAL_PRIMARY: Readonly<Record<string, string>> = {
  [SPAWN_WORKER_TOOL]: "toolview.spawn.refused",
  [CHECK_WORKERS_TOOL]: "toolview.check.refused",
  [STEER_WORKER_TOOL]: "toolview.steer.refused",
  [STOP_WORKER_TOOL]: "toolview.stop.refused",
  [DELIVER_RESULT_TOOL]: "toolview.deliver.refused",
  [MESSAGE_AGENT_TOOL]: "toolview.message.refused",
  [AWAIT_AGENT_TOOL]: "toolview.await.refused",
  [SPAWN_DISPATCHER_TOOL]: "toolview.dispatcher.refused",
  [SEND_PEER_TOOL]: "toolview.peer.refused",
};

/**
 * Map one tool's refusal reason onto its human cause key. Unknown reasons
 * still get the honest generic phrase; the raw enum is added to details by
 * the caller. Null/empty reasons answer null so the caller can choose its
 * own honest default.
 */
export function refusalCauseKey(
  toolName: string,
  reason: string | null | undefined,
): string | null {
  if (typeof reason !== "string" || reason.length === 0) return null;
  return (
    REFUSAL_CAUSES[toolName]?.[reason] ?? "toolview.cause.failed"
  );
}

/** Build a refusal row with one sentence, no boolean fields, raw reason in details. */
function refusalModel(input: {
  readonly toolName: string;
  readonly reason: string | null;
  readonly subject: ResolvedSubject;
  readonly fallbackSubjectKey: string;
  readonly details: readonly ToolviewDetail[];
  /** Titled tools override the generic refusal sentence. */
  readonly primaryKey?: string;
  readonly primaryValues?: Readonly<Record<string, string>>;
}): ToolviewModel {
  return {
    kind: "detail",
    state: "failed",
    primaryKey:
      input.primaryKey ??
      REFUSAL_PRIMARY[input.toolName] ??
      "toolview.cause.failed",
    primaryValues:
      input.primaryValues ??
      (input.subject.text !== null ? { subject: input.subject.text } : {}),
    causeKey:
      refusalCauseKey(input.toolName, input.reason) ?? "toolview.cause.failed",
    subject: input.subject.text,
    subjectKey:
      input.subject.text === null ? input.fallbackSubjectKey : null,
    facts: [],
    details: input.details,
    statusRows: [],
  };
}

/** Build a parsed detail row. */
function detailModel(input: {
  readonly state: ToolviewState;
  readonly primaryKey: string;
  readonly primaryValues?: Readonly<Record<string, string>>;
  readonly subject: ResolvedSubject;
  readonly fallbackSubjectKey: string | null;
  readonly facts?: readonly (ToolviewFact | null)[];
  readonly details?: readonly ToolviewDetail[];
  readonly statusRows?: readonly ToolviewStatusRow[];
}): ToolviewModel {
  return {
    kind: "detail",
    state: input.state,
    primaryKey: input.primaryKey,
    primaryValues: input.primaryValues ?? {},
    causeKey: null,
    subject: input.subject.text,
    subjectKey:
      input.subject.text === null ? input.fallbackSubjectKey : null,
    facts: capFacts(input.facts ?? []),
    details: input.details ?? [],
    statusRows: input.statusRows ?? [],
  };
}

/** Whether a payload carries anything a row may honestly render. */
function hasPayload(
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): boolean {
  if (result !== null) return true;
  return args !== null && Object.keys(args).length > 0;
}

/** The raw reason text of a failed result, when it has one. */
function reasonOf(result: Record<string, unknown> | null): string | null {
  return result === null ? null : asString(result.reason);
}

function describeSpawn(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const workerId = asString(result?.worker_id);
  const title = asString(result?.title) ?? asString(args?.title);
  const subject = resolveSubject({
    result,
    args,
    id: workerId,
    title,
    kind: "worker",
  });
  const streamKey = asString(result?.stream_key) ?? asString(args?.stream_key);
  const todoId = asString(args?.todo_id);
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.worker, workerId],
    [TOOLVIEW_DETAIL_KEYS.stream, streamKey],
    [TOOLVIEW_DETAIL_KEYS.todo, todoId],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);

  const ok = asBool(result?.ok);
  if (result !== null && ok === false) {
    return refusalModel({
      toolName: SPAWN_WORKER_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details,
      ...(subject.titled
        ? {
            primaryKey: "toolview.spawn.refused",
            primaryValues: { title: subject.text ?? "" },
          }
        : {
            primaryKey: "toolview.spawn.refused-generic",
            primaryValues: {},
          }),
    });
  }
  if (result !== null && ok !== true) {
    // A readable result whose `ok` is not boolean tells no honest story.
    return details.length > 0 || subject.text !== null
      ? detailModel({
          state: "working",
          primaryKey: subject.titled
            ? "toolview.spawn.pending"
            : "toolview.spawn.pending-generic",
          primaryValues: subject.titled
            ? { title: subject.text ?? "" }
            : subject.text !== null
              ? { subject: subject.text }
              : {},
          subject,
          fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
          details,
        })
      : DEGRADED;
  }

  const pending = result === null;
  const primaryKey = pending
    ? subject.titled
      ? "toolview.spawn.pending"
      : "toolview.spawn.pending-generic"
    : subject.titled
      ? "toolview.spawn.started"
      : "toolview.spawn.started-generic";
  const primaryValues = subject.titled
    ? { title: subject.text ?? "" }
    : subject.text !== null
      ? { subject: subject.text }
      : {};
  const facts = [
    // The title is the subject; the short worker ref is the useful fact.
    !subject.titled ? null : textFact(shortRef(workerId ?? subject.id ?? "", "worker")),
    todoId === null ? null : textFact(shortRef(todoId, "todo")),
  ];
  return detailModel({
    state: "starting",
    primaryKey,
    primaryValues,
    subject,
    fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
    facts,
    details,
  });
}

/** Parse one check row into the readable row shape. */
function parseCheckRow(record: Record<string, unknown>): ToolviewStatusRow | null {
  const workerId = asString(record.worker_id);
  if (workerId === null) return null;
  const ref = shortRef(workerId, "worker");
  const title = asString(record.title) ?? ref;
  const elapsedMs = asCount(record.elapsed_ms);
  const toolCalls = asCount(record.tool_call_count);
  return {
    workerId,
    title,
    statusLabel: asString(record.status),
    statusWordKey: statusWordKey(asString(record.status)),
    facts: capFacts([
      elapsedMs === null
        ? null
        : textFact(formatDuration(elapsedMs)),
      toolCalls === null || toolCalls === 0
        ? null
        : countFact("roster.activity.toolcalls", toolCalls),
    ]),
    activity: clampText(record.recent_activity),
    shortRef: ref,
  };
}

function describeCheck(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const targetId = asString(args?.worker_id);
  const subject = resolveSubject({
    result,
    args,
    id: targetId,
    kind: "worker",
  });
  const ok = result === null ? null : asBool(result.ok);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: CHECK_WORKERS_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details: detailsOf([
        [TOOLVIEW_DETAIL_KEYS.worker, targetId],
        [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
      ]),
    });
  }
  if (result !== null && ok !== true) return DEGRADED;

  if (result === null) {
    return detailModel({
      state: "working",
      primaryKey: "toolview.check.pending",
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details: detailsOf([[TOOLVIEW_DETAIL_KEYS.worker, targetId]]),
    });
  }

  const rows = result.rows;
  if (!Array.isArray(rows)) return DEGRADED;
  const statusRows: ToolviewStatusRow[] = [];
  const details: ToolviewDetail[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (record === null) continue;
    const parsed = parseCheckRow(record);
    if (parsed === null) continue;
    statusRows.push(parsed);
    details.push(
      ...detailsOf([
        [TOOLVIEW_DETAIL_KEYS.worker, parsed.workerId],
        [TOOLVIEW_DETAIL_KEYS.stream, asString(record.stream_key)],
        [TOOLVIEW_DETAIL_KEYS.transcript, asString(record.transcript_ref)],
        [TOOLVIEW_DETAIL_KEYS.todo, asString(record.todo_id)],
      ]),
    );
  }

  const count = statusRows.length;
  const primaryKey =
    count === 0
      ? "toolview.check.summary.none"
      : `toolview.check.summary.${count === 1 ? "one" : "other"}`;
  return detailModel({
    state: "done",
    primaryKey,
    primaryValues: count === 0 ? {} : { count: String(count) },
    subject,
    fallbackSubjectKey: null,
    details,
    statusRows,
  });
}

function describeSteer(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const workerId =
    asString(result?.worker_id) ?? asString(args?.worker_id);
  const subject = resolveSubject({
    result,
    args,
    id: workerId,
    title: asString(result?.title),
    kind: "worker",
  });
  const instruction = clampText(args?.message);
  const ok = result === null ? null : asBool(result.ok);
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.worker, workerId],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: STEER_WORKER_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details,
    });
  }
  if (result !== null && ok !== true) {
    return details.length > 0 || subject.text !== null
      ? detailModel({
          state: "working",
          primaryKey: "toolview.steer.pending",
          primaryValues:
            subject.text !== null ? { subject: subject.text } : {},
          subject,
          fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
          facts: [textFact(instruction)],
          details,
        })
      : DEGRADED;
  }

  const pending = result === null;
  return detailModel({
    state: pending ? "working" : "adjusting",
    primaryKey: pending ? "toolview.steer.pending" : "toolview.steer.sent",
    primaryValues: subject.text !== null ? { subject: subject.text } : {},
    subject,
    fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
    facts: [
      textFact(instruction),
      result?.dormant === true
        ? copyFact("toolview.fact.dormant")
        : null,
    ],
    details,
  });
}

function describeStop(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const workerId =
    asString(result?.worker_id) ?? asString(args?.worker_id);
  const subject = resolveSubject({
    result,
    args,
    id: workerId,
    title: asString(result?.title),
    kind: "worker",
  });
  const mode = asString(result?.mode);
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.worker, workerId],
    [TOOLVIEW_DETAIL_KEYS.mode, mode],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);
  const ok = result === null ? null : asBool(result.ok);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: STOP_WORKER_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details,
    });
  }
  if (result !== null && ok !== true) {
    return details.length > 0 || subject.text !== null
      ? detailModel({
          state: "working",
          primaryKey: "toolview.stop.pending",
          primaryValues:
            subject.text !== null ? { subject: subject.text } : {},
          subject,
          fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
          details,
        })
      : DEGRADED;
  }

  const released = mode === "released-hold";
  return detailModel({
    state: result === null ? "working" : "stopped",
    primaryKey:
      result === null
        ? "toolview.stop.pending"
        : released
          ? "toolview.stop.released"
          : "toolview.stop.stopped",
    primaryValues: subject.text !== null ? { subject: subject.text } : {},
    subject,
    fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
    details,
  });
}

function describeDeliver(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const todoId =
    asString(result?.todo_completed) ?? asString(args?.todo_id);
  const subject = resolveSubject({
    result,
    args,
    id: todoId,
    title: asString(result?.todo_title),
    kind: "todo",
  });
  const attachmentPaths = Array.isArray(args?.attachment_paths)
    ? args.attachment_paths
    : [];
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.todo, todoId],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);

  if (result === null) {
    return detailModel({
      state: "working",
      primaryKey: "toolview.deliver.pending",
      subject,
      fallbackSubjectKey: null,
      facts: [
        attachmentPaths.length === 0
          ? null
          : countFact(
              "toolview.fact.attachments",
              attachmentPaths.length,
            ),
      ],
      details,
    });
  }

  const delivered = asBool(result.delivered);
  if (delivered !== true) {
    // `delivered:false` becomes an honest refusal, never the word "false".
    // A result with no readable `delivered` flag has no deliver story.
    if (delivered === null && asBool(result.ok) !== false) return DEGRADED;
    const reason = reasonOf(result) ?? "send-failed";
    return refusalModel({
      toolName: DELIVER_RESULT_TOOL,
      reason,
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.todo,
      details: detailsOf([
        [TOOLVIEW_DETAIL_KEYS.todo, todoId],
        [TOOLVIEW_DETAIL_KEYS.reason, reason],
      ]),
    });
  }

  const completedTodo = asString(result.todo_completed);
  // ADR-0009: with no wired send channel the dispatcher's own reply is the
  // channel (`channel: "reply"`). The obligation is recorded, but the user has
  // not read anything yet — never render this as "Delivered to you".
  const replyChannel = asString(result.channel) === "reply";
  const todoFact =
    completedTodo === null
      ? null
      : replyChannel
        ? subject.titled
          ? copyFact("toolview.fact.todo-marked-done", {
              title: subject.text ?? "",
            })
          : copyFact("toolview.fact.todo-marked-done-ref", {
              ref: shortRef(completedTodo, "todo"),
            })
        : copyFact("toolview.fact.todo-completed", {
            ref: shortRef(completedTodo, "todo"),
          });
  return detailModel({
    state: "done",
    primaryKey: replyChannel
      ? "toolview.deliver.recorded"
      : "toolview.deliver.done",
    subject,
    fallbackSubjectKey: null,
    facts: [
      todoFact,
      attachmentPaths.length === 0
        ? null
        : countFact("toolview.fact.attachments", attachmentPaths.length),
    ],
    details,
  });
}

/**
 * Ticket 70: the send_peer row — the conversation-visible trace of peer
 * traffic. The message BODY is never rendered here.
 */
function describeSendPeer(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const toSession =
    asString(result?.to_session) ?? asString(args?.to_session);
  const subject = resolveSubject({
    result,
    args,
    id: toSession,
    kind: "dispatcher",
  });
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.target, toSession],
    [TOOLVIEW_DETAIL_KEYS.message, asString(result?.message_id)],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);
  const ok = result === null ? null : asBool(result.ok);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: SEND_PEER_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.dispatcher,
      details,
    });
  }
  if (result !== null && ok !== true) {
    return details.length > 0 || subject.text !== null
      ? detailModel({
          state: "working",
          primaryKey: "toolview.peer.pending",
          primaryValues:
            subject.text !== null ? { subject: subject.text } : {},
          subject,
          fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.dispatcher,
          details,
        })
      : DEGRADED;
  }

  const pending = result === null;
  return detailModel({
    state: pending ? "working" : "done",
    primaryKey: pending ? "toolview.peer.pending" : "toolview.peer.sent",
    primaryValues: subject.text !== null ? { subject: subject.text } : {},
    subject,
    fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.dispatcher,
    facts: [
      args?.priority === true ? copyFact("toolview.fact.priority") : null,
    ],
    details,
  });
}

/**
 * Ticket 152: the message_agent row (ticket 116's one messaging verb). The
 * target is the thing the user cares about, and `delivered_as` says which
 * lane accepted it ("steer" = your worker, "peer" = another dispatcher). The
 * message BODY never renders here.
 */
function describeMessageAgent(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const target = asString(result?.target) ?? asString(args?.target);
  const deliveredAs = asString(result?.delivered_as);
  const subject = resolveSubject({
    result,
    args,
    id: target,
    kind:
      deliveredAs === "peer"
        ? "dispatcher"
        : deliveredAs === "steer"
          ? "worker"
          : "agent",
  });
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.target, target],
    [TOOLVIEW_DETAIL_KEYS.message, asString(result?.message_id)],
    [TOOLVIEW_DETAIL_KEYS.mode, deliveredAs],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);
  const ok = result === null ? null : asBool(result.ok);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: MESSAGE_AGENT_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.agent,
      details,
    });
  }
  if (result !== null && ok !== true) {
    return details.length > 0 || subject.text !== null
      ? detailModel({
          state: "working",
          primaryKey: "toolview.message.pending",
          primaryValues:
            subject.text !== null ? { subject: subject.text } : {},
          subject,
          fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.agent,
          details,
        })
      : DEGRADED;
  }

  const pending = result === null;
  const laneFact =
    deliveredAs === "steer"
      ? copyFact("toolview.fact.via-steer")
      : deliveredAs === "peer"
        ? copyFact("toolview.fact.via-peer")
        : null;
  return detailModel({
    state: pending ? "working" : "done",
    primaryKey: pending ? "toolview.message.pending" : "toolview.message.sent",
    primaryValues: subject.text !== null ? { subject: subject.text } : {},
    subject,
    fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.agent,
    facts: [
      laneFact,
      args?.priority === true ? copyFact("toolview.fact.priority") : null,
      result?.dormant === true ? copyFact("toolview.fact.dormant") : null,
    ],
    details,
  });
}

/**
 * Ticket 152: the await_agent row (ticket 117's one bounded wait). The row
 * is about WAIT STATE only — it never echoes a result excerpt.
 */
function describeAwaitAgent(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const target = asString(result?.target) ?? asString(args?.target);
  const subject = resolveSubject({
    result,
    args,
    id: target,
    kind: "worker",
  });
  const waitedMs = asCount(result?.waited_ms);
  const settledAtMs = asCount(result?.settled_at_ms);
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.target, target],
    [TOOLVIEW_DETAIL_KEYS.status, asString(result?.status)],
    [TOOLVIEW_DETAIL_KEYS.mode, asString(result?.worker_status)],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
    [
      TOOLVIEW_DETAIL_KEYS.waited,
      waitedMs === null ? null : `${waitedMs} ms`,
    ],
    [
      TOOLVIEW_DETAIL_KEYS.settled,
      settledAtMs === null ? null : String(settledAtMs),
    ],
  ]);
  const ok = result === null ? null : asBool(result.ok);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: AWAIT_AGENT_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details,
    });
  }
  if (result !== null && ok !== true) return DEGRADED;

  if (result === null) {
    return detailModel({
      state: "working",
      primaryKey: "toolview.await.pending",
      primaryValues: subject.text !== null ? { subject: subject.text } : {},
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      details,
    });
  }

  const status = asString(result.status);
  const waitedFact =
    waitedMs === null
      ? null
      : copyFact("toolview.fact.waited", {
          duration: formatDuration(waitedMs),
        });

  if (status === "settled") {
    const workerStatus = asString(result.worker_status);
    if (workerStatus === "completed") {
      return detailModel({
        state: "done",
        primaryKey: "toolview.await.done",
        primaryValues:
          subject.text !== null ? { subject: subject.text } : {},
        subject,
        fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
        facts: [waitedFact],
        details,
      });
    }
    if (workerStatus === "error") {
      return detailModel({
        state: "failed",
        primaryKey: "toolview.await.failed",
        primaryValues:
          subject.text !== null ? { subject: subject.text } : {},
        subject,
        fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
        facts: [waitedFact],
        details,
      });
    }
    if (workerStatus === "aborted") {
      return detailModel({
        state: "stopped",
        primaryKey: "toolview.await.stopped",
        primaryValues:
          subject.text !== null ? { subject: subject.text } : {},
        subject,
        fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
        facts: [waitedFact],
        details,
      });
    }
    return DEGRADED;
  }
  if (status === "still-running") {
    return detailModel({
      state: "working",
      primaryKey: "toolview.await.working",
      primaryValues: subject.text !== null ? { subject: subject.text } : {},
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      facts: [waitedFact],
      details,
    });
  }
  if (status === "gone") {
    return detailModel({
      state: "failed",
      primaryKey: "toolview.await.gone",
      primaryValues: subject.text !== null ? { subject: subject.text } : {},
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      facts: [waitedFact],
      details,
    });
  }
  if (status === "released") {
    const reason = asString(result.reason);
    return detailModel({
      state: "stopped",
      primaryKey: "toolview.await.released",
      primaryValues: subject.text !== null ? { subject: subject.text } : {},
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.worker,
      facts: [
        reason === "user-message"
          ? copyFact("toolview.fact.user-spoke")
          : reason === "stopped"
            ? copyFact("toolview.fact.turn-stopped")
            : null,
        copyFact("toolview.fact.keeps-running"),
      ],
      details,
    });
  }
  return DEGRADED;
}

/**
 * Ticket 152: the spawn_dispatcher row (ticket 118's mitosis). The title
 * names what was summoned; the handoff prompt never renders here.
 */
function describeSpawnDispatcher(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  if (!hasPayload(args, result)) return DEGRADED;

  const dispatcherId = asString(result?.dispatcher_id);
  const title = asString(result?.title) ?? asString(args?.title);
  const subject = resolveSubject({
    result,
    args,
    id: dispatcherId,
    title,
    kind: "dispatcher",
  });
  const details = detailsOf([
    [TOOLVIEW_DETAIL_KEYS.dispatcher, dispatcherId],
    [TOOLVIEW_DETAIL_KEYS.reason, reasonOf(result)],
  ]);
  const ok = result === null ? null : asBool(result.ok);

  if (result !== null && ok === false) {
    return refusalModel({
      toolName: SPAWN_DISPATCHER_TOOL,
      reason: reasonOf(result),
      subject,
      fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.dispatcher,
      details,
      ...(subject.titled
        ? {
            primaryKey: "toolview.dispatcher.refused",
            primaryValues: { title: subject.text ?? "" },
          }
        : {
            primaryKey: "toolview.dispatcher.refused-generic",
            primaryValues: {},
          }),
    });
  }
  if (result !== null && ok !== true) {
    return details.length > 0 || subject.text !== null
      ? detailModel({
          state: "starting",
          primaryKey: subject.titled
            ? "toolview.dispatcher.pending"
            : "toolview.dispatcher.pending-generic",
          primaryValues: subject.titled
            ? { title: subject.text ?? "" }
            : subject.text !== null
              ? { subject: subject.text }
              : {},
          subject,
          fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.dispatcher,
          details,
        })
      : DEGRADED;
  }

  const pending = result === null;
  return detailModel({
    state: "starting",
    primaryKey: pending
      ? subject.titled
        ? "toolview.dispatcher.pending"
        : "toolview.dispatcher.pending-generic"
      : subject.titled
        ? "toolview.dispatcher.summoned"
        : "toolview.dispatcher.summoned-generic",
    primaryValues: subject.titled
      ? { title: subject.text ?? "" }
      : subject.text !== null
        ? { subject: subject.text }
        : {},
    subject,
    fallbackSubjectKey: TOOLVIEW_SUBJECT_KEYS.dispatcher,
    facts: [
      !subject.titled
        ? null
        : textFact(shortRef(dispatcherId ?? "", "dispatcher")),
    ],
    details,
  });
}

//#region stock props → parser payload (the boundary adapter)

interface PartialArgumentsReader {
  keys(): readonly string[];
  text(key: string): string | undefined;
  value(key: string): unknown;
}

function isPartialArguments(value: unknown): value is PartialArgumentsReader {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.keys === "function" &&
    typeof record.text === "function" &&
    typeof record.value === "function"
  );
}

function readArguments(args: unknown): Record<string, unknown> | null {
  if (isPartialArguments(args)) {
    const out: Record<string, unknown> = {};
    for (const key of args.keys()) {
      if (typeof key !== "string" || key.length === 0) continue;
      const value = args.value(key);
      if (value !== undefined) {
        out[key] = value;
        continue;
      }
      const text = args.text(key);
      if (typeof text === "string") out[key] = text;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  return asRecord(args);
}

function parseArgumentsText(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function readResult(block: Record<string, unknown>): Record<string, unknown> | null {
  const meta = asRecord(block.meta);
  if (meta !== null) return meta;

  const recorded = recordedPayload(block.content);
  if (recorded !== null) return recorded;

  if (block.isError === true) {
    const error = asRecord(block.error);
    const reason = asString(error?.reason) ?? asString(error?.code);
    return reason === null ? { ok: false } : { ok: false, reason };
  }
  return null;
}

function recordedPayload(content: unknown): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null;
  const firstTextRecord = (blocks: readonly unknown[]) => {
    for (const block of blocks) {
      const record = asRecord(block);
      if (record === null || record.type !== "text") continue;
      return parseArgumentsText(record.text);
    }
    return null;
  };
  for (const part of content) {
    const record = asRecord(part);
    if (record === null) continue;
    if (record.type === "tool-result" && Array.isArray(record.content)) {
      const nested = firstTextRecord(record.content);
      if (nested !== null) return nested;
      continue;
    }
    if (record.type === "text") return firstTextRecord([record]);
  }
  return null;
}

/**
 * Adapt the props the shipped renderer actually passes into the record the
 * parsers below were written against. A props record without `phase` keeps
 * the plain `{args, result}` reading (the store's own rows and the pinned
 * parser tests use that shape).
 */
export function adaptToolviewProps(props: unknown): ToolCallPayload {
  const record = asRecord(props);
  if (record === null) return { args: null, result: null };
  if (typeof record.phase !== "string") {
    return { args: record.args, result: record.result };
  }

  const block = asRecord(record.block);
  if (block === null) return { args: null, result: null };

  const call = asRecord(block.call);
  const args =
    readArguments(block.args) ??
    parseArgumentsText(block.argsRaw) ??
    parseArgumentsText(call?.argsRaw);

  const result = record.phase === "result" ? readResult(block) : null;
  return { args, result };
}

//#endregion

/**
 * Parse one tool call payload into a view model for the given wire tool
 * name. Never throws: every deviation (foreign tool name, non-object props,
 * wrong-typed fields, junk rows) degrades to the safe `degraded` model.
 */
export function describeToolview(
  toolName: string,
  props: unknown,
): ToolviewModel {
  try {
    const record = asRecord(props);
    if (record === null) return DEGRADED;
    const payload: ToolCallPayload = adaptToolviewProps(record);
    switch (toolName) {
      case SPAWN_WORKER_TOOL:
        return describeSpawn(payload);
      case CHECK_WORKERS_TOOL:
        return describeCheck(payload);
      case STEER_WORKER_TOOL:
        return describeSteer(payload);
      case STOP_WORKER_TOOL:
        return describeStop(payload);
      case DELIVER_RESULT_TOOL:
        return describeDeliver(payload);
      case MESSAGE_AGENT_TOOL:
        return describeMessageAgent(payload);
      case AWAIT_AGENT_TOOL:
        return describeAwaitAgent(payload);
      case SPAWN_DISPATCHER_TOOL:
        return describeSpawnDispatcher(payload);
      case SEND_PEER_TOOL:
        return describeSendPeer(payload);
      default:
        return DEGRADED;
    }
  } catch {
    return DEGRADED;
  }
}

/** Guard: the claimed keys are exactly the core dispatcher tool names. */
export function isDispatcherToolName(toolName: string): boolean {
  return (DISPATCHER_TOOL_NAMES as readonly string[]).includes(toolName);
}
