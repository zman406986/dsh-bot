/**
 * Ticket 23 — access-request prompt relay through the host prompt seams
 * (design-16 §4.4).
 *
 * Offline only (S8): a fake `ctx.userQuestions` seam shaped after the
 * shipped `dsh-user-questions` contract, fake AdapterContext seams driving
 * the real plugin apply(), the real CordisDshHost, and the real Multitask
 * core. No network, no LLM, no running dsh. The relay itself (timeout,
 * decisions, delivery) is covered by test/access-relay.test.ts and is
 * untouched here — these tests cover the prompt as an additional answer
 * surface onto that relay.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apply } from "../src/plugin.js";
import {
  ACCESS_PROMPT_ALLOW,
  ACCESS_PROMPT_ALWAYS_ALLOW,
  ACCESS_PROMPT_DENY,
  ACCESS_PROMPT_DENY_DETAIL,
  APPROVAL_DETAIL_CLAMP_CHARS,
  APPROVAL_EXPIRED_COPY,
  APPROVAL_LOCATION_LOCAL,
  APPROVAL_SECRET_STORED_COPY,
  DISPATCHER_START_COMMAND,
  accessPromptQuestion,
  accessPromptQuestionId,
  clampApprovalDetail,
  createAccessPromptPump,
  describeAccessAction,
  parseAccessPromptAnswer,
  type AccessPromptAnswerLike,
  type AccessPromptRequestLike,
  type AdapterContext,
  type AgentLike,
  type CommandDefinitionLike,
  type CommandResultLike,
  type UserQuestionsLike,
} from "../src/adapter/index.js";
import type {
  AccessDecision,
  AccessTicket,
} from "../src/core/access-types.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface CapturedAsk {
  readonly request: AccessPromptRequestLike;
  resolve(answer: AccessPromptAnswerLike): void;
  reject(error: unknown): void;
}

/** The (already-built) question id of a captured ask — asserted present. */
function questionIdOf(ask: CapturedAsk | undefined): string {
  assert.ok(ask !== undefined, "no prompt was captured for this ask");
  const id = ask.request.questions[0]?.id;
  assert.ok(id !== undefined, "captured ask carries no question id");
  return id;
}

/**
 * Fake user-questions seam: records every ask and hands the test the
 * resolver/rejecter. Honors the shipped abort contract (an aborted signal
 * rejects the pending ask).
 */
function createFakeUserQuestions(): UserQuestionsLike & {
  asks: CapturedAsk[];
} {
  const asks: CapturedAsk[] = [];
  return {
    asks,
    ask(request: AccessPromptRequestLike): Promise<AccessPromptAnswerLike> {
      return new Promise<AccessPromptAnswerLike>((resolve, reject) => {
        asks.push({ request, resolve, reject });
        request.signal?.addEventListener("abort", () => {
          reject(new Error("prompt aborted"));
        });
      });
    },
  };
}

/** A seam whose ask() always fails — the integration fallback case. */
function createFailingUserQuestions(): UserQuestionsLike {
  return {
    ask(): Promise<AccessPromptAnswerLike> {
      return Promise.reject(new Error("no answerer composed"));
    },
  };
}

/** Answer payload selecting Allow for the given (already-built) question id. */
function allowAnswer(questionId: string): AccessPromptAnswerLike {
  return {
    answers: [{ id: questionId, selected: [ACCESS_PROMPT_ALLOW] }],
  };
}

/** Answer payload selecting Deny for the given (already-built) question id. */
function denyAnswer(questionId: string): AccessPromptAnswerLike {
  return {
    answers: [{ id: questionId, selected: [ACCESS_PROMPT_DENY] }],
  };
}

function ticket(overrides: Partial<AccessTicket> = {}): AccessTicket {
  return {
    workerId: "w-1",
    requestId: "req-1",
    body: {
      class: "tool",
      target: "write_file",
      reason: "needs to write outside the workspace",
    },
    createdAtMs: 1_000,
    parentSessionId: "s-1",
    status: "pending",
    ...overrides,
  };
}

