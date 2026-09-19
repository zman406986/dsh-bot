#!/usr/bin/env node
// tools/adr-index.mjs — regenerate ONLY the index table in docs/adr/README.md from docs/adr/*.md
// (ticket 96). Deterministic; idempotent; runs from any cwd; zero dependencies.
//
// MERGE RULE (ticket 96, "Decide and record the ADR-index merge rule"):
//   The generator owns the ROW SET — an ADR file exists under docs/adr/NNNN-*.md if and only if
//   the table has a row with that number, sorted by number. Every per-number ROW LINE that already
//   exists is reused VERBATIM, so the hand-maintained Status prose ("accepted; **superseded by
//   0018** — no flag, always-on", the ADR-0016 retraction note, pending-sign-off notes) and the
//   curated titles are NEVER rewritten or flattened. Rows for numbers without a file are dropped.
//   New ADR files get a synthesized row: title from the file's H1, status from the file's
//   **Status:** line. All non-table prose in README.md is preserved byte-for-byte (line endings
//   included). A second run is byte-identical.
//
// CLI:
//   node tools/adr-index.mjs            merge-regenerate the table in docs/adr/README.md
//   node tools/adr-index.mjs --check    verify the on-disk file equals regeneration; exit 1 if not
//   node tools/adr-index.mjs --json     machine-readable output (combine with --check)
//   node tools/adr-index.mjs --help
// Exit codes: 0 ok/fresh · 1 stale · 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRootOf, readTextIfExists, splitLines, detectEol } from './lib.mjs';

export const ADR_INDEX_VERSION = '1.0.0';
export const ADR_DIR_REL = 'docs/adr';
export const ADR_INDEX_REL = 'docs/adr/README.md';

const ADR_FILE_RE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;
const ROW_RE = /^\|\s*\[(\d{4})\]\(([^)|]+)\)\s*\|/;
const CANONICAL_HEADER = ['| ADR | Title | Status |', '|---|---|---|'];

/** Every ADR file: { num, fileName, file, title, status }, sorted by number. */
export function listAdrFiles(rootDir) {
  const adrDir = path.join(rootDir, ADR_DIR_REL);
  let names = [];
  try {
    names = fs.readdirSync(adrDir);
  } catch {
    names = [];
  }
  const files = [];
  for (const name of names) {
    if (name === 'README.md' || name === 'INDEX.md') continue;
    const m = name.match(ADR_FILE_RE);
    if (!m) continue;
    const text = readTextIfExists(path.join(adrDir, name)) ?? '';
    const h1 = text.match(/^#\s+(.+)$/m);
    const statusLine = text.match(/^\*\*Status:\*\*[ \t]*(.*)$/m);
    files.push({
      num: m[1],
      fileName: name,
      file: `${ADR_DIR_REL}/${name}`,
      title: h1 ? h1[1].trim() : m[1],
      status: statusLine ? statusLine[1].trim() : '',
    });
  }
  files.sort((a, b) => a.num.localeCompare(b.num));
  return files;
}

/**
 * Parse README.md's first contiguous `|`-table.
 * Returns { start, end, header, separator, rows: Map<num, line>, passthrough: string[] }
 * with start === -1 when no table exists. Unparsable block lines are kept in `passthrough`
 * (re-emitted verbatim) so malformed tables never lose prose.
 */
export function parseAdrTable(text) {
  const lines = splitLines(text);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return { start: -1, end: -1, header: null, separator: null, rows: new Map(), passthrough: [] };
  }
  let end = start;
  while (end < lines.length && /^\s*\|/.test(lines[end])) end++;
  const block = lines.slice(start, end);
  const header = block.length > 0 ? block[0] : null;
  const separator = block.length > 1 && /^\|[\s:|-]+$/.test(block[1]) ? block[1] : null;
  const rows = new Map();
  const passthrough = [];
  for (let i = separator ? 2 : 1; i < block.length; i++) {
    const m = block[i].match(ROW_RE);
    if (m) {
      if (!rows.has(m[1])) rows.set(m[1], block[i]); // duplicate numbers: first wins
    } else {
      passthrough.push(block[i]);
    }
  }
  return { start, end, header, separator, rows, passthrough };
}

function synthesizeRow(file) {
  const esc = (s) => s.replace(/\|/g, '\\|');
  const status = file.status || '(status pending — hand-maintain this cell)';
  return `| [${file.num}](${file.fileName}) | ${esc(file.title)} | ${esc(status)} |`;
}

