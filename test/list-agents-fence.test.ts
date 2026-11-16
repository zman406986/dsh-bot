/**
 * Same-name `list_agents` fence (adapter/list-agents-fence.ts).
 *
 * A layered fake surface mirrors the live host's registry: the stock global
 * map is INHERITED, an own-layer registration shadows it by name, and the
 * disposer puts the stock definition back. The helper is structural, so this
 * test needs no dsh package and no network (S8).
 *
 * Pinned here:
 * 1. the gate refuses when the scoped surface cannot be read, does not show
 *    stock `list_agents`, or lacks either host listing seam;
 * 2. name/description/parameters/output-schema are the stock bytes/shape;
 * 3. `children` is untouched: every direct entry, one-shot dropped,
 *    diagnostic projected, live status from `agents.get`;
 * 4. `descendants` is clamped to `parentId === caller && depth === 1`, with
 *    parent/depth preserved and the grandchild absent;
 * 5. render text is stock text, including `(no subagents)` and the em dash;
 * 6. an unknown scope rejects before either seam is called;
 * 7. the disposer removes the wrapper and the stock definition is visible
 *    again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIST_AGENTS_DESCRIPTION,
  LIST_AGENTS_EMPTY_TEXT,
  LIST_AGENTS_SCOPE_DESCRIPTION,
  LIST_AGENTS_TOOL_NAME,
  registerListAgentsFence,
  type ListAgentsFenceOptions,
  type ListAgentsFenceToolSurface,
  type ListAgentsProjectedEntry,
} from "../src/adapter/list-agents-fence.js";
import type { SubagentListEntryLike } from "../src/adapter/cordis-dsh-host.js";

const SELF = "session-self";
const OTHER = "session-other";

/** Stock description as the host ships it, byte-for-byte. */
const STOCK_DESCRIPTION =
  "List subagents you started, with their ids, labels, and status. running means it is working; inactive means it is not currently working. You will be notified when a subagent finishes; there is no need to keep checking its status. Use send_message to continue the conversation.";

/** Stock scope description as the host ships it, byte-for-byte. */
const STOCK_SCOPE_DESCRIPTION =
  "children (default) lists direct children, which accept send_message in any status. descendants lists the whole tree below you with each entry's parent session id and depth; entries deeper than 1 accept only interrupt_agent.";

interface FakeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly output: {
    schema: unknown;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ readonly type: string; readonly text?: string }>;
    readonly presentationMeta?: unknown;
  };
  execute(args: unknown, exec?: unknown): Promise<unknown>;
}

/** The stock global registration every real dispatcher inherits. */
function stockListAgents(): FakeTool {
  return {
    name: "list_agents",
    description: "stock description that the scoped wrapper must shadow",
    parameters: {},
    output: {
      schema: { type: "array" },
      render: () => [{ type: "text", text: "stock" }],
    },
    execute: async () => [],
  };
}

function otherStockTool(name: string): FakeTool {
  return {
    name,
    description: "some other stock verb",
    parameters: {},
    output: { schema: { type: "object" }, render: () => [] },
    execute: async () => ({}),
  };
}

/**
 * Layered scoped surface: inherited (stock/global) map + OWN map. A name in
 * the own map shadows the inherited one; removing it restores the inherited
 * definition. `schemas` reports the union (own names once).
 */
function createLayeredSurface(stock: readonly FakeTool[]) {
  const inherited = new Map<string, FakeTool>(
    stock.map((tool) => [tool.name, tool]),
  );
  const own = new Map<string, FakeTool>();
  const schemaScopes: unknown[] = [];
  const tools: ListAgentsFenceToolSurface = {
    schemas(scope?: unknown) {
      schemaScopes.push(scope);
      const names = new Set([...inherited.keys(), ...own.keys()]);
      return [...names].map((name) => ({ name }));
    },
    register(definition: unknown) {
      const def = definition as FakeTool;
      if (own.has(def.name)) {
        throw new Error(`tool "${def.name}" is already registered in this scope`);
      }
      own.set(def.name, def);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        own.delete(def.name);
      };
    },
  };
  const visible = (name: string): FakeTool | undefined =>
    own.get(name) ?? inherited.get(name);
  return { inherited, own, tools, visible, schemaScopes };
}

type ListSeam = (
  parentSessionId: string,
  signal?: AbortSignal,
) => Promise<readonly SubagentListEntryLike[]>;

