import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksToText, textBlock, textBlocks } from "../src/adapter/content-blocks.js";
import { WAKE_CUE, wakeUserMessage } from "../src/adapter/wake-copy.js";

describe("content blocks", () => {
  it("textBlock builds a text block", () => {
    assert.deepEqual(textBlock("hello"), { type: "text", text: "hello" });
  });

  it("textBlocks wraps one text block", () => {
    assert.deepEqual(textBlocks("hi"), [{ type: "text", text: "hi" }]);
  });

  it("blocksToText joins text blocks with blank lines", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "reasoning", text: "ignored" },
      { type: "text", text: "second" },
    ];
    assert.equal(blocksToText(blocks), "first\n\nsecond");
  });

  it("blocksToText handles empty and undefined", () => {
    assert.equal(blocksToText(undefined), "");
    assert.equal(blocksToText([]), "");
  });

  it("blocksToText skips empty text blocks", () => {
    assert.equal(
      blocksToText([
        { type: "text", text: "" },
        { type: "text", text: "only" },
      ]),
      "only",
    );
  });
});

describe("wake copy", () => {
  it("wakeUserMessage builds a plugin-sourced user message", () => {
    const msg = wakeUserMessage();
    assert.equal(msg.role, "user");
    assert.equal(msg.source.kind, "plugin");
    assert.equal(msg.source.plugin, "multitask-dispatcher");
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0]?.type, "text");
    assert.equal((msg.content[0] as { text: string }).text, WAKE_CUE);
    assert.ok(msg.id.length > 0);
  });

  it("wakeUserMessage mints unique ids", () => {
    const a = wakeUserMessage();
    const b = wakeUserMessage();
    assert.notEqual(a.id, b.id);
  });
});