/**
 * Merge the row set with the files: existing row lines reused verbatim (prose preserved),
 * new files appended in number order, rows without files dropped, passthrough lines kept.
 */
export function mergeAdrTable(table, files) {
  const out = [table.header ?? CANONICAL_HEADER[0], table.separator ?? CANONICAL_HEADER[1]];
  const known = new Set();
  for (const f of files) {
    const existing = table.rows.get(f.num);
    out.push(existing ?? synthesizeRow(f));
    known.add(f.num);
  }
  for (const [num, line] of table.rows) {
    if (!known.has(num)) out.push(line); // row without a file: the file set owns rows, but never silently delete prose
  }
  out.push(...table.passthrough);
  return out;
}

/** Full regenerated README.md content (merge rule applied), plus the file list. */
export function generateAdrIndex(rootDir) {
  const files = listAdrFiles(rootDir);
  const text = readTextIfExists(path.join(rootDir, ADR_INDEX_REL));
  if (text === null) {
    const body = ['# Architecture Decision Records', '', ...mergeAdrTable(parseAdrTable(''), files), ''].join('\n');
    return { relPath: ADR_INDEX_REL, content: body, files, created: true };
  }
  const eol = detectEol(text);
  const table = parseAdrTable(text);
  const merged = mergeAdrTable(table, files);
  let lines;
  if (table.start === -1) {
    // No table yet: insert one directly after the first heading (or at the end).
    lines = splitLines(text);
    const headingAt = lines.findIndex((l) => /^#\s/.test(l));
    const at = headingAt === -1 ? lines.length : headingAt + 1;
    lines.splice(at, 0, '', ...merged);
  } else {
    const all = splitLines(text);
    lines = [...all.slice(0, table.start), ...merged, ...all.slice(table.end)];
  }
  return { relPath: ADR_INDEX_REL, content: lines.join(eol), files, created: false };
}

export function checkAdrIndex(rootDir) {
  const { relPath, content, files } = generateAdrIndex(rootDir);
  const actual = readTextIfExists(path.join(rootDir, relPath));
  if (actual === null) {
    return { ok: false, relPath, rows: files.length, reason: `missing — run: node tools/adr-index.mjs`, expected: content, actual: null };
  }
  if (actual !== content) {
    return { ok: false, relPath, rows: files.length, reason: 'stale — differs from regeneration; run: node tools/adr-index.mjs', expected: content, actual };
  }
  return { ok: true, relPath, rows: files.length, reason: 'fresh', expected: content, actual };
}

export function writeAdrIndex(rootDir) {
  const { relPath, content, files } = generateAdrIndex(rootDir);
  fs.writeFileSync(path.join(rootDir, relPath), content, 'utf8');
  return { relPath, rows: files.length };
}

function usage() {
  return [
    'usage: node tools/adr-index.mjs [--check] [--json] [--help]',
    '',
    '  (default)   merge-regenerate the index table in docs/adr/README.md from docs/adr/*.md',
    '              (row set owned by the files; per-number title/status rows and all prose preserved)',
    '  --check     verify the on-disk README equals regeneration (exit 1 when stale)',
    '  --json      machine-readable JSON output',
  ].join('\n');
}

export function main(argv, rootDir = repoRootOf(import.meta.url)) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const unknown = args.filter((a) => a !== '--check' && a !== '--json');
  if (unknown.length > 0) {
    console.error(`adr-index: unknown argument(s): ${unknown.join(' ')}\n${usage()}`);
    return 2;
  }
  const json = args.includes('--json');
  if (args.includes('--check')) {
    const r = checkAdrIndex(rootDir);
    if (json) {
      console.log(
        JSON.stringify(
          { tool: 'adr-index', version: ADR_INDEX_VERSION, ok: r.ok, relPath: r.relPath, rows: r.rows, reason: r.reason },
          null,
          2
        )
      );
    } else {
      console.log(`adr-index: ${r.relPath} — ${r.ok ? 'fresh' : r.reason} (${r.rows} rows)`);
    }
    return r.ok ? 0 : 1;
  }
  const w = writeAdrIndex(rootDir);
  if (json) {
    console.log(JSON.stringify({ tool: 'adr-index', version: ADR_INDEX_VERSION, ok: true, ...w }, null, 2));
  } else {
    console.log(`adr-index: regenerated table in ${w.relPath} (${w.rows} rows; prose preserved)`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
