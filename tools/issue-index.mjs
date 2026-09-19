#!/usr/bin/env node
// tools/issue-index.mjs — generate Issue-tracker/open-issue-index.md from Issue-tracker/open/*.md
// (ticket 96). The row set is owned by the folder: a ticket that moves cannot leave a stale row.
//
// Zero dependencies (node:fs / node:path / node:url). Runs from any cwd. Output is
// deterministic — sorted by ticket number, no timestamps — so a second run is byte-identical.
//
// CLI:
//   node tools/issue-index.mjs            write Issue-tracker/open-issue-index.md
//   node tools/issue-index.mjs --check    verify the on-disk index is fresh; exit 1 if not
//   node tools/issue-index.mjs --json     machine-readable output (combine with --check)
//   node tools/issue-index.mjs --help
// Exit codes: 0 ok/fresh · 1 stale/missing · 2 usage error.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRootOf, readTextIfExists, detectEol } from './lib.mjs';

export const ISSUE_INDEX_VERSION = '1.0.0';
export const OPEN_DIR_REL = 'Issue-tracker/open';
export const OPEN_INDEX_REL = 'Issue-tracker/open-issue-index.md';

const TICKET_FILE_RE = /^(\d+)-([a-z0-9-]+)\.md$/;

/** Every open ticket: { num, slug, file, title, status, labels }, sorted by number. */
export function listOpenTickets(rootDir) {
  const openDir = path.join(rootDir, OPEN_DIR_REL);
  let names = [];
  try {
    names = fs.readdirSync(openDir);
  } catch {
    names = [];
  }
  const tickets = [];
  for (const name of names) {
    const m = name.match(TICKET_FILE_RE);
    if (!m) continue;
    const text = readTextIfExists(path.join(openDir, name)) ?? '';
    const h1 = text.match(/^#\s+(.+)$/m);
    // H1 shape: "# NN — Title"; strip the number+dash prefix, fall back to the slug.
    const title =
      (h1 ? h1[1].trim().replace(/^\d+\s*[—–-]\s*/, '').trim() : '') || m[2];
    const labelsLine = text.match(/^\*\*Labels:\*\*[ \t]*(.*)$/m);
    tickets.push({
      num: m[1],
      slug: m[2],
      file: `${OPEN_DIR_REL}/${name}`,
      title,
      status: 'open', // from the folder — listOpenTickets only walks open/
      labels: labelsLine ? labelsLine[1].trim() : '',
    });
  }
  tickets.sort((a, b) => Number(a.num) - Number(b.num) || a.slug.localeCompare(b.slug));
  return tickets;
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|');
}

/** Render the index body (pure function of the ticket list + line ending). */
export function renderIssueIndex(tickets, eol = '\n') {
  const n = tickets.length;
  const lines = [
    `<!-- GENERATED FILE — tools/issue-index.mjs v${ISSUE_INDEX_VERSION}; do not edit by hand. Regenerate: node tools/issue-index.mjs -->`,
    '',
    '# Open ticket index',
    '',
    `Generated from \`Issue-tracker/open/*.md\` — ${n} open ticket${n === 1 ? '' : 's'}. The row set is owned by the folder, so a ticket that moves cannot leave a stale row behind (ticket 96). Titles and labels mirror each ticket's own lines.`,
    '',
    '| # | Ticket | Title | Status | Labels |',
    '|---|---|---|---|---|',
  ];
  for (const t of tickets) {
    const link = t.file.slice('Issue-tracker/'.length); // index sits inside Issue-tracker/
    lines.push(
      `| ${t.num} | [${t.num}-${t.slug}](${link}) | ${escapeCell(t.title)} | ${t.status} | ${escapeCell(t.labels)} |`
    );
  }
  return lines.join(eol) + eol;
}

export function generateIssueIndex(rootDir) {
  const tickets = listOpenTickets(rootDir);
  // Match an existing file's dominant line ending (mirrors adr-index.mjs): a git
  // autocrlf checkout stores LF in the blob but puts CRLF on disk, and that checkout
  // artifact must never read as index staleness — only content drift is staleness.
  const existing = readTextIfExists(path.join(rootDir, OPEN_INDEX_REL));
  const eol = existing === null ? '\n' : detectEol(existing);
  return { relPath: OPEN_INDEX_REL, content: renderIssueIndex(tickets, eol), tickets };
}

export function checkIssueIndex(rootDir) {
  const { relPath, content, tickets } = generateIssueIndex(rootDir);
  const actual = readTextIfExists(path.join(rootDir, relPath));
  if (actual === null) {
    return {
      ok: false,
      relPath,
      rows: tickets.length,
      reason: 'missing — run: node tools/issue-index.mjs',
      expected: content,
      actual: null,
    };
  }
  if (actual !== content) {
    return {
      ok: false,
      relPath,
      rows: tickets.length,
      reason: 'stale — differs from regeneration; run: node tools/issue-index.mjs',
      expected: content,
      actual,
    };
  }
  return { ok: true, relPath, rows: tickets.length, reason: 'fresh', expected: content, actual };
}

export function writeIssueIndex(rootDir) {
  const { relPath, content, tickets } = generateIssueIndex(rootDir);
  fs.writeFileSync(path.join(rootDir, relPath), content, 'utf8');
  return { relPath, rows: tickets.length };
}

function usage() {
  return [
    'usage: node tools/issue-index.mjs [--check] [--json] [--help]',
    '',
    '  (default)   write Issue-tracker/open-issue-index.md from Issue-tracker/open/*.md',
    '  --check     verify the on-disk index is fresh (exit 1 when missing or stale)',
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
    console.error(`issue-index: unknown argument(s): ${unknown.join(' ')}\n${usage()}`);
    return 2;
  }
  const json = args.includes('--json');
  if (args.includes('--check')) {
    const r = checkIssueIndex(rootDir);
    if (json) {
      console.log(
        JSON.stringify(
          { tool: 'issue-index', version: ISSUE_INDEX_VERSION, ok: r.ok, relPath: r.relPath, rows: r.rows, reason: r.reason },
          null,
          2
        )
      );
    } else {
      console.log(`issue-index: ${r.relPath} — ${r.ok ? 'fresh' : r.reason} (${r.rows} rows)`);
    }
    return r.ok ? 0 : 1;
  }
  const w = writeIssueIndex(rootDir);
  if (json) {
    console.log(JSON.stringify({ tool: 'issue-index', version: ISSUE_INDEX_VERSION, ok: true, ...w }, null, 2));
  } else {
    console.log(`issue-index: wrote ${w.relPath} (${w.rows} rows)`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
