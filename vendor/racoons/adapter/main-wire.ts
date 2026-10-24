/**
 * Capturing main's outgoing request (ISSUE-026 chunk 3, ADR-0010).
 *
 * What this seam sees, stated exactly: the host's `llm/stream` waterfall hands a
 * listener the request OBJECT the runtime is about to dispatch — the object the
 * agent loop assembled, deep-frozen when the loop built it — before the provider
 * adapter maps it to an HTTP body. It does NOT hand over those HTTP bytes, and
 * no code in this package ever sees them. So the capture is the dispatched
 * request, not the provider wire: system, tools and messages in the exact object
 * the runtime received, before any adapter reshaping (role merging, tool-role
 * rewriting, header assembly). A capture point at the adapter boundary is what
 * would make this byte-exact; `captureMainRequest` is the one function such a
 * point would replace.
 *
 * The shape taken from that object:
 *
 * - `system` is the request's own system slot, copied as it stands — empty when
 *   the caller set none. A loop-built request carries its prompt as the leading
 *   `system`-role message; that message STAYS a message at index 0, so the
 *   fork's list starts where main's did. The old capture lifted it into the slot
 *   and dropped it from the list, which diverged at the first message
 *   (CRITIC-026 chunk B).
 * - `tools` is the request's tool schema list, copied whole.
 * - every message whose role is `system`, `user`, `assistant` or `tool` stays a
 *   message, in order: its text blocks joined, a tool-call block rendered as one
 *   bracketed line. Non-text blocks and roles the fork cannot carry (`developer`,
 *   anything unknown) are counted as dropped, never invented.
 *
 * A request this package sent itself (a judge or prune ask) is skipped: it is
 * not main, and seeding from it would replay the wrong conversation.
 *
 * So is a request the host stamped `purpose: 'session-title'` (ISSUE-031): the
 * title call is a second async request carrying the same session id, one
 * system prompt and no tools. It is not main's conversation, and taking it as
 * main's last request seeds the next fork from the title prompt instead of the
 * conversation. Skipping it leaves the previous main request in place; a
 * session that has sent only a title request has no seed at all.
 */
import type { Sha256, WireMessage, WireRequest, WireTool } from '@racoons/core';
import { wireRequestHash } from '@racoons/core';
import { isRacoonsAskRequest } from './llm-ask.js';

/** One captured request, plus what the capture had to drop to shape it. */
export interface CapturedMainRequest {
  readonly wire: WireRequest;
  readonly seedHash: Sha256;
  /**
   * Always false since CRITIC-026 chunk B: the capture no longer lifts a leading
   * `system` message into the slot, so the slot never comes from a message. Kept
   * because the `judge-seed` journal line names it.
   */
  readonly systemFromMessage: boolean;
  readonly droppedMessages: number;
  readonly droppedBlocks: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One message's text, block by block, counting what the fork cannot carry. */
function messageText(content: unknown): { text: string; dropped: number } {
  if (!Array.isArray(content)) return { text: '', dropped: 0 };
  const parts: string[] = [];
  let dropped = 0;
  for (const block of content) {
    if (!isRecord(block)) { dropped += 1; continue; }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
      continue;
    }
    if (block['type'] === 'tool-call') {
      const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
      const args = typeof block['arguments'] === 'string' ? block['arguments'] : '';
      parts.push(`[tool call ${name} ${args}]`);
      continue;
    }
    dropped += 1;
  }
  return { text: parts.join(''), dropped };
}

/** The roles the seed carries as messages, copied where main put them. */
const SEED_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Main's role, copied verbatim. The fork's `WireMessage` role is the judge
 * history's vocabulary — `user`, `assistant`, `tool` — and has no `system`,
 * while main's list can carry one. Nothing in the fork reads a role on seed (it
 * copies and hashes the message) and the send seam passes the role through, so
 * this is a type-level narrowing, not a reshape: widening the core role union is
 * a separate change.
 */
function seedRole(role: string): WireMessage['role'] {
  return role as WireMessage['role'];
}

/**
 * Normalize one outgoing request into the fork's seed shape, or `null` when the
 * value is not a shaped request at all. The hash is taken over exactly the
 * three fields the fork copies, so bookkeeping keys cannot move it.
 */
export function captureMainRequest(options: unknown): CapturedMainRequest | null {
  if (!isRecord(options)) return null;
  if (isRacoonsAskRequest(options)) return null;
  // dsh stamps an auxiliary call with the purpose it serves; a session-title
  // call is not main's conversation and must not become the fork's seed.
  if (options['purpose'] === 'session-title') return null;
  const messages = options['messages'];
  if (!Array.isArray(messages)) return null;
  const tools = Array.isArray(options['tools'])
    ? (options['tools'] as unknown[]).filter(isRecord) as unknown as WireTool[] : [];
  const system = typeof options['system'] === 'string' ? options['system'] : '';
  let droppedMessages = 0;
  let droppedBlocks = 0;
  const turns: WireMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) { droppedMessages += 1; continue; }
    const role = message['role'];
    // A `system`-role message is main's prompt or main's state; either way it
    // stays a message in the list. The raw list is preserved: no lift, no drop.
    if (typeof role !== 'string' || !SEED_ROLES.has(role)) {
      droppedMessages += 1;
      continue;
    }
    const read = messageText(message['content']);
    droppedBlocks += read.dropped;
    turns.push({ role: seedRole(role), text: read.text });
  }
  const wire: WireRequest = { system, tools, messages: turns };
  return { wire, seedHash: wireRequestHash(wire), systemFromMessage: false,
    droppedMessages, droppedBlocks };
}

/** The per-session store of the last request main dispatched. */
export interface MainWireCapture {
  /** Called from the `llm/stream` observer; a request this package sent is skipped. */
  note(options: unknown): void;
  /** The last captured request for a session, or null when none was seen. */
  last(sessionId: string): CapturedMainRequest | null;
}

/**
 * A capture store keyed by the session id the request was stamped with. The
 * loop stamps every main request, so the map holds one entry per conversation.
 * A request with no session id is ignored: without the key, a judge pass could
 * only guess whose conversation it is holding.
 */
export function createMainWireCapture(): MainWireCapture {
  const bySession = new Map<string, CapturedMainRequest>();
  return {
    note(options) {
      const captured = captureMainRequest(options);
      if (captured === null) return;
      if (!isRecord(options)) return;
      const id = options['sessionId'];
      if (typeof id !== 'string' || id === '') return;
      bySession.set(id, captured);
    },
    last(sessionId) {
      return bySession.get(sessionId) ?? null;
    },
  };
}
