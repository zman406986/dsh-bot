/**
 * #299 creation-boundary regression. Offline: real product activation/summon,
 * registered stock tool, Runtime authority, manager setup and descriptor.
 * In-memory services stop after agents.create/setup; no inference can run.
 * Only the private manager export is exposed in memory; no stock logic changes.
 *
 * Portable host discovery: set DSH_HOST_DIR to the installed `@deepseek-ai/dsh`
 * package directory to override. Otherwise the host is found by module
 * resolution: repo-local first, then the global npm root (`npm root -g`).
 * No install layout is hardcoded. When no usable host is found, every test
 * skips with a reason and the process exits 0.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { registerStockWorkerModelDefaultBridge, type StockWorkerToolDefinition } from "../src/adapter/stock-worker-model-default.js";

const requireFromTest = createRequire(import.meta.url);

/** The installed `@deepseek-ai/dsh` package directory, or undefined. */
function findHostDir(): string | undefined {
  const override = process.env.DSH_HOST_DIR;
  if (override !== undefined && override !== "") {
    const dir = resolve(override);
    return existsSync(join(dir, "package.json")) ? dir : undefined;
  }
  try {
    return dirname(requireFromTest.resolve("@deepseek-ai/dsh/package.json"));
  } catch { /* not installed repo-locally; fall through to the global npm root */ }
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (globalRoot === "") return undefined;
    const requireFromGlobal = createRequire(join(globalRoot, "dsh-host-probe.js"));
    return dirname(requireFromGlobal.resolve("@deepseek-ai/dsh/package.json"));
  } catch { return undefined; }
}

const hostDir = findHostDir();
let skip: string | false = hostDir !== undefined ? false
  : process.env.DSH_HOST_DIR
    ? `DSH_HOST_DIR (${process.env.DSH_HOST_DIR}) does not point at an installed dsh host`
    : "no installed dsh host found (repo-local module resolution or global npm root); set DSH_HOST_DIR to the @deepseek-ai/dsh package directory";

