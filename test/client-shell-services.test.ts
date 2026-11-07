/**
 * Client service posture (offline, S8).
 *
 * Pinned here:
 *
 * 1. the module's `inject` list carries only what the LIVE entries read
 *    (`slots`, `locale`) — already asserted with the strict host in
 *    `client-face-scaffold.test.ts`; here the focus is the complement;
 * 2. the dormant shell resolves its own faces at the mount point through the
 *    service-method boundary (`ctx.get`), so it works on a host-shaped
 *    context whose undeclared service PROPERTY reads throw;
 * 3. the mounted shell binds the sessions feed, retains the selected session
 *    (0.2.x shape), and releases it with the fiber;
 * 4. an absent sessions face degrades to an empty shell, never a throw.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apply,
  inject,
  mountShellPage,
  resolveShellService,
} from "../src/client/index.js";
import type {
  ClientContext,
  ClientSessionsLike,
} from "../src/client/context.js";
import type {
  ConversationWindowLike,
} from "../src/client/conversation-store.js";

const DORMANT_SERVICES = new Set([
  "sessions",
  "remote",
  "remote.commands",
  "conversation",
  "configForms",
]);

/**
 * A host-shaped client context: service PROPERTY reads outside the fake's own
 * locals throw exactly like the real context proxy, and `ctx.get(name)` is
 * the service-method boundary that resolves them. `effect` collects the
 * disposers so a test can unload the mount.
 *
 * With `supportInject`, the fake carries cordis's dependency watch: an
 * `inject(deps, callback)` registration runs as soon as every named service
 * exists (immediately when already present, or from `addService` later). The
 * callback receives the same context, whose `get` resolves the live service.
 */
function createHostShapeCtx(
  services: Record<string, unknown>,
  options?: { supportInject?: boolean },
): {
  ctx: ClientContext;
  dispose(): void;
  /** Materialize a service the watch may have been waiting for. */
  addService(name: string, value: unknown): void;
} {
  const effects: Array<() => void> = [];
  const injectRecords: Array<{
    deps: readonly string[];
    callback: (ctx: ClientContext) => unknown;
    active: boolean;
    dispose: (() => void) | undefined;
  }> = [];
  const base: Record<string, unknown> = {
    effect(execute: () => unknown) {
      const returned = execute();
      const disposer =
        typeof returned === "function" ? (returned as () => void) : () => {};
      effects.push(disposer);
      return disposer;
    },
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return (key: string) => key;
      },
    },
    slots: {
      inject() {
        return () => {};
      },
      register() {
        return () => {};
      },
    },
  };
  if (options?.supportInject === true) {
    base.inject = (
      deps: readonly string[],
      callback: (ctx: ClientContext) => unknown,
    ) => {
      const record = { deps, callback, active: false } as {
        deps: readonly string[];
        callback: (ctx: ClientContext) => unknown;
        active: boolean;
        dispose: (() => void) | undefined;
      };
      injectRecords.push(record);
      runInjections();
      return {
        dispose() {
          record.active = false;
          record.dispose?.();
          record.dispose = undefined;
        },
      };
    };
  }
  const ctx = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return (name: string) => services[name];
      }
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && DORMANT_SERVICES.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return undefined;
    },
  }) as unknown as ClientContext;
  /** Run every watched callback whose dependencies now all exist. */
  function runInjections(): void {
    for (const record of injectRecords) {
      if (record.active) continue;
      if (!record.deps.every((name) => services[name] !== undefined)) continue;
      record.active = true;
      const returned = record.callback(ctx);
      record.dispose =
        typeof returned === "function" ? (returned as () => void) : undefined;
    }
  }
  return {
    ctx,
    dispose() {
      for (const dispose of [...effects].reverse()) dispose();
      for (const record of [...injectRecords].reverse()) {
        record.active = false;
        record.dispose?.();
        record.dispose = undefined;
      }
    },
    addService(name, value) {
      services[name] = value;
      runInjections();
    },
  };
}

/** A window with one assistant text turn. */
function windowWith(text: string): ConversationWindowLike {
  return {
    entries: [
      {
        type: "event",
        event: {
          type: "assistant/message",
          seq: 1,
          time: 1,
          data: { message: { content: [{ type: "text", text }] } },
        },
      },
    ],
  };
}

describe("client services — live entries keep their declared faces", () => {
  it("the module inject is exactly slots + locale", () => {
    assert.deepEqual([...inject].sort(), ["locale", "slots"]);
    for (const name of DORMANT_SERVICES) {
      assert.equal(
        inject.includes(name),
        false,
        `${name} must not gate the live entries`,
      );
    }
  });

  it("apply never touches a dormant service (host-shaped ctx)", () => {
    const host = createHostShapeCtx({});
    assert.doesNotThrow(() => apply(host.ctx));
    host.dispose();
  });
});

