/**
 * Per-tool call views (ticket 24; design-16 §2/§4.2/§5).
 *
 * The shipped `tool.call.toolview` slot is KEYED by wire tool name (Finding 5,
 * `dsh-client-ui-tool` contract/slots.d.ts:9-23): a key the shipped
 * composition already covers is replaced, not shared; an UNCLAIMED key falls
 * back to the generic tool row. The dispatcher tool names (eight since
 * ticket 118; nine keys claimed here with the retained historical
 * `send_peer`) have been plugin-owned and none is claimed by any shipped
 * `dsh-client-ui-*` package (shipped claims per the 0.1.5-rc.1 catalog:
 * `cordis_define` / `cordis_run` only), so claiming them is additive-safe.
 *
 * Keys are EXACTLY the core wire tool names from
 * `src/core/policy/prompts.ts` — nothing invented (design-16 §5). Ids/labels
 * live under the `multitask-dispatcher` locale namespace.
 *
 * This module is pure registration data + pure payload parsing: no React,
 * no DOM, no Cordis. Tests assert it directly (offline, S8). The component
 * factory that consumes these view models lives in `toolview-panel.tsx`.
 *
 * Views are read-only presentation (design-16 §3.4): they render only what
 * the tool call already carries — no fetches, no actions, no authority.
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

/**
 * The shipped keyed slot for per-tool call renderings. dsh-owned; never an
 * invented slot name (design-16 §5 slot-name rule).
 */
export const TOOL_CALL_TOOLVIEW_SLOT = "tool.call.toolview";

/**
 * The wire tool names this face claims, in registration order — the eight
 * dispatcher tools plus the retained historical `send_peer` key (ticket 152).
 * `deliver_result` is included because its call row benefits from an
 * at-a-glance delivered/todo outcome on wake turns (ticket 24 "if it
 * benefits"); `send_peer` (ticket 70) because its row is the user-visible
 * trace of peer traffic on the conversation surface.
 *
 * `message_agent` (ticket 116), `await_agent` (ticket 117) and
 * `spawn_dispatcher` (ticket 118) had no row renderer here — the deliberate
 * lag ticket 152 closes: each now has its own parser below, so the dispatcher
 * surface is covered key for key. `send_peer` stays claimed because
 * transcripts from before ticket 116 still carry those rows.
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
 * catalog (research Finding 5). We must never claim one of these — claiming
 * a covered key is a shadowing election against shipped UI.
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

/** Locale keys for the field labels rendered by the toolview rows. */
export const TOOLVIEW_FIELD_KEYS = {
  worker: "toolview.field.worker",
  title: "toolview.field.title",
  stream: "toolview.field.stream",
  todo: "toolview.field.todo",
  outcome: "toolview.field.outcome",
  steer: "toolview.field.steer",
  delivered: "toolview.field.delivered",
  attachments: "toolview.field.attachments",
  peer: "toolview.field.peer",
  priority: "toolview.field.priority",
  // Ticket 152: labels for the message_agent / await_agent /
  // spawn_dispatcher rows.
  agent: "toolview.field.agent",
  status: "toolview.field.status",
  deliveredAs: "toolview.field.delivered-as",
  dispatcher: "toolview.field.dispatcher",
} as const;

/** Locale key for the degraded row copy. */
export const TOOLVIEW_DEGRADED_KEY = "toolview.degraded";

/**
 * The props a toolview entry is handed by the renderer. The exact prop face
 * is renderer-controlled, so the parsers below treat this defensively: any
 * deviation degrades to a safe row, never a throw.
 */
export interface ToolCallPayload {
  readonly args: unknown;
  readonly result: unknown;
}

/** One label/value pair; `labelKey` resolves through the locale seat. */
export interface ToolviewField {
  readonly labelKey: string;
  readonly value: string;
}

/**
 * One `check_workers` roster row. `statusLabel` reuses the core FSM
 * vocabulary VERBATIM (identity contract, same as the roster panel); null
 * when the payload carries no readable status. `activity` is the row's
 * recent-activity phrase when the core recorded one (ticket 29) — clamped,
 * whitespace-collapsed; null when absent so the line is omitted entirely.
 */
export interface ToolviewStatusRow {
  readonly workerId: string;
  readonly title: string;
  readonly statusLabel: string | null;
  readonly activity: string | null;
}

/**
 * Parsed view outcome: `degraded` renders the safe degraded row (malformed,
 * partial, or foreign payload); `detail` renders the parsed fields plus any
 * status rows.
 */