describe("access prompt — payload copy (design-16 §6 + ticket 30)", () => {
  it("tool ask uses the exact design template with the three ticket-30 options", () => {
    const question = accessPromptQuestion(ticket());
    assert.equal(
      question.question,
      'Worker w-1 needs approval to use the tool "write_file".',
    );
    assert.equal(question.id, "access:req-1");
    assert.equal(
      question.detail,
      `needs to write outside the workspace\n\n${APPROVAL_LOCATION_LOCAL}`,
    );
    assert.deepEqual(question.options, [
      { label: ACCESS_PROMPT_ALLOW },
      { label: ACCESS_PROMPT_ALWAYS_ALLOW },
      { label: ACCESS_PROMPT_DENY },
    ]);
  });

  it("every prompt detail carries the constant local location line", () => {
    const question = accessPromptQuestion(
      ticket({ body: { class: "tool", target: "t", reason: "" } }),
    );
    assert.equal(question.detail, APPROVAL_LOCATION_LOCAL);
  });

  it("credential ask names the credential — never a value (ticket 13)", () => {
    const question = accessPromptQuestion(
      ticket({
        requestId: "req-cred",
        body: {
          class: "credential",
          target: "API_TOKEN",
          reason: "need the API token",
          credentialName: "API_TOKEN",
        },
      }),
    );
    assert.equal(
      question.question,
      'Worker w-1 needs approval to use the credential "API_TOKEN".',
    );
    // No value field anywhere on the payload; names only.
    const encoded = JSON.stringify(question);
    assert.ok(encoded.includes("API_TOKEN"));
    assert.ok(!encoded.includes("sk-"));
    const parsed: unknown = JSON.parse(encoded);
    assert.ok(typeof parsed === "object" && parsed !== null);
    assert.ok(!("value" in parsed));
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      assert.ok(!entry || typeof entry !== "object" || !("value" in entry));
    }
  });

  it("network, filesystem, and other classes phrase the action", () => {
    assert.equal(
      describeAccessAction({ class: "network", target: "example.com", reason: "r" }),
      'reach the network target "example.com"',
    );
    assert.equal(
      describeAccessAction({ class: "filesystem", target: "/etc/hosts", reason: "r" }),
      'access the path "/etc/hosts"',
    );
    assert.equal(
      describeAccessAction({ class: "other", target: "mystery", reason: "r" }),
      'perform "mystery"',
    );
    assert.equal(
      describeAccessAction({ class: "other", target: "", reason: "r" }),
      'perform "(unnamed)"',
    );
  });
});

describe("access prompt — clamped detail (ticket 30)", () => {
  it("short reason passes through unchanged", () => {
    assert.equal(clampApprovalDetail("short reason"), "short reason");
    assert.equal(clampApprovalDetail(""), "");
  });

  it("long reason hard-cuts at the limit with the omitted count", () => {
    const clamped = clampApprovalDetail("x".repeat(300));
    assert.equal(
      clamped,
      `${"x".repeat(APPROVAL_DETAIL_CLAMP_CHARS)}… [+${300 - APPROVAL_DETAIL_CLAMP_CHARS} more characters]`,
    );
  });

  it("exact-limit reason gets no marker", () => {
    const exact = "y".repeat(APPROVAL_DETAIL_CLAMP_CHARS);
    assert.equal(clampApprovalDetail(exact), exact);
  });

  it("the prompt clamps the reason but never truncates inside the target name", () => {
    const target = "T".repeat(500);
    const question = accessPromptQuestion(
      ticket({ body: { class: "tool", target, reason: "z".repeat(400) } }),
    );
    assert.ok(question.question.includes(target));
    assert.ok(!question.question.includes("…"));
    // The clamped reason does appear, with the omission marker.
    assert.ok(question.detail?.includes("more characters]"));
    assert.ok((question.detail ?? "").length < 400);
  });
});

