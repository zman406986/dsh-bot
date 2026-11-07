import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAssistantUsage } from "racoons-dsh";
import type { DshUsageRead, DshUsageSource } from "racoons-dsh";
import type { ApiUsage } from "@racoons/core";

/**
 * Ticket 206 — the public usage reader must not return `kind: 'usage'` from
 * individually safe bucket counts whose sum overflows Number.MAX_SAFE_INTEGER.
 * Both aggregate additions (cache buckets and prompt total) are checked.
 */

const MAX = Number.MAX_SAFE_INTEGER;

function read(usage: unknown): DshUsageRead | null {
  const event: DshUsageSource = { type: "assistant/message", seq: 1, data: { usage } };
  return readAssistantUsage(event);
}

function expectUsage(usage: Record<string, unknown>): ApiUsage {
  const result = read(usage);
  assert.ok(result !== null, "an assistant/message with a usage row is read");
  if (result.kind !== "usage") assert.fail(`expected usage, got ${result.kind}`);
  return result.usage;
}

function expectInvalid(usage: Record<string, unknown>): void {
  const result = read(usage);
  assert.ok(result !== null);
  assert.equal(result.kind, "invalid");
}

describe("usage reader safe aggregates (ticket 206)", () => {
  it("rejects an unsafe prompt aggregate from individually safe buckets", () => {
    expectInvalid({ inputTokens: MAX, outputTokens: 0, cacheReadTokens: 2 });
  });

  it("rejects an unsafe cache aggregate from individually safe buckets", () => {
    expectInvalid({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: MAX, cacheWriteTokens: 2,
    });
  });

  it("keeps the normal disjoint-bucket conversion", () => {
    assert.deepEqual(expectUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 2 }), {
      inputTokens: 3, outputTokens: 0, cachedInputTokens: 2,
    });
  });

  it("still rejects an individually unsafe bucket", () => {
    expectInvalid({ inputTokens: MAX + 1, outputTokens: 0 });
  });

  it("still rejects a negative bucket", () => {
    expectInvalid({ inputTokens: -1, outputTokens: 0 });
  });

  it("accepts the safe boundary values", () => {
    assert.deepEqual(expectUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: MAX - 1 }), {
      inputTokens: MAX, outputTokens: 0, cachedInputTokens: MAX - 1,
    });
    assert.deepEqual(expectUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: MAX }), {
      inputTokens: MAX, outputTokens: 0, cachedInputTokens: MAX,
    });
  });

  it("keeps a missing usage row distinct from an invalid one", () => {
    assert.deepEqual(readAssistantUsage({ type: "assistant/message", seq: 1, data: {} }),
      { kind: "missing" });
  });

  it("returns null for a non-usage event", () => {
    assert.equal(readAssistantUsage({ type: "tool/result", seq: 1 }), null);
  });

  it("keeps unknown cache null and a measured zero cache zero", () => {
    assert.equal(expectUsage({ inputTokens: 5, outputTokens: 1 }).cachedInputTokens, null);
    assert.equal(expectUsage({
      inputTokens: 5, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null,
    }).cachedInputTokens, null);
    assert.equal(expectUsage({
      inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    }).cachedInputTokens, 0);
    assert.equal(expectUsage({
      inputTokens: 5, outputTokens: 1, cacheReadTokens: 0,
    }).cachedInputTokens, 0);
  });
});