export type ToolviewModel =
  | { readonly kind: "degraded" }
  | {
      readonly kind: "detail";
      readonly fields: readonly ToolviewField[];
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

/** Boolean or null — booleans render verbatim ("true"/"false"). */
function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Collapse whitespace and clamp to the compact-row budget. Null for
 * missing/empty values so the field is omitted entirely.
 */
function clampText(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  if (flat.length <= TOOLVIEW_TEXT_CLAMP_CHARS) return flat;
  return `${flat.slice(0, TOOLVIEW_TEXT_CLAMP_CHARS)}…`;
}

/** Outcome field from a tool result: "ok" or the verbatim failure reason. */
function outcomeField(
  result: Record<string, unknown> | null,
): ToolviewField | null {
  if (result === null) return null;
  const ok = asBool(result.ok);
  if (ok === null) return null;
  if (ok) return { labelKey: TOOLVIEW_FIELD_KEYS.outcome, value: "ok" };
  const reason = asString(result.reason);
  return {
    labelKey: TOOLVIEW_FIELD_KEYS.outcome,
    value: reason ?? "failed",
  };
}

/** Degrade only when nothing at all parsed. */
function detailOrDegraded(
  fields: readonly ToolviewField[],
  statusRows: readonly ToolviewStatusRow[],
): ToolviewModel {
  if (fields.length === 0 && statusRows.length === 0) return DEGRADED;
  return { kind: "detail", fields, statusRows };
}

function describeSpawn(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const workerId = asString(result?.worker_id);
  if (workerId !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.worker, value: workerId });
  }
  const title = asString(result?.title) ?? asString(args?.title);
  if (title !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.title, value: title });
  }
  const stream = asString(result?.stream_key) ?? asString(args?.stream_key);
  if (stream !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.stream, value: stream });
  }
  const todo = asString(args?.todo_id);
  if (todo !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.todo, value: todo });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

function describeCheck(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];
  const statusRows: ToolviewStatusRow[] = [];

  const target = asString(args?.worker_id);
  if (target !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.worker, value: target });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  // Status rows only from a well-formed success result; a success carrying
  // a non-array `rows` is malformed → degraded.
  if (result !== null && asBool(result.ok) === true) {
    const rows = result.rows;
    if (!Array.isArray(rows)) return DEGRADED;
    for (const row of rows) {
      const record = asRecord(row);
      if (record === null) continue;
      const rowWorker = asString(record.worker_id);
      if (rowWorker === null) continue;
      statusRows.push({
        workerId: rowWorker,
        title: asString(record.title) ?? rowWorker,
        // Core FSM vocabulary verbatim; unreadable status → null (omitted).
        statusLabel: asString(record.status),
        // Ticket 29: the core clamps `recent_activity` to
        // CHECK_ACTIVITY_CHARS (120); this second clamp keeps a malformed
        // or oversized wire value inside the compact-row budget too.
        activity: clampText(record.recent_activity),
      });
    }
  }

  return detailOrDegraded(fields, statusRows);
}

function describeSteer(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const workerId = asString(args?.worker_id);
  if (workerId !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.worker, value: workerId });
  }
  const steer = clampText(args?.message);
  if (steer !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.steer, value: steer });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

function describeStop(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const workerId = asString(args?.worker_id);
  if (workerId !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.worker, value: workerId });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

function describeDeliver(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const delivered = asBool(result?.delivered);
  if (delivered !== null) {
    fields.push({
      labelKey: TOOLVIEW_FIELD_KEYS.delivered,
      value: delivered ? "true" : "false",
    });
  }
  const todo =
    asString(result?.todo_completed) ?? asString(args?.todo_id);
  if (todo !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.todo, value: todo });
  }
  const attachments = args?.attachment_paths;
  if (Array.isArray(attachments)) {
    fields.push({
      labelKey: TOOLVIEW_FIELD_KEYS.attachments,
      value: String(attachments.length),
    });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

/**
 * Ticket 70: the send_peer row — the conversation-visible trace of peer
 * traffic. Read-only fields from the call's own record: the target session,
 * the priority flag, and the acceptance outcome. The message BODY is never
 * rendered here (the row stays a compact at-a-glance line; the body lives
 * in the dispatcher's turns, not the tool row).
 */
function describeSendPeer(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const toSession = asString(result?.to_session) ?? asString(args?.to_session);
  if (toSession !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.peer, value: toSession });
  }
  const priority = asBool(args?.priority);
  if (priority !== null) {
    fields.push({
      labelKey: TOOLVIEW_FIELD_KEYS.priority,
      value: priority ? "true" : "false",
    });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

/**
 * Ticket 152: the message_agent row (ticket 116's one messaging verb). The
 * target is the thing the user cares about, and `delivered_as` says which
 * lane accepted it ("steer" = your worker, "peer" = another dispatcher). The
 * message BODY never renders here, same rule as `send_peer`; the call's text
 * stays in the dispatcher's turns.
 */
function describeMessageAgent(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const target = asString(result?.target) ?? asString(args?.target);
  if (target !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.agent, value: target });
  }
  const deliveredAs = asString(result?.delivered_as);
  if (deliveredAs !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.deliveredAs, value: deliveredAs });
  }
  const priority = asBool(args?.priority);
  if (priority !== null) {
    fields.push({
      labelKey: TOOLVIEW_FIELD_KEYS.priority,
      value: priority ? "true" : "false",
    });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

/**
 * Ticket 152: the await_agent row (ticket 117's one bounded wait). The
 * worker id plus the outcome status is the whole story: `settled` carries
 * the worker's terminal status after it, and a `released` wait names which
 * racer cut it short. A timeout is a normal outcome, so no "Outcome" field
 * on the success path — only a refusal renders its reason.
 */
function describeAwaitAgent(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const target = asString(result?.target) ?? asString(args?.target);
  if (target !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.worker, value: target });
  }
  const status = asString(result?.status);
  if (status !== null) {
    const workerStatus = asString(result?.worker_status);
    const reason = asString(result?.reason);
    const detail =
      status === "settled" && workerStatus !== null
        ? `${status} · ${workerStatus}`
        : status === "released" && reason !== null
          ? `${status} · ${reason}`
          : status;
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.status, value: detail });
  }
  if (result !== null && asBool(result.ok) === false) {
    const outcome = outcomeField(result);
    if (outcome !== null) fields.push(outcome);
  }

  return detailOrDegraded(fields, []);
}

