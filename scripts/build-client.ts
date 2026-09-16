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
 */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_MODULE_ID, wrapClientBundle } from "../src/client/wrapper.js";

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");

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

const invoked = process.argv[1];
const isMain =
  invoked !== undefined &&
  path.resolve(invoked).toLowerCase() === thisFile.toLowerCase();

if (isMain) {
  const bundle = await buildClient();
  const outFile = path.join(repoRoot, "client", "index.js");
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, bundle, "utf8");
  process.stdout.write(
    `client bundle written: ${path.relative(repoRoot, outFile)} (${bundle.length} bytes)\n`,
  );
}
