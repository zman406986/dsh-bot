import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ForkError, appendMessage, forkErrorMessage, seedFork,
} from "@racoons/core";
import type { ConversationRole, WireFork } from "@racoons/core";

/**
 * Ticket 205 — the repeated-role policy refuses assistant/assistant and
 * tool/tool, permits user/user, and its fixed `role-conflict` diagnostic must
 * describe both refused pairs without claiming an assistant turn for tool/tool.
 */

const ROLE_CONFLICT_MESSAGE =
  "A fork refuses two assistant turns or two tool turns in a row; a user ask after a user turn is legal.";

function seed(...roles: ConversationRole[]): WireFork {
  return seedFork({
    system: "s",
    tools: [],
    messages: roles.map((role, index) => ({ role, text: `${role}-${String(index)}` })),
  });
}

function refused(fork: WireFork, role: ConversationRole): ForkError {
  try {
    appendMessage(fork, { role, text: `next-${role}` });
  } catch (error) {
    assert.ok(error instanceof ForkError, "a repeated non-user turn throws ForkError");
    return error;
  }
  assert.fail(`expected a second ${role} turn to be refused`);
}

describe("fork repeated-role policy (ticket 205)", () => {
  it("states both refused pairs in the fixed role-conflict diagnostic", () => {
    assert.equal(forkErrorMessage("role-conflict"), ROLE_CONFLICT_MESSAGE);
  });

  it("refuses assistant/assistant with the fixed diagnostic", () => {
    const error = refused(seed("assistant"), "assistant");
    assert.equal(error.code, "role-conflict");
    assert.equal(error.message, ROLE_CONFLICT_MESSAGE);
  });

  it("refuses tool/tool with the fixed diagnostic", () => {
    const error = refused(seed("tool"), "tool");
    assert.equal(error.code, "role-conflict");
    assert.equal(error.message, ROLE_CONFLICT_MESSAGE);
  });

  it("permits a user ask after a user turn", () => {
    const grown = appendMessage(seed("user"), { role: "user", text: "ask" });
    assert.deepEqual(grown.messages.map(message => message.role), ["user", "user"]);
  });

  it("permits every pair of different roles", () => {
    const roles: readonly ConversationRole[] = ["user", "assistant", "tool"];
    for (const first of roles) {
      for (const second of roles) {
        if (first === second) continue;
        const grown = appendMessage(seed(first), { role: second, text: `${second}-next` });
        assert.deepEqual(grown.messages.map(message => message.role), [first, second]);
      }
    }
  });
});