describe("access prompt — answer parsing", () => {
  const id = accessPromptQuestionId("req-1");

  it("maps explicit Allow and Deny selections", () => {
    assert.equal(parseAccessPromptAnswer(allowAnswer(id), id), "allow");
    assert.equal(parseAccessPromptAnswer(denyAnswer(id), id), "deny");
  });

  it("maps the session always-allow selection (ticket 30)", () => {
    assert.equal(
      parseAccessPromptAnswer(
        { answers: [{ id, selected: [ACCESS_PROMPT_ALWAYS_ALLOW] }] },
        id,
      ),
      "always-allow",
    );
  });

  it("deny wins over any allow shape; always-allow wins over plain allow", () => {
    const parse = (selected: string[]) =>
      parseAccessPromptAnswer({ answers: [{ id, selected }] }, id);
    assert.equal(parse([ACCESS_PROMPT_ALLOW, ACCESS_PROMPT_DENY]), "deny");
    assert.equal(
      parse([ACCESS_PROMPT_ALWAYS_ALLOW, ACCESS_PROMPT_DENY]),
      "deny",
    );
    assert.equal(
      parse([ACCESS_PROMPT_ALLOW, ACCESS_PROMPT_ALWAYS_ALLOW]),
      "always-allow",
    );
  });

  it("never invents a decision from a missing or foreign answer", () => {
    assert.equal(parseAccessPromptAnswer(undefined, id), null);
    assert.equal(parseAccessPromptAnswer({ answers: [] }, id), null);
    // Wrong question id.
    assert.equal(
      parseAccessPromptAnswer(
        { answers: [{ id: "access:other", selected: [ACCESS_PROMPT_ALLOW] }] },
        id,
      ),
      null,
    );
    // Custom text without a selection.
    assert.equal(
      parseAccessPromptAnswer({ answers: [{ id, selected: [], custom: "maybe" }] }, id),
      null,
    );
    // Unknown label.
    assert.equal(
      parseAccessPromptAnswer({ answers: [{ id, selected: ["Wait"] }] }, id),
      null,
    );
  });

  it("fails closed to deny when a UI somehow returns both options", () => {
    assert.equal(
      parseAccessPromptAnswer(
        { answers: [{ id, selected: [ACCESS_PROMPT_ALLOW, ACCESS_PROMPT_DENY] }] },
        id,
      ),
      "deny",
    );
  });
});

