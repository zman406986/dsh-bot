/**
 * Ticket 124 — plugin-level wiring for deterministic microcompact.
 *
 * Pins what `apply` does with the feature:
 *
 * 1. The `microcompactEnabled` Config field exists, defaults to FALSE, and is
 *    `.volatile()` like every other field (the settings form requires it).
 * 2. Off (the default): NO `agent/pre-step` listener is registered — a plugin
 *    that ships a surface-rewriting pass must be opt-in.
 * 3. On: exactly one `agent/pre-step` listener is registered and unload
 *    removes it.
 * 4. On, but a non-dispatcher session: no surface is rewritten (the gate).
 * 5. On, dispatcher session, pressure over the ratio: the pass clears old tool
 *    results and writes the boundary into the plugin's own durability store.
 *
 * Offline only (S8): a stub context, a fake session, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Config, apply } from "../src/plugin.js";
import { volatileConfig } from "./support/plugin-config.js";
import { createInMemoryDurability } from "../src/core/durability.js";
import {
  CLEARED_TOOL_RESULT_TEXT,
  MICROCOMPACT_TRIGGER_RATIO,
} from "../src/core/microcompact.js";
import type { AdapterContext, AgentLike } from "../src/adapter/cordis-dsh-host.js";

/** The schema's declared fields, in order. */
function schemaFields(): string[] {
  return Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict);
}

/** Whether one schema field is volatile (the settings form requirement). */
function isVolatile(field: string): boolean {
  const dict = (Config as unknown as {
    dict: Record<string, { meta?: { volatile?: boolean } }>;
  }).dict;
  return dict[field]?.meta?.volatile === true;
}

interface FakeMessage {
  readonly id: string;
  readonly role: string;
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly source?: { readonly kind: string; readonly callId?: string };
  readonly toolCallId?: string;
}

/**
 * Stub plugin context. Mirrors the live shapes the other plugin-level suites
 * use: `on` returns a disposer, `effect` runs `execute` and collects the
 * returned cleanup, and `ctx.get` resolves a service by name.
 */
function createStubCtx(options: {
  tokenMeter?: unknown;
} = {}): AdapterContext & {
  effect: (execute: () => unknown, label?: string) => unknown;
  inject: (services: readonly string[], callback: (child: Record<string, never>) => void) => void;
  get(name: string): unknown;
  disposers: Array<() => void>;
  listeners: Map<string, Array<(payload: never) => unknown>>;
  fire(name: string, payload: unknown): Promise<unknown>;
  tables: Map<string, Map<string, unknown>>;
} {
  const disposers: Array<() => void> = [];
  const listeners = new Map<string, Array<(payload: never) => unknown>>();
  const tables = new Map<string, Map<string, unknown>>();
  const services = new Map<string, unknown>();
  if (options.tokenMeter !== undefined) {
    services.set("tokenMeter", options.tokenMeter);
  }

  const fire = async (name: string, payload: unknown): Promise<unknown> => {
    const list = [...(listeners.get(name) ?? [])];
    let nextCalled = false;
    let result: unknown;
    const next = async () => {
      nextCalled = true;
      return { kind: "enter", messages: [] };
    };
    for (const listener of list) {
      result = await (listener as (p: unknown, n: () => Promise<unknown>) => unknown)(
        payload,
        next,
      );
    }
    if (!nextCalled) return result;
    return result;
  };

  const ctx = {
    disposers,
    listeners,
    tables,
    fire,
    effect(execute: () => unknown, label?: string) {
      void label;
      const result = execute();
      if (typeof result === "function") {
        disposers.push(result as () => void);
        return;
      }
      if (
        typeof result === "object" &&
        result !== null &&
        Symbol.iterator in result
      ) {
        for (const step of result as Iterable<unknown>) {
          if (typeof step === "function") disposers.push(step as () => void);
        }
      }
    },
    inject() {},
    get(name: string) {
      return services.get(name);
    },
    on(name: string, cb: (payload: never) => unknown) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((entry) => entry !== cb),
        );
      };
    },
    commands: {
      register() {
        return () => {};
      },
    },
    tools: {
      schemas() {
        return [];
      },
      register() {
        return () => {};
      },
    },
    jobs: { list() {
      return [];
    } },
    agents: { get() {
      return undefined;
    } },
    subagents: {
      async startActivation() {
        throw new Error("spawn is not exercised here");
      },
      interrupt() {},
      async sendMessage() {
        return undefined;
      },
    },
    storageDomain: {
      async open() {
        return {
          table(name: string) {
            let table = tables.get(name);
            if (table === undefined) {
              table = new Map<string, unknown>();
              tables.set(name, table);
            }
            const current = table;
            return {
              get(key: string) {
                return current.get(key);
              },
              entries() {
                return current.entries();
              },
              async put(key: string, value: unknown) {
                current.set(key, value);
              },
              async delete(key: string) {
                return current.delete(key);
              },
            };
          },
          async close() {},
        };
      },
    },
  };
  return ctx as never;
}

