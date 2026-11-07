// dev/build-freshness.mjs — fail-closed staleness gate for the built plugin.
//
// dev/browser-serve.mjs and dev/e2e-mock.mjs both boot the built plugin from
// lib/ (and the web overlay serves client/). Neither may build automatically,
// so both refuse to start on a missing or stale build and say which command to
// run. `node dev/build-freshness.mjs` is the CLI form; the harnesses import
// `assertBuildFresh` directly.
//
// Exit 1 = stale, missing, or the probe itself could not run. There is no
// "repair" path: a stale build is always a human/build-script decision.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function display(root, file) {
  return relative(root, file).split(sep).join('/');
}

/**
 * Newest `.ts` / `.tsx` source under `roots`, ignoring declaration files and
 * dependency trees. Returns `{ path, mtimeMs }` or null when nothing matched.
 */
function newestSource(root, roots, extensions, skipDir) {
  let newest = null;
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || skipDir?.(full)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.tsx')) continue;
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const mtimeMs = statSync(full).mtimeMs;
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
    }
  }
  return newest;
}

function checkOutput(root, problems, { output, source, buildCommand, sourceLabel }) {
  if (!existsSync(output)) {
    problems.push(`missing ${display(root, output)} — run "${buildCommand}"`);
    return;
  }
  if (source === undefined || source === null) return; // the scan failure is already reported
  const outputMtimeMs = statSync(output).mtimeMs;
  if (outputMtimeMs < source.mtimeMs) {
    problems.push(
      `stale ${display(root, output)}: older than ${display(root, source.path)} (${sourceLabel}) — run "${buildCommand}"`,
    );
  }
}

/**
 * Compare every build output with its own newest relevant source.
 * `lib/index.js` is emitted by `npm run build` over src/ minus src/client plus
 * vendor/racoons. `client/index.js` is emitted by `npm run build:client`; its
 * bundle imports modules outside src/client (core types, policy prompts, the
 * roster channel) and its external list comes from package.json, so the whole
 * source tree, the builder, and the manifest are relevant to it. The client
 * set is deliberately conservative: a false "stale" costs one cheap rebuild,
 * while a false "fresh" serves wrong bytes.
 */
export function checkBuildFreshness(root = REPO_ROOT) {
  const srcRoot = join(root, 'src');
  const clientSrc = join(srcRoot, 'client');
  const vendorRoot = join(root, 'vendor', 'racoons');
  const scriptsRoot = join(root, 'scripts');
  const manifestPath = join(root, 'package.json');
  const problems = [];

  let libSource;
  try {
    libSource = newestSource(root, [srcRoot, vendorRoot], ['.ts'], (full) => full === clientSrc);
    // A null scan means the source roots produced nothing. The PowerShell twin
    // throws on that; returning null here would make every output look fresh,
    // so it is a problem, not a pass. (The scan throwing is reported below.)
    if (libSource === null) {
      problems.push('no lib sources found under src/ and vendor/racoons — cannot verify lib/index.js freshness');
    }
  } catch (error) {
    problems.push(`could not scan lib sources under src/ and vendor/racoons: ${error.message}`);
  }

  let clientSource;
  try {
    clientSource = newestSource(root, [srcRoot, vendorRoot, scriptsRoot], ['.ts', '.tsx']);
    if (clientSource === null) {
      problems.push('no client sources found under src/, vendor/racoons, and scripts/ — cannot verify client/index.js freshness');
    }
    // Only fold in the manifest when a source scan found something: otherwise
    // the manifest would mask the empty scan and read as fresh.
    if (clientSource !== null && existsSync(manifestPath)) {
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;
      if (manifestMtimeMs > clientSource.mtimeMs) {
        clientSource = { path: manifestPath, mtimeMs: manifestMtimeMs };
      }
    }
  } catch (error) {
    problems.push(`could not scan client sources under src/, vendor/racoons, and scripts/: ${error.message}`);
  }

  checkOutput(root, problems, {
    output: join(root, 'lib', 'index.js'),
    source: libSource,
    sourceLabel: 'newest lib source',
    buildCommand: 'npm run build',
  });
  checkOutput(root, problems, {
    output: join(root, 'client', 'index.js'),
    source: clientSource,
    sourceLabel: 'newest client source',
    buildCommand: 'npm run build:client',
  });

  return { ok: problems.length === 0, problems, libSource, clientSource };
}

/** Throw a loud, actionable error when the build is stale. Never builds. */
export function assertBuildFresh(label = 'boot') {
  const result = checkBuildFreshness();
  if (!result.ok) {
    throw new Error(
      `${label}: refusing to boot a stale build. ${result.problems.join('; ')}. Do not run the harness against lib/ until the build is refreshed.`,
    );
  }
  return result;
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  resolve(invoked).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
) {
  const result = checkBuildFreshness();
  if (result.ok) {
    console.log('build fresh: lib/index.js and client/index.js are newer than their sources');
  } else {
    for (const problem of result.problems) console.error(`build: ${problem}`);
    process.exitCode = 1;
  }
}