describe("access prompt pump — surfacing and routing", () => {
  interface Harness {
    pump: ReturnType<typeof createAccessPromptPump>;
    seam: ReturnType<typeof createFakeUserQuestions>;
    pending: AccessTicket[];
    resolved: Array<{ workerId: string; decision: AccessDecision }>;
    requeued: AccessTicket[];
    alwaysAllowed: AccessTicket[];
    expired: AccessTicket[];
    secretStored: AccessTicket[];
    setActive(active: boolean): void;
  }

  function createHarness(withSeam = true): Harness {
    const seam = createFakeUserQuestions();
    const pending: AccessTicket[] = [];
    const resolved: Array<{ workerId: string; decision: AccessDecision }> = [];
    const requeued: AccessTicket[] = [];
    const alwaysAllowed: AccessTicket[] = [];
    const expired: AccessTicket[] = [];
    const secretStored: AccessTicket[] = [];
    let active = true;
    const pump = createAccessPromptPump({
      ...(withSeam ? { userQuestions: seam } : {}),
      isActive: () => active,
      listPending: () => [...pending],
      resolve: (workerId, decision) => {
        resolved.push({ workerId, decision });
        return true;
      },
      alwaysAllow: (t) => alwaysAllowed.push(t),
      notifyExpired: (t) => expired.push(t),
      notifySecretStored: (t) => secretStored.push(t),
      getAgent: () => "agent-1",
      requeueConversational: (t) => requeued.push(t),
    });
    return {
      pump,
      seam,
      pending,
      resolved,
      requeued,
      alwaysAllowed,
      expired,
      secretStored,
      setActive(value: boolean) {
        active = value;
      },
    };
  }

  it("emits one structured ask per pending ticket, scoped to the agent", () => {
    const h = createHarness();
    h.pending.push(
      ticket(),
      ticket({ workerId: "w-2", requestId: "req-2" }),
    );
    h.pump.sync();
    assert.equal(h.seam.asks.length, 2);
    const first = h.seam.asks[0];
    assert.ok(first);
    assert.equal(first.request.questions.length, 1);
    assert.equal(first.request.questions[0]?.id, "access:req-1");
    assert.equal(first.request.agent, "agent-1");
    assert.ok(first.request.signal instanceof AbortSignal);
    assert.ok(h.pump.isPrompted("req-1"));
    assert.ok(h.pump.isPrompted("req-2"));
  });

  it("routes an Allow answer into the core resolve entry", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.seam.asks[0]?.resolve(allowAnswer(questionIdOf(h.seam.asks[0])));
    await tick();
    assert.deepEqual(h.resolved, [{ workerId: "w-1", decision: { kind: "allow" } }]);
  });

  it("routes a Deny answer as an explicit user-denied decision", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.seam.asks[0]?.resolve(denyAnswer(questionIdOf(h.seam.asks[0])));
    await tick();
    assert.deepEqual(h.resolved, [
      {
        workerId: "w-1",
        decision: {
          kind: "deny",
          reason: "user-denied",
          detail: ACCESS_PROMPT_DENY_DETAIL,
        },
      },
    ]);
  });

  it("Always allow inserts the session row, then routes the same allow", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    const ask = h.seam.asks[0];
    assert.ok(ask);
    ask.resolve({
      answers: [
        { id: questionIdOf(ask), selected: [ACCESS_PROMPT_ALWAYS_ALLOW] },
      ],
    });
    await tick();
    assert.deepEqual(h.alwaysAllowed, [ticket()]);
    assert.deepEqual(h.resolved, [
      { workerId: "w-1", decision: { kind: "allow" } },
    ]);
  });

  it("an answer for a ticket that already left the relay is expired: copy only, nothing resolved", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    // The relay resolved the ticket elsewhere (timeout deny / clear) but the
    // pump has not pruned its prompt yet — the answer beat the next sync().
    h.pending.length = 0;
    const ask = h.seam.asks[0];
    assert.ok(ask);
    ask.resolve(allowAnswer(questionIdOf(ask)));
    await tick();
    assert.equal(h.resolved.length, 0);
    assert.deepEqual(h.expired, [ticket()]);
    assert.equal(h.alwaysAllowed.length, 0);
  });

  it("an expired Always-allow answer inserts no session row", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.pending.length = 0;
    const ask = h.seam.asks[0];
    assert.ok(ask);
    ask.resolve({
      answers: [
        { id: questionIdOf(ask), selected: [ACCESS_PROMPT_ALWAYS_ALLOW] },
      ],
    });
    await tick();
    assert.equal(h.alwaysAllowed.length, 0);
    assert.deepEqual(h.expired, [ticket()]);
  });

  it("a dismissed answer on a gone ticket stays silent (no invented expiry)", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.pending.length = 0;
    h.seam.asks[0]?.resolve({ answers: [] });
    await tick();
    assert.equal(h.resolved.length, 0);
    assert.equal(h.expired.length, 0);
  });

  it("an allowed credential ask surfaces the stored-secret notice", async () => {
    const h = createHarness();
    const credentialTicket = ticket({
      body: {
        class: "credential",
        target: "API_TOKEN",
        reason: "need the API token",
        credentialName: "API_TOKEN",
      },
    });
    h.pending.push(credentialTicket);
    h.pump.sync();
    h.seam.asks[0]?.resolve(allowAnswer(questionIdOf(h.seam.asks[0])));
    await tick();
    assert.deepEqual(h.secretStored, [credentialTicket]);
  });

  it("an allowed tool ask surfaces no stored-secret notice", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.seam.asks[0]?.resolve(allowAnswer(questionIdOf(h.seam.asks[0])));
    await tick();
    assert.deepEqual(h.resolved, [
      { workerId: "w-1", decision: { kind: "allow" } },
    ]);
    assert.equal(h.secretStored.length, 0);
  });

  it("resolves nothing for a dismissed or foreign answer (timeout decides)", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.seam.asks[0]?.resolve({ answers: [] });
    await tick();
    assert.equal(h.resolved.length, 0);
    // The ask ended without a decision — no longer held.
    assert.equal(h.pump.isPrompted("req-1"), false);
  });

  it("dedupes: sync while a prompt is outstanding never re-asks", () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.pump.sync();
    h.pump.sync();
    assert.equal(h.seam.asks.length, 1);
    assert.equal(h.pump.suppressesConversational("req-1"), true);
  });

  it("prunes state (and aborts the dead seam request) once the ticket is gone", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    // The relay resolved the ticket elsewhere (timeout / clear / settle).
    h.pending.length = 0;
    h.pump.sync();
    assert.equal(h.pump.isPrompted("req-1"), false);
    await tick();
    // The outstanding seam request was aborted — no decision was routed.
    assert.equal(h.resolved.length, 0);
  });

  it("a stale prompt whose ticket was pruned is inert: answering routes nothing", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    // The relay resolved the ticket elsewhere (timeout / clear / settle):
    // the next sync prunes the prompt and aborts its seam request.
    h.pending.length = 0;
    h.pump.sync();
    await tick();
    assert.equal(h.resolved.length, 0);

    // The aborted ask can no longer answer — exactly one dead prompt.
    h.seam.asks[0]?.resolve(allowAnswer(questionIdOf(h.seam.asks[0])));
    await tick();
    assert.equal(h.resolved.length, 0);
    assert.equal(h.seam.asks.length, 1);
  });

  it("a seam failure releases the ask: conversational requeue, no re-prompt", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.seam.asks[0]?.reject(new Error("no answerer composed"));
    await tick();
    assert.equal(h.resolved.length, 0);
    // Released: conversational surface owns it again.
    assert.equal(h.pump.suppressesConversational("req-1"), false);
    assert.deepEqual(h.requeued, [ticket()]);
    // And it is never re-prompted.
    h.pump.sync();
    assert.equal(h.seam.asks.length, 1);
  });

  it("reset abandons outstanding prompts without touching tickets", async () => {
    const h = createHarness();
    h.pending.push(ticket());
    h.pump.sync();
    h.pump.reset();
    await tick();
    assert.equal(h.pump.isPrompted("req-1"), false);
    assert.equal(h.resolved.length, 0);
    assert.equal(h.requeued.length, 0);
  });

  it("is inert without a seam and while dormant", () => {
    const h = createHarness(false);
    h.pending.push(ticket());
    h.pump.sync();
    assert.equal(h.pump.isPrompted("req-1"), false);
    assert.equal(h.pump.suppressesConversational("req-1"), false);

    const dormant = createHarness();
    dormant.pending.push(ticket());
    dormant.setActive(false);
    dormant.pump.sync();
    assert.equal(dormant.seam.asks.length, 0);
    assert.equal(dormant.pump.suppressesConversational("req-1"), false);
  });
});