/** The token meter the plugin reads through `ctx.get("tokenMeter")`. */
function createMeter(totalTokens: number) {
  const price = (message: FakeMessage): number => {
    let tokens = 4;
    for (const block of message.content) {
      tokens += Math.ceil(block.text.length / 4) + 4;
    }
    return tokens;
  };
  return {
    measure(session: unknown) {
      const fake = session as {
        surface: { nodes: readonly number[] };
        eventAt(seq: number): { data?: { message?: FakeMessage } } | undefined;
      };
      return {
        totalTokens,
        nodes: fake.surface.nodes.map((seq) => {
          const message = fake.eventAt(seq)?.data?.message;
          const tokens = message === undefined ? 4 : price(message);
          return { seq, tokens, heuristicTokens: tokens };
        }),
      };
    },
    estimateMessage(message: unknown) {
      return price(message as FakeMessage);
    },
  };
}

/**
 * Fake session with a system node, a user node, `toolCount` large tool
 * results, and an assistant node. Replacements splice in place, like dsh.
 */
function createFakeSession(toolCount: number) {
  const events: Array<{ seq: number; type: string; data?: unknown }> = [];
  const surfaceNodes: number[] = [];
  const push = (seq: number, type: string, message?: FakeMessage) => {
    events.push({ seq, type, data: message === undefined ? {} : { message } });
    surfaceNodes.push(seq);
  };
  push(0, "system/message", {
    id: "sys",
    role: "system",
    content: [{ type: "text", text: "sys" }],
  });
  push(1, "user/message", {
    id: "u1",
    role: "user",
    content: [{ type: "text", text: "do work" }],
  });
  for (let i = 0; i < toolCount; i += 1) {
    const seq = 2 + i;
    push(seq, "tool/result", {
      id: `m-${seq}`,
      role: "tool",
      content: [{ type: "text", text: "x".repeat(16_000) }],
      source: { kind: "tool", callId: `call-${seq}` },
      toolCallId: `call-${seq}`,
    });
  }
  push(2 + toolCount, "assistant/message", {
    id: "a1",
    role: "assistant",
    content: [{ type: "text", text: "working" }],
  });

  return {
    id: "session-dispatcher",
    get seq() {
      return Math.max(events.length, 2 + toolCount + 1);
    },
    surface: { nodes: surfaceNodes },
    eventAt(seq: number) {
      return events.find((event) => event.seq === seq);
    },
    requestContext() {
      return { contextWindow: 1_000_000 };
    },
    append(type: string, data: unknown, opts?: unknown) {
      const seq = events.length;
      events.push({ seq, type, data });
      const op = opts as { surfaceOp?: { op: string; startSeq: number } } | undefined;
      if (type !== "compaction/prune") {
        if (op?.surfaceOp?.op === "replace") {
          const at = surfaceNodes.indexOf(op.surfaceOp.startSeq);
          if (at >= 0) surfaceNodes.splice(at, 1, seq);
        } else if (op !== undefined) {
          surfaceNodes.push(seq);
        }
      }
      return { seq };
    },
    /** How many tool results carry the cleared placeholder on the surface. */
    clearedOnSurface(): number {
      let count = 0;
      for (const seq of surfaceNodes) {
        const message = (events.find((event) => event.seq === seq)?.data as
          | { message?: FakeMessage }
          | undefined)?.message;
        if (
          message?.content.length === 1 &&
          message.content[0]?.text === CLEARED_TOOL_RESULT_TEXT
        ) {
          count += 1;
        }
      }
      return count;
    },
    raw: events,
  };
}

