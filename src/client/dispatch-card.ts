/**
 * Worker-dispatch card projection (ticket 69 §3.2, C15 holds) — the FROZEN
 * shape ticket 81 renders. Pure data: no React, no DOM, no Cordis; asserted
 * directly by offline tests (S8).
 *
 * PRESENTATION-TIME ONLY: the card is projected from the dispatcher
 * conversation's own `spawn_worker` tool-call record (the parsed call
 * arguments and structured result), never from a relay or a wake. Replay-safe:
 * the projection is a pure function of the durable record, so a replayed
 * history window yields the identical card.
 *
 * This module used to live beside the access-ask card family in
 * `approval-cards.ts`. Ticket 174 / ADR-0033 removed that family with the
 * worker access-ask feature; the dispatch card has no dependency on it and
 * survives here on its own.
 */

/** Frozen gating provenance for a dispatch card. */
export type WorkerDispatchGating =
  | "ungated"
  | "approval-allowed"
  | "approval-refused";

/**
 * The frozen worker-dispatch card shape (design §3.2): `outcome` carries the
 * spawned worker id or the refusal reason.
 *
 * Ticket 174 / ADR-0033: `gating` keeps its frozen three-value vocabulary and
 * every record now projects `"ungated"`. The review-posture gate that produced
 * the other two values was removed with the access-ask feature, so the field
 * is retained only as the record contract it always was — no projection
 * invents a gated value.
 */
export interface WorkerDispatchCard {
  readonly cardKind: "worker-dispatch";
  readonly toolCallId: string;
  readonly streamKey: string | null;
  readonly title: string | null;
  readonly outcome:
    | { readonly kind: "spawned"; readonly workerId: string }
    | { readonly kind: "refused"; readonly reason: string };
  readonly gating: WorkerDispatchGating;
}

/** One `spawn_worker` tool-call record from the conversation window. */
export interface SpawnToolCallRecord {
  readonly callId: string;
  /** Parsed raw arguments JSON (any shape — junk possible). */
  readonly args: unknown;
  /** Parsed structured result payload; `null` until the result lands. */
  readonly result: unknown;
}

/** Narrow `value` to a plain object record (arrays are not records here). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Project one `spawn_worker` tool-call record into the frozen dispatch card,
 * or `null` when no card may honestly render yet: an UNSETTLED call (no
 * result — the tool row's own running state is the pending presentation) or
 * a record too malformed to name a spawn (never a fabricated card). Pure in
 * the record → replay-safe by construction.
 */
export function projectDispatchCard(
  record: SpawnToolCallRecord,
): WorkerDispatchCard | null {
  const args = asRecord(record.args);
  const result = asRecord(record.result);
  if (result === null) return null; // unsettled: no outcome to present

  let outcome: WorkerDispatchCard["outcome"];
  const ok = result.ok;
  if (ok === true) {
    const workerId = asString(result.worker_id);
    if (workerId === null) return null; // malformed success: no card
    outcome = { kind: "spawned", workerId };
  } else if (ok === false) {
    outcome = {
      kind: "refused",
      reason: asString(result.reason) ?? "failed",
    };
  } else {
    return null; // no readable result shape: the generic row covers it
  }

  return {
    cardKind: "worker-dispatch",
    toolCallId: record.callId,
    streamKey: asString(result.stream_key) ?? asString(args?.stream_key),
    title: asString(result.title) ?? asString(args?.title),
    outcome,
    gating: "ungated",
  };
}