/**
 * Ticket 152: the spawn_dispatcher row (ticket 118's mitosis). The child
 * session id is what the dispatcher messages later, so it leads; the title
 * names what was summoned. The handoff prompt never renders here.
 */
function describeSpawnDispatcher(payload: ToolCallPayload): ToolviewModel {
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const fields: ToolviewField[] = [];

  const dispatcherId = asString(result?.dispatcher_id);
  if (dispatcherId !== null) {
    fields.push({
      labelKey: TOOLVIEW_FIELD_KEYS.dispatcher,
      value: dispatcherId,
    });
  }
  const title = clampText(result?.title) ?? clampText(args?.title);
  if (title !== null) {
    fields.push({ labelKey: TOOLVIEW_FIELD_KEYS.title, value: title });
  }
  const outcome = outcomeField(result);
  if (outcome !== null) fields.push(outcome);

  return detailOrDegraded(fields, []);
}

//#region stock props → parser payload (the boundary adapter)

/**
 * The structural face this adapter reads off the shipped `PartialArguments`
 * reader (`dsh-util-values/lib/types/partial-json.d.ts:24-123`): keys seen so
 * far, a streaming string prefix, and a completed non-string value. All three
 * readers are total — absent or differently typed fields answer `undefined`,
 * never throw (`:20-22`).
 */
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

/**
 * Materialize the lazy argument reader into the plain record the parsers
 * already consume. Reads whatever has arrived: a completed non-string answers
 * `value()`, a string answers its `text()` prefix (complete or still
 * streaming), so a half-streamed argument object renders the fields it has
 * instead of degrading. A reader over a still-open object simply yields the
 * fields whose delimiters have landed.
 */
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
    // An empty reading falls back to the raw text the caller may still hold
    // (a result whose `tool/call` left the loaded window has an empty view,
    // `records.d.ts:279-281`).
    return Object.keys(out).length === 0 ? null : out;
  }
  return asRecord(args);
}

/** Parse one raw argument JSON text; junk and non-objects narrow to null. */
function parseArgumentsText(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/**
 * The structured result record for the parsers, read off a settled
 * `ToolResultNode` (`records.d.ts:157-185`): the tool's own `meta` when it
 * attached one, else the first text block's JSON (where the harness
 * serializes a tool's structured payload), mirroring the store's reader.
 * A failed call with no readable payload still reports the failure
 * (`isError` + `error.code`/`error.reason`, `:177-182`), never a false "ok".
 */
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

/**
 * First JSON text block of a result's content as a record. A `tool-result`
 * block carries its payload one nesting level deeper; a bare text block sits
 * at the message level. The first text block decides — JSON is the structured
 * record, any other text is prose and yields null.
 */
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
 * parsers below were written against.
 *
 * Stock dsh hands the keyed `tool.call.toolview` slot
 * `ToolCallCommonProps & ToolCallPhaseProps` — only `phase` plus `block`
 * (`dsh-client-ui-tool/lib/types/client/contract/slots.d.ts:54-84`, composed
 * at `dsh-client-ui-tool/lib/client.js:1936-1947`) — while the argument view
 * is lazy (`records.d.ts:270,282`). The parsers want `{args, result}`, so the
 * real data is lifted here, at the boundary; the parser shape is unchanged.
 *
 * A props record without `phase` keeps the plain `{args, result}` reading
 * (the store's own rows and the pinned parser tests use that shape).
 */
export function adaptToolviewProps(props: unknown): ToolCallPayload {
  const record = asRecord(props);
  if (record === null) return { args: null, result: null };
  if (typeof record.phase !== "string") {
    return { args: record.args, result: record.result };
  }

  const block = asRecord(record.block);
  if (block === null) return { args: null, result: null };

  // Arguments: `block.args` (all three stages, `records.d.ts:270`) with the
  // raw-text fallbacks — `argsRaw` once dispatched (`:288-291`), `call.argsRaw`
  // on a settled result whose call is still in-window (`:170-173`).
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
