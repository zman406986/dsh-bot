import type { PathEvidence, SearchTarget, SourceRef, ToolEvidence } from '@racoons/core';

/** Facts supplied by the tool integration, never inferred from display text. */
export interface DshPathObservation {
  /** The spelling this observation is keyed by: the call's own target when it named one. */
  readonly path: string;
  readonly pathKey?: string;
  /**
   * The spelling the result itself shows when it differs from the call's own —
   * a read's host meta names the resolved path. Absent means `path` is both.
   */
  readonly displayPath?: string;
  readonly title?: string | null;
  /**
   * The line span this observation covers, when the host reported one. For a
   * read it is the lines the call's own meta returned (`meta.lines.length`), not
   * the file's `totalLines`: a partial read states what it covered (ISSUE-051).
   */
  readonly lineCount?: number | null;
  readonly byteLength?: number | null;
  readonly matchCount?: number;
}

export interface DshResultFacts {
  readonly complete?: boolean;
  readonly failed?: boolean;
  readonly paths?: readonly DshPathObservation[];
}

export interface DshEvidenceInput {
  readonly toolName: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly target?: SearchTarget | null;
  readonly result?: DshResultFacts;
}

/**
 * The evidence kinds this adapter derives. `write` is the core union's own
 * member (V0 widened `ToolEvidence['kind']`; ISSUE-045 chunk C6 removed the
 * boundary cast E0 needed before that landed), so the value reaches core typed.
 */
export type DshToolKind = ToolEvidence['kind'];

export function classifyDshTool(toolName: string): DshToolKind {
  switch (toolName.toLowerCase()) {
    case 'read': case 'read_file': case 'read-file': return 'read';
    case 'search': case 'grep': case 'rg': return 'search';
    case 'glob': return 'glob';
    // A write proves a path changed. It never proves a search space was empty.
    case 'write': case 'edit': case 'apply_patch': case 'patch': return 'write';
    default: return 'other';
  }
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function targetFor(item: DshEvidenceInput, kind: DshToolKind): SearchTarget | null {
  if (item.target !== undefined) {
    return item.target === null || nonempty(item.target.key) === null
      ? null : { ...item.target };
  }
  const label = nonempty(item.input?.['target'])
    ?? (kind === 'search' || kind === 'glob' ? nonempty(item.input?.['pattern']) : null)
    // A write's target is the path it changed, taken from the call's own
    // arguments. It is a fact, so it survives even without a mount-supplied target.
    ?? (kind === 'write' ? nonempty(item.input?.['file_path'])
      ?? nonempty(item.input?.['filePath']) ?? nonempty(item.input?.['path']) : null);
  return label === null ? null : { key: label, label };
}

function count(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Unknown output is never proof of a miss. A read proves a hit through its own
 * host meta — the lines it returned, which arrive as `lineCount` — never through
 * a count (ISSUE-051). A read with no such span stays `unknown`.
 */
export function deriveToolEvidence(
  item: DshEvidenceInput, source: SourceRef, sourceRecallId: string | null = null,
): ToolEvidence {
  const kind = classifyDshTool(item.toolName);
  const target = targetFor(item, kind);
  const observed = new Map<string, DshPathObservation[]>();
  for (const path of item.result?.paths ?? []) {
    if (path.path.length === 0) continue;
    const key = nonempty(path.pathKey) ?? path.path;
    const group = observed.get(key) ?? [];
    group.push(path);
    observed.set(key, group);
  }
  const explicitPaths = item.input?.['paths'];
  const inputPaths: unknown[] = Array.isArray(explicitPaths) ? explicitPaths : [];
  // dsh spells a write's target `file_path`; reads keep their existing spellings.
  const named = kind === 'write' ? [item.input?.['file_path']] : [];
  for (const path of [...named, item.input?.['path'], item.input?.['filePath'], ...inputPaths]) {
    const name = nonempty(path);
    if (name !== null && ![...observed.values()].some(group => group.some(value => value.path === name))) {
      observed.set(name, [{ path: name }]);
    }
  }
  const paths: PathEvidence[] = [...observed.entries()].map(([pathKey, group]) => {
    const path = group[0];
    if (path === undefined) throw new Error('Empty path observation group');
    const counts = group.map(value => count(value.matchCount));
    const lines = group.map(value => count(value.lineCount));
    let outcome: PathEvidence['outcome'] = 'unknown';
    // A write proves a path changed, never that a search space was empty.
    if (kind !== 'other' && kind !== 'write' && item.result?.failed !== true) {
      // A read has no count: the span its own meta reports is what proves the call
      // returned the path's content. It needs no search target — the observation's
      // own path is the host's fact, and a file of zero lines returned no content.
      const covered = kind === 'read' && lines.some(value => value !== null && value >= 1);
      if (covered || (target !== null && counts.some(value => value !== null && value > 0))) {
        outcome = 'hit';
      }
      // Every observation must prove zero; an unknown observation is never a miss,
      // and a read is never a miss (lookup.ts: a miss returned an error, not content).
      if (kind !== 'read' && target !== null
        && counts.every(value => value === 0)
        && item.result?.complete === true && item.result.failed === false) outcome = 'miss';
    }
    // A partial read reports the span it covered, which is the scope of these
    // bytes; every other kind keeps the length its observation carried.
    return { pathKey, displayPath: nonempty(path.displayPath) ?? path.path,
      title: path.title ?? null, lineCount: count(path.lineCount),
      byteLength: count(path.byteLength), outcome };
  });
  // The union admits `write` (V0), so the derived kind travels typed, no cast.
  return { kind, target, paths, source: { ...source }, sourceRecallId };
}
