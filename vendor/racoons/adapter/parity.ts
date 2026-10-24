export interface DshParityRow {
  readonly id: string;
  readonly microcompactBehaviour: string;
  readonly racoonsEquivalent: string;
  readonly status: 'covered' | 'deferred' | 'n/a';
  readonly reason?: string;
}

/** Contract coverage, not a claim that the unavailable worktree was executed or inspected. */
export const DSH_PARITY_CHECKLIST: readonly DshParityRow[] = Object.freeze([
  { id: 'size-threshold-capping', microcompactBehaviour: 'Limit oversized result payloads.',
    racoonsEquivalent: 'Entry events delegate size decisions to core CapRule.', status: 'covered' },
  { id: 'deterministic-pass-order', microcompactBehaviour: 'Run deterministic selection first.',
    racoonsEquivalent: 'Engine runs configured rules in order; M1 defaults are Cap then Seal.',
    status: 'covered' },
  { id: 'boundary-resume-marker', microcompactBehaviour: 'Keep the boundary marker as resume success evidence.',
    racoonsEquivalent: 'Round trips and M1 append applications preserve existing host records.',
    status: 'deferred', reason: 'Exact reference marker recognition cannot be checked: the supplied '
      + 'worktree files are absent. M1 does not create the native resume success marker.' },
  { id: 'already-capped-result', microcompactBehaviour: 'Do not cap a result a second time.',
    racoonsEquivalent: 'Preserve embedded records and evidence; core CapRule decides whether to skip.',
    status: 'covered' },
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
]);