// --- Plugin integration over the real host seams (offline) -----------------

function createAgent(id: string, opts?: { topLevel?: boolean }): AgentLike {
  const topLevel = opts?.topLevel ?? true;
  return {
    session: {
      id,
      header: topLevel
        ? { parentSession: null, delegationDepth: 0 }
        : { parentSession: "parent-x", delegationDepth: 1 },
    },
    followup() {},
    inject() {},
  };
}

function createFullCtx(seam: UserQuestionsLike | undefined) {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const commands = new Map<string, CommandDefinitionLike>();
  const tools = new Map<
    string,
    { execute: (args: unknown, exec?: unknown) => Promise<unknown> }
  >();
  const disposers: Array<() => void> = [];
  const sentMessages: Array<{ targetId: unknown; text: string }> = [];
  const wakeFollowups: string[] = [];
  let nextChild = 1;

  const fire = (name: string, payload: unknown) => {
    for (const cb of [...(listeners.get(name) ?? [])]) {
      cb(payload as never);
    }
  };

  const dispatcherAgent: AgentLike = {
    session: { id: "s-1", header: { parentSession: null, delegationDepth: 0 } },
    followup(message: unknown) {
      const content = (message as { content?: Array<{ text?: string }> })
        .content;
      wakeFollowups.push((content ?? []).map((b) => b.text ?? "").join(""));
    },
    inject() {},
  };

  const ctx = {
    effect(dispose: () => void) {
      disposers.push(dispose);
    },
    inject() {},
    on(name: string, cb: (payload: never) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((c) => c !== cb),
        );
      };
    },
    commands: {
      register(definition: CommandDefinitionLike) {
        commands.set(definition.name, definition);
        return () => {
          commands.delete(definition.name);
        };
      },
    },
    tools: {
      schemas: () => [...tools.keys()].map((name) => ({ name })),
      register(definition: {
        name: string;
        execute: (args: unknown, exec?: unknown) => Promise<unknown>;
      }) {
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    },
    subagents: {
      async startContinuable() {
        const childId = `child-${nextChild++}`;
        return { childId, messageId: `msg-${childId}` };
      },
      interrupt() {},
      async sendMessage(
        _sender: unknown,
        targetId: unknown,
        content: Array<{ text?: string }>,
      ) {
        sentMessages.push({
          targetId,
          text: content.map((block) => block.text ?? "").join(""),
        });
        return "msg-stub";
      },
    },
    agents: { get: (id: unknown) => (String(id) === "s-1" ? dispatcherAgent : undefined) },
    jobs: { list: () => [] },
    storageDomain: {
      async open() {
        return {
          table() {
            const t = new Map<string, unknown>();
            return {
              get: (key: string) => t.get(key) as never,
              entries: () => t.entries() as never,
              async put(key: string, value: unknown) {
                t.set(key, value);
              },
              async delete(key: string) {
                return t.delete(key);
              },
            };
          },
          async close() {},
          name: "stub",
        };
      },
    },
    ...(seam !== undefined ? { userQuestions: seam } : {}),
    // Test surface
    fire,
    disposers,
    tool: (name: string) => tools.get(name),
    runCommand: async (invocation: {
      commandId: string;
      agent?: AgentLike;
    }): Promise<CommandResultLike> => {
      const command = commands.get(invocation.commandId);
      if (command === undefined) {
        throw new Error(`command not registered: ${invocation.commandId}`);
      }
      return command.handler(invocation as never) as CommandResultLike;
    },
    sentMessages,
    wakeFollowups,
  };
  return ctx as typeof ctx & AdapterContext;
}

