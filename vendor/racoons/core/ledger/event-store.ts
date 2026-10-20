import type { DatabaseSync } from "node:sqlite";
import type { LedgerEntry, LedgerEvent } from "./types.js";
import { LedgerError } from "./types.js";
import { stableJson } from "./integrity.js";
import { asRow, integer, text } from "./rows.js";
import type { Row } from "./rows.js";

export function appendEvent(db: DatabaseSync, event: LedgerEvent): LedgerEntry {
  if (typeof event.sessionId !== "string" || typeof event.eventKey !== "string" ||
      !Number.isSafeInteger(event.atMs)) throw new LedgerError("storage", "Invalid event identity");
  const payload = stableJson(event);
  const existingRow = db.prepare("SELECT * FROM ledger_events WHERE event_key = ?").get(event.eventKey);
  if (existingRow !== undefined) {
    const existing = asRow(existingRow, "ledger_events");
    if (text(existing, "payload_json") !== payload) {
      throw new LedgerError("idempotency-conflict", `Conflicting event ${event.eventKey}`);
    }
    return decodeEntry(existing);
  }
  const intentId = event.kind === "prepared" || event.kind === "abandoned" ? event.intentId
    : event.kind === "applied" ? event.receipt.intentId : null;
  if (intentId !== null) {
    const intentRow = db.prepare("SELECT * FROM applications WHERE intent_id = ?").get(intentId);
    if (intentRow === undefined) throw new LedgerError("not-found", `Missing intent ${intentId}`);
    const intent = asRow(intentRow, "applications");
    if (text(intent, "session_id") !== event.sessionId) conflict("Event session differs from intent");
    if (event.kind === "prepared" &&
        text(intent, "application_sha256") !== event.applicationSha256) conflict("Prepared hash differs");
    if (event.kind === "applied") {
      const receipt = event.receipt;
      if (receipt.sessionId !== event.sessionId ||
          receipt.baseRevision !== text(intent, "base_revision") ||
          receipt.applicationSha256 !== text(intent, "application_sha256") ||
          !Number.isSafeInteger(receipt.appliedAtMs) || typeof receipt.resultRevision !== "string") {
        conflict("Receipt differs from prepared intent");
      }
    }
  }
  const result = db.prepare(`INSERT INTO ledger_events
    (event_key, session_id, intent_id, kind, at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(event.eventKey, event.sessionId, intentId, event.kind, event.atMs, payload);
  const sequence = Number(result.lastInsertRowid);
  if (!Number.isSafeInteger(sequence)) throw new LedgerError("storage", "Event sequence exceeds safe integer");
  // Parse a private snapshot, so mutation of caller-owned objects cannot leak back.
  return decodeEntry({ sequence, payload_json: payload, event_key: event.eventKey,
    session_id: event.sessionId, kind: event.kind, at_ms: event.atMs, intent_id: intentId });
}

export function decodeEntry(row: Row): LedgerEntry {
  const raw: unknown = JSON.parse(text(row, "payload_json"));
  if (typeof raw !== "object" || raw === null || !("kind" in raw) ||
      !("sessionId" in raw) || !("eventKey" in raw) || !("atMs" in raw) ||
      raw.kind !== row.kind || raw.sessionId !== row.session_id ||
      raw.eventKey !== row.event_key || raw.atMs !== row.at_ms) {
    throw new LedgerError("storage", "Stored event metadata is inconsistent");
  }
  return { sequence: integer(row, "sequence"), event: raw as LedgerEvent };
}

function conflict(message: string): never {
  throw new LedgerError("idempotency-conflict", message);
}
