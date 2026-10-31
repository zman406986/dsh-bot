export interface DshParityRow {
  readonly id: string;
  readonly microcompactBehaviour: string;
  readonly racoonsEquivalent: string;
  readonly status: 'covered' | 'deferred' | 'n/a';
  readonly reason?: string;
  /**
   * The file that proves a `covered` row, repo-relative. Absent on rows that
   * predate this field. A covered row in `CHUNK_PARITY_IDS` must name one, and
   * `parity.test.ts` refuses a path that does not exist — a claim with no test
   * behind it is a claim of a different kind.
   */
  readonly proof?: string;
}

/**
 * The rows ISSUE-045 chunk C12 adds, one per gap the core-completion work
 * closed at the surface: manual forget (G1), proof removals (G2), per-path
 * coverage (G3), recall source fallback (G5) and usage reconciliation (G8).
 * G4/G6/G7 ride inside these (write invalidation is proven by the proof tests
 * the rows name; export/hydrate is core-only and carries no dsh behaviour).
 */
export const CHUNK_PARITY_IDS = ['manual-forget', 'proof-removals',
  'per-path-coverage', 'recall-source-fallback', 'usage-reconciliation'] as const;

/** Contract coverage, not a claim that the unavailable worktree was executed or inspected. */
export const DSH_PARITY_CHECKLIST: readonly DshParityRow[] = Object.freeze([
  { id: 'size-threshold-capping', microcompactBehaviour: 'Limit oversized result payloads.',
    racoonsEquivalent: 'Entry-time size limiting is scrapped (ADR-0014); what replaces it is the '
      + 'entry checkpoint ask, which fires only above the size floor.', status: 'covered' },
  { id: 'deterministic-pass-order', microcompactBehaviour: 'Run deterministic selection first.',
    racoonsEquivalent: 'Engine runs configured rules in order; the defaults are Seal, Verdict, '
      + 'EntryShape, Stale and Superseded.',
    status: 'covered' },
  { id: 'boundary-resume-marker', microcompactBehaviour: 'Keep the boundary marker as resume success evidence.',
    racoonsEquivalent: 'Round trips and M1 append applications preserve existing host records.',
    status: 'deferred', reason: 'Exact reference marker recognition cannot be checked: the supplied '
      + 'worktree files are absent. M1 does not create the native resume success marker.' },
  { id: 'already-capped-result', microcompactBehaviour: 'Do not cap a result a second time.',
    racoonsEquivalent: 'Preserve embedded records and evidence; a node an earlier plan reserved is '
      + 'never removed twice.', status: 'covered' },
  { id: 'tool-call-pairing', microcompactBehaviour: 'Keep tool-call and result envelopes paired.',
    racoonsEquivalent: 'Envelope mapping preserves call IDs, roles, array order, and extra fields.',
    status: 'covered' },
  { id: 'original-restorable', microcompactBehaviour: 'Keep original removed content available.',
    racoonsEquivalent: 'Engine archives before apply; adapter recall delegates exact restoration to core.',
    status: 'covered' },
  { id: 'history-swap', microcompactBehaviour: 'Replace an existing history span atomically.',
    racoonsEquivalent: 'The shipped port applies entry and append modes only; rewrite and rehydrate '
      + 'are refused as unsupported.', status: 'deferred',
    reason: 'History replacement and resume rehydration are deferred to the Protocol milestone, '
      + 'which lands the checkpoint-revert seam (ADR-0007; PRD §13).' },
  { id: 'reference-test-parity', microcompactBehaviour: 'Match the reference microcompact test cases.',
    racoonsEquivalent: 'Adapter tests cover the declared core and host contracts.', status: 'deferred',
    reason: 'The requested reference source and test paths are absent; behaviour beyond the PRD '
      + 'cannot be verified with Read and Write alone.' },

  // --- ISSUE-045 chunk C12: the core-completion gaps, row by row -----------
  // PRD §6.2 "Mistakes are recoverable: manual forget, or recall by id."
  { id: 'manual-forget', microcompactBehaviour: 'Let the agent undo one of its own reads on request.',
    racoonsEquivalent: 'The additive `forget` tool resolves a path and line ranges to one held unit '
      + 'and the mount applies it at its next boundary as one revert plus one receipt; a refused '
      + 'request applies nothing.', status: 'covered',
    proof: 'packages/adapters/dsh/test/forget-tool.test.ts' },
  // PRD §6.6 stale read / superseded read.
  { id: 'proof-removals', microcompactBehaviour: 'Drop a read the transcript itself proves wrong or '
      + 'redundant.', racoonsEquivalent: 'Core registers the stale-read and superseded-read rules; '
      + 'both plan one `proof` op through the same revert lane a verdict uses (ADR-0018), and the '
      + 'mount applies them in its at-rest pass.', status: 'covered',
    proof: 'packages/adapters/dsh/test/prune.test.ts' },
  // PRD §6.6 "Coverage is metered in bytes per source path across all
  // result-producing calls". The meter is core's; the mount feeds it where the
  // snapshot is built, so this row is honest as covered.
  { id: 'per-path-coverage', microcompactBehaviour: 'Report what each source path costs the context.',
    racoonsEquivalent: 'Core ships `CoverageMeter` (tool-name agnostic, hit/miss/unknown split, '
      + 'proven by `packages/core/test/coverage.test.ts`), and the mount records every tool-result '
      + 'node it holds, handing the rows out on `SessionSnapshot.pathCoverage`.', status: 'covered',
    proof: 'packages/adapters/dsh/test/plugin.test.ts' },
  // PRD §6.7 "recall falls back to re-reading the unchanged source when the
  // ledger misses — the two-device safety rule."
  { id: 'recall-source-fallback', microcompactBehaviour: 'Restore archived bytes after a ledger miss.',
    racoonsEquivalent: 'Core answers a miss from the unchanged source under the manifest\'s own hash '
      + '(proven by `packages/core/test/recall-fallback.test.ts` and '
      + '`packages/core/test/recall-integrity.test.ts`); a changed file is a refusal, never a '
      + 'substitute.', status: 'covered',
    proof: 'packages/adapters/dsh/test/plugin.test.ts' },
  // PRD §6.9 "authoritative counts reconcile from API usage (including cached
  // tokens) after each call."
  { id: 'usage-reconciliation', microcompactBehaviour: 'Reconcile the local estimate against the '
      + 'provider\'s own counts.', racoonsEquivalent: 'The mount reads the `assistant/message` usage '
      + 'row, maps the host\'s disjoint buckets onto the core\'s whole-prompt count with the cache '
      + 'share kept readable, and journals `usage-reconciled` or `usage-missing` once per request.',
    status: 'covered', proof: 'packages/adapters/dsh/test/plugin.test.ts' },
]);
