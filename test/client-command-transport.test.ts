/**
 * Ticket 114 — the client command-transport salvage (native-UI revert).
 *
 * The retired session-management suite (ticket 101/106) owned tests for the
 * add/delete/close seats, which left with the floating-window UI. Five of its
 * tests, however, exercise SURVIVING adapter/transport behavior, not the
 * retired chrome: the no-worker-kill host-key posture, the transport's exact
 * method surface, the ticket-102b throwing nested-face regression, and the
 * two contained-failure paths. They live here now, bodies unchanged (only
 * the retired seat calls dropped), so the revert cannot lose that coverage.
 *
 * Offline only (S8): the host faces are minimal fakes standing in for the
 * verified seams.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountShellPage } from "../src/client/index.js";
import { bindCommandTransport, submitAccessResolve } from "../src/client/actions.js";
import type { AccessAskCard } from "../src/client/approval-cards.js";
import type { ClientContext } from "../src/client/context.js";

async function drain(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("posture — session lifecycle only, never worker/turn management", () => {
  it("the mounted hosts carry no stop/cancel/kill-style key", () => {
    // A minimal client fake: the shell composition mounts; the hosts' KEY
    // SET is the assertion target, so the seats need no live faces.
    const ctx = {
      effect(execute: () => unknown) {
        const returned = execute();
        void (typeof returned === "function" ? returned : () => {});
      },
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (key: string) => key;
        },
      },
      sessions: {
        list: { getSnapshot: () => ({ ids: [], byId: {} }) },
        scope: () => undefined,
      },
    } as unknown as ClientContext;
    const mount = mountShellPage(ctx);
    const offenders = Object.keys(mount.hosts).filter((key) =>
      /stop|cancel|kill|abort|deactivate|terminate|destroy/i.test(key),
    );
    assert.deepEqual(
      offenders,
      [],
      `the shell hosts must not carry worker-kill-style affordance keys; found: ${offenders.join(", ")}`,
    );
  });

  it("the one egress transport carries exactly the two user send paths", () => {
    const transport = bindCommandTransport({
      remote: () => undefined,
      sessions: () => undefined,
    });
    assert.deepEqual(Object.keys(transport).sort(), [
      "sendCommand",
      "sendPrompt",
    ]);
  });

  it("a THROWING nested-face read resolves to no-channel, never a rejection (ticket 102b)", async () => {
    // The live defect's exact shape: the resolver throws at the property
    // READ (not a call) when the nested dotted name is not in the inject
    // list, and `typeof remote.commands?.execute` cannot catch a throwing
    // getter. The transport must absorb it as the honest `no-channel`
    // result — the same outcome a structurally absent face gives — instead
    // of a rejected promise the seats swallow.
    const transport = bindCommandTransport({
      remote: () => ({
        get commands(): never {
          throw new Error(
            'cannot get property "remote.commands" without inject',
          );
        },
      }),
      sessions: () => undefined,
    });
    assert.deepEqual(await transport.sendCommand("s-1", "/dsh-bot"), {
      kind: "no-channel",
    });
  });

  it("an absent remote face is contained (no throw, honest no-channel)", async () => {
    const transport = bindCommandTransport({
      remote: () => undefined,
      sessions: () => undefined,
    });
    await assert.doesNotReject(async () => {
      const result = await transport.sendCommand("s-1", "/dispatcher-resolve");
      assert.deepEqual(result, { kind: "no-channel" });
      await drain();
    });
  });

  it("a transport rejection is contained: the caller never throws, writes nothing itself", async () => {
    const rejecting = {
      effect(execute: () => unknown) {
        const returned = execute();
        void (typeof returned === "function" ? returned : () => {});
      },
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (key: string) => key;
        },
      },
      remote: {
        commands: {
          execute() {
            return Promise.reject(new Error("transport down"));
          },
        },
      },
      sessions: {
        list: { getSnapshot: () => ({ ids: [], byId: {} }) },
        scope: () => undefined,
      },
    } as unknown as ClientContext;
    // The mount itself never throws over a rejecting host face…
    let mount: ReturnType<typeof mountShellPage> | undefined;
    assert.doesNotThrow(() => {
      mount = mountShellPage(rejecting);
    });
    assert.equal(typeof mount?.hosts.conversation, "function");
    // …and the surviving resolve action contains a rejecting transport as
    // the honest `failed` outcome (the retired seats used this same path).
    const transport = bindCommandTransport({
      remote: () => ({
        commands: {
          execute() {
            return Promise.reject(new Error("transport down"));
          },
        },
      }),
      sessions: () => undefined,
    });
    await assert.doesNotReject(async () => {
      const card: AccessAskCard = {
        cardKind: "access-ask",
        requestId: "req-1",
        workerId: "w-1",
        workerTitle: "w-1",
        body: { class: "tool", target: "run_tests", reason: "r" },
        parentSessionId: "s-1",
        createdAtMs: 0,
        status: "pending",
        optionSet: [],
        locationLine: "Runs on your computer.",
        detail: "r",
      };
      const outcome = await submitAccessResolve(transport, card, "allow");
      assert.deepEqual(outcome, { kind: "failed" });
      await drain();
    });
  });
});
