/**
 * `blocksToText` is on the worker settle path (`subagent/end` →
 * `normalizeSettleReport`). A host payload with a null/undefined/primitive
 * element used to throw there, aborting settle: no record, no wake, and the
 * worker appeared "running" forever. These tests pin the tolerant flattening.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksToText, textBlock } from "../src/adapter/content-blocks.js";
import type { ContentBlock } from "../src/adapter/content-blocks.js";

describe("blocksToText — junk-tolerant flattening", () => {
  it("skips null, undefined, and non-object elements around real text", () => {
    const blocks = [
      null,
      undefined,
      textBlock("first"),
      "stray string",
      42,
      true,
      { type: "text" }, // text missing
      { type: "text", text: 7 }, // wrong text type
      { type: "reasoning", text: "ignored" },
      { type: "tool-call", name: "bash" }, // unknown block type
      textBlock("second"),
    ] as unknown as ContentBlock[];
    assert.equal(blocksToText(blocks), "first\n\nsecond");
  });

  it("answers an empty string when every element is junk", () => {
    assert.equal(
      blocksToText([null, undefined, 0, "", {}] as unknown as ContentBlock[]),
      "",
    );
  });

  it("answers an empty string for a non-array runtime value", () => {
    assert.equal(blocksToText(null as unknown as ContentBlock[]), "");
    assert.equal(blocksToText("nope" as unknown as ContentBlock[]), "");
    assert.equal(blocksToText(undefined), "");
    assert.equal(blocksToText([]), "");
  });
});
