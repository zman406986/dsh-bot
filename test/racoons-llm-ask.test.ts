import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askWire } from "racoons-dsh";
import type {
  DshLlmChunk, DshLlmService, DshLlmStreamOptions, StreamOutcome,
} from "racoons-dsh";

/**
 * Ticket 186 — the ask loop owns its stream iterator. Returning on a finish
 * chunk must close it so generator cleanup runs exactly once; natural
 * completion must not trigger a redundant close, and cleanup must not replace
 * the ask's typed outcome.
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
