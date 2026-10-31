/**
 * The mount's journal vocabulary, as one closed list (CRITIC-022 P3 #14).
 *
 * A journal line is the only evidence an operator has for what the mount did,
 * and every consumer reads it by a literal `kind`. While the kinds were bare
 * strings, a typo in one `journal('...')` call was a line no reader ever saw and
 * no compiler ever caught. The union below closes the vocabulary: `journal` in
 * `./plugin.ts` takes `RacoonsJournalKind`, so a misspelling is a compile error.
 *
 * ADR-0028 removed the judge pass, so the table loop has one caller (the bulk
 * prune) and its kinds are literal `prune-*` spellings; the `judge-*` and
 * gate-verdict kinds it wrote are gone with the seam that wrote them.
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
  // the prune pass (ISSUE-022; ADR-0028: the ONE table ask left)
  'prune-requested', 'prune-off', 'prune-unseeded', 'prune-plan', 'prune-seed',
  'prune-seed-refused', 'prune-send-refused', 'prune-skip', 'prune-table',
  'prune-verdict', 'prune-recorded', 'prune-threshold', 'prune-error',
  'prune-round-error', 'prune-round-resumed',
  'prune-apply', 'prune-apply-error', 'prune-apply-skipped',
  // the host's own compaction, observed never touched (ISSUE-029)
  'native-compaction',
  // per-request token accounting (G8, ISSUE-045 D1): a reconciled reading, and
  // an `assistant/message` step that carried no usage row at all
  'usage-reconciled', 'usage-missing',
  // the manual forget tool's apply leg (G1, ISSUE-045 D2): one line per request
  // the mount drained at a boundary, and one for a drain that threw
  'forget', 'forget-error',
  // the entry checkpoint's ask (G7, ISSUE-056 C6a; ADR-0022): `entry-ask`
  // carries the answer, its action fields and the observed ask cost;
  // `entry-ask-refused` carries the refusal code and, when the seam returned a
  // text, that text in `raw` (a bounded prefix); `entry-ask-off` says the seam
  // was not armed. Without these three a dead seam reads as a green zero-shaping
  // run, so the mount journals one of them per over-floor result (C6b).
  'entry-ask', 'entry-ask-refused', 'entry-ask-off',
  // the entry checkpoint's APPLY (ISSUE-058 chunk P3c-2; ADR-0022 §11–§14):
  // `entry-apply` carries the surface outcome — `rewound` for a keep-all,
  // `landed` for a forget — with the host seqs the write consumed;
  // `entry-apply-refused` names why an answered exchange wrote nothing and the
  // result stands whole. Additive: the three ask kinds above keep their
  // meanings, so a reader of the earlier lines sees the same vocabulary.
  'entry-apply', 'entry-apply-refused',
] as const;

/** One journal record's kind. */
export type RacoonsJournalKind = (typeof RACOONS_JOURNAL_KINDS)[number];

/** One journal call: a kind from the closed list plus its fields. */
export type MountJournal = (kind: RacoonsJournalKind, fields: Record<string, unknown>) => void;
