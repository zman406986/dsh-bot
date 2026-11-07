/**
 * The ADR-0027 peer-label read after the dsh 0.2.2 migration.
 *
 * This plugin does not own the `subagent` projection key, so it cannot hold
 * that registration's handle. The non-deprecated read is therefore
 * `registry.snapshot(session, ["subagent"])` (the unit's wire view — the
 * identity itself, or null); older hosts without `snapshot` keep the guarded
 * `registry.stateOf(session, key)` overload. Both must answer null for
 * everything unreadable rather than invent a name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUBAGENT_PROJECTION_KEY, subagentLabelOf } from "../src/adapter/peer-label.js";

interface SnapshotCalls {
  snapshot: number;
  stateOf: number;
}

/** A 0.2.2-shaped registry: snapshot answers the wire view. */
function snapshotRegistry(
  value: unknown,
  calls: SnapshotCalls,
  options?: { readonly throwOnSnapshot?: boolean },
) {
  return {
    calls,
    snapshot(_session: unknown, keys?: readonly string[]) {
      calls.snapshot += 1;
      if (options?.throwOnSnapshot === true) {
        throw new Error("snapshot exploded");
      }
      assert.deepEqual(keys, [SUBAGENT_PROJECTION_KEY]);
      return { asOfSeq: 3, values: { [SUBAGENT_PROJECTION_KEY]: value } };
    },
    stateOf(): never {
      calls.stateOf += 1;
      throw new Error("deprecated registry.stateOf must not be read");
    },
  };
}

/** An older-host registry: only the deprecated state-of read exists. */
function legacyRegistry(value: unknown, calls: { stateOf: number }) {
  return {
    calls,
    stateOf(_session: unknown, key: string) {
      calls.stateOf += 1;
      assert.equal(key, SUBAGENT_PROJECTION_KEY);
      return value;
    },
  };
}

describe("subagentLabelOf — dsh 0.2.2 snapshot read", () => {
  it("reads the label from the wire identity, not the raw state shape", () => {
    const calls = { snapshot: 0, stateOf: 0 };
    const label = subagentLabelOf(
      snapshotRegistry(
        { mode: "continuable", label: "Research scout", seq: 3 },
        calls,
      ),
      { id: "s1" },
    );
    assert.equal(label, "Research scout");
    assert.equal(calls.snapshot, 1);
    assert.equal(calls.stateOf, 0, "the deprecated overload is never read");
  });

  it("normalizes whitespace and rejects an empty label", () => {
    assert.equal(
      subagentLabelOf(
        snapshotRegistry(
          { mode: "one-shot", label: "  Research \n scout ", seq: 1 },
          { snapshot: 0, stateOf: 0 },
        ),
        { id: "s1" },
      ),
      "Research scout",
    );
    assert.equal(
      subagentLabelOf(
        snapshotRegistry(
          { mode: "one-shot", label: "   ", seq: 1 },
          { snapshot: 0, stateOf: 0 },
        ),
        { id: "s1" },
      ),
      null,
    );
  });

  it("answers null for a null wire identity (no valid descriptor)", () => {
    const calls = { snapshot: 0, stateOf: 0 };
    assert.equal(subagentLabelOf(snapshotRegistry(null, calls), { id: "s1" }), null);
    assert.equal(calls.stateOf, 0, "mounted-but-null stays on the modern path");
  });

  it("answers null when the snapshot omits the key or is malformed", () => {
    for (const snapshot of [
      { asOfSeq: 0, values: {} },
      { asOfSeq: 0, values: "nope" },
      "not a snapshot",
      null,
    ]) {
      const calls = { snapshot: 0, stateOf: 0 };
      const registry = {
        calls,
        snapshot() {
          calls.snapshot += 1;
          return snapshot;
        },
        stateOf() {
          calls.stateOf += 1;
          return { identity: { mode: "continuable", label: "stale" } };
        },
      };
      assert.equal(subagentLabelOf(registry, { id: "s1" }), null);
      assert.equal(
        calls.stateOf,
        0,
        "a present snapshot face is authoritative; no deprecated retry",
      );
    }
  });

  it("answers null when the snapshot throws or the identity is malformed", () => {
    assert.equal(
      subagentLabelOf(
        snapshotRegistry(
          { mode: "continuable", label: "x", seq: 1 },
          { snapshot: 0, stateOf: 0 },
          { throwOnSnapshot: true },
        ),
        { id: "s1" },
      ),
      null,
    );
    for (const value of [
      { mode: "admiral", label: "x", seq: 1 },
      { label: "x", seq: 1 },
      { mode: "continuable", label: 42, seq: 1 },
      { identity: "nope" },
      42,
    ]) {
      assert.equal(
        subagentLabelOf(snapshotRegistry(value, { snapshot: 0, stateOf: 0 }), {
          id: "s1",
        }),
        null,
        JSON.stringify(value),
      );
    }
  });
});

describe("subagentLabelOf — guarded legacy fallback", () => {
  it("reads the raw fold state's identity.label on a pre-snapshot host", () => {
    const calls = { stateOf: 0 };
    assert.equal(
      subagentLabelOf(
        legacyRegistry(
          { identity: { mode: "continuable", label: "Research scout", seq: 3 } },
          calls,
        ),
        { id: "s1" },
      ),
      "Research scout",
    );
    assert.equal(calls.stateOf, 1);
  });

  it("no registry, no read face, junk state, or a throw all answer null", () => {
    assert.equal(subagentLabelOf(undefined, { id: "s1" }), null);
    assert.equal(subagentLabelOf({}, { id: "s1" }), null);
    assert.equal(
      subagentLabelOf(legacyRegistry(42, { stateOf: 0 }), { id: "s1" }),
      null,
    );
    assert.equal(
      subagentLabelOf(
        legacyRegistry({ identity: "nope" }, { stateOf: 0 }),
        { id: "s1" },
      ),
      null,
    );
    assert.equal(
      subagentLabelOf(
        {
          stateOf() {
            throw new Error("registry exploded");
          },
        },
        { id: "s1" },
      ),
      null,
    );
    assert.equal(
      subagentLabelOf(
        {
          get stateOf(): never {
            throw new Error("un-injected member");
          },
        },
        { id: "s1" },
      ),
      null,
    );
  });
});
