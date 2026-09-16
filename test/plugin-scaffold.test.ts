import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Config, apply, inject, name } from "../src/plugin.js";

describe("plugin scaffold", () => {
  it("exports the Cordis plugin contract", () => {
    assert.equal(name, "multitask-dispatcher");
    assert.deepEqual(inject, []);
    assert.ok(Config);
  });

  it("apply registers through ctx.effect and the disposer is callable", () => {
    const disposers: Array<() => void> = [];
    const ctx = {
      effect(dispose: () => void) {
        disposers.push(dispose);
      },
    };

    apply(ctx, { enabled: true });
    assert.equal(disposers.length, 1);
    assert.doesNotThrow(() => {
      disposers[0]?.();
    });
  });

  it("apply is a no-op when disabled", () => {
    const disposers: Array<() => void> = [];
    const ctx = {
      effect(dispose: () => void) {
        disposers.push(dispose);
      },
    };

    apply(ctx, { enabled: false });
    assert.equal(disposers.length, 0);
  });
});
