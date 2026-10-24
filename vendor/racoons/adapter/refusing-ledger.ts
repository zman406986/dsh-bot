/**
 * The refusing ledger (ISSUE-004 chunk 4, ADR-0013 ruling 4).
 *
 * A durable ledger that cannot open installs this in its place. Every method
 * refuses with a typed `LedgerError('storage')`, so the engine stops before it
 * can prepare or apply anything: no removal happens, the transcript keeps its
 * bytes, and the session degrades to `recovery-pending` instead of throwing
 * into the host's pre-step. Recall refuses for the same reason: there is no
 * store to read.
 *
 * The refusal keeps the open failure's code and path, so the journal line the
 * mount writes can name what could not be opened and why.
 */
import { LedgerError } from '@racoons/core';
import type {
  Ledger, LedgerEntry, LedgerEvent, PreparableApplication, PreparedIntent, RecallId,
  RecallRecord, SessionId,
} from '@racoons/core';

/** What could not be opened: the storage error's code, path and message. */
export interface RefusingLedgerOptions {
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}

export class RefusingLedger implements Ledger {
  readonly code: string;
  readonly path: string | null;
  readonly message: string;

  constructor(options: RefusingLedgerOptions) {
    this.code = options.code;
    this.path = options.path;
    this.message = options.message;
  }

  /** One typed refusal naming the operation and the failed open. */
  private refusal(operation: string): LedgerError {
    return new LedgerError('storage', `racoons: the trash ledger is unavailable (${this.code})`
      + `${this.path === null ? '' : ` at ${this.path}`}; refusing ${operation}: ${this.message}`);
  }

  async prepare(_application: PreparableApplication): Promise<PreparedIntent> {
    throw this.refusal('prepare');
  }

  async append(_event: LedgerEvent): Promise<LedgerEntry> {
    throw this.refusal('append');
  }

  async *events(_sessionId: SessionId): AsyncIterable<LedgerEntry> {
    throw this.refusal('events');
  }

  async recall(_id: RecallId): Promise<RecallRecord> {
    throw this.refusal('recall');
  }

  async close(): Promise<void> {
    throw this.refusal('close');
  }
}

export function createRefusingLedger(options: RefusingLedgerOptions): RefusingLedger {
  return new RefusingLedger(options);
}
