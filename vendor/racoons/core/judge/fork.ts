/**
 * The judge fork (ADR-0010, ISSUE-026): main's last captured wire request,
 * copied whole and never re-rendered, grown append-only.
 *
 * A judge pass replays main's prefix so the provider can serve it from cache, so
 * the fork is a copy of the request OBJECT the capture took — `system`, `tools`
 * and `messages` — not a second composition of them. Byte-provenance to the
 * provider's HTTP body is not established: the host hands over the dispatched
 * request and the adapter serializes it at send; no code here sees those bytes.
 * With the capture preserving main's raw message list, the fork's message-list
 * shape mirrors main's captured shape exactly — same order, same roles, a
 * leading `system` message still a message. `seedFork` copies the three fields
 * whole and asserts the copy hashes to the input's hash; a mismatch is refused
 * with a `ForkError` — a different request would spend the cache hit.
 *
 * Growth is append-only. `appendAsk` adds the next `user` ask, `appendVerdict`
 * the `assistant` answer, and `appendMessage` the general case. Every append
 * first re-asserts the fork's own invariant: the system hash, the tool hash and
 * every existing message hash still match what was recorded. A drifted byte is
 * refused, never repaired or re-rendered. Non-user roles must alternate: a
 * second `assistant` turn or a second `tool` turn in a row is refused. Two
 * `user` turns in a row are LEGAL and normal — a judge ask after a seed whose
 * last message is the user's turn is provider-legal, and refusing it stalled
 * the pass (CRITIC-026 P2#5).
 *
 * Each append returns a NEW fork: the previous one is untouched, so a caller
 * holding a prefix reference sees the same bytes it always saw. Its recorded
 * hashes are the prefix hashes, and they do not change as the fork grows.
 *
 * The system bytes are frozen for the fork's life, and the tool list is frozen
 * with them (ADR-0010: tool list frozen per session, system bytes frozen per
 * fork). Messages are copied but not element-frozen, so a changed message is
 * *detected* by the re-assert on the next append rather than hidden behind a
 * freeze error.
 *
 * Hashes are canonical and deterministic: every one is
 * `sha256Sync(canonicalManifestBytes(...))`, the repo's one definition of bytes,
 * so two readers holding the same wire state agree on its hash.
 */

import type { Sha256 } from "../types/identity.js";
import { hashMessage, hashSystem, hashTools, hashWireRequest } from "./fork-hash.js";
import type { ConversationRole, ConversationTurn } from "./assembly.js";

/** The hash helpers the fork asserts with, re-exported for its callers. */
export {
  hashMessage, hashMessages, hashSystem, hashTools, hashWireRequest,
} from "./fork-hash.js";
export type { WireRequestFields } from "./fork-hash.js";

/**
 * One message of a wire request: the role and its exact text. It is assembly's
 * `ConversationTurn` — the fork grows the same shape the judge history renders,
 * so nothing is re-shaped between composition and the fork.
 */
export type WireMessage = ConversationTurn;

/**
 * One tool definition as main sent it. The fork never reads inside a tool: it
 * copies the record and hashes it, so the fields beyond `name` stay whatever
 * the host's wire carried.
 */
export interface WireTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly [key: string]: unknown;
}

/** Main's last sent request, as the fork takes it. */
export interface WireRequest {
  readonly system: string;
  readonly tools: readonly WireTool[];
  readonly messages: readonly WireMessage[];
}

/** A seeded fork: the copied wire state plus the hashes asserted on it. */
export interface WireFork {
  /** Hash of the whole seed — the root the fork grows from, never rewritten. */
  readonly seedHash: Sha256;
  /** Hash of the system bytes, re-asserted before every append. */
  readonly systemHash: Sha256;
  /** Hash of the tool list, re-asserted before every append. */
  readonly toolsHash: Sha256;
  readonly system: string;
  readonly tools: readonly WireTool[];
  readonly messages: readonly WireMessage[];
  /** One hash per message, in order, re-asserted before every later append. */
  readonly messageHashes: readonly Sha256[];
}

export type ForkErrorCode =
  | "seed-hash-mismatch"
  | "system-hash-drift"
  | "tools-hash-drift"
  | "message-hash-drift"
  | "role-conflict"
  | "invalid-message";

/**
 * One refusal from the fork. The code names the defect and the message is fixed
 * per code, so a caller and a test can both quote it verbatim. The fork never
 * repairs a drifted byte: a copy that changed is refused whole.
 */
export class ForkError extends Error {
  readonly code: ForkErrorCode;

  constructor(code: ForkErrorCode, message: string) {
    super(message);
    this.name = "ForkError";
    this.code = code;
  }
}

const MESSAGES: Readonly<Record<ForkErrorCode, string>> = {
  "seed-hash-mismatch":
    "The fork's seed bytes do not hash to main's last sent wire request.",
  "system-hash-drift": "The fork's system bytes changed after the seed.",
  "tools-hash-drift": "The fork's tool list changed after the seed.",
  "message-hash-drift": "A fork message changed after it was appended.",
  "role-conflict":
    "A fork refuses two assistant turns or two tool turns in a row; a user ask after a user turn is legal.",
  "invalid-message": "A fork message carries a known role and string text.",
};

