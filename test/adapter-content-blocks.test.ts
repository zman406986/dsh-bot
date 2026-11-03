import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blocksToText } from "../src/adapter/content-blocks.js";
import { WAKE_CUE, WAKE_SOURCE_KIND, wakeUserMessage } from "../src/adapter/wake-copy.js";

describe("wake message construction", () => {
  it("builds a producer-owned user message on the v4 source kind", () => {
    // Format v4 rejects the retired shared `plugin` kind; the producer-owned
    // kind is the one the v3→v4 migration assigns to this package. A host
    // format bump makes this the first failure, which is where we want it.
    const msg = wakeUserMessage();
    assert.equal(msg.role, "user");
    assert.equal(msg.source.kind, "plugin:multitask-dispatcher");
    assert.equal(msg.source.kind, WAKE_SOURCE_KIND);
    assert.equal("plugin" in msg.source, false);
    assert.equal(msg.content.length, 1);
    assert.equal((msg.content[0] as { text: string }).text, WAKE_CUE);
    assert.ok(msg.id.length > 0);
    assert.notEqual(wakeUserMessage().id, msg.id, "ids are unique");
  });

  it("flattens text blocks and drops non-text and empty ones", () => {
    assert.equal(
      blocksToText([
        { type: "text", text: "first" },
        { type: "reasoning", text: "ignored" },
        { type: "text", text: "" },
        { type: "text", text: "second" },
      ]),
      "first\n\nsecond",
    );
    assert.equal(blocksToText(undefined), "");
    assert.equal(blocksToText([]), "");
  });
});
