#!/usr/bin/env node
// tools/doc-lint.mjs — lint the orientation docs for rot (ticket 96: "make the orientation
// docs provably honest"). Zero dependencies (node:fs / node:path / node:url); runs from any cwd.
//
// The checks are DATA-DRIVEN so the known-catches list can be extended without touching the
// engine:
//   CONFIG           — which docs/folders are linted (orientation docs, tracker, ADR index)
//   PATH_ALLOWLIST   — backticked tokens exempt from path resolution, each with a written reason
//   DOC_EXPECTATIONS — per-doc mustCite / forbid entries (ticket 96's first catches live here)
//   RULES            — the rule registry; every rule id must have fixture coverage in
//                      tools/fixtures/doc-lint/repo, enforced by --self-test. To add a rule:
//                      write the check, register it here, add a fixture that fires it.
//
// CLI:
//   node tools/doc-lint.mjs             lint the real repo (human-readable), exit 1 on findings
//   node tools/doc-lint.mjs --json      machine-readable output
//   node tools/doc-lint.mjs --self-test run the fixture self-test (no real docs touched)
//   node tools/doc-lint.mjs --help
// Exit codes: 0 clean / self-test passes · 1 findings / self-test fails · 2 usage error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  repoRootOf,
  readTextIfExists,
  splitLines,
  stripFencedBlocks,
  extractBacktickedTokens,
  looksLikeRepoPath,
  pathResolves,
  firstMatchingLine,
} from './lib.mjs';
import { checkIssueIndex, writeIssueIndex, OPEN_INDEX_REL } from './issue-index.mjs';
import { listAdrFiles, parseAdrTable, writeAdrIndex, checkAdrIndex, ADR_INDEX_REL } from './adr-index.mjs';

export const DOC_LINT_VERSION = '1.0.0';

/** What gets linted, in one place. */
export const CONFIG = {
  // Ticket 96 check 1 names these orientation docs. Missing docs are skipped silently
  // (agent.md: context docs are created lazily — their absence is not rot).
  // AGENTS.md is deliberately NOT here: it is gitignored/local-only, so requiring it
  // made lint:docs permanently red on a developer machine and blind on a fresh clone.
  // The tracked docs/agents-rulebook.md below is the durable home of those rules.
  orientationDocs: [
    'README.md',
    'CONTEXT.md',
    'agent.md',
    'Issue-tracker/issue-tracker.md',
    'research/research.md',
    'docs/adr/README.md',
    // Ticket 97: the tracked rulebook + read-before guides are orientation docs too.
    'docs/agents-rulebook.md',
    'read-before-running-live-and-browser-tests.md',
    'read-before-reference-tree-work.md',
  ],
  trackerDir: 'Issue-tracker',
  trackerStatuses: ['open', 'deferred', 'resolved', 'cancelled'],
  // A wayfinder child ticket legitimately sits in open/ with `Status: claimed` (tracker guide).
  statusSynonyms: { open: ['claimed'] },
  openIndexRel: OPEN_INDEX_REL,
  adrDir: 'docs/adr',
  adrIndexRel: ADR_INDEX_REL,
};

/**
 * Backticked tokens exempt from path resolution. Every entry carries a written reason;
 --self-test asserts allowlisted paths never produce findings.
 */
export const PATH_ALLOWLIST = [
  { path: 'cordis.patch.yml', because: 'dsh profile patch-layer filename; lives under ~/.dsh/profiles/<profile>/, not in the repo' },
  { path: 'cordis.yml', because: 'dsh profile base-config filename; lives under ~/.dsh/profiles/<profile>/, not in the repo' },
  { path: 'CONTEXT-MAP.md', because: 'conditional convention name (agent.md: "if it exists"); created lazily, absence is not rot' },
  { path: 'map.md', because: 'wayfinder shorthand for .scratch/<effort>/map.md (Issue-tracker/issue-tracker.md)' },
  { path: 'dsh-interrupt-continue.md', because: 'naming example in research/research.md §Naming, not a citation' },
  { path: 'dsh-todo-store.md', because: 'naming example in research/research.md §Naming, not a citation' },
  { path: 'sidecar-vs-embed.md', because: 'naming example in research/research.md §Naming, not a citation' },
  { path: 'open/', because: 'tracker status-folder shorthand for Issue-tracker/open/ (agent.md §Domain docs layout list)' },
  { path: 'deferred/', because: 'tracker status-folder shorthand for Issue-tracker/deferred/ (agent.md §Domain docs layout list)' },
  { path: 'resolved/', because: 'tracker status-folder shorthand for Issue-tracker/resolved/ (agent.md §Domain docs layout list)' },
  { path: 'cancelled/', because: 'tracker status-folder shorthand for Issue-tracker/cancelled/ (agent.md §Domain docs layout list)' },
  { path: '.out-of-scope/', because: 'convention name from the research-notes skills convention (research/research.md §Naming), not a repo path' },
  { path: 'conversation.session.header.actions', because: 'dsh client UI slot name (the seat ADR-0024’s rider licenses and ADR-0031 extends; cited in docs/adr/README.md), not a repo path — ticket 156' },
  { path: 'dsh-bot-RACOONS.bat', because: 'retired Desktop launcher, recorded by name in issue-tracker history only; the RACOONS route now lives in the single tracked dsh-bot.bat' },
];

