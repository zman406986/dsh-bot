import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorsAt, anchorsFor } from "@racoons/core";

/**
 * Ticket 221 — one contiguous blank band must not be rescanned once per
 * candidate anchor. A 200k-line all-blank body used to walk the band for every
 * entry position (about 400M loop bodies) before emitting one notice.
 */

const BAND_LINES = 1_000_000;
const TIME_LIMIT_MS = 500;

describe("racoons anchor blank bands (ticket 221)", () => {
  it("emits one notice for a huge contiguous blank band within a linear pass", () => {
    const lines = new Array<string>(BAND_LINES).fill("");
    const started = performance.now();
    const anchors = anchorsFor(lines);
    const elapsed = performance.now() - started;
    assert.deepEqual(anchors, [`lines 1–${String(BAND_LINES)} are blank`],
      "one notice, at the band's first selected position");
    assert.ok(elapsed < TIME_LIMIT_MS,
      `blank-band anchors took ${elapsed.toFixed(1)}ms; repeated band walks are the regression`);
  });

  it("keeps the band notice's dedup and ordering for a small mixed body", () => {
    const lines = Array.from({ length: 100 }, (_, index) =>
      index === 10 || index === 11 ? "" : `content ${String(index + 1)}`);
    assert.deepEqual(anchorsAt(lines, [11, 12, 13]),
      ["lines 11–12 are blank", 'line 13 of 100 ends with "content 13"']);
  });
});
