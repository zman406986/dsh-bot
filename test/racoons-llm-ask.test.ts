import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askEntry, askWire } from "racoons-dsh";
import type {
  DshLlmChunk, DshLlmService, DshLlmStreamOptions, StreamOutcome,
} from "racoons-dsh";

/**
 * The ask seam's stream contract. Ticket 186: the ask loop owns its stream
 * iterator — returning on a finish chunk must close it so generator cleanup
 * runs exactly once, natural completion must not trigger a redundant close,
 * and cleanup must not replace the ask's typed outcome. Ticket 185: only a
 * text-only reply is an answer — a tool-bearing response is a typed refusal at
 * both the shared helper and the entry caller.
 */

const ask = (service: DshLlmService, signal?: AbortSignal): Promise<StreamOutcome> =>
  askWire(service, {
    system: "",
    tools: [],
    messages: [{ role: "user", text: "q" }],
  }, {
    provider: "p",
    model: "m",
    ...(signal === undefined ? {} : { signal }),
  });

describe("ask stream iterator cleanup (ticket 186)", () => {
  it("closes the stream after a finish chunk and keeps the answer", async () => {
    let cleanups = 0;
    const service: DshLlmService = {
      stream(_options: DshLlmStreamOptions) {
        return (async function* (): AsyncGenerator<DshLlmChunk> {
          try {
            yield { type: "text-delta", index: 0, text: "allow" };
            yield { type: "finish", reason: "stop" };
          } finally {
            cleanups += 1;
          }
        })();
      },
    };

    const outcome = await ask(service);
    assert.equal(outcome.status, "answered");
    if (outcome.status !== "answered") assert.fail("expected an answered ask");
    assert.equal(outcome.text, "allow");
    assert.equal(outcome.finish, "stop");
    assert.equal(cleanups, 1);
  });

  it("does not return() an iterator that completed naturally", async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const service: DshLlmService = {
      stream(_options: DshLlmStreamOptions): AsyncIterable<DshLlmChunk> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<DshLlmChunk> {
            return {
              async next(): Promise<IteratorResult<DshLlmChunk>> {
                nextCalls += 1;
                return nextCalls === 1
                  ? { done: false, value: { type: "text-delta", index: 0, text: "done" } }
                  : { done: true, value: undefined };
              },
              async return(): Promise<IteratorResult<DshLlmChunk>> {
                returnCalls += 1;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };

    const outcome = await ask(service);
    assert.equal(outcome.status, "answered");
    if (outcome.status !== "answered") assert.fail("expected an answered ask");
    assert.equal(outcome.text, "done");
    assert.equal(outcome.finish, null);
    assert.equal(nextCalls, 2);
    assert.equal(returnCalls, 0);
  });

  it("runs cleanup once and preserves a stream error", async () => {
    let cleanups = 0;
    const service: DshLlmService = {
      stream(_options: DshLlmStreamOptions) {
        return (async function* (): AsyncGenerator<DshLlmChunk> {
          try {
            yield { type: "text-delta", index: 0, text: "partial" };
            throw new Error("boom");
          } finally {
            cleanups += 1;
          }
        })();
      },
    };

    const outcome = await ask(service);
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") assert.fail("expected a refused ask");
    assert.equal(outcome.reason, "stream-error");
    assert.match(outcome.message, /boom/);
    assert.equal(cleanups, 1);
  });

  it("runs cleanup once on caller cancellation", async () => {
    let cleanups = 0;
    const controller = new AbortController();
    const service: DshLlmService = {
      stream(options: DshLlmStreamOptions) {
        return (async function* (): AsyncGenerator<DshLlmChunk> {
          try {
            yield { type: "text-delta", index: 0, text: "partial" };
            await new Promise<never>((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            });
            yield { type: "finish", reason: "stop" };
          } finally {
            cleanups += 1;
          }
        })();
      },
    };

    const pending = ask(service, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const outcome = await pending;
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") assert.fail("expected a refused ask");
    assert.equal(outcome.reason, "aborted");
    assert.equal(cleanups, 1);
  });
});

/**
 * Ticket 185 — a reply is an answer only when it is text and nothing else. A
 * tool-bearing response (a `tool-call-delta` chunk or a `tool-calls` finish,
 * or both) is a typed refusal even when its adjacent text is a syntactically
 * valid entry decision; the same text on a clean `stop` finish stays accepted.
 */
const MIXED_ANSWER_TEXT = '{"forgetall":"summary"}';

function scriptedStream(chunks: readonly DshLlmChunk[]): AsyncIterable<DshLlmChunk> {
  return (async function* emit(): AsyncGenerator<DshLlmChunk> {
    for (const chunk of chunks) yield chunk;
  })();
}

function scriptedService(chunks: readonly DshLlmChunk[]): DshLlmService {
  return {
    stream(_options: DshLlmStreamOptions) {
      return scriptedStream(chunks);
    },
  };
}

describe("ask stream answer acceptance (ticket 185)", () => {
  it("refuses a tool-calls finish even when its text is a valid answer", async () => {
    const outcome = await ask(scriptedService([
      { type: "text-delta", index: 0, text: MIXED_ANSWER_TEXT },
      { type: "tool-call-delta", index: 0, callId: "c1", name: "read", arguments: "{}" },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]));
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") assert.fail("expected a refusal");
    assert.equal(outcome.reason, "tool-call");
  });

  it("refuses a tool-call chunk even when the finish says stop", async () => {
    const outcome = await ask(scriptedService([
      { type: "text-delta", index: 0, text: MIXED_ANSWER_TEXT },
      { type: "tool-call-delta", index: 0, callId: "c1", name: "read", arguments: "{}" },
      { type: "finish", reason: "stop" },
    ]));
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") assert.fail("expected a refusal");
    assert.equal(outcome.reason, "tool-call");
  });

  it("still accepts the same text on a clean stop finish", async () => {
    const outcome = await ask(scriptedService([
      { type: "text-delta", index: 0, text: MIXED_ANSWER_TEXT },
      { type: "finish", reason: "stop" },
    ]));
    assert.equal(outcome.status, "answered");
    if (outcome.status !== "answered") assert.fail("expected an answered ask");
    assert.equal(outcome.text, MIXED_ANSWER_TEXT);
    assert.equal(outcome.finish, "stop");
  });
});

/**
 * Ticket 185, entry caller: `askEntry` must hand the helper's tool-call
 * refusal back as data instead of reading the adjacent decision text. The
 * landed result stays whole on the mount's existing refusal path.
 */
const ENTRY_BODY = "alpha\nbeta\ngamma\n";
const ENTRY_BYTES = new TextEncoder().encode(ENTRY_BODY);
const ENTRY_SURFACE = {
  system: "sys",
  tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
  messages: [
    { role: "user", text: "read it" },
    { role: "assistant", text: "[tool call read {}]" },
    { role: "tool", text: ENTRY_BODY },
  ],
} as const;

function askEntryWith(service: DshLlmService): ReturnType<typeof askEntry> {
  return askEntry({
    resultBytes: ENTRY_BYTES,
    seed: null,
    surface: ENTRY_SURFACE,
    llm: service,
    route: { provider: "p", model: "m" },
    timeoutMs: 1_000,
  });
}

describe("entry ask answer acceptance (ticket 185)", () => {
  it("does not turn a mixed tool-call reply into an answered decision", async () => {
    const requests: DshLlmStreamOptions[] = [];
    const outcome = await askEntryWith({
      stream(options) {
        requests.push(options);
        return scriptedStream([
          { type: "text-delta", index: 0, text: MIXED_ANSWER_TEXT },
          { type: "tool-call-delta", index: 0, callId: "c1", name: "read", arguments: "{}" },
          { type: "finish", reason: "tool-calls" },
        ]);
      },
    });
    assert.equal(outcome.status, "refused");
    if (outcome.status !== "refused") assert.fail("expected a refusal");
    assert.equal(outcome.code, "stream-error");
    assert.equal(outcome.reason, "tool-call");
    assert.equal(requests.length, 1);
    assert.equal((requests[0]?.tools as readonly unknown[] | undefined)?.length, 1,
      "the entry ask advertises the retained tool, so the mixed reply is reachable");
  });

  it("still accepts the same text on a clean stop finish", async () => {
    const outcome = await askEntryWith(scriptedService([
      { type: "text-delta", index: 0, text: MIXED_ANSWER_TEXT },
      { type: "finish", reason: "stop" },
    ]));
    assert.equal(outcome.status, "answered");
    if (outcome.status !== "answered") assert.fail("expected an answered entry ask");
    assert.equal(outcome.answer.action, "forgetall");
    assert.equal(outcome.raw, MIXED_ANSWER_TEXT);
  });
});