interface OptionsParts {
  readonly tools: ListAgentsFenceToolSurface;
  readonly listChildren?: ListSeam;
  readonly listDescendants?: ListSeam;
  readonly statuses?: ReadonlyMap<string, string>;
}

function fenceOptions(parts: OptionsParts): ListAgentsFenceOptions {
  const statuses = parts.statuses ?? new Map<string, string>();
  return {
    tools: parts.tools,
    // The scope is the activated agent; the gate must ask for ITS surface.
    scope: { session: { id: SELF } },
    sessionId: SELF,
    agents: {
      get: (id: unknown) => {
        const status = statuses.get(String(id));
        return status === undefined ? undefined : { status };
      },
    },
    ...(parts.listChildren === undefined
      ? {}
      : { listChildren: parts.listChildren }),
    ...(parts.listDescendants === undefined
      ? {}
      : { listDescendants: parts.listDescendants }),
  };
}

/** A fence over a fresh layered surface, plus the seams' own call log. */
function createFence(options: {
  readonly children?: readonly SubagentListEntryLike[];
  readonly descendants?: readonly SubagentListEntryLike[];
  readonly statuses?: ReadonlyMap<string, string>;
  readonly stock?: readonly FakeTool[];
}) {
  const surface = createLayeredSurface(
    options.stock ?? [stockListAgents(), otherStockTool("send_message")],
  );
  const childCalls: Array<{ parent: string; signal?: AbortSignal }> = [];
  const descendantCalls: Array<{ root: string; signal?: AbortSignal }> = [];
  const listChildren: ListSeam = async (parentSessionId, signal) => {
    childCalls.push(
      signal === undefined
        ? { parent: parentSessionId }
        : { parent: parentSessionId, signal },
    );
    return options.children ?? [];
  };
  const listDescendants: ListSeam = async (rootSessionId, signal) => {
    descendantCalls.push(
      signal === undefined
        ? { root: rootSessionId }
        : { root: rootSessionId, signal },
    );
    return options.descendants ?? [];
  };
  const dispose = registerListAgentsFence(
    fenceOptions({
      tools: surface.tools,
      listChildren,
      listDescendants,
      ...(options.statuses === undefined
        ? {}
        : { statuses: options.statuses }),
    }),
  );
  assert.notEqual(dispose, null, "fence must register on a qualifying surface");
  const wrapper = surface.own.get(LIST_AGENTS_TOOL_NAME);
  assert.ok(wrapper, "wrapper is registered on the own layer");
  return {
    surface,
    wrapper,
    dispose: dispose as () => void,
    childCalls,
    descendantCalls,
  };
}

const CHILD_RUNNING: SubagentListEntryLike = {
  id: "child-1",
  label: "Child One",
  mode: "continuable",
};
const CHILD_IDLE: SubagentListEntryLike = {
  id: "child-2",
  label: "Child Two",
  mode: "continuable",
};
const ONE_SHOT: SubagentListEntryLike = {
  id: "one-shot-1",
  label: "One Shot",
  mode: "one-shot",
};
const DIAG_UNAVAILABLE: SubagentListEntryLike = {
  id: "diag-1",
  kind: "diagnostic",
  reason: "unavailable",
};
const DIAG_CORRUPT: SubagentListEntryLike = {
  id: "diag-1",
  kind: "diagnostic",
  reason: "corrupt",
};
const STATUSES = new Map<string, string>([
  ["child-1", "running"],
  ["grand-1", "running"],
]);

