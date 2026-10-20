import { DatabaseSync } from "node:sqlite";
import type { RecallId, SessionId } from "../types/identity.js";
import type { Clock } from "../types/transcript.js";
import type { BlobStore } from "./blob-store.js";
import type { RecallRecord } from "./manifest.js";
import type {
  Ledger, LedgerEntry, LedgerEvent, PreparableApplication, PreparedIntent, SqliteLedgerOptions,
} from "./types.js";
import { LedgerError } from "./types.js";
import { initializeSchema } from "./schema.js";
import { storageError } from "./integrity.js";
import { asRow, integer } from "./rows.js";
import { publishPreparation, verifyApplication } from "./prepare.js";
import { commitPreparation } from "./commit-preparation.js";
import { appendEvent, decodeEntry } from "./event-store.js";
import { readRecall } from "./recall.js";

export type { SqliteLedgerOptions } from "./types.js";

export class SqliteLedger implements Ledger {
  readonly #db: DatabaseSync;
  readonly #store: BlobStore;
  readonly #clock: Clock;
  #closed = false;

  private constructor(db: DatabaseSync, options: SqliteLedgerOptions) {
    this.#db = db;
    this.#store = options.blobStore;
    this.#clock = options.clock;
  }

  static async open(options: SqliteLedgerOptions): Promise<SqliteLedger> {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(options.databasePath);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      initializeSchema(db);
      return new SqliteLedger(db, options);
    } catch (error) {
      db?.close();
      throw storageError(error, "Cannot open trash ledger");
    }
  }

  async prepare(application: PreparableApplication): Promise<PreparedIntent> {
    this.#assertOpen();
    try {
      const data = await verifyApplication(application);
      await publishPreparation(data, this.#store);
      this.#assertOpen();
      return this.#transaction(() => {
        const previous = this.#db.prepare("SELECT * FROM applications WHERE intent_id = ?")
          .get(data.intent.intentId);
        const atMs = previous === undefined ? this.#clock.nowMs()
          : integer(asRow(previous, "applications"), "created_at_ms");
        if (!Number.isSafeInteger(atMs)) throw new LedgerError("storage", "Invalid clock timestamp");
        commitPreparation(this.#db, data, atMs);
        appendEvent(this.#db, {
          kind: "prepared", sessionId: data.intent.sessionId, atMs,
          eventKey: `prepared:${data.intent.intentId}`, intentId: data.intent.intentId,
          applicationSha256: data.intent.applicationSha256,
        });
        return data.intent;
      });
    } catch (error) { throw storageError(error, "Cannot prepare application"); }
  }

  async append(event: LedgerEvent): Promise<LedgerEntry> {
    this.#assertOpen();
    try { return this.#transaction(() => appendEvent(this.#db, event)); }
    catch (error) { throw storageError(error, "Cannot append event"); }
  }

  async *events(sessionId: SessionId): AsyncIterable<LedgerEntry> {
    this.#assertOpen();
    try {
      // Snapshot rows before yielding: no live cursor escapes into asynchronous code.
      const rows = this.#db.prepare(`SELECT * FROM ledger_events
        WHERE session_id = ? ORDER BY sequence`).all(sessionId);
      for (const row of rows) yield decodeEntry(asRow(row, "ledger_events"));
    } catch (error) { throw storageError(error, "Cannot read events"); }
  }

  async recall(id: RecallId): Promise<RecallRecord> {
    this.#assertOpen();
    try { return await readRecall(this.#db, this.#store, id); }
    catch (error) { throw storageError(error, `Cannot recall ${id}`); }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#db.close();
      this.#closed = true;
    } catch (error) { throw storageError(error, "Cannot close trash ledger"); }
  }

  #assertOpen(): void {
    if (this.#closed) throw new LedgerError("storage", "Trash ledger is closed");
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
