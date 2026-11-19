/** Test-only resolver for the declared public host peer; no stock behavior changes. */
import { registerHooks, createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const hostRequire = createRequire(resolve(process.env.APPDATA, "npm/node_modules/@deepseek-ai/dsh/package.json"));
const scopeUrl = pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-scope")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@deepseek-ai/dsh-scope") return nextResolve(specifier, context);
    return { url: scopeUrl, shortCircuit: true };
  },
});