describe("registerListAgentsFence gate", () => {
  it("returns null when the scoped surface does not show stock list_agents", () => {
    const surface = createLayeredSurface([otherStockTool("send_message")]);
    const dispose = registerListAgentsFence(
      fenceOptions({
        tools: surface.tools,
        listChildren: async () => [],
        listDescendants: async () => [],
      }),
    );
    assert.equal(dispose, null);
    assert.equal(surface.own.size, 0);
    assert.equal(surface.visible(LIST_AGENTS_TOOL_NAME), undefined);
  });

  it("returns null when the surface cannot be read", () => {
    let registered = 0;
    const tools: ListAgentsFenceToolSurface = {
      schemas() {
        throw new Error("surface unreadable");
      },
      register() {
        registered += 1;
        return () => {};
      },
    };
    const dispose = registerListAgentsFence(
      fenceOptions({
        tools,
        listChildren: async () => [],
        listDescendants: async () => [],
      }),
    );
    assert.equal(dispose, null);
    assert.equal(registered, 0);
  });

  it("returns null when listChildren is missing", () => {
    const surface = createLayeredSurface([stockListAgents()]);
    const dispose = registerListAgentsFence(
      fenceOptions({
        tools: surface.tools,
        listDescendants: async () => [],
      }),
    );
    assert.equal(dispose, null);
    assert.equal(surface.own.size, 0);
  });

  it("returns null when listDescendants is missing", () => {
    const surface = createLayeredSurface([stockListAgents()]);
    const dispose = registerListAgentsFence(
      fenceOptions({
        tools: surface.tools,
        listChildren: async () => [],
      }),
    );
    assert.equal(dispose, null);
    assert.equal(surface.own.size, 0);
  });

  it("reads schemas with the given agent scope", () => {
    const surface = createLayeredSurface([stockListAgents()]);
    const scope = { session: { id: SELF } };
    const dispose = registerListAgentsFence({
      tools: surface.tools,
      scope,
      sessionId: SELF,
      agents: { get: () => undefined },
      listChildren: async () => [],
      listDescendants: async () => [],
    });
    assert.notEqual(dispose, null);
    assert.equal(surface.schemaScopes[0], scope);
  });
});

describe("registerListAgentsFence registered shape", () => {
  it("shadows stock with the stock name/description/parameters/output schema", () => {
    const { wrapper } = createFence({});

    assert.equal(wrapper.name, LIST_AGENTS_TOOL_NAME);
    assert.equal(wrapper.name, "list_agents");
    assert.equal(wrapper.description, STOCK_DESCRIPTION);
    assert.equal(wrapper.description, LIST_AGENTS_DESCRIPTION);

    assert.deepEqual(wrapper.parameters, {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["children", "descendants"],
          description: STOCK_SCOPE_DESCRIPTION,
        },
      },
    });
    assert.equal(STOCK_SCOPE_DESCRIPTION, LIST_AGENTS_SCOPE_DESCRIPTION);
    // The optional scope is NOT required; the stock schema has no required list.
    assert.ok(!("required" in (wrapper.parameters as object)));

    const schema = wrapper.output.schema as {
      type: string;
      items: {
        oneOf: Array<{
          type: string;
          additionalProperties: boolean;
          required: string[];
          properties: Record<string, { enum?: string[] }>;
        }>;
      };
    };
    assert.equal(schema.type, "array");
    assert.ok(Array.isArray(schema.items.oneOf));
    assert.equal(schema.items.oneOf.length, 2);

    const [child, diagnostic] = schema.items.oneOf;
    assert.ok(child !== undefined && diagnostic !== undefined);
    assert.equal(child.type, "object");
    assert.equal(child.additionalProperties, false);
    assert.deepEqual(child.required, ["kind", "id", "label", "status"]);
    assert.deepEqual(child.properties.status?.enum, ["running", "inactive"]);
    assert.ok(!("parent" in child.required));
    assert.ok(!("depth" in child.required));

    assert.equal(diagnostic.type, "object");
    assert.equal(diagnostic.additionalProperties, false);
    assert.deepEqual(diagnostic.required, ["kind", "id", "reason"]);
    assert.deepEqual(diagnostic.properties.reason?.enum, [
      "corrupt",
      "unsupported",
      "unavailable",
    ]);
    assert.ok(!("parent" in diagnostic.required));
    assert.ok(!("depth" in diagnostic.required));

    // No presentationMeta: stock list_agents has none.
    assert.equal(wrapper.output.presentationMeta, undefined);
  });
});

describe("registerListAgentsFence children scope", () => {
  it("returns every direct entry unchanged, drops one-shot, projects diagnostics", async () => {
    const { wrapper, childCalls } = createFence({
      children: [CHILD_RUNNING, CHILD_IDLE, ONE_SHOT, DIAG_UNAVAILABLE],
      statuses: STATUSES,
    });
    const signal = new AbortController().signal;
    const result = (await wrapper.execute({}, { signal })) as ListAgentsProjectedEntry[];

    assert.deepEqual(result, [
      { kind: "child", id: "child-1", label: "Child One", status: "running" },
      { kind: "child", id: "child-2", label: "Child Two", status: "inactive" },
      { kind: "diagnostic", id: "diag-1", reason: "unavailable" },
    ]);
    // Children carry NO position, even though the seam could have supplied one.
    assert.deepEqual(Object.keys(result[0] ?? {}), [
      "kind",
      "id",
      "label",
      "status",
    ]);
    assert.equal(childCalls.length, 1);
    assert.equal(childCalls[0]?.parent, SELF);
    assert.equal(childCalls[0]?.signal, signal);

    assert.deepEqual(wrapper.output.render({}, result), [
      {
        type: "text",
        text: "child-1 [running] — Child One\nchild-2 [inactive] — Child Two\ndiag-1 [diagnostic: unavailable]",
      },
    ]);
  });

  it("defaults to children and renders the stock empty text", async () => {
    const { wrapper, childCalls, descendantCalls } = createFence({});
    const result = await wrapper.execute({});
    assert.deepEqual(result, []);
    assert.equal(childCalls.length, 1);
    assert.equal(descendantCalls.length, 0);
    assert.equal(LIST_AGENTS_EMPTY_TEXT, "(no subagents)");
    assert.deepEqual(wrapper.output.render({}, result), [
      { type: "text", text: "(no subagents)" },
    ]);
  });
});