let stock: any;
let stockTool: any;
let stockProvider: any;
let pluginApply: typeof import("../src/plugin.js").apply;
if (hostDir !== undefined) {
  try {
    const hostRequire = createRequire(join(hostDir, "package.json"));
    const scopeUrl = pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-scope")).href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== "@deepseek-ai/dsh-scope") return nextResolve(specifier, context);
        return { url: scopeUrl, shortCircuit: true };
      },
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!url.replaceAll("\\", "/").endsWith("/dsh-subagent/lib/index.js")) return result;
        const source = typeof result.source === "string"
          ? result.source : new TextDecoder().decode(result.source);
        return { ...result, source: source + "\nexport { SubagentManager as RegressionSubagentManager };\n" };
      },
    });
    const load = (name: string) => import(pathToFileURL(hostRequire.resolve(name)).href);
    stock = await load("@deepseek-ai/dsh-subagent");
    stockTool = await load("@deepseek-ai/dsh-tool-subagent");
    stockProvider = await load("@deepseek-ai/dsh-subagent-spawn-in-process");
    ({ apply: pluginApply } = await import("../src/plugin.js"));
  } catch (error) {
    skip = `dsh host at ${hostDir} is not usable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
const A = { provider: "deepseek-official", model: "deepseek-flash" };
const B = { provider: "qwen", model: "qwen4-max-preview" };
const STOP = new Error("STOP_AFTER_REAL_SETUP_AND_PRODUCT_ADOPTION");

async function fixture(options: { allowed?: readonly typeof A[] | null; unavailable?: boolean; modelSelection?: boolean } = {}) {
  const listeners = new Map<string, Function[]>();
  const agents = new Map<string, any>();
  const sessions = new Map<string, any>();
  const providers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tables = new Map<string, Map<string, any>>();
  const definitions = new Map<string, any>();
  const scopedDefinitions = new WeakMap<object, Map<string, any>>();
  const creates: any[] = [];
  const preflights: any[] = [];
  const disposers: Function[] = [];
  let streamCalls = 0;
  let activationCalls = 0;
  let deferredMark: { id: string; ready: Promise<unknown>; entered: () => void } | undefined;
  const off = () => {};
  const bus = {
    on(name: string, fn: Function) {
      const row = listeners.get(name) ?? [];
      row.push(fn); listeners.set(name, row);
      return () => listeners.set(name, row.filter(x => x !== fn));
    },
    fire(name: string, ...args: unknown[]) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    },
  };
  function toolSurface(owner?: object): any {
    const local = owner === undefined ? definitions : new Map<string, any>();
    if (owner !== undefined) scopedDefinitions.set(owner, local);
    return {
      register(def: any) {
        assert.ok(!local.has(def.name), "duplicate own-layer tool " + def.name);
        local.set(def.name, def); bus.fire("tools/change");
        return () => {
          if (local.get(def.name) === def) { local.delete(def.name); bus.fire("tools/change"); }
        };
      },
      get(name: string, scope?: object) {
        return (scope === undefined ? undefined : scopedDefinitions.get(scope)?.get(name)) ?? definitions.get(name);
      },
      executable(name: string, scope?: object) {
        return (scope === undefined ? undefined : scopedDefinitions.get(scope)?.get(name)) ?? definitions.get(name);
      },
      schemas(scope = owner) {
        const view = new Map(definitions);
        for (const [name, def] of scope === undefined ? [] : scopedDefinitions.get(scope) ?? []) view.set(name, def);
        return [...view.values()].map(x => ({ name: x.name, parameters: x.parameters }));
      },
      restrict: () => off,
    };
  }
  const llm = {
    listProviders: () => [{ id: A.provider }, { id: B.provider }],
    async listModels(provider: string) {
      return [A, B].filter(x => x.provider === provider).map(x => ({ id: x.model }));
    },
    async resolveCallConfig(config: any) {
      assert.ok([A, B].some(x => x.provider === config.provider && x.model === config.model));
      preflights.push({ ...config });
      if (options.unavailable) throw new Error("fixture selected route unavailable");
      return { ...config };
    },
    stream() { streamCalls++; throw new Error("inference is forbidden in this regression"); },
  };
  const directory = { ensure: async () => process.cwd(), set: async () => {} };
  const systemPrompt = {
    section: () => off, context: () => off,
    getSectionOrder: () => 0, getContextOrder: () => 0,
  };
  const storageDomain = {
    async open() {
      return {
        table(name: string) {
          let table = tables.get(name);
          if (table === undefined) { table = new Map(); tables.set(name, table); }
          return {
            get: (key: string) => {
              if (name === "dispatcher_sessions" && deferredMark?.id === key) {
                deferredMark.entered(); return deferredMark.ready;
              }
              return table!.get(key);
            }, entries: () => table!.entries(),
            put: async (key: string, value: unknown) => { table!.set(key, value); },
            delete: async (key: string) => table!.delete(key),
          };
        },
        async close() {},
      };
    },
  };
  const services: Record<string, any> = {
    llm, workingDirectory: directory,
    sessions: { get: (id: string) => sessions.get(id) }, sessionPersistence: {},
  };
  const ctx: any = {
    ...bus, get: (name: string) => services[name],
    logger: { warn: console.warn, info: () => {} },
    systemPrompt, tools: toolSurface(), workingDirectory: directory, storageDomain,
    commands: { register(def: any) { commands.set(def.name, def); return () => commands.delete(def.name); } },
    sessionProjections: {
      async register(def: any) {
        return { stateOf: () => def.key === "subagentModelSelectionPolicy"
          ? options.allowed === null ? undefined : options.allowed ?? [A, B] : undefined };
      },
      snapshot: () => ({ values: {} }),
    },
    effect(fn: any) {
      const result = fn();
      if (result && typeof result[Symbol.iterator] === "function") {
        for (const dispose of result) if (typeof dispose === "function") disposers.push(dispose);
      } else if (typeof result === "function") disposers.push(result);
      return typeof result === "function" ? result : off;
    },
    plugin() { return { ctx, dispose: async () => {} }; },
    jobs: { list: () => [] },
  };
  function makeSession(id: string, header: any, options: any) {
    const events: any[] = [];
    return {
      id, header: { id, ...header }, events,
      append(type: string, data: any) {
        const event = { type, data, seq: events.length }; events.push(event); return event;
      },
      requestHeader: () => ({ config: { ...options } }),
      get seq() { return events.length; },
    };
  }
  function makeAgent(session: any, options: any): any {
    const agent: any = { id: session.id, session, options: { ...options }, followup() {}, interrupt() {}, inject() {} };
    agent.ctx = { ...ctx, tools: toolSurface(agent) };
    agents.set(agent.id, agent); sessions.set(agent.id, session);
    return agent;
  }
  ctx.agents = {
    get: (id: string) => agents.get(id),
    async create(spec: any) {
      const session = makeSession(spec.sessionId, spec.meta, spec.agentOptions ?? {});
      const agent = makeAgent(session, spec.agentOptions);
      creates.push({ spec, session, agent });
      await spec.setup?.(agent.ctx, agent);
      bus.fire("agent/created", { agent, source: "startup" });
      if (spec.parentAgent !== undefined) throw STOP;
      return { agent, dispose: async () => {} };
    },
  };
  services.agents = ctx.agents;
  const manager = new stock.RegressionSubagentManager(ctx, {
    prepareContinuable: (name: string, request: any) => providers.get(name).prepareContinuable(request),
    observeActivation() { throw new Error("unreachable after creation sentinel"); },
  }, () => 8);
  const runtime = Object.create(stock.SubagentRuntime.prototype);
  runtime.ctx = ctx; runtime.manager = manager; runtime.providers = providers;
  runtime.config = { maxDepth: { get: () => 1 } };
  ctx.subagents = {
    registerProvider(provider: any) { providers.set(provider.name, provider); },
    getProvider: (name: string) => providers.get(name),
    resolveMaxDepth: (value: unknown) => runtime.resolveMaxDepth(value),
    startActivation: (spec: any) => { activationCalls++; return runtime.startActivation(spec); },
    interrupt() {}, async sendMessage() {},
  };
  services.subagents = ctx.subagents;
  stockProvider.apply(ctx, { providerName: "spawn" });
  await stockTool.apply(ctx, {
    provider: "spawn", toolName: "subagent", modelSelection: options.modelSelection ?? true,
    modelDiscovery: false, maxDepth: 1,
  });
  pluginApply(ctx, {
    enabled: { get: () => true },
    inboxEnabled: { get: () => false },
    microcompactEnabled: { get: () => false },
  } as never);
  const root = makeAgent(makeSession("default-route-root", { cwd: process.cwd() }, A), A);
  const activated = await commands.get("dsh-bot").handler({ agent: root, args: {} });
  assert.equal(activated.kind, "success", JSON.stringify(activated));
  return { root, creates, agents, tables, preflights, get streamCalls() { return streamCalls; },
    get activationCalls() { return activationCalls; },
    deferDefaultRead() {
      let release!: (mark: unknown) => void, entered!: () => void;
      const ready = new Promise<unknown>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      deferredMark = { id: root.id, ready, entered };
      return { started, release: () => { deferredMark = undefined; release({ sessionId: root.id, generation: 2, workerModel: B }); } };
    },
    disposeAgent() { agents.delete(root.id); bus.fire("agent/disposed", { agent: root }); },
    dispose() { for (const dispose of disposers.reverse()) dispose(); } };
}

async function summonLeader(rig: Awaited<ReturnType<typeof fixture>>) {
  const result = await rig.root.ctx.tools.get("spawn_dispatcher", rig.root).execute({
    title: "Offline permission leader", prompt: "Creation-boundary test only",
    worker_model: B.provider + "/" + B.model,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const leader = rig.agents.get(result.dispatcher_id);
  assert.ok(leader);
  assert.deepEqual(rig.tables.get("dispatcher_sessions")?.get(leader.id)?.workerModel, B);
  return leader;
}

function childBoundaryCounts(rig: Awaited<ReturnType<typeof fixture>>) {
  return {
    creates: rig.creates.length,
    descriptors: rig.creates.flatMap(row => row.session.events).filter(event => event.type === "subagent/descriptor").length,
    markers: rig.tables.get("worker_markers")?.size ?? 0,
    activations: rig.activationCalls,
    streams: rig.streamCalls,
  };
}

test("composed stock policy rejects unauthorized stored default before any child starts", { skip }, async () => {
  const rig = await fixture({ allowed: [A] });
  try {
    const leader = await summonLeader(rig);
    const before = childBoundaryCounts(rig);
    await assert.rejects(leader.ctx.tools.get("subagent", leader).execute({
      description: "Forbidden default", prompt: "must not create",
    }, { agent: leader, signal: new AbortController().signal }), /not allowed for this Session/);
    assert.deepEqual(childBoundaryCounts(rig), before,
      "denied default creates no activation, child, descriptor, product marker or stream");
    assert.equal(rig.preflights.length, 0, "allowlist rejects before adapter preflight");
  } finally { rig.dispose(); }
});

test("composed stock policy rejects explicit forbidden route before child creation", { skip }, async () => {
  const rig = await fixture({ allowed: [A] });
  try {
    const leader = await summonLeader(rig);
    const before = childBoundaryCounts(rig);
    await assert.rejects(leader.ctx.tools.get("subagent", leader).execute({
      description: "Forbidden explicit route", prompt: "must not create", ...B,
    }, { agent: leader, signal: new AbortController().signal }), /not allowed for this Session/);
    assert.deepEqual(childBoundaryCounts(rig), before);
    assert.equal(rig.preflights.length, 0);
  } finally { rig.dispose(); }
});

test("composed stock preflight rejects unavailable allowed default without a child", { skip }, async () => {
  const rig = await fixture({ unavailable: true });
  try {
    const leader = await summonLeader(rig);
    const before = childBoundaryCounts(rig);
    await assert.rejects(leader.ctx.tools.get("subagent", leader).execute({
      description: "Unavailable default", prompt: "must not create",
    }, { agent: leader, signal: new AbortController().signal }), /selected route unavailable/);
    assert.deepEqual(childBoundaryCounts(rig), before);
    assert.deepEqual(rig.preflights, [B]);
  } finally { rig.dispose(); }
});

for (const control of [
  { label: "no recorded policy", options: { allowed: null }, error: /not allowed for this Session/ },
  { label: "selection disabled", options: { modelSelection: false }, error: /selection is disabled/ },
]) {
  test("composed stock rejects off-parent default with " + control.label, { skip }, async () => {
    const rig = await fixture(control.options);
    try {
      const leader = await summonLeader(rig);
      const before = childBoundaryCounts(rig);
      await assert.rejects(leader.ctx.tools.get("subagent", leader).execute({
        description: control.label, prompt: "must not create",
      }, { agent: leader, signal: new AbortController().signal }), control.error);
      assert.deepEqual(childBoundaryCounts(rig), before);
      assert.equal(rig.preflights.length, 0);
    } finally { rig.dispose(); }
  });
}

for (const control of [
  { label: "explicit A overrides stored B", selection: A, expected: A, effort: undefined },
  { label: "explicit B stays B", selection: B, expected: B, effort: undefined },
  { label: "effort-only selection applies to stored B", selection: { reasoning_effort: "high" }, expected: B, effort: "high" },
]) {
  test("composed stock route precedence: " + control.label, { skip }, async () => {
    const rig = await fixture();
    try {
      const leader = await summonLeader(rig);
      const before = rig.creates.length;
      await assert.rejects(leader.ctx.tools.get("subagent", leader).execute({
        description: control.label, prompt: "stop after setup", ...control.selection,
      }, { agent: leader, signal: new AbortController().signal }), error => error === STOP);
      assert.equal(rig.creates.length, before + 1);
      const row = rig.creates.at(-1);
      assert.deepEqual({ provider: row.spec.agentOptions.provider, model: row.spec.agentOptions.model }, control.expected);
      const descriptor = row.session.events.find((event: any) => event.type === "subagent/descriptor").data;
      assert.deepEqual({ provider: descriptor.agentProvider, model: descriptor.agentModel }, control.expected);
      assert.equal(row.spec.agentOptions.reasoningEffort, control.effort);
      assert.equal(rig.preflights.at(-1).reasoningEffort, control.effort);
      assert.deepEqual(leader.options, A);
      assert.equal(rig.streamCalls, 0);
    } finally { rig.dispose(); }
  });
}

test("bridge keeps two agents stable on unrelated global registry changes", { skip }, async () => {
  const listeners = new Set<() => void>();
  const local = new Map<object, StockWorkerToolDefinition>();
  const source: StockWorkerToolDefinition = { name: "subagent", async execute() { return "stock result"; } };
  const fire = () => { for (const cb of [...listeners]) cb(); };
  const first = {}, second = {};
  let resolveDefault!: (route: typeof B) => void;
  const ready = new Promise<typeof B>(resolve => { resolveDefault = resolve; });
  const install = (agent: object) => registerStockWorkerModelDefaultBridge({
    agent,
    tools: {
      get: (_name, scope) => local.get(scope) ?? source,
      executable: (_name, scope) => local.get(scope) ?? source,
      register(definition) {
        local.set(agent, definition); fire();
        return () => { if (local.get(agent) === definition) { local.delete(agent); fire(); } };
      },
    },
    inherited: () => ({ definition: source, executable: source }),
    onToolsChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    getDefault: () => ready,
  });
  const disposeFirst = install(first), disposeSecond = install(second);
  try {
    const admittedFirst = local.get(first)!, admittedSecond = local.get(second)!;
    const pending = admittedFirst.execute({}, { agent: first, signal: new AbortController().signal });
    fire(); // another tool's registration emits the unfiltered public event
    resolveDefault(B);
    assert.equal(await pending, "stock result");
    assert.equal(local.get(first), admittedFirst, "first Agent registration identity stays admitted");
    assert.equal(local.get(second), admittedSecond, "sibling Agent registration identity stays admitted");
  } finally { disposeFirst(); disposeSecond(); }
});

for (const disposed of [false, true]) {
  test("composed missing default mirror awaits durable mark" + (disposed ? " and rejects disposed Agent" : " before selecting B"), { skip }, async () => {
    const rig = await fixture();
    try {
      // Let activation's empty-table warmup settle first. The selected row is
      // then supplied by a delayed durable read, not an in-process summon.
      await new Promise(resolve => setImmediate(resolve));
      const gate = rig.deferDefaultRead();
      const before = childBoundaryCounts(rig);
      const tool = rig.root.ctx.tools.get("subagent", rig.root);
      const expected = disposed ? /exact live dispatcher|no longer active/ : (error: unknown) => error === STOP;
      const pending = assert.rejects(tool.execute({
        description: "Deferred durable route", prompt: "creation boundary only",
      }, { agent: rig.root, signal: new AbortController().signal }), expected);
      await gate.started;
      assert.deepEqual(childBoundaryCounts(rig), before, "pending durable read must not inherit A or create a child");
      if (disposed) rig.disposeAgent();
      gate.release();
      await pending;
      if (disposed) {
        assert.deepEqual(childBoundaryCounts(rig), before, "disposed Agent cannot create after read resolves");
      } else {
        assert.equal(rig.creates.length, before.creates + 1);
        const row = rig.creates.at(-1);
        assert.deepEqual({ provider: row.spec.agentOptions.provider, model: row.spec.agentOptions.model }, B);
        assert.deepEqual(rig.root.options, A);
      }
      assert.equal(rig.streamCalls, 0);
    } finally { rig.dispose(); }
  });
}

function bridgeFixture() {
  const agent = {};
  const listeners = new Set<() => void>();
  const calls: Array<{ args: unknown; exec: unknown }> = [];
  const stockDefinition: StockWorkerToolDefinition = {
    name: "subagent", description: "original stock metadata", parameters: {}, output: {},
    async execute(args, exec) { calls.push({ args, exec }); return "original result"; },
  };
  let inherited: StockWorkerToolDefinition | undefined = stockDefinition;
  let conditional = false;
  let local: StockWorkerToolDefinition | undefined;
  const fire = () => { for (const cb of [...listeners]) cb(); };
  const tools = {
    get(_name: string, scope: object) { assert.equal(scope, agent); return local ?? inherited; },
    executable(_name: string, scope: object) { assert.equal(scope, agent); return local ?? (conditional ? undefined : inherited); },
    register(definition: StockWorkerToolDefinition) {
      assert.equal(local, undefined, "own-layer duplicate must never be registered");
      local = definition; fire();
      return () => { if (local === definition) { local = undefined; fire(); } };
    },
  };
  let defaultRoute: typeof B | undefined = B;
  const dispose = registerStockWorkerModelDefaultBridge({
    agent, tools,
    inherited: () => ({ definition: inherited, executable: conditional ? undefined : inherited }),
    onToolsChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    async getDefault(exactAgent) { assert.equal(exactAgent, agent); return defaultRoute; },
  });
  return { agent, calls, tools, stockDefinition, dispose,
    setDefault(route: typeof B | undefined) { defaultRoute = route; },
    replace(definition: StockWorkerToolDefinition | undefined, hasCondition = false) { inherited = definition; conditional = hasCondition; fire(); } };
}

test("bridge preserves metadata and exact execution while only defaulting omitted route", { skip }, async () => {
  const rig = bridgeFixture();
  try {
    const wrapper = rig.tools.get("subagent", rig.agent)!;
    assert.notEqual(wrapper, rig.stockDefinition);
    assert.equal(wrapper.output, rig.stockDefinition.output);
    assert.equal(wrapper.parameters, rig.stockDefinition.parameters);
    const exec = { agent: rig.agent, signal: new AbortController().signal };
    const omitted = Object.freeze({ prompt: "work", reasoning_effort: "high" });
    assert.equal(await wrapper.execute(omitted, exec), "original result");
    assert.deepEqual(rig.calls[0]?.args, { ...omitted, ...B });
    assert.equal(rig.calls[0]?.exec, exec);
    assert.deepEqual(omitted, { prompt: "work", reasoning_effort: "high" });
    const explicit = Object.freeze({ prompt: "work", ...A, reasoning_effort: "low" });
    await wrapper.execute(explicit, exec);
    assert.equal(rig.calls[1]?.args, explicit, "complete explicit route stays unchanged");
    const partial = Object.freeze({ model: A.model });
    await wrapper.execute(partial, exec);
    assert.equal(rig.calls[2]?.args, partial, "stock retains partial-route validation");
    rig.setDefault(undefined);
    await wrapper.execute(omitted, exec);
    assert.equal(rig.calls[3]?.args, omitted, "no default keeps inheritance input unchanged");
  } finally { rig.dispose(); }
});

test("bridge follows stock replacement and rejects retained stale definitions", { skip }, async () => {
  const rig = bridgeFixture();
  const oldWrapper = rig.tools.get("subagent", rig.agent)!;
  const replacement: StockWorkerToolDefinition = {
    ...rig.stockDefinition, description: "replacement stock metadata",
    async execute() { return "replacement result"; },
  };
  const exec = { agent: rig.agent, signal: new AbortController().signal };
  rig.replace(replacement);
  const fresh = rig.tools.get("subagent", rig.agent)!;
  assert.equal(fresh.description, replacement.description);
  await assert.rejects(oldWrapper.execute({}, exec), /no longer active/);
  assert.equal(await fresh.execute({}, exec), "replacement result");
  rig.replace(undefined);
  assert.equal(rig.tools.get("subagent", rig.agent), undefined);
  await assert.rejects(fresh.execute({}, exec), /no longer active/);
  rig.dispose(); rig.dispose();
});

test("bridge rejects disposal during asynchronous default restoration", { skip }, async () => {
  const agent = {};
  let resolveDefault!: (route: typeof B) => void;
  const ready = new Promise<typeof B>(resolve => { resolveDefault = resolve; });
  let local: StockWorkerToolDefinition | undefined;
  let calls = 0;
  const source: StockWorkerToolDefinition = {
    name: "subagent", async execute() { calls++; return "must not run"; },
  };
  const dispose = registerStockWorkerModelDefaultBridge({
    agent,
    tools: {
      get: () => local ?? source,
      executable: () => local ?? source,
      register(definition) { local = definition; return () => { local = undefined; }; },
    },
    inherited: () => ({ definition: source, executable: source }),
    onToolsChange: () => () => {},
    getDefault: () => ready,
  });
  const pending = local!.execute({}, { agent, signal: new AbortController().signal });
  dispose(); resolveDefault(B);
  await assert.rejects(pending, /no longer active/);
  assert.equal(calls, 0);
});

test("bridge leaves conditional stock replacements unshadowed", { skip }, async () => {
  const rig = bridgeFixture();
  try {
    const oldWrapper = rig.tools.get("subagent", rig.agent)!;
    const replacement = { ...rig.stockDefinition, description: "conditional replacement" };
    rig.replace(replacement, true);
    assert.equal(rig.tools.get("subagent", rig.agent), replacement,
      "bridge must not strip an uninspectable registration condition");
    assert.equal(rig.tools.executable("subagent", rig.agent), undefined,
      "without step admission conditional stock remains unavailable");
    await assert.rejects(oldWrapper.execute({}, { agent: rig.agent }), /no longer active/);
    assert.equal(rig.calls.length, 0);
  } finally { rig.dispose(); }
});

test("stored worker_model B reaches registered stock omitted-route creation", { timeout: 5000, skip }, async () => {
  const rig = await fixture();
  try {
    const spawn = rig.root.ctx.tools.get("spawn_dispatcher", rig.root);
    assert.ok(spawn, "real activation registered summon tool");
    await assert.rejects(rig.root.ctx.tools.get("subagent", rig.root).execute({
      description: "No default inheritance", prompt: "stop after setup",
    }, { agent: rig.root, signal: new AbortController().signal }), error => error === STOP);
    const inherited = rig.creates.at(-1).spec.agentOptions;
    assert.deepEqual({ provider: inherited.provider, model: inherited.model }, A);
    const summoned = await spawn.execute({
      title: "Offline route leader", prompt: "No model execution: route boundary only",
      worker_model: B.provider + "/" + B.model,
    });
    assert.equal(summoned.ok, true, JSON.stringify(summoned));
    const leader = rig.agents.get(summoned.dispatcher_id);
    assert.ok(leader, "product summon created leader");
    assert.deepEqual(leader.options, A, "leader remains on A");
    assert.deepEqual(rig.tables.get("dispatcher_sessions")?.get(leader.id)?.workerModel, B,
      "real summon stored B under actual leader id");
    const signal = new AbortController().signal;
    const tool = leader.ctx.tools.get("subagent", leader);
    assert.ok(tool, "leader resolves registered active stock surface");
    const before = rig.creates.length;
    await assert.rejects(tool.execute({
      description: "Offline creation boundary", prompt: "Stop after setup; never infer",
    }, { agent: leader, signal }), error => error === STOP);
    assert.equal(rig.creates.length, before + 1, "one real manager materialization");
    const row = rig.creates.at(-1);
    const descriptor = row.session.events.find((event: any) => event.type === "subagent/descriptor")?.data;
    assert.ok(descriptor, "real manager setup appended descriptor");
    assert.ok(rig.tables.get("worker_markers")?.has(row.agent.id), "product adopted created worker");
    assert.equal(rig.streamCalls, 0, "zero inference streams");
    const actual = { provider: row.spec.agentOptions.provider, model: row.spec.agentOptions.model };
    assert.deepEqual({ provider: descriptor.agentProvider, model: descriptor.agentModel }, actual,
      "descriptor agrees with agents.create route");
    assert.deepEqual(actual, B, "omitted stock route must select stored worker_model B, not leader A");
    await assert.rejects(leader.ctx.tools.get("subagent", leader).execute({
      description: "Second omitted worker", prompt: "same durable default remains",
    }, { agent: leader, signal }), error => error === STOP);
    const later = rig.creates.at(-1);
    assert.deepEqual({ provider: later.spec.agentOptions.provider, model: later.spec.agentOptions.model }, B,
      "default applies to later workers, not only the first");
    assert.equal(rig.streamCalls, 0);
  } finally {
    rig.dispose();
  }
});
