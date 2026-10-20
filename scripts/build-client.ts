/**
 * Client bundle build path (ticket 20).
 *
 * Deliberately decoupled from the host `tsc` build (`npm run build`): dsh
 * loads browser code from a single self-contained script that registers via
 * `window.__ModuleLoader__.load({id, factory})` (Finding 4), so this script
 * compiles `src/client/index.ts` with esbuild (CJS, react kept external — it
 * is a platform seed word on the dsh web side) and wraps the output in the
 * loader shell from `src/client/wrapper.ts`.
 *
 * Run: `npm run build:client` → writes `client/index.js` (the
 * `exports["./client"]` target). Also importable: `buildClient()` returns the
 * bundle text for offline contract tests.
 *
 * Run directly as main: writes the bundle to disk.
 *
 * Freshness check (ticket 114): `node --import tsx scripts/build-client.ts
 * --check` rebuilds in memory (esbuild `write: false`, so `client/index.js`
 * is never touched) and compares the bytes with the served file:
 *   0 = fresh, 1 = stale or missing, 2 = the check could not run (build or
 *   read failure).
 *
 * The comparison is a pure function (`compareBundles`) so offline tests can
 * exercise it without depending on the real `client/index.js` state.
 */
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_MODULE_ID, wrapClientBundle } from "../src/client/wrapper.js";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");
const bundlePath = path.join(repoRoot, "client", "index.js");

/** The served bundle matches a fresh build byte-for-byte. */
export interface BundleFresh {
  status: "fresh";
  bytes: number;
  sha256: string;
}

/** The served bundle exists but differs from a fresh build. */
export interface BundleStale {
  status: "stale";
  expectedBytes: number;
  actualBytes: number;
  expectedSha256: string;
  actualSha256: string;
  /**
   * Byte offset of the first difference. When one input is a prefix of the
   * other, this is the shorter length (the first byte one input lacks).
   */
  firstDifferenceOffset: number;
}

/** The served bundle is absent. */
export interface BundleMissing {
  status: "missing";
  expectedBytes: number;
  expectedSha256: string;
}

export type BundleComparison = BundleFresh | BundleStale | BundleMissing;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function firstDifference(a: Uint8Array, b: Uint8Array): number | null {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? null : shared;
}

/**
 * Compare a fresh build (`expected`) against the served bundle (`actual`).
 * `actual === null` means the served file is missing.
 *
 * Everything is byte-oriented on purpose: `client/index.js` contains
 * multi-byte UTF-8 copy, so string length (UTF-16 code units) is not the
 * same as the on-disk size.
 */
export function compareBundles(
  expected: Uint8Array,
  actual: Uint8Array | null,
): BundleComparison {
  const expectedSha256 = sha256Hex(expected);
  if (actual === null) {
    return {
      status: "missing",
      expectedBytes: expected.length,
      expectedSha256,
    };
  }
  const offset = firstDifference(expected, actual);
  if (offset === null) {
    return { status: "fresh", bytes: expected.length, sha256: expectedSha256 };
  }
  return {
    status: "stale",
    expectedBytes: expected.length,
    actualBytes: actual.length,
    expectedSha256,
    actualSha256: sha256Hex(actual),
    firstDifferenceOffset: offset,
  };
}

/**
 * Build the browser bundle in memory and return the loader-shell text.
 * Throws when esbuild reports errors (build failure is loud, per Finding 4:
 * a missing/broken built bundle fails plugin activation).
 */
export async function buildClient(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(repoRoot, "src", "client", "index.ts")],
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom"],
    sourcemap: false,
    minify: false,
    write: false,
    logLevel: "warning",
  });
  const body = result.outputFiles[0]?.text;
  if (body === undefined) {
    throw new Error("client build produced no output");
  }
  return wrapClientBundle(CLIENT_MODULE_ID, body);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function checkMessage(comparison: BundleComparison): string {
  switch (comparison.status) {
    case "fresh":
      return `client bundle fresh: client/index.js matches a fresh build (${comparison.bytes} bytes, sha256 ${comparison.sha256})\n`;
    case "stale":
      return [
        "client bundle STALE: client/index.js does not match the client source",
        `  fresh build: ${comparison.expectedBytes} bytes, sha256 ${comparison.expectedSha256}`,
        `  on disk:     ${comparison.actualBytes} bytes, sha256 ${comparison.actualSha256}`,
        `  first differing byte: ${comparison.firstDifferenceOffset}`,
        "Run npm run build:client to refresh the served bundle.",
        "",
      ].join("\n");
    case "missing":
      return "client bundle missing; run npm run build:client\n";
  }
}

/** Run `--check`; returns the process exit code. */
async function runCheck(): Promise<number> {
  let expected: Buffer;
  try {
    expected = Buffer.from(await buildClient(), "utf8");
  } catch (error) {
    process.stderr.write(
      `client bundle check failed: build error: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  let actual: Buffer | null;
  try {
    actual = await readFile(bundlePath);
  } catch (error) {
    if (!isNotFound(error)) {
      process.stderr.write(
        `client bundle check failed: cannot read client/index.js: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 2;
    }
    actual = null;
  }

  const comparison = compareBundles(expected, actual);
  const message = checkMessage(comparison);
  if (comparison.status === "fresh") {
    process.stdout.write(message);
    return 0;
  }
  process.stderr.write(message);
  return 1;
}

const invoked = process.argv[1];
const isMain =
  invoked !== undefined &&
  path.resolve(invoked).toLowerCase() === thisFile.toLowerCase();

if (isMain) {
  if (process.argv.length <= 2) {
    const bundle = await buildClient();
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, bundle, "utf8");
    process.stdout.write(
      `client bundle written: ${path.relative(repoRoot, bundlePath)} (${bundle.length} bytes)\n`,
    );
  } else if (process.argv.slice(2).join(" ") === "--check") {
    process.exitCode = await runCheck();
  } else {
    process.stderr.write(
      `usage: node --import tsx scripts/build-client.ts [--check]\n`,
    );
    process.exitCode = 2;
  }
}