describe("registerListAgentsFence descendants clamp", () => {
  it("returns only direct children, preserving parent/depth", async () => {
    const { wrapper, descendantCalls } = createFence({
      descendants: [
        // depth 1 under the caller
        {
          id: "child-1",
          label: "Child One",
          mode: "continuable",
          parentId: SELF,
          depth: 1,
        },
        // depth 2 — the legacy grandchild that stock would have leaked
        {
          id: "grand-1",
          label: "Grandchild",
          mode: "continuable",
          parentId: "child-1",
          depth: 2,
        },
        // depth 1 but under a different parent
        {
          id: "other-1",
          label: "Other Parent's Child",
          mode: "continuable",
          parentId: OTHER,
          depth: 1,
        },
        // depth-1 diagnostic: stock keeps diagnostics, so does the clamp
        {
          id: "diag-1",
          kind: "diagnostic",
          reason: "corrupt",
          parentId: SELF,
          depth: 1,
        },
        // depth-1 one-shot: stock drops non-continuable entries
        {
          id: "one-shot-1",
          label: "One Shot",
          mode: "one-shot",
          parentId: SELF,
          depth: 1,
        },
      ],
      statuses: STATUSES,
    });

    const result = (await wrapper.execute(
      { scope: "descendants" },
      { signal: new AbortController().signal },
    )) as ListAgentsProjectedEntry[];

    assert.deepEqual(result, [
      {
        kind: "child",
        id: "child-1",
        label: "Child One",
        status: "running",
        parent: SELF,
        depth: 1,
      },
      {
        kind: "diagnostic",
        id: "diag-1",
        reason: "corrupt",
        parent: SELF,
        depth: 1,
      },
    ]);
    assert.equal(descendantCalls.length, 1);
    assert.equal(descendantCalls[0]?.root, SELF);

    // Stock descendants render: position suffix on every surviving row.
    assert.deepEqual(wrapper.output.render({ scope: "descendants" }, result), [
      {
        type: "text",
        text: `child-1 [running] parent=${SELF} depth=1 — Child One\ndiag-1 [diagnostic: corrupt] parent=${SELF} depth=1`,
      },
    ]);
  });

  it("rejects an unknown scope before calling either seam", async () => {
    const { wrapper, childCalls, descendantCalls } = createFence({});
    await assert.rejects(
      () => wrapper.execute({ scope: "root" }),
      /unsupported scope/,
    );
    assert.equal(childCalls.length, 0);
    assert.equal(descendantCalls.length, 0);
  });
});

describe("registerListAgentsFence disposal", () => {
  it("removes the wrapper and makes the stock definition visible again", () => {
    const stock = stockListAgents();
    const { surface, wrapper, dispose } = createFence({ stock: [stock] });

    assert.equal(surface.visible(LIST_AGENTS_TOOL_NAME), wrapper);
    assert.notEqual(surface.visible(LIST_AGENTS_TOOL_NAME), stock);

    dispose();

    assert.equal(surface.own.has(LIST_AGENTS_TOOL_NAME), false);
    assert.equal(surface.visible(LIST_AGENTS_TOOL_NAME), stock);
    assert.deepEqual(
      surface.tools
        .schemas()
        .filter((schema) => schema.name === LIST_AGENTS_TOOL_NAME),
      [{ name: LIST_AGENTS_TOOL_NAME }],
    );
  });

  it("is idempotent", () => {
    const stock = stockListAgents();
    const { surface, dispose } = createFence({ stock: [stock] });
    dispose();
    dispose();
    assert.equal(surface.visible(LIST_AGENTS_TOOL_NAME), stock);
  });
});