const ALLOWLISTED = new Set(PATH_ALLOWLIST.map((a) => a.path));

/**
 * Per-doc expectations. Ticket 96's first catches are encoded here; W2 fixes the docs and the
 * entries become standing guardrails. Extend data-driven: add an entry + a fixture that fires it.
 */
export const DOC_EXPECTATIONS = [
  {
    doc: 'docs/agents-rulebook.md',
    mustCite: [
      { path: 'PRD-dsh-multitask-dispatcher.md', because: 'the PRD is stack level 3 and the reading order routes to it (ticket 97)' },
      { path: 'docs/adr/README.md', because: 'the ADR index is how the stack levels 1–2 are reached (ticket 97)' },
      { path: 'CONTEXT.md', because: 'the glossary is stack level 5 (ticket 97)' },
      { path: 'read-before-running-live-and-browser-tests.md', because: 'the live/browser-test guide is a level-6 home the register points at (ticket 97)' },
      { path: 'read-before-reference-tree-work.md', because: 'the reference-tree guide is a level-6 home the register points at (ticket 97)' },
      { path: 'Issue-tracker/issue-tracker.md', because: 'the tracker guide holds the log-before-implementing rule (ticket 97)' },
    ],
    forbid: [],
  },
  {
    doc: 'README.md',
    mustCite: [],
    forbid: [
      {
        pattern: /Ticket 01 scaffold|Host adapter and tools land in later tickets/i,
        because: 'the Status section still describes ticket 01; it must describe the current state (always-on dispatcher plugin, wrapper shell) — ticket 96',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rule checks. Each returns findings: { rule, file, line?, message, because? }.
// ---------------------------------------------------------------------------

function findOrientationPathFindings(rootDir) {
  const findings = [];
  const seen = new Set();
  for (const docRel of CONFIG.orientationDocs) {
    const abs = path.join(rootDir, docRel);
    const text = readTextIfExists(abs);
    if (text === null) continue; // optional doc — absence is not rot
    const docDir = path.dirname(abs);
    for (const { token, line } of extractBacktickedTokens(stripFencedBlocks(text))) {
      if (!looksLikeRepoPath(token)) continue;
      if (ALLOWLISTED.has(token)) continue;
      const key = `${docRel}:${line}:${token}`;
      if (seen.has(key)) continue;
      if (!pathResolves(rootDir, docDir, token)) {
        seen.add(key);
        findings.push({
          rule: 'orientation-path-resolution',
          file: docRel,
          line,
          message: `backticked path \`${token}\` does not resolve (repo root or the doc's own directory)`,
        });
      }
    }
  }
  return findings;
}

function findRequiredCitationFindings(rootDir) {
  const findings = [];
  for (const expectation of DOC_EXPECTATIONS) {
    const text = readTextIfExists(path.join(rootDir, expectation.doc));
    if (text === null) continue;
    for (const cite of expectation.mustCite) {
      if (!text.includes(cite.path)) {
        findings.push({
          rule: 'orientation-required-citation',
          file: expectation.doc,
          message: `missing required citation of \`${cite.path}\``,
          because: cite.because,
        });
      }
    }
  }
  return findings;
}

function findForbiddenClaimFindings(rootDir) {
  const findings = [];
  for (const expectation of DOC_EXPECTATIONS) {
    const text = readTextIfExists(path.join(rootDir, expectation.doc));
    if (text === null) continue;
    for (const forbid of expectation.forbid) {
      const line = firstMatchingLine(text, forbid.pattern);
      if (line !== null) {
        findings.push({
          rule: 'orientation-forbidden-claim',
          file: expectation.doc,
          line,
          message: `known-stale claim present (matches ${String(forbid.pattern)})`,
          because: forbid.because,
        });
      }
    }
  }
  return findings;
}

/** The ticket's **Status:** value must carry the folder's status (trailing prose allowed). */
function statusValueCarries(value, status) {
  const v = value.trim().toLowerCase();
  if (v === status) return true;
  if (!v.startsWith(status)) return false;
  const rest = v.slice(status.length);
  return /^[\s(—–:;,.\-]/.test(rest);
}

function findStatusAgreementFindings(rootDir) {
  const findings = [];
  for (const status of CONFIG.trackerStatuses) {
    const dir = path.join(rootDir, CONFIG.trackerDir, status);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // folder not present in this tree
    }
    const allowed = [status, ...(CONFIG.statusSynonyms[status] ?? [])];
    for (const name of names.filter((n) => n.toLowerCase().endsWith('.md')).sort()) {
      const rel = `${CONFIG.trackerDir}/${status}/${name}`;
      const text = readTextIfExists(path.join(dir, name));
      if (text === null) continue;
      const m = text.match(/^\*\*Status:\*\*[ \t]*(.*)$/m);
      if (!m) {
        findings.push({
          rule: 'tracker-status-agreement',
          file: rel,
          message: 'no **Status:** line found (the tracker guide requires one near the top)',
        });
        continue;
      }
      if (!allowed.some((s) => statusValueCarries(m[1], s))) {
        findings.push({
          rule: 'tracker-status-agreement',
          file: rel,
          line: firstMatchingLine(text, /^\*\*Status:\*\*/m) ?? undefined,
          message: `**Status:** line says "${m[1].trim()}" but the file sits in ${CONFIG.trackerDir}/${status}/`,
          because: 'tracker guide: status is which folder the file is in; keep the line in sync',
        });
      }
    }
  }
  return findings;
}

function findOpenIndexFindings(rootDir) {
  const r = checkIssueIndex(rootDir);
  if (r.ok) return [];
  return [
    {
      rule: 'open-index-freshness',
      file: CONFIG.openIndexRel,
      message: r.reason,
      because: 'the open-queue index is generated from Issue-tracker/open/*.md (ticket 96)',
    },
  ];
}

function findAdrRowFindings(rootDir) {
  const findings = [];
  const files = listAdrFiles(rootDir);
  const text = readTextIfExists(path.join(rootDir, CONFIG.adrIndexRel));
  if (text === null) {
    findings.push({
      rule: 'adr-index-row-freshness',
      file: CONFIG.adrIndexRel,
      message: `ADR index file missing — run: node tools/adr-index.mjs`,
    });
    return findings;
  }
  const table = parseAdrTable(text);
  for (const f of files) {
    if (!table.rows.has(f.num)) {
      findings.push({
        rule: 'adr-index-row-freshness',
        file: CONFIG.adrIndexRel,
        message: `ADR file ${f.file} has no row in ${CONFIG.adrIndexRel} (run: node tools/adr-index.mjs)`,
      });
    }
  }
  for (const [num] of table.rows) {
    if (!files.some((f) => f.num === num)) {
      findings.push({
        rule: 'adr-index-row-freshness',
        file: CONFIG.adrIndexRel,
        message: `table row ${num} has no matching docs/adr/${num}-*.md file (row set is owned by the files)`,
      });
    }
  }
  // Status prose is hand-maintained by design (ticket 96): never checked here.
  return findings;
}

// ---------------------------------------------------------------------------
// Rule registry — data-driven, self-test enforces fixture coverage per rule.
// ---------------------------------------------------------------------------

export const RULES = [
  {
    id: 'orientation-path-resolution',
    description: 'Backticked repo paths in the orientation docs resolve on disk (root-relative, or relative to the citing doc; PATH_ALLOWLIST honored).',
    run: findOrientationPathFindings,
  },
  {
    id: 'orientation-required-citation',
    description: 'Each orientation doc cites the real home of what it describes (DOC_EXPECTATIONS.mustCite).',
    run: findRequiredCitationFindings,
  },
  {
    id: 'orientation-forbidden-claim',
    description: 'Known-stale claims are absent (DOC_EXPECTATIONS.forbid, each with a recorded reason).',
    run: findForbiddenClaimFindings,
  },
  {
    id: 'tracker-status-agreement',
    description: 'Every Issue-tracker ticket file has a **Status:** line that agrees with its folder (claimed allowed under open/).',
    run: findStatusAgreementFindings,
  },
  {
    id: 'open-index-freshness',
    description: 'Issue-tracker/open-issue-index.md exists and byte-equals regeneration from Issue-tracker/open/*.md.',
    run: findOpenIndexFindings,
  },
  {
    id: 'adr-index-row-freshness',
    description: 'docs/adr/README.md has exactly one row per docs/adr/NNNN-*.md file and no row without a file (row set only; status prose is hand-maintained and never checked).',
    run: findAdrRowFindings,
  },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Lint a tree (real repo or fixture). Deterministic ordering; ok === true iff no findings. */
export function lintRepo(rootDir) {
  const findings = [];
  for (const rule of RULES) {
    findings.push(...rule.run(rootDir));
  }
  findings.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      ((a.line ?? 0) - (b.line ?? 0)) ||
      a.message.localeCompare(b.message)
  );
  return { rootDir, rulesRun: RULES.length, findings, ok: findings.length === 0 };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printHuman(result) {
  console.log(`doc-lint v${DOC_LINT_VERSION} — repo root: ${result.rootDir}`);
  for (const rule of RULES) {
    const ruleFindings = result.findings.filter((f) => f.rule === rule.id);
    if (ruleFindings.length === 0) continue;
    console.log(`\nRULE ${rule.id} — ${ruleFindings.length} finding(s)`);
    for (const f of ruleFindings) {
      const where = f.file + (f.line != null ? `:${f.line}` : '');
      console.log(`  FAIL ${where} — ${f.message}`);
      if (f.because) console.log(`       because: ${f.because}`);
    }
  }
  const counts = {};
  for (const f of result.findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  if (result.ok) {
    console.log(`\ndoc-lint: 0 findings across ${result.rulesRun} rules — CLEAN`);
  } else {
    console.log(`\ndoc-lint: ${result.findings.length} finding(s) across ${result.rulesRun} rules — FAILED`);
    for (const [rule, n] of Object.entries(counts).sort()) console.log(`  ${rule}: ${n}`);
    console.log('Fix the flagged docs (this is expected rot on the pre-W2 tree — ticket 96), or run --json for machine-readable output.');
  }
}

function toJson(result) {
  const counts = {};
  for (const f of result.findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return {
    tool: 'doc-lint',
    version: DOC_LINT_VERSION,
    root: result.rootDir,
    ok: result.ok,
    rulesRun: result.rulesRun,
    counts,
    findings: result.findings,
  };
}

// ---------------------------------------------------------------------------
// Self-test: the tool's own test, run against tools/fixtures/doc-lint/repo only.
// Asserts (a) every rule fires on a fixture built to rot in exactly its class,
// (b) allowlisted paths never fire, (c) both generators are deterministic and
// idempotent and their --check flips stale→fresh, (d) ADR regeneration preserves prose.
// ---------------------------------------------------------------------------

const FIXTURE_REL = path.join('tools', 'fixtures', 'doc-lint', 'repo');

function selfTest(fixtureRoot) {
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass, detail });

  check('fixture repo exists', fs.existsSync(path.join(fixtureRoot, 'README.md')), fixtureRoot);

  const result = lintRepo(fixtureRoot);
  check('fixture lint produced findings', result.findings.length > 0, `${result.findings.length} findings`);

  for (const rule of RULES) {
    const fired = result.findings.filter((f) => f.rule === rule.id);
    check(`rule fires on fixture: ${rule.id}`, fired.length > 0, `${fired.length} finding(s)`);
  }

  const pathResolutionFindings = result.findings.filter((f) => f.rule === 'orientation-path-resolution');
  for (const allowed of PATH_ALLOWLIST) {
    const leaked = pathResolutionFindings.filter((f) => (f.message ?? '').includes(`\`${allowed.path}\``));
    check(`allowlist honored: ${allowed.path}`, leaked.length === 0, leaked.map((f) => f.message).join(' | '));
  }

  const cleanAgent = result.findings.filter((f) => f.file === 'agent.md');
  check('clean fixture doc produces no findings (agent.md)', cleanAgent.length === 0, cleanAgent.map((f) => f.message).join(' | '));

  const staleOpen = result.findings.filter((f) => f.rule === 'open-index-freshness' && /stale/.test(f.message));
  check('stale open-index detected as stale (not missing)', staleOpen.length === 1, staleOpen.map((f) => f.message).join(' | '));

  const moved = result.findings.filter(
    (f) => f.rule === 'tracker-status-agreement' && (f.file ?? '').endsWith('resolved/02-beta-ticket.md')
  );
  check('status/folder mismatch caught (resolved/02-beta-ticket.md)', moved.length === 1);

  const missingLine = result.findings.filter(
    (f) => f.rule === 'tracker-status-agreement' && (f.file ?? '').endsWith('open/03-gamma-ticket.md')
  );
  check('missing Status line caught (open/03-gamma-ticket.md)', missingLine.length === 1);

  const agrees = result.findings.filter(
    (f) => f.rule === 'tracker-status-agreement' && (f.file ?? '').endsWith('resolved/04-moved-ticket.md')
  );
  check('agreeing ticket not flagged (resolved/04-moved-ticket.md)', agrees.length === 0);

  // --- generator round-trips in a temp copy (fixtures and real repo stay untouched) ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-lint-selftest-'));
  try {
    fs.cpSync(fixtureRoot, tmp, { recursive: true });

    check('fixture open-index stale before write', checkIssueIndex(tmp).ok === false);
    writeIssueIndex(tmp);
    const afterWrite = checkIssueIndex(tmp);
    check('open-index fresh after write', afterWrite.ok === true, afterWrite.reason);
    const openIndexPath = path.join(tmp, CONFIG.openIndexRel);
    const first = fs.readFileSync(openIndexPath, 'utf8');
    writeIssueIndex(tmp);
    const second = fs.readFileSync(openIndexPath, 'utf8');
    check('open-index generation idempotent (byte-identical second run)', first === second);
    check('open-index excludes moved ticket 04', !first.includes('04-moved-ticket'));

    // autocrlf resilience: a git checkout that flips LF (blob) → CRLF (disk) is a
    // checkout artifact, not staleness — only content drift may flag. Normalize to LF
    // first so this is deterministic regardless of the checkout's own EOL style.
    const lfIndex = first.replace(/\r\n/g, '\n');
    const crlfIndex = lfIndex.replace(/\n/g, '\r\n');
    fs.writeFileSync(openIndexPath, crlfIndex, 'utf8');
    const crlfCheck = checkIssueIndex(tmp);
    check('open-index fresh under CRLF checkout (autocrlf artifact)', crlfCheck.ok === true, crlfCheck.reason);
    writeIssueIndex(tmp);
    check('open-index rewrite preserves CRLF style', fs.readFileSync(openIndexPath, 'utf8') === crlfIndex);
    fs.writeFileSync(openIndexPath, crlfIndex.replace('open ticket', 'OPEN TICKET'), 'utf8');
    check('CRLF index with drifted content still detected stale', checkIssueIndex(tmp).ok === false);

    check('fixture adr index stale before write (0002 row missing)', checkAdrIndex(tmp).ok === false);
    writeAdrIndex(tmp);
    const adrAfter = checkAdrIndex(tmp);
    check('adr index fresh after write', adrAfter.ok === true, adrAfter.reason);
    const adrPath = path.join(tmp, CONFIG.adrIndexRel);
    const adrFirst = fs.readFileSync(adrPath, 'utf8');
    writeAdrIndex(tmp);
    const adrSecond = fs.readFileSync(adrPath, 'utf8');
    check('adr generation idempotent (byte-identical second run)', adrFirst === adrSecond);
    check('adr regeneration preserves hand prose', adrFirst.includes('Human prose that must survive regeneration'));
    check('adr regeneration synthesizes row for new file 0002', /\| \[0002\]\(0002-second-decision\.md\) \| Second decision \| draft \(non-human-approved\) \|/.test(adrFirst));
    check('adr regeneration keeps existing row verbatim', adrFirst.includes('| [0001](0001-first-decision.md) | First decision | accepted |'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return checks;
}

function runSelfTest(rootDir) {
  const fixtureRoot = path.join(rootDir, FIXTURE_REL);
  console.log(`doc-lint v${DOC_LINT_VERSION} — self-test against ${fixtureRoot}`);
  const checks = selfTest(fixtureRoot);
  let failed = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`  PASS ${c.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  const passed = checks.length - failed;
  console.log(`\nself-test: ${passed}/${checks.length} checks passed${failed === 0 ? ' — OK' : ' — FAILED'}`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    'usage: node tools/doc-lint.mjs [--json] [--self-test] [--help]',
    '',
    '  (default)    lint the orientation docs of this repo; exit 1 on any finding',
    '  --json       machine-readable JSON output',
    '  --self-test  run the fixture self-test (tools/fixtures/doc-lint/repo); no real docs touched',
    '',
    'Exit codes: 0 clean/pass · 1 findings or self-test failure · 2 usage error.',
  ].join('\n');
}

export function main(argv, rootDir = repoRootOf(import.meta.url)) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const unknown = args.filter((a) => a !== '--json' && a !== '--self-test');
  if (unknown.length > 0) {
    console.error(`doc-lint: unknown argument(s): ${unknown.join(' ')}\n${usage()}`);
    return 2;
  }
  if (args.includes('--self-test')) {
    return runSelfTest(rootDir);
  }
  const result = lintRepo(rootDir);
  if (args.includes('--json')) {
    console.log(JSON.stringify(toJson(result), null, 2));
  } else {
    printHuman(result);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
