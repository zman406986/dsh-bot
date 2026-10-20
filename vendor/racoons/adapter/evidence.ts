import type { PathEvidence, SearchTarget, SourceRef, ToolEvidence } from '@racoons/core';

/** Facts supplied by the tool integration, never inferred from display text. */
export interface DshPathObservation {
  readonly path: string;
  readonly pathKey?: string;
  readonly title?: string | null;
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

export function classifyDshTool(toolName: string): ToolEvidence['kind'] {
  switch (toolName.toLowerCase()) {
    case 'read': case 'read_file': case 'read-file': return 'read';
    case 'search': case 'grep': case 'rg': return 'search';
    case 'glob': return 'glob';
    default: return 'other';
  }
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function targetFor(item: DshEvidenceInput, kind: ToolEvidence['kind']): SearchTarget | null {
  if (item.target !== undefined) {
    return item.target === null || nonempty(item.target.key) === null
      ? null : { ...item.target };
  }
  const label = nonempty(item.input?.['target'])
    ?? (kind === 'search' || kind === 'glob' ? nonempty(item.input?.['pattern']) : null);
  return label === null ? null : { key: label, label };
}

function count(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Unknown output, a read alone, and an empty body are never proof of a miss. */
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
  for (const path of [item.input?.['path'], item.input?.['filePath'], ...inputPaths]) {
    const name = nonempty(path);
    if (name !== null && ![...observed.values()].some(group => group.some(value => value.path === name))) {
      observed.set(name, [{ path: name }]);
    }
  }
  const paths: PathEvidence[] = [...observed.entries()].map(([pathKey, group]) => {
    const path = group[0];
    if (path === undefined) throw new Error('Empty path observation group');
    const counts = group.map(value => count(value.matchCount));
    let outcome: PathEvidence['outcome'] = 'unknown';
    if (kind !== 'other' && target !== null && item.result?.failed !== true) {
      if (counts.some(value => value !== null && value > 0)) outcome = 'hit';
      // Every observation must prove zero; an unknown observation is never a miss.
      if (counts.every(value => value === 0)
        && item.result?.complete === true && item.result.failed === false) outcome = 'miss';
    }
    return { pathKey, displayPath: path.path, title: path.title ?? null,
      lineCount: count(path.lineCount), byteLength: count(path.byteLength), outcome };
  });
  return { kind, target, paths, source: { ...source }, sourceRecallId };
}
