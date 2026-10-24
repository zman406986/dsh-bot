/**
 * Wire-request parsing and canonical bytes (ISSUE-026 chunk 5, ADR-0010).
 *
 * Two shapes carry main's conversation here, and they differ: the runtime's
 * request OBJECT, which `main-wire.ts` captures from the `llm/stream`
 * waterfall (roles `user`/`assistant`/`tool`, blocks `text` and `tool-call`),
 * and a provider BODY, `{system, tools, messages}`, where blocks are typed
 * `text`, `tool_use` and `tool_result`, and a tool result keeps the wire's
 * `user` role. This module reads the body shape: each message becomes one
 * `{role, text}` turn, the shape the fork copies, and nothing else.
 *
 * - text blocks: their `text`, joined with no separator;
 * - `tool_use`: `[tool call <name> <input as canonical JSON>]`;
 * - `tool_result`: `[tool result <tool_use_id> <content text>]`;
 * - any other block type is refused, never dropped: a projection that lost a
 *   block silently would hash as if the body never carried it.
 *
 * A wire body carries a tool result under the `user` role, so a `user` message
 * whose blocks are all `tool_result` is read as the fork's `tool` role — the
 * inverse of `askWire`'s projection and the role the fork needs to keep its
 * appends alternating. A mixed message keeps its declared role.
 *
 * `canonicalWireRequest` is the exact preimage of core's `wireRequestHash`:
 * both call `canonicalManifestBytes` over `{system, tools, messages}`, so
 * `sha256Sync(toBytes(canonicalWireRequest(request)))` equals
 * `wireRequestHash(request)`. Keys sort, so tool-record key order cannot move
 * the hash; only the three fields are read, so bookkeeping keys cannot either.
 *
 * Determinism holds at this level: `parse(canonical(parse(body)))` is
 * byte-identical to `canonical(parse(body))`, and the committed fixture pins
 * it. What is NOT proven, and cannot be: that a body equals what main actually
 * sent. dsh's session log carries the request header and context, not the sent
 * body (ISSUE-026), so body-vs-log equality is checkable only against recorded
 * mock bodies like that fixture.
 */
import type { WireMessage, WireRequest, WireTool } from '@racoons/core';
import { canonicalManifestBytes, fromBytes } from '@racoons/core';

/** Why a payload is not a wire request. One code per malformed class. */
export type WireRequestParseErrorCode =
  | 'payload-not-object'
  | 'system-not-string'
  | 'tools-not-array'
  | 'tool-not-object'
  | 'tool-name-not-string'
  | 'tool-not-json'
  | 'messages-not-array'
  | 'message-not-object'
  | 'message-role-missing'
  | 'message-role-invalid'
  | 'message-content-invalid'
  | 'block-not-object'
  | 'block-type-unsupported'
  | 'block-text-not-string'
  | 'block-tool-invalid';

const MESSAGES: Readonly<Record<WireRequestParseErrorCode, string>> = {
  'payload-not-object': 'A wire request must be an object.',
  'system-not-string': 'A wire request system slot must be a string.',
  'tools-not-array': 'A wire request tool slot must be a list.',
  'tool-not-object': 'Every tool must be an object.',
  'tool-name-not-string': 'Every tool must carry a non-empty string name.',
  'tool-not-json': 'A tool must carry plain JSON data.',
  'messages-not-array': 'A wire request message slot must be a list.',
  'message-not-object': 'Every message must be an object.',
  'message-role-missing': 'Every message must carry a role.',
  'message-role-invalid': 'A message role must be user, assistant or tool.',
  'message-content-invalid': 'A message must carry a string text or a block list, not both.',
  'block-not-object': 'Every content block must be an object.',
  'block-type-unsupported': 'Only text, tool_use and tool_result blocks can be carried.',
  'block-text-not-string': 'A text block must carry string text.',
  'block-tool-invalid': 'A tool_use needs a name and a tool_result needs an id.',
};

/** One refusal from the parser: the code names the defect, the detail the place. */
export class WireRequestParseError extends Error {
  readonly code: WireRequestParseErrorCode;

