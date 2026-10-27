/**
 * The persisted prune round (ISSUE-022 chunk 6; ADR-0009).
 *
 * The mount's round ordinal is the stamp on every assigned index, so two passes
 * must never share one — including across a restart. The engine keeps no pass
 * state (its `settlePrune` consumes `round` and stores nothing), so the mount
 * writes the counter to its own per-session storage: `prune-round.json` beside
 * the session's `ledger.sqlite`, under the same ADR-0013 root and the same
 * `<sessionId>` directory the ledger already uses.
 *
 * It is NOT a ledger record: a round is not a receipt, and the ledger's kinds
 * are a closed, append-only record of applied-ness (ADR-0015). One small file
 * keeps the two facts apart.
 *
 * Concurrency ruling (2026-10-24, ISSUE-035 item 9): two mounts of the SAME
 * session in one process may both read round n and both write n+1. Accepted and
 * documented, not locked: the write is a plain last-write-wins replacement, so
 * the file always holds one complete ordinal and never a torn one. A replayed
 * ordinal is harmless — the round is a stamp on the pass, not a ledger kind
 * (ADR-0015), and event ids are content-derived (76d224e,
 * `dsh:<session>:prune:<round>:<digest>`), so the engine reads a repeated id as
 * a replay and a different document as a new event. Distinct sessions never
 * meet here: ADR-0013 gives each its own directory.
 *
 * Fail-open, like every other mount seam: an unreadable or corrupt file reads
 * as round 0, and a failed write journals `prune-round-error` and does not stop
 * the pass. Worst case is a repeated round ordinal, never a refused prune.
 *
 * `:memory:` storage (tests) persists nothing: the in-memory entry counter is
 * the whole truth there, exactly as before this module existed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResolvedRacoonsStorage } from './storage.js';
import type { MountJournal } from './journal-kinds.js';

/** The counter's file name, beside `ledger.sqlite` and `blobs/`. */
export const PRUNE_ROUND_FILE = 'prune-round.json';

/** The session directory a resolved durable target names, or null when in memory. */
function sessionDirOf(target: ResolvedRacoonsStorage): string | null {
  return target.databasePath === ':memory:' ? null : dirname(target.databasePath);
}

/**
 * The round this session last completed; 0 when nothing was ever written.
 * A durable target with no file, a corrupt file, or a negative/non-integer
 * value all read as 0: the safe failure is "start over", never "trust garbage".
 */
export function readPruneRound(target: ResolvedRacoonsStorage): number {
  const dir = sessionDirOf(target);
  if (dir === null) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, PRUNE_ROUND_FILE), 'utf8'));
    const round = typeof parsed === 'object' && parsed !== null
      ? (parsed as { readonly round?: unknown }).round : undefined;
    return typeof round === 'number' && Number.isSafeInteger(round) && round >= 0 ? round : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the last completed round. Returns false when it could not be written;
 * the caller journals that and keeps the in-memory counter, so the pass itself
 * is never lost — only its durability across a restart.
 */
export function writePruneRound(target: ResolvedRacoonsStorage, round: number,
  journal: MountJournal, sessionId: string): boolean {
  const dir = sessionDirOf(target);
  if (dir === null) return true;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PRUNE_ROUND_FILE), `${JSON.stringify({ round })}\n`, 'utf8');
    return true;
  } catch (error) {
    journal('prune-round-error', { sessionId, round,
      message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