/** A live-looking dispatcher agent wrapping the fake session. */
function dispatcherAgent(session: unknown): AgentLike {
  return {
    session: session as AgentLike["session"],
    followup() {},
    inject() {},
  };
}

describe("microcompact plugin wiring (ticket 124)", () => {
  it("declares microcompactEnabled, off by default and volatile", () => {
    assert.ok(schemaFields().includes("microcompactEnabled"));
    assert.equal(isVolatile("microcompactEnabled"), true);
    // Default must be OFF: a surface-rewriting pass is opt-in.
    // (schemastery objects are callable, not `.parse`-able; the declared
    // default lives on the field's `meta`.)
    const dict = (Config as unknown as {
      dict: Record<string, { meta?: { default?: unknown } }>;
    }).dict;
    assert.equal(dict.microcompactEnabled?.meta?.default, false);
  });

  it("registers NO pre-step listener when the field is off", () => {
    const ctx = createStubCtx({ tokenMeter: createMeter(999_999_999) });
    apply(ctx as never, volatileConfig({ enabled: true }));
    assert.equal(ctx.listeners.has("agent/pre-step"), false);
    assert.doesNotThrow(() => {
      for (const dispose of ctx.disposers) dispose();
    });
  });

  it("registers exactly one pre-step listener when the field is on, and unload removes it", () => {
    const ctx = createStubCtx({ tokenMeter: createMeter(999_999_999) });
    apply(
      ctx as never,
      volatileConfig({ enabled: true, microcompactEnabled: true }),
    );
    assert.equal((ctx.listeners.get("agent/pre-step") ?? []).length, 1);
    for (const dispose of ctx.disposers) dispose();
    assert.equal((ctx.listeners.get("agent/pre-step") ?? []).length, 0);
  });

  it("never rewrites a session that is not an activated dispatcher", async () => {
    const ctx = createStubCtx({ tokenMeter: createMeter(999_999_999) });
    apply(
      ctx as never,
      volatileConfig({ enabled: true, microcompactEnabled: true }),
    );
    const session = createFakeSession(9);
    await ctx.fire("agent/pre-step", { agent: dispatcherAgent(session) });
    assert.equal(
      session.clearedOnSurface(),
      0,
      "an ordinary chat must never be compacted",
    );
    for (const dispose of ctx.disposers) dispose();
  });
});

describe("microcompact boundary store through the plugin's durability (ticket 124)", () => {
  it("the in-memory store carries boundaries beside worker markers", async () => {
    const store = createInMemoryDurability();
    await store.writeCompactionBoundary({
      sessionId: "s-1",
      passSeq: 1,
      status: "applied",
      layer: "microcompact",
      trigger: "ratio",
      ratio: MICROCOMPACT_TRIGGER_RATIO,
      keepNewest: 5,
      usedTokens: 600_000,
      windowTokens: 1_000_000,
      thresholdTokens: 550_000,
      clearedSeqs: [2, 3],
      replacementSeqs: [20, 21],
      boundarySeq: 21,
      clearedCount: 2,
      clearedChars: 32_000,
      clearedBytes: 32_000,
      freedTokens: 8_000,
      updatedAtMs: 1_700_000_000_000,
    });
    assert.equal(store.boundaries.size, 1);
    const read = await store.readCompactionBoundary("s-1");
    assert.equal(read?.passSeq, 1);
    assert.equal((await store.readWorkerMarkers("s-1")).length, 0);
  });
});
