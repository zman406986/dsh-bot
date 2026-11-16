/**
 * Ticket 45 pin: every tool schema we hand to the LLM must be valid JSON
 * Schema at the provider boundary. `required` is ONLY legal as an
 * object-level array of property names; a boolean `required` inside a
 * property schema made the provider refuse every activated dispatcher turn
 * with INVALID_REQUEST ("false is not of type \"array\""). Offline fakes
 * never validate emitted schemas, so this walks the serialized trees
 * structurally — a regression fails without a live host.
 *
 * Fake-vs-host (ticket 91): the capture `tools.register` throws on a
 * duplicate name with the shipped wording
 * (`@deepseek-ai/dsh-tools/lib/index.js:2538`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeDshHost } from "../src/core/fake-host.js";
import { createMultitask } from "../src/core/multitask.js";
import { DISPATCHER_TOOL_NAMES } from "../src/core/policy/prompts.js";
import {
  registerDispatcherTools,
  type RegisterableTool,
} from "../src/adapter/dispatcher-tools.js";
import type { AdapterContext } from "../src/adapter/cordis-dsh-host.js";

const JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/**
 * Recursively validate one JSON-Schema node: `required` (if present) must be
 * an array of strings (never a boolean), `type` must be a valid JSON-Schema
 * type string, and properties/items recurse.
 */
function assertValidToolSchema(node: unknown, path: string): void {
  assert.ok(
    node !== null && typeof node === "object" && !Array.isArray(node),
    `${path}: schema node must be a plain object`,
  );
  const schema = node as Record<string, unknown>;
  if ("required" in schema) {
    assert.notEqual(
      typeof schema.required,
      "boolean",
      `${path}: required must never be a boolean (provider rejects the request)`,
    );
    assert.ok(
      Array.isArray(schema.required),
      `${path}: required must be an array of property names`,
    );
    for (const entry of schema.required as unknown[]) {
      assert.equal(
        typeof entry,
        "string",
        `${path}: required entries must be strings`,
      );
    }
  }
  if ("type" in schema) {
    assert.ok(
      typeof schema.type === "string" &&
        JSON_SCHEMA_TYPES.has(schema.type),
      `${path}: invalid JSON-Schema type ${JSON.stringify(schema.type)}`,
    );
  }
  if (schema.properties !== undefined) {
    assert.ok(
      typeof schema.properties === "object" && schema.properties !== null,
      `${path}: properties must be an object`,
    );
    for (const [name, child] of Object.entries(
      schema.properties as Record<string, unknown>,
    )) {
      assertValidToolSchema(child, `${path}.properties.${name}`);
    }
  }
  if (schema.items !== undefined) {
    assertValidToolSchema(schema.items, `${path}.items`);
  }
}

/**
 * The capture context only needs `tools`, and the capture registry always
 * implements `register` (the real `ToolsLike.register` is optional for stub
 * hosts). Returning the narrow shape keeps the assertions below non-optional.
 */
interface CaptureCtx {
  tools: NonNullable<AdapterContext["tools"]> & {
    register(definition: unknown): () => void;
  };
  registered: RegisterableTool[];
}

function createCaptureCtx(): CaptureCtx {
  const registered: RegisterableTool[] = [];
  return {
    registered,
    tools: {
      schemas: () => registered.map((tool) => ({ name: tool.name })),
      register(definition: unknown) {
        const tool = definition as RegisterableTool;
        // Shipped rule (ticket 91): a duplicate tool name throws
        // (dsh-tools lib/index.js:2538, NamedEntries factory). The shipped
        // surface never re-registers a name; this keeps it that way.
        if (registered.some((t) => t.name === tool.name)) {
          throw new Error(
            `tool "${tool.name}" is already registered (for a per-agent ` +
              `variant, register through that agent's \`agent.ctx\` ` +
              `instead)`,
          );
        }
        registered.push(tool);
        return () => {
          const at = registered.indexOf(tool);
          if (at >= 0) registered.splice(at, 1);
        };
      },
    },
  };
}

function registerAllDispatcherTools(): RegisterableTool[] {
  const ctx = createCaptureCtx();
  const host = new FakeDshHost();
  const multitask = createMultitask(host);
  registerDispatcherTools({
    ctx,
    multitask,
    getSessionId: () => "session-1",
  });
  return ctx.registered;
}

describe("tool schema shape — provider-valid JSON Schema (ticket 45)", () => {
  it("the capture registry throws the host duplicate-tool error (ticket 91 pin)", () => {
    const ctx = createCaptureCtx();
    const tool = {
      name: "deliver_result",
      description: "d",
      parameters: {},
      execute: async () => ({}),
    } as unknown as RegisterableTool;
    ctx.tools.register(tool);

    assert.throws(
      () => ctx.tools.register(tool),
      /tool "deliver_result" is already registered/,
    );
  });

  it("the three kept dispatcher tool schemas are structurally valid", () => {
    const tools = registerAllDispatcherTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    assert.equal(tools.length, 3);
    for (const tool of tools) {
      assertValidToolSchema(tool.parameters, `${tool.name}.parameters`);
    }
  });

  it("the removed dispatcher tool names are absent from the registered surface", () => {
    const registered = new Set(
      registerAllDispatcherTools().map((tool) => tool.name),
    );
    for (const removed of [
      "spawn_worker",
      "check_workers",
      "steer_worker",
      "stop_worker",
      "await_agent",
      "send_peer",
      "reply_to_dispatcher",
    ]) {
      assert.equal(
        registered.has(removed),
        false,
        `removed tool still registered: ${removed}`,
      );
    }
  });

  it("required flags become the parent object's required array", () => {
    const tools = registerAllDispatcherTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const deliver = byName.get("deliver_result")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(deliver.required, ["text"]);

    const message = byName.get("message_agent")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(message.required, ["target", "text"]);

    const summon = byName.get("spawn_dispatcher")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(summon.required, ["title", "prompt"]);
  });

  it("no property schema carries a required key; optionality preserved", () => {
    const tools = registerAllDispatcherTools();
    const deliver = tools.find(
      (tool) => tool.name === "deliver_result",
    )?.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };
    // `text` required:true, `todo_id`/`attachment_paths` required:false —
    // none of them keeps a per-field required key after serialization.
    for (const [name, property] of Object.entries(deliver.properties)) {
      assert.equal(
        "required" in property,
        false,
        `deliver_result.properties.${name} still carries required`,
      );
    }
    assert.deepEqual(deliver.properties.attachment_paths?.items, {
      type: "string",
    });
  });

  it("spawn_dispatcher keeps its model and worker_model parameters optional", () => {
    const tools = registerAllDispatcherTools();
    const summon = tools.find(
      (tool) => tool.name === "spawn_dispatcher",
    )?.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(
      Object.keys(summon.properties).sort(),
      ["model", "prompt", "title", "worker_model"],
    );
    for (const name of ["model", "worker_model"]) {
      assert.equal(
        "required" in (summon.properties[name] ?? {}),
        false,
        `spawn_dispatcher.properties.${name} still carries required`,
      );
    }
  });
});