async function activateAndSpawn(
  ctx: ReturnType<typeof createFullCtx>,
): Promise<{ workerId: string; agent: AgentLike }> {
  const agent = createAgent("s-1");
  const activation = await ctx.runCommand({
    commandId: DISPATCHER_START_COMMAND,
    agent,
  });
  assert.equal(activation.kind, "success");
  const spawn = ctx.tool("spawn_worker");
  assert.ok(spawn);
  const value = (await spawn.execute(
    { stream_key: "k", title: "Write docs", prompt: "P" },
    { agent: { session: { id: "s-1" } } },
  )) as { ok: boolean; worker_id: string };
  assert.equal(value.ok, true);
  const workerId = value.worker_id;
  ctx.fire("agent/status", {
    agent: { session: { id: workerId } },
    status: "running",
  });
  return { workerId, agent };
}

async function requestAccess(
  ctx: ReturnType<typeof createFullCtx>,
  workerId: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  const tool = ctx.tool("request_access");
  assert.ok(tool, "request_access must be registered after activation");
  const value = (await tool.execute(
    {
      class: "tool",
      target: "write_file",
      reason: "need to write outside the workspace",
      ...args,
    },
    { agent: { session: { id: workerId } } },
  )) as { ok: boolean };
  assert.equal(value.ok, true);
}

