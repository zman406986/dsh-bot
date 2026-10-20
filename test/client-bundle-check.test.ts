/**
 * Ticket 114 — client bundle freshness check (`scripts/build-client.ts
 * --check`).
 *
 * Offline only: exercises the pure `compareBundles` helper. Nothing here
 * reads or writes the real `client/index.js`, so the suite is independent of
 * whatever build state the working tree happens to be in.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { compareBundles } from "../scripts/build-client.js";

const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");
const sha256 = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

describe("client bundle freshness comparison (ticket 114)", () => {
  it("equal bytes are fresh and report the shared size + hash", () => {
    const bundle = bytes("window.__ModuleLoader__.load({});\n");
    const result = compareBundles(bundle, bytes("window.__ModuleLoader__.load({});\n"));
    assert.deepEqual(result, {
      status: "fresh",
      bytes: bundle.length,
      sha256: sha256(bundle),
    });
  });

  it("a one-byte difference is stale with both sizes, both hashes, and the offset", () => {
    const expected = bytes("abcdef");
    const actual = bytes("abXdef");
    const result = compareBundles(expected, actual);
    assert.equal(result.status, "stale");
    if (result.status !== "stale") return;
    assert.equal(result.expectedBytes, 6);
    assert.equal(result.actualBytes, 6);
    assert.equal(result.expectedSha256, sha256(expected));
    assert.equal(result.actualSha256, sha256(actual));
    assert.notEqual(result.expectedSha256, result.actualSha256);
    assert.equal(result.firstDifferenceOffset, 2);
  });

  it("same UTF-16 length but different bytes still reads as stale", () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes; comparing decoded
    // strings by length would call this pair equal-sized — bytes must not.
    const expected = bytes("aé");
    const actual = bytes("aè");
    assert.equal(expected.length, actual.length);
    const result = compareBundles(expected, actual);
    assert.equal(result.status, "stale");
    if (result.status !== "stale") return;
    // Both encode as 0x61 0xC3 0xA9/0xA8: the continuation byte differs.
    assert.equal(result.firstDifferenceOffset, 2);
  });

  it("a truncated bundle is stale, not an equality-by-prefix", () => {
    const expected = bytes("full bundle text");
    const actual = bytes("full bundle");
    const result = compareBundles(expected, actual);
    assert.equal(result.status, "stale");
    if (result.status !== "stale") return;
    assert.equal(result.expectedBytes, 16);
    assert.equal(result.actualBytes, 11);
    assert.equal(result.firstDifferenceOffset, 11);
  });

  it("an appended tail is stale even when the shared prefix matches", () => {
    const result = compareBundles(bytes("bundle"), bytes("bundle plus tail"));
    assert.equal(result.status, "stale");
    if (result.status !== "stale") return;
    assert.equal(result.firstDifferenceOffset, 6);
  });

  it("a missing served bundle reports missing with the fresh build's size + hash", () => {
    const expected = bytes("bundle");
    const result = compareBundles(expected, null);
    assert.deepEqual(result, {
      status: "missing",
      expectedBytes: 6,
      expectedSha256: sha256(expected),
    });
  });

  it("empty bundles compare cleanly (no phantom difference at offset 0)", () => {
    assert.deepEqual(compareBundles(bytes(""), bytes("")), {
      status: "fresh",
      bytes: 0,
      sha256: sha256(bytes("")),
    });
  });
});