describe("shell mount — resolves its own services at the mount point", () => {
  function createSessions(calls: {
    retained: string[];
    released: number;
  }): ClientSessionsLike {
    const window = windowWith("from the window");
    const eventSource = {
      getSnapshot: () => window,
      subscribe: () => () => {},
    };
    return {
      list: {
        getSnapshot: () => ({
          ids: ["s-1"],
          byId: { "s-1": { id: "s-1", displayTitle: "Dispatcher" } },
        }),
        subscribe: () => () => {},
      },
      scope: () => undefined,
      retain(target, options) {
        calls.retained.push(`${target}:${options.source}`);
        return {
          sessionId: target,
          binding: { eventSource },
          release() {
            calls.released += 1;
          },
        };
      },
    };
  }

  it("binds the feed through ctx.get and retains the selected session", () => {
    const calls = { retained: [] as string[], released: 0 };
    const host = createHostShapeCtx({
      sessions: createSessions(calls),
      conversation: { input: { for: () => ({ setDraft() {} }) } },
      remote: { commands: { execute: async () => ({}) } },
    });

    const mount = mountShellPage(host.ctx);
    assert.equal(
      mount.store.getBox().state.rows.get("s-1")?.title,
      "Dispatcher",
      "the sessions feed bound through ctx.get",
    );

    mount.store.select("s-1");
    assert.deepEqual(calls.retained, ["s-1:multitask-dispatcher-shell"]);
    const state = mount.conversation.stateFor("s-1");
    assert.ok(state.kind === "ready");
    assert.equal(state.transcript.items[0]?.kind, "assistant");

    host.dispose();
    assert.equal(calls.released, 1, "the mount's fiber releases the reference");
  });

  it("an absent sessions face leaves an empty shell, never a throw", () => {
    const host = createHostShapeCtx({
      conversation: { input: { for: () => ({ setDraft() {} }) } },
    });
    assert.doesNotThrow(() => {
      const mount = mountShellPage(host.ctx);
      assert.equal(mount.store.getBox().state.order.length, 0);
    });
    host.dispose();
  });

  it("binds a sessions service that appears AFTER the mount (ctx.inject)", () => {
    const host = createHostShapeCtx({}, { supportInject: true });
    const mount = mountShellPage(host.ctx);
    assert.equal(mount.store.getBox().state.order.length, 0);

    const calls = { retained: [] as string[], released: 0 };
    host.addService("sessions", createSessions(calls));

    // The dependency watch bound the feed when the service materialized —
    // the mount no longer captures its absence forever.
    assert.equal(
      mount.store.getBox().state.rows.get("s-1")?.title,
      "Dispatcher",
    );

    mount.store.select("s-1");
    assert.deepEqual(calls.retained, ["s-1:multitask-dispatcher-shell"]);
    const state = mount.conversation.stateFor("s-1");
    assert.ok(state.kind === "ready");
    assert.equal(state.transcript.items[0]?.kind, "assistant");

    host.dispose();
    assert.equal(calls.released, 1, "the watch's disposer released the reference");
  });

  it("keeps today's behavior when sessions is already present under ctx.inject", () => {
    const calls = { retained: [] as string[], released: 0 };
    const host = createHostShapeCtx(
      { sessions: createSessions(calls) },
      { supportInject: true },
    );
    const mount = mountShellPage(host.ctx);
    assert.equal(
      mount.store.getBox().state.rows.get("s-1")?.title,
      "Dispatcher",
      "the watch ran immediately for an available service",
    );
    host.dispose();
  });
});

describe("resolveShellService — boundary first, guarded property fallback", () => {
  it("prefers ctx.get(name) and contains a throwing boundary", () => {
    const value = { marker: "nested" };
    const ctx = {
      get(name: string) {
        if (name === "remote.commands") return value;
        throw new Error("not here");
      },
      remote: undefined,
    } as unknown as ClientContext;
    assert.equal(
      resolveShellService<{ marker: string }>(ctx, "remote.commands"),
      value,
    );
  });

  it("falls back to a plain property for a structural fake", () => {
    const sessions = {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      scope: () => undefined,
    } as unknown as ClientSessionsLike;
    const ctx = { sessions } as unknown as ClientContext;
    assert.equal(resolveShellService(ctx, "sessions"), sessions);
  });

  it("an undeclared property read that throws is an absent face", () => {
    const ctx = {
      get() {
        throw new Error("no boundary");
      },
      get sessions(): never {
        throw new Error('cannot get property "sessions" without inject');
      },
    } as unknown as ClientContext;
    assert.equal(resolveShellService(ctx, "sessions"), undefined);
  });
});
