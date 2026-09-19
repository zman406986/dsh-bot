/**
 * Ticket 69 chunk B (design 2026-09-19 §3) — the approval-card projections
 * frozen as ticket 81's rendering contract. Offline only (S8): pure
 * functions over relay-truth fixtures and spawn tool-call records; the
 * component rendering itself stays covered by build + typecheck.
 *
 * Pinned here: the exact §3 shapes (B1), the injectable `locationFor` hook
 * as 71's re-base point with its map-backed default (B2), and — via the
 * unchanged-source assertion in the ticket comment — B3 (no
 * access-types.ts / relay-semantics diff: this suite imports relay TYPES
 * only and the git range for the chunk-B commits touches neither
 * `src/core/access-types.ts` nor `src/core/access-relay.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCESS_PROMPT_ALLOW,
  ACCESS_PROMPT_ALWAYS_ALLOW,
  ACCESS_PROMPT_DENY,
  APPROVAL_LOCATION_LOCAL,
  clampApprovalDetail,
} from "../src/adapter/index.js";
import { reviewPostureDenyDetail } from "../src/core/review-posture.js";
import type {
  AccessNotice,
  AccessTicket,
} from "../src/core/access-types.js";
import {
  createApprovalCardsStore,
  defaultLocationFor,
  projectAccessAskCards,
  projectDispatchCard,
  type SpawnToolCallRecord,
} from "../src/client/approval-cards.js";

function ticket(overrides: Partial<AccessTicket> = {}): AccessTicket {
  return {
    workerId: "w-1",
    requestId: "req-1",
    body: {
      class: "tool",
      target: "write_file",
      reason: "needs to write outside the workspace",
    },
    createdAtMs: 1_000,
    parentSessionId: "s-1",
    status: "pending",
    ...overrides,
  };
}

function notice(overrides: Partial<AccessNotice> = {}): AccessNotice {
  return {
    kind: "access-resolved",
    workerId: "w-1",
    title: "Summarize RFCs",
    decision: { kind: "deny", reason: "user-denied", detail: "no" },
    body: {
      class: "tool",
      target: "write_file",
      reason: "needs to write outside the workspace",
    },
    ...overrides,
  };
}

describe("chunk B — access-ask card projection (frozen §3.1 shape)", () => {
  it("projects a pending ticket into the exact frozen card shape", () => {
    const [card] = projectAccessAskCards([ticket()]);
    assert.ok(card);
    assert.deepEqual(card, {
      cardKind: "access-ask",
      requestId: "req-1",
      workerId: "w-1",
      workerTitle: "w-1",
      body: {
        class: "tool",
        target: "write_file",
        reason: "needs to write outside the workspace",
      },
      parentSessionId: "s-1",
      createdAtMs: 1_000,
      status: "pending",
      optionSet: [
        { kind: "allow", label: ACCESS_PROMPT_ALLOW },
        { kind: "always-allow", label: ACCESS_PROMPT_ALWAYS_ALLOW },
        { kind: "deny", label: ACCESS_PROMPT_DENY },
      ],
      locationLine: APPROVAL_LOCATION_LOCAL,
      detail: "needs to write outside the workspace",
    });
    assert.equal(card.decision, undefined);
  });

  it("derives the secret-ask cardKind for credential asks (names, never values)", () => {
    const [card] = projectAccessAskCards([
      ticket({
        body: {
          class: "credential",
          target: "API_TOKEN",
          reason: "deploy needs it",
          credentialName: "API_TOKEN",
        },
      }),
    ]);
    assert.equal(card?.cardKind, "secret-ask");
    assert.equal(card?.body.credentialName, "API_TOKEN");
    assert.ok(!JSON.stringify(card).includes("sk-"));
  });

  it("a worker title resolver names the card; absent → the workerId", () => {
    const [titled] = projectAccessAskCards([ticket()], [], {
      workerTitleOf: (id) => (id === "w-1" ? "Summarize RFCs" : null),
    });
    assert.equal(titled?.workerTitle, "Summarize RFCs");
  });

  it("drops the always option for wildcard targets — ticket 30's fence, always", () => {
    for (const target of ["*", "gh-api*", "pre*fix"]) {
      const [card] = projectAccessAskCards([
        ticket({ body: { class: "network", target, reason: "r" } }),
      ]);
      assert.deepEqual(
        card?.optionSet.map((option) => option.kind),
        ["allow", "deny"],
        target,
      );
    }
  });

  it("clamps the reason with the omission marker and never clamps the target", () => {
    const longReason = "x".repeat(600);
    const [card] = projectAccessAskCards([
      ticket({ body: { class: "filesystem", target: "/very/long/path", reason: longReason } }),
    ]);
    assert.equal(card?.detail, clampApprovalDetail(longReason));
    assert.ok(card?.detail.includes("[+"));
    assert.equal(card?.body.target, "/very/long/path");
  });
});

describe("chunk B — settled cards: decision provenance is the shipped relay truth", () => {
  it("a posture deny surfaces as policy-denied with the self-naming detail (no new reason kind)", () => {
    const detail = reviewPostureDenyDetail("tool", "write_file");
    const decision = {
      kind: "deny" as const,
      reason: "policy-denied" as const,
      detail,
    };
    const [card] = projectAccessAskCards([], [
      notice({ decision, title: "w-1" }),
    ], {
      remembered: [ticket()],
    });
    assert.equal(card?.status, "resolved");
    assert.deepEqual(card?.decision, decision);
    assert.equal(card?.decision?.reason, "policy-denied");
    assert.equal(
      card?.decision?.detail,
      'auto-review posture denied tool "write_file"',
    );
    assert.deepEqual(card?.optionSet, []); // settled cards offer no actions
  });

  it("the ADR-0008 timeout deny settles a card as expired with ticket 30's expired copy", () => {
    const [card] = projectAccessAskCards([], [
      notice({
        decision: {
          kind: "deny",
          reason: "timeout",
          detail: "This request already expired and was denied by default.",
        },
      }),
    ], { remembered: [ticket()] });
    assert.equal(card?.status, "expired");
    assert.equal(card?.requestId, "req-1");
    assert.equal(card?.parentSessionId, "s-1");
    assert.equal(card?.createdAtMs, 1_000);
  });

  it("an allow settles as resolved (credential allows carry 30's stored copy as the note)", () => {
    const [card] = projectAccessAskCards([], [
      notice({
        decision: {
          kind: "allow",
          note:
            "Saved. The value is stored securely and is never shown to workers or in this chat.",
        },
        body: {
          class: "credential",
          target: "API_TOKEN",
          reason: "deploy",
          credentialName: "API_TOKEN",
        },
      }),
    ], { remembered: [ticket()] });
    assert.equal(card?.status, "resolved");
    assert.equal(card?.cardKind, "secret-ask");
    assert.equal(
      card?.decision?.kind === "allow" && card.decision.note,
      "Saved. The value is stored securely and is never shown to workers or in this chat.",
    );
  });

  it("an unjoinable notice carries honest unknowns (no fabricated identity)", () => {
    const [card] = projectAccessAskCards([], [notice()]);
    assert.equal(card?.requestId, "");
    assert.equal(card?.parentSessionId, "");
    assert.equal(card?.createdAtMs, 0);
    assert.equal(card?.workerTitle, "Summarize RFCs"); // notice title survives
  });

  it("pending truth outranks a skewed notice for the same worker", () => {
    const cards = projectAccessAskCards([ticket()], [notice()]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.status, "pending");
  });
});

describe("chunk B — the locationFor hook (B2: 71's re-base point)", () => {
  it("the default resolves the 71 AC-4 map's local entry — never hard-coded", () => {
    assert.equal(defaultLocationFor(), APPROVAL_LOCATION_LOCAL);
    const [card] = projectAccessAskCards([ticket()]);
    assert.equal(card?.locationLine, APPROVAL_LOCATION_LOCAL);
  });

  it("an injected hook wins — the card carries whatever the map resolves", () => {
    const [card] = projectAccessAskCards([ticket()], [], {
      locationFor: () => "Runs on the product's computer (remote box).",
    });
    assert.equal(card?.locationLine, "Runs on the product's computer (remote box).");
  });

  it("the hook receives the projected card (minus the line) as its input", () => {
    let seen: { requestId: string; cardKind: string } | null = null;
    projectAccessAskCards([ticket()], [], {
      locationFor: (input) => {
        seen = { requestId: input.requestId, cardKind: input.cardKind };
        return "L";
      },
    });
    assert.deepEqual(seen, { requestId: "req-1", cardKind: "access-ask" });
  });
});

describe("chunk B — worker-dispatch card projection (frozen §3.2, replay-safe)", () => {
  const spawned: SpawnToolCallRecord = {
    callId: "call-1",
    args: {
      stream_key: "todo-7",
      title: "Summarize RFCs",
      prompt: "...",
    },
    result: {
      ok: true,
      worker_id: "w-9",
      stream_key: "todo-7",
      title: "Summarize RFCs",
      ack: "Started ...",
    },
  };

  it("projects a settled ungated spawn into the frozen card", () => {
    assert.deepEqual(projectDispatchCard(spawned), {
      cardKind: "worker-dispatch",
      toolCallId: "call-1",
      streamKey: "todo-7",
      title: "Summarize RFCs",
      outcome: { kind: "spawned", workerId: "w-9" },
      gating: "ungated",
    });
  });

  it("the chunk-A `gated` marker derives approval-allowed provenance", () => {
    const card = projectDispatchCard({
      ...spawned,
      result: { ...spawned.result, gated: true },
    });
    assert.equal(card?.gating, "approval-allowed");
    assert.equal(
      (card?.outcome as { kind: string }).kind,
      "spawned",
    );
  });

  it("an auto-review refusal derives approval-refused with the honest reason", () => {
    const card = projectDispatchCard({
      callId: "call-2",
      args: { stream_key: "s", title: "Risky thing" },
      result: {
        ok: false,
        reason: "auto-review-refused",
        detail: 'auto-review posture denied worker-dispatch "Risky thing"',
      },
    });
    assert.deepEqual(card?.outcome, { kind: "refused", reason: "auto-review-refused" });
    assert.equal(card?.gating, "approval-refused");
    assert.equal(card?.title, "Risky thing");
  });

  it("other refusal reasons stay ungated refusals", () => {
    const card = projectDispatchCard({
      callId: "call-3",
      args: {},
      result: { ok: false, reason: "duplicate-stream-key", detail: "held" },
    });
    assert.deepEqual(card?.outcome, { kind: "refused", reason: "duplicate-stream-key" });
    assert.equal(card?.gating, "ungated");
  });

  it("unsettled or malformed records project NO card (never a fabricated spawn)", () => {
    assert.equal(projectDispatchCard({ callId: "c", args: {}, result: null }), null);
    assert.equal(
      projectDispatchCard({ callId: "c", args: {}, result: { ok: true } }),
      null,
    );
    assert.equal(
      projectDispatchCard({ callId: "c", args: "junk", result: "junk" }),
      null,
    );
  });

  it("replay-safe: the same record projects the identical card, every time", () => {
    assert.deepEqual(projectDispatchCard(spawned), projectDispatchCard(spawned));
    assert.deepEqual(projectDispatchCard(spawned), projectDispatchCard(spawned));
  });
});

describe("chunk B — the approval-cards store (81's data seam)", () => {
  it("starts unfed (unknown) and only a feed can make empty mean 'nothing waiting'", () => {
    const store = createApprovalCardsStore();
    assert.equal(store.getBox().state.kind, "unfed");
    store.applyRelayTruth([], []);
    assert.equal(store.getBox().state.kind, "ready");
    assert.equal(store.getBox().state.cards.length, 0);
  });

  it("feeds project pending cards and remember tickets for later notice joins", () => {
    const store = createApprovalCardsStore();
    const seen: string[] = [];
    store.subscribe(() => {
      const state = store.getBox().state;
      if (state.kind === "ready") seen.push(`${state.cards.length}`);
    });
    store.applyRelayTruth([ticket()], []);
    store.applyRelayTruth([], [notice({ decision: {
      kind: "deny", reason: "timeout", detail: "expired",
    } })]);
    assert.deepEqual(seen, ["1", "1"]);
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    const card = state.cards[0];
    assert.equal(card?.status, "expired");
    assert.equal(card?.requestId, "req-1"); // joined through the memory
  });

  it("an injected locationFor rides the feed's projections", () => {
    const store = createApprovalCardsStore({
      locationFor: () => "custom",
    });
    store.applyRelayTruth([ticket()], []);
    const state = store.getBox().state;
    assert.equal(state.kind, "ready");
    assert.equal(state.cards[0]?.locationLine, "custom");
  });
});