describe("plugin apply — access prompts over the host seam", () => {
  it("activated session: pending ask emits one prompt with exact copy", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId } = await activateAndSpawn(ctx);

    await requestAccess(ctx, workerId);

    assert.equal(seam.asks.length, 1);
    const ask = seam.asks[0];
    assert.ok(ask);
    assert.equal(ask.request.questions.length, 1);
    assert.equal(
      ask.request.questions[0]?.question,
      `Worker ${workerId} needs approval to use the tool "write_file".`,
    );
    assert.deepEqual(ask.request.questions[0]?.options, [
      { label: ACCESS_PROMPT_ALLOW },
      { label: ACCESS_PROMPT_ALWAYS_ALLOW },
      { label: ACCESS_PROMPT_DENY },
    ]);
    // Ticket 30: detail carries the reason plus the constant location line.
    assert.ok(
      ask.request.questions[0]?.detail?.includes(
        "need to write outside the workspace",
      ),
    );
    assert.ok(
      ask.request.questions[0]?.detail?.includes(APPROVAL_LOCATION_LOCAL),
    );
    // The ask is scoped to the activated dispatcher chat.
    const agent = ask.request.agent as AgentLike | undefined;
    assert.equal(String(agent?.session?.id), "s-1");

    // Resolve the prompt so the relay's armed default timeout is cancelled
    // (no stray timer after the test).
    ask.resolve(allowAnswer(questionIdOf(ask)));
    await tick();
    await tick();
  });

  it("Allow answer routes through the unchanged relay to the worker", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);

    seam.asks[0]?.resolve(allowAnswer(questionIdOf(seam.asks[0])));
    await tick();
    await tick();

    assert.equal(ctx.sentMessages.length, 1);
    const sent = ctx.sentMessages[0];
    assert.ok(sent);
    assert.equal(sent.targetId, workerId);
    assert.ok(sent.text.includes("[Parent: access allowed]"));
    assert.ok(sent.text.includes("write_file"));
  });

  it("Deny answer delivers the honest deny wrapper", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);

    seam.asks[0]?.resolve(denyAnswer(questionIdOf(seam.asks[0])));
    await tick();
    await tick();

    assert.equal(ctx.sentMessages.length, 1);
    const sent = ctx.sentMessages[0];
    assert.ok(sent);
    assert.ok(sent.text.includes("[Parent: access denied]"));
    assert.ok(sent.text.includes("denied by the user"));
    assert.ok(sent.text.includes("Do not retry"));
  });

  it("no answer: the relay timeout still denies; a late answer is a no-op", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true, accessRequestTimeoutMs: 25 });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    assert.equal(ctx.sentMessages.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ctx.sentMessages.length, 1);
    const sent = ctx.sentMessages[0];
    assert.ok(sent);
    assert.ok(
      sent.text.includes("timed out") || sent.text.includes("timeout"),
    );

    // The user answers the stale prompt afterwards: the pump forwards, the
    // core relay no-ops it — never a second delivery.
    seam.asks[0]?.resolve(allowAnswer(questionIdOf(seam.asks[0])));
    await tick();
    await tick();
    assert.equal(ctx.sentMessages.length, 1);
  });

  it("Always allow records a session row: the next matching ask auto-answers unprompted", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    assert.equal(seam.asks.length, 1);

    const ask = seam.asks[0];
    assert.ok(ask);
    ask.resolve({
      answers: [
        { id: questionIdOf(ask), selected: [ACCESS_PROMPT_ALWAYS_ALLOW] },
      ],
    });
    await tick();
    await tick();
    // This ask's own allow was delivered.
    assert.equal(ctx.sentMessages.length, 1);

    // A later ask with the same class+target hits the session row: delivered
    // immediately, never prompted (shipped policy no-op path).
    await requestAccess(ctx, workerId);
    assert.equal(seam.asks.length, 1);
    assert.equal(ctx.sentMessages.length, 2);
    assert.ok(ctx.sentMessages[1]?.text.includes("[Parent: access allowed]"));
  });

  it("session always-allow rows clear on deactivation: a new session prompts again", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId, agent } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    const ask = seam.asks[0];
    assert.ok(ask);
    ask.resolve({
      answers: [
        { id: questionIdOf(ask), selected: [ACCESS_PROMPT_ALWAYS_ALLOW] },
      ],
    });
    await tick();
    await tick();

    // Session ends and a new session activates in the same chat.
    ctx.fire("agent/disposed", { agent });
    await tick();
    const reactivation = await ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(reactivation.kind, "success");
    await tick();

    // The session row is gone: the same ask must prompt again. A leaked row
    // would auto-answer it with no new prompt.
    await requestAccess(ctx, workerId);
    assert.equal(seam.asks.length, 2);
    const second = seam.asks[1];
    assert.ok(second);
    // Deny to cancel the relay's armed default timeout (test hygiene).
    second.resolve(denyAnswer(questionIdOf(second)));
    await tick();
    await tick();
    // One allow delivery (the first, remembered ask) + one deny delivery.
    assert.equal(ctx.sentMessages.length, 2);
  });

  it("a late answer after the timeout surfaces honest expired copy, resolving nothing", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true, accessRequestTimeoutMs: 25 });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    assert.equal(ctx.sentMessages.length, 0);

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ctx.sentMessages.length, 1); // the ADR-0008 timeout deny

    // The user answers the stale prompt: the next wake carries the expired
    // copy and no second decision is delivered.
    const ask = seam.asks[0];
    assert.ok(ask);
    ask.resolve(allowAnswer(questionIdOf(ask)));
    await tick();
    await tick();
    assert.equal(ctx.sentMessages.length, 1);
    assert.ok(
      ctx.wakeFollowups.some((text) => text.includes(APPROVAL_EXPIRED_COPY)),
    );
  });

  it("an allowed credential ask reports the stored-secret reassurance", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId, {
      class: "credential",
      target: "API_TOKEN",
      reason: "need the API token",
      credentialName: "API_TOKEN",
    });
    assert.equal(seam.asks.length, 1);
    // Names only — never a value (ticket 13 invariant on the prompt payload).
    const ask = seam.asks[0];
    assert.ok(ask);
    assert.ok(JSON.stringify(ask.request).includes("API_TOKEN"));
    ask.resolve(allowAnswer(questionIdOf(ask)));
    await tick();
    await tick();

    // The worker got the allow; the user-facing post-decision notice carries
    // the names-never-values reassurance.
    assert.equal(ctx.sentMessages.length, 1);
    assert.ok(
      ctx.wakeFollowups.some((text) =>
        text.includes(APPROVAL_SECRET_STORED_COPY),
      ),
    );
  });

  it("dedupe: a prompted ask is not also rendered conversationally", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    await tick();

    // The prompt owns the ask — the conversational wake carries no ask copy.
    const rendered = ctx.wakeFollowups.join("\n");
    assert.ok(!rendered.includes("Access requests"));
    assert.ok(!rendered.includes("write_file"));

    // Resolve the prompt so the relay's armed default timeout is cancelled.
    const ask = seam.asks[0];
    assert.ok(ask);
    ask.resolve(allowAnswer(questionIdOf(ask)));
    await tick();
    await tick();
  });

  it("seam failure degrades safely: conversational fallback, timeout still denies", async () => {
    const ctx = createFullCtx(createFailingUserQuestions());
    apply(ctx, { enabled: true, accessRequestTimeoutMs: 25 });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    await tick();
    await tick();

    // Released ask falls back to the shipped conversational relay.
    assert.ok(
      ctx.wakeFollowups.some((text) => text.includes("Access requests")),
    );
    assert.ok(ctx.wakeFollowups.some((text) => text.includes("write_file")));

    // And the relay timeout still bounds it — no hang, no crash.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ctx.sentMessages.length, 1);
    assert.ok(ctx.sentMessages[0]?.text.includes("timed out"));
  });

  it("no seam configured: conversational relay stays the ask surface", async () => {
    const ctx = createFullCtx(undefined);
    apply(ctx, { enabled: true, accessRequestTimeoutMs: 25 });
    const { workerId } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    await tick();

    // Never suppressed when the prompt seam is absent (ticket 23 fallback).
    assert.ok(
      ctx.wakeFollowups.some((text) => text.includes("Access requests")),
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ctx.sentMessages.length, 1);
    assert.ok(ctx.sentMessages[0]?.text.includes("timed out"));
  });

  it("deactivation abandons the outstanding prompt; the ticket clears on settle", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true, accessRequestTimeoutMs: 40 });
    const { workerId, agent } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    assert.equal(seam.asks.length, 1);

    // Session ends (agent/disposed) → the pump abandons the prompt.
    ctx.fire("agent/disposed", { agent });
    await tick();
    assert.equal(ctx.sentMessages.length, 0);

    // The worker keeps running across deactivation (design-16 §3.6) and its
    // settle drops the ticket — no delivery, no crash, no lingering timer.
    ctx.fire("subagent/end", {
      id: workerId,
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "done" }],
    });
    await tick();
    assert.equal(ctx.sentMessages.length, 0);
  });

  it("re-activation re-presents a still-pending ask as a fresh prompt", async () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true, accessRequestTimeoutMs: 5_000 });
    const { workerId, agent } = await activateAndSpawn(ctx);
    await requestAccess(ctx, workerId);
    assert.equal(seam.asks.length, 1);

    ctx.fire("agent/disposed", { agent });
    await tick();

    const reactivation = await ctx.runCommand({
      commandId: DISPATCHER_START_COMMAND,
      agent,
    });
    assert.equal(reactivation.kind, "success");
    await tick();

    assert.equal(seam.asks.length, 2);
    const second = seam.asks[1];
    assert.ok(second);
    assert.equal(
      second.request.questions[0]?.id,
      seam.asks[0]?.request.questions[0]?.id,
    );

    // Answer the fresh prompt so the relay ticket resolves and its armed
    // timeout is cancelled (no stray timer after the test).
    second.resolve(allowAnswer(questionIdOf(second)));
    await tick();
    await tick();
    assert.equal(ctx.sentMessages.length, 1);
  });

  it("dormant plugin: no request_access tool, no prompts possible", () => {
    const seam = createFakeUserQuestions();
    const ctx = createFullCtx(seam);
    apply(ctx, { enabled: true });
    // Deferred to activation (ticket 19): the dormant tool surface is stock.
    const tool = ctx.tool("request_access");
    assert.equal(tool, undefined);
    assert.equal(seam.asks.length, 0);
  });
});
