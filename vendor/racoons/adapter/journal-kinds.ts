/**
 * The mount's journal vocabulary, as one closed list (CRITIC-022 P3 #14).
 *
 * A journal line is the only evidence an operator has for what the mount did,
 * and every consumer reads it by a literal `kind`. While the kinds were bare
 * strings, a typo in one `journal('...')` call was a line no reader ever saw and
 * no compiler ever caught. The union below closes the vocabulary: `journal` in
 * `./plugin.ts` takes `RacoonsJournalKind`, so a misspelling is a compile error.
 *
 * The table loop builds four of its kinds by template (`${stage}-table` and
 * friends, where `stage` is `'judge' | 'prune'`). Both concrete spellings are
 * listed here, so a template with a wider `stage` would fail to typecheck too.
 *
 * This module has no imports on purpose: both the mount and the seams it hands
 * a `MountJournal` to need the type, and a leaf keeps those wires acyclic.
 */

/** Every kind this mount journals. */
export const RACOONS_JOURNAL_KINDS = [
  // mount lifecycle
  'mounted', 'capabilities', 'telemetry',
  // step and turn boundaries
  'at-rest', 'at-rest-error', 'entry', 'entry-error', 'skip', 'publish',
  // storage (ADR-0013)
  'storage-plan', 'storage-retry', 'storage-recovered', 'storage-unavailable',
  // the judge pass (ISSUE-024, ISSUE-026)
  'judge-off', 'judge-unseeded', 'judge-ask', 'judge-seed', 'judge-seed-refused',
  'judge-skip', 'judge-send-refused', 'judge-table', 'judge-error', 'judge-receipt-error',
  'verdict-empty', 'verdict-posted', 'verdict-settled',
  // the prune pass (ISSUE-022)
  'prune-requested', 'prune-off', 'prune-unseeded', 'prune-plan', 'prune-seed',
  'prune-seed-refused', 'prune-send-refused', 'prune-skip', 'prune-table',
  'prune-verdict', 'prune-recorded', 'prune-threshold', 'prune-error',
  'prune-round-error', 'prune-round-resumed',
  'prune-apply', 'prune-apply-error', 'prune-apply-skipped',
  // the host's own compaction, observed never touched (ISSUE-029)
  'native-compaction',
] as const;

/** One journal record's kind. */
export type RacoonsJournalKind = (typeof RACOONS_JOURNAL_KINDS)[number];

/** One journal call: a kind from the closed list plus its fields. */
export type MountJournal = (kind: RacoonsJournalKind, fields: Record<string, unknown>) => void;
