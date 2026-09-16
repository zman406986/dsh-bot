/**
 * Per-tool call views (ticket 24; design-16 §2/§4.2/§5).
 *
 * The shipped `tool.call.toolview` slot is KEYED by wire tool name (Finding 5,
 * `dsh-client-ui-tool` contract/slots.d.ts:9-23): a key the shipped
 * composition already covers is replaced, not shared; an UNCLAIMED key falls
 * back to the generic tool row. The five dispatcher tool names have been
 * plugin-owned since ticket 11 and none is claimed by any shipped
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
  CHECK_WORKERS_TOOL,
  DELIVER_RESULT_TOOL,
  DISPATCHER_TOOL_NAMES,
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
 * The wire tool names this face claims, in registration order — all five
 * dispatcher tools. `deliver_result` is included because its call row
 * benefits from an at-a-glance delivered/todo outcome on wake turns
 * (ticket 24 "if it benefits").
 */
export const TOOLVIEW_TOOL_NAMES: readonly string[] = [
  SPAWN_WORKER_TOOL,
  CHECK_WORKERS_TOOL,
  STEER_WORKER_TOOL,
  STOP_WORKER_TOOL,
  DELIVER_RESULT_TOOL,
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
 * when the payload carries no readable status.
 */
export interface ToolviewStatusRow {
  readonly workerId: string;
  readonly title: string;
  readonly statusLabel: string | null;
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
    const payload: ToolCallPayload = {
      args: record.args,
      result: record.result,
    };
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
