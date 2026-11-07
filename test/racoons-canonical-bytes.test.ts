import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalBytesWithByteArrays, equalBytes, fromBytes } from "@racoons/core";

/**
 * Ticket 236 — the public canonical encoder must preserve an own `__proto__`
 * JSON member. `JSON.parse` produces a real own data property, so the two
 * objects below differ only by that member and must encode to distinct bytes.
 */

const encode = (value: unknown): string => fromBytes(canonicalBytesWithByteArrays(value));

describe("canonical bytes with byte arrays (ticket 236)", () => {
  it("preserves an own __proto__ member instead of collapsing it to {}", () => {
    const withProto = JSON.parse('{"__proto__":1}') as unknown;
    const withoutProto = JSON.parse("{}") as unknown;

    assert.equal(encode(withProto), '{"__proto__":1}');
    assert.equal(encode(withoutProto), "{}");
    assert.ok(!equalBytes(canonicalBytesWithByteArrays(withProto),
      canonicalBytesWithByteArrays(withoutProto)),
    "objects differing only in an own __proto__ member must encode differently");
  });

  it("keeps ordinary keys and the existing canonical ordering", () => {
    assert.equal(encode({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(encode(JSON.parse('{"normal":1}') as unknown), '{"normal":1}');
  });

  it("still normalizes byte arrays in objects, arrays and at the top level", () => {
    assert.equal(encode(new Uint8Array([1, 2])), "[1,2]");
    assert.equal(encode({
      blob: new Uint8Array([1, 2]),
      list: [new Uint8Array([3, 4])],
      nested: { bytes: new Uint8Array([]) },
    }), '{"blob":[1,2],"list":[[3,4]],"nested":{"bytes":[]}}');
  });
});
