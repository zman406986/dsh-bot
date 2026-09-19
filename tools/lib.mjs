// tools/lib.mjs — shared zero-dependency helpers for the doc tooling (ticket 96).
// Node stdlib only (node:fs / node:path / node:url) — no npm dependencies, ever.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root inferred from a tool's import.meta.url (tools/ sits directly under the root). */
export function repoRootOf(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
}

/**
 * File text or null when absent/unreadable (missing files are findings, not crashes).
 * A leading UTF-8 BOM is stripped so `^#`-style line parses (H1, Status, Labels) work on
 * BOM-prefixed files; generator comparisons are BOM-normalized on both sides accordingly.
 */
export function readTextIfExists(absPath) {
  try {
    const text = fs.readFileSync(absPath, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** Does the path exist on disk (file or directory)? */
export function fsEntryExists(absPath) {
  try {
    return fs.existsSync(absPath);
  } catch {
    return false;
  }
}

/** Split text into lines, tolerant of CRLF. */
export function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Detect the dominant line ending of a text so rewrites never churn every line. */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Remove fenced ``` code blocks — their contents are illustrations
 * (layout sketches, shell recipes, example trees), not live path citations.
 * Kept lines are blanked so line numbers stay stable.
 */
export function stripFencedBlocks(text) {
  const out = [];
  let insideFence = false;
  for (const line of splitLines(text)) {
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence;
      out.push('');
      continue;
    }
    out.push(insideFence ? '' : line);
  }
  return out.join('\n');
}

/** All `...` spans with 1-based line numbers. Strip fenced blocks first. */
export function extractBacktickedTokens(text) {
  const tokens = [];
  splitLines(text).forEach((line, i) => {
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      tokens.push({ token: m[1], line: i + 1 });
    }
  });
  return tokens;
}

const PATH_TOKEN_DISQUALIFIERS = [
  { re: /\s/, why: 'whitespace (command or prose, not a path)' },
  { re: /:/, why: 'colon (scheme, drive letter, or label, not a repo path)' },
  { re: /[<>*?"“”'|[\]]/, why: 'placeholder, glob, or bracket character' },
  { re: /^[~$#/]/, why: 'home / variable / absolute / anchor reference' },
];

/**
 * Does a backticked token look like a repo-relative path we should verify?
 * Conservative on purpose: only tokens with a `/` or a file extension qualify —
 * bare code words (`insert`, `DshHost`, `main`) are never treated as paths.
 */
export function looksLikeRepoPath(token) {
  if (PATH_TOKEN_DISQUALIFIERS.some(({ re }) => re.test(token))) return false;
  if (token.endsWith('.')) return false;
  if (token.includes('/')) return true;
  return /\.[A-Za-z0-9]+$/.test(token);
}

/**
 * Resolve a repo-relative token: against the repo root first, then against the
 * citing document's own directory (the tracker guide cites `open/`, meaning
 * `Issue-tracker/open/`). Trailing slashes mean directories and are fine.
 */
export function pathResolves(rootDir, docDir, token) {
  const rel = token.replace(/\/+$/, '');
  if (rel === '') return true;
  if (fsEntryExists(path.join(rootDir, rel))) return true;
  if (fsEntryExists(path.join(docDir, rel))) return true;
  return false;
}

/** First 1-based line index whose text matches `pattern`, or null. */
export function firstMatchingLine(text, pattern) {
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}
