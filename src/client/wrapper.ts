/**
 * Module-loader shell for the built client bundle (ticket 20, Finding 4).
 *
 * dsh's client module system executes a plugin bundle only to REGISTER its
 * factory: `window.__ModuleLoader__.load({id, factory})`. The factory is
 * CJS-shaped — `(require) => { var module = {exports:{}}; ...; return
 * module.exports; }` — and the synchronous `require` it receives resolves
 * platform seed words (react, react/jsx-runtime, react-dom, ...), memoized
 * modules, and other registered package factories. This mirrors the wrapper
 * every shipped `dsh-client-ui-*` bundle uses.
 *
 * `external` names in `dsh.client` (package.json) mark the bare specifiers
 * our bundle requires but does not inline; static-table names (react) add no
 * boot-graph edge (dsh-client-modules `orderByModuleGraph`).
 */

/** Loader registration id: the package name the host scanned. */
export const CLIENT_MODULE_ID = "dsh-multitask-dispatcher";

/**
 * Wrap compiled CJS module body in the module-loader registration shell.
 * Pure string shaping so tests can assert the emitted contract offline.
 */
export function wrapClientBundle(moduleId: string, body: string): string {
  const indented = body
    .trimEnd()
    .split("\n")
    .map((line) => (line.length > 0 ? `\t\t${line}` : line))
    .join("\n");
  return [
    "window.__ModuleLoader__.load({",
    `\tid: ${JSON.stringify(moduleId)},`,
    "\tfactory: (require) => {",
    "\t\tvar module = { exports: {} };",
    "\t\tvar exports = module.exports;",
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    indented,
    "\t\treturn module.exports;",
    "\t}",
    "});",
    "",
  ].join("\n");
}