  constructor(code: WireRequestParseErrorCode, detail: string) {
    super(`${MESSAGES[code]} ${detail}`);
    this.name = 'WireRequestParseError';
    this.code = code;
  }
}
function fail(code: WireRequestParseErrorCode, detail: string): never {
  throw new WireRequestParseError(code, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A deep copy of plain JSON data, so the canonical bytes never read a getter
 * twice and never meet a value JSON cannot encode: `undefined`, a non-finite
 * number, a class instance or a cycle is refused, under the caller's code. */
function jsonValue(value: unknown, code: WireRequestParseErrorCode, where: string,
  ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code, `${where} carries a non-finite number.`);
    return value;
  }
  if (value === undefined) fail(code, `${where} carries undefined; JSON cannot encode it.`);
  if (typeof value !== 'object') fail(code, `${where} carries a non-JSON value.`);
  if (ancestors.has(value)) fail(code, `${where} carries a cycle.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value as unknown[], (item: unknown, index: number) =>
        jsonValue(item, code, `${where}[${String(index)}]`, ancestors));
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(code, `${where} carries a non-plain object.`);
    }
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      copy[key] = jsonValue(source[key], code, `${where}.${key}`, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}
/** The canonical text of one JSON value, as core's bytes util renders it. */
function canonicalText(value: unknown, code: WireRequestParseErrorCode, where: string): string {
  return fromBytes(canonicalManifestBytes(jsonValue(value, code, where, new Set<object>())));
}

/** One tool: its name must be there, the rest is copied whole. */
function toolOf(value: unknown, index: number): WireTool {
  const where = `tools[${String(index)}]`;
  if (!isRecord(value)) fail('tool-not-object', `${where} is not an object.`);
  const name = value['name'];
  if (typeof name !== 'string' || name === '') {
    fail('tool-name-not-string', `${where} has no non-empty string name.`);
  }
  return jsonValue(value, 'tool-not-json', where, new Set<object>()) as WireTool;
}

/** A tool_result body: a string, or the text of its blocks. */
function resultText(content: unknown, where: string): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    fail('block-tool-invalid', `${where}.content is neither a string nor a block list.`);
  }
  return (content as unknown[]).map((block: unknown, index: number) =>
    blockText(block, `${where}.content[${String(index)}]`)).join('');
}

/** One content block projected to text; an unknown type is refused, not dropped. */
function blockText(value: unknown, where: string): string {
  if (!isRecord(value)) fail('block-not-object', `${where} is not an object.`);
  const type = value['type'];
  if (type === 'text') {
    const text = value['text'];
    if (typeof text !== 'string') fail('block-text-not-string', `${where} has non-string text.`);
    return text;
  }
  if (type === 'tool_use') {
    const name = value['name'];
    if (typeof name !== 'string' || name === '') fail('block-tool-invalid', `${where} has no name.`);
    const input = value['input'];
    const args = input === undefined ? '{}'
      : canonicalText(input, 'block-tool-invalid', `${where}.input`);
    return `[tool call ${name} ${args}]`;
  }
  if (type === 'tool_result') {
    const id = value['tool_use_id'];
    if (typeof id !== 'string' || id === '') fail('block-tool-invalid', `${where} has no id.`);
    return `[tool result ${id} ${resultText(value['content'], where)}]`;
  }
  fail('block-type-unsupported', `${where} has type ${String(type)}.`);
}

const ROLES: readonly string[] = Object.freeze(['user', 'assistant', 'tool']);

/** True for a non-empty block list whose every block is a `tool_result`. */
function isAllToolResults(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return (content as unknown[]).every((block: unknown) =>
    isRecord(block) && block['type'] === 'tool_result');
}

/** One message: a known role, and text from either the turn slot or its blocks. */
function messageOf(value: unknown, index: number): WireMessage {
  const where = `messages[${String(index)}]`;
  if (!isRecord(value)) fail('message-not-object', `${where} is not an object.`);
  const role = value['role'];
  if (role === undefined) fail('message-role-missing', `${where} has no role.`);
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    fail('message-role-invalid', `${where} has role ${String(role)}.`);
  }
  const text = value['text'];
  const content = value['content'];
  let rendered: string;
  if (text !== undefined || content === undefined) {
    if (typeof text !== 'string') fail('message-content-invalid', `${where} has no string text.`);
    if (content !== undefined) {
      fail('message-content-invalid', `${where} carries both text and content.`);
    }
    rendered = text;
  } else if (typeof content === 'string') {
    rendered = content;
  } else if (Array.isArray(content)) {
    rendered = (content as unknown[]).map((block: unknown, blockIndex: number) =>
      blockText(block, `${where}.content[${String(blockIndex)}]`)).join('');
  } else {
    fail('message-content-invalid', `${where}.content is neither a string nor a block list.`);
  }
  const carried = role === 'user' && isAllToolResults(content) ? 'tool' : role;
  return { role: carried as WireMessage['role'], text: rendered };
}

/**
 * Reads a wire-shaped body into the fork's request. Only `system`, `tools` and
 * `messages` are read; every other key of the body is ignored. `system` and
 * `tools` may be absent, a message must carry its role and its content, and
 * anything the projection cannot carry is a typed refusal.
 */
export function parseWireRequest(payload: unknown): WireRequest {
  if (!isRecord(payload)) fail('payload-not-object', 'The payload is not an object.');
  const system = payload['system'];
  if (system !== undefined && typeof system !== 'string') {
    fail('system-not-string', `The system slot has type ${typeof system}.`);
  }
  const toolsField = payload['tools'];
  if (toolsField !== undefined && !Array.isArray(toolsField)) fail('tools-not-array', 'tools is not a list.');
  const tools = (toolsField === undefined ? [] : toolsField as unknown[])
    .map((tool: unknown, index: number) => toolOf(tool, index));
  const messagesField = payload['messages'];
  if (!Array.isArray(messagesField)) fail('messages-not-array', 'messages is not a list.');
  const messages = (messagesField as unknown[])
    .map((message: unknown, index: number) => messageOf(message, index));
  return { system: system ?? '', tools, messages };
}
/** The canonical text of a wire request: exactly the bytes `wireRequestHash`
 * hashes, decoded as UTF-8. Two requests with the same three fields render the
 * same text whatever key order their objects happened to carry. */
export function canonicalWireRequest(request: WireRequest): string {
  return fromBytes(canonicalManifestBytes({
    system: request.system,
    tools: request.tools,
    messages: request.messages,
  }));
}