/** The fixed message for a refusal code, so a second seam quotes the same text. */
export function forkErrorMessage(code: ForkErrorCode): string {
  return MESSAGES[code];
}

function fail(code: ForkErrorCode): never {
  throw new ForkError(code, MESSAGES[code]);
}

/** The canonical hash of a wire request, over exactly its three fields. */
export function wireRequestHash(request: WireRequest): Sha256 {
  return hashWireRequest(request);
}

/**
 * A deep copy of plain JSON-shaped data: arrays and plain objects are rebuilt,
 * every other value is immutable or plain and is copied by value.
 */
function deepCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Array.from(value, (item: unknown) => deepCopy(item));
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) copy[key] = deepCopy(source[key]);
  return copy;
}

/** Freezes a copied tool record through every nested object and array. */
function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

/**
 * Seeds a fork from main's last sent wire request.
 *
 * The three fields are deep-copied first, so a caller that keeps mutating its
 * own arrays or records cannot reach the fork. The copy is then hashed and
 * compared with the input's hash: they are equal by construction, and a
 * difference is a defect in the copy — refused with `seed-hash-mismatch` before
 * anything is sent.
 *
 * The returned fork is frozen; its tool records are deep-frozen. Its messages
 * are copied and left writable one by one, so drift is caught by the append
 * seam's hash re-assert.
 */
export function seedFork(lastSentWireRequest: WireRequest): WireFork {
  const expected = hashWireRequest(lastSentWireRequest);
  const system = lastSentWireRequest.system;
  const tools = deepFreeze(deepCopy(lastSentWireRequest.tools)) as WireTool[];
  const messages = deepCopy(lastSentWireRequest.messages) as WireMessage[];
  const fork: WireFork = Object.freeze({
    seedHash: expected,
    systemHash: hashSystem(system),
    toolsHash: hashTools(tools),
    system,
    tools: Object.freeze(tools),
    messages: Object.freeze(messages),
    messageHashes: Object.freeze(messages.map(hashMessage)),
  });
  if (hashWireRequest(fork) !== expected) fail("seed-hash-mismatch");
  return fork;
}

/**
 * The fork's own invariant, re-asserted before every append: the system bytes,
 * the tool list and each recorded message still hash to what was recorded.
 * A fork built by hand with a hash that does not match its bytes is refused
 * exactly like one that drifted after seeding.
 */
function assertForkIntact(fork: WireFork): void {
  if (hashSystem(fork.system) !== fork.systemHash) fail("system-hash-drift");
  if (hashTools(fork.tools) !== fork.toolsHash) fail("tools-hash-drift");
  if (fork.messages.length !== fork.messageHashes.length) fail("message-hash-drift");
  for (let index = 0; index < fork.messages.length; index += 1) {
    if (hashMessage(fork.messages[index]) !== fork.messageHashes[index]) {
      fail("message-hash-drift");
    }
  }
}

const ROLES: readonly ConversationRole[] = Object.freeze(["user", "assistant", "tool"]);

function isMessage(value: unknown): value is WireMessage {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { role?: unknown; text?: unknown };
  return typeof candidate.text === "string"
    && ROLES.includes(candidate.role as ConversationRole);
}

/**
 * Appends one message and returns the grown fork. The input fork is unchanged,
 * and the new fork's prefix hashes — seed, system, tools and every earlier
 * message — are the input's, unchanged: growth only ever adds at the end.
 */
export function appendMessage(fork: WireFork, message: WireMessage): WireFork {
  assertForkIntact(fork);
  if (!isMessage(message)) fail("invalid-message");
  const last = fork.messages[fork.messages.length - 1];
  // A user turn after a user turn is provider-legal and is exactly what a judge
  // ask does when main's last sent turn is the user's. Non-user turns must
  // alternate: two answers or two tool results in a row are refused.
  if (last !== undefined && last.role === message.role && message.role !== "user") {
    fail("role-conflict");
  }
  const added = deepCopy(message) as WireMessage;
  // The grown fork carries copies of the prefix messages too: a later write to
  // the previous fork's objects cannot change bytes the grown fork reports.
  const prefix = fork.messages.map(existing => deepCopy(existing) as WireMessage);
  return Object.freeze({
    ...fork,
    messages: Object.freeze([...prefix, added]),
    messageHashes: Object.freeze([...fork.messageHashes, hashMessage(added)]),
  });
}

/** Appends the next judge ask: one `user` message. */
export function appendAsk(fork: WireFork, text: string): WireFork {
  return appendMessage(fork, { role: "user", text });
}

/** Appends the judge's answer: one `assistant` message. */
export function appendVerdict(fork: WireFork, text: string): WireFork {
  return appendMessage(fork, { role: "assistant", text });
}
