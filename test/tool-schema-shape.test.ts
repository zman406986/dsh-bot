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
import {
  createWorkerReplyTool,
  toRegisterableWorkerTool,
} from "../src/core/tools.js";
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

function createCaptureCtx(): AdapterContext & {
  registered: RegisterableTool[];
} {
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
  } as AdapterContext & { registered: RegisterableTool[] };
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
      name: "spawn_worker",
      description: "d",
      parameters: {},
      execute: async () => ({}),
    } as unknown as RegisterableTool;
    ctx.tools.register(tool);

    assert.throws(
      () => ctx.tools.register(tool),
      /tool "spawn_worker" is already registered/,
    );
  });

  it("all eight serialized dispatcher tool schemas are structurally valid", () => {
    const tools = registerAllDispatcherTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...DISPATCHER_TOOL_NAMES],
    );
    for (const tool of tools) {
      assertValidToolSchema(tool.parameters, `${tool.name}.parameters`);
    }
  });

  it("required flags become the parent object's required array", () => {
    const tools = registerAllDispatcherTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawn = byName.get("spawn_worker")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(spawn.required, ["stream_key", "title", "prompt"]);

    const check = byName.get("check_workers")?.parameters as Record<
      string,
      unknown
    >;
    // No mandatory fields → no object-level required key at all.
    assert.equal(check.required, undefined);

    const steer = byName.get("steer_worker")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(steer.required, ["worker_id", "message"]);

    const stop = byName.get("stop_worker")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(stop.required, ["worker_id"]);

    const deliver = byName.get("deliver_result")?.parameters as Record<
      string,
      unknown
    >;
    assert.deepEqual(deliver.required, ["text"]);
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

  it("worker-side reply_to_dispatcher schema passes the same structural walk", () => {
    // Ticket 174 / ADR-0033 removed the worker access tool; the surviving
    // worker-side tool is the mid-task reply, and it takes this same walk.
    const tool = toRegisterableWorkerTool(
      createWorkerReplyTool({
        multitask: {
          getWorker: () => undefined,
          sendPeer: () => ({ ok: false, messageId: "", reason: "self-target", detail: "" }),
        } as never,
        resolveWorkerId: () => null,
      }),
    );
    assert.equal(tool.name, "reply_to_dispatcher");
    assertValidToolSchema(tool.parameters, `${tool.name}.parameters`);
  });
});
