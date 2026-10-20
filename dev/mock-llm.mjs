// dev/mock-llm.mjs — local scripted model endpoint for offline end-to-end tests.
//
// dsh 0.2.1's DeepSeek provider speaks the Anthropic Messages wire protocol and
// always streams. Point it here with:
//
//   DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1
//   DEEPSEEK_API_KEY=<any non-empty literal>
//
// (`@deepseek-ai/dsh-llm-deepseek` resolves its endpoint from `$DEEPSEEK_BASE_URL`
// and its key from the credential ref `DEEPSEEK_API_KEY`; see `messagesApiRoot`
// and `resolveAdapterOptions` in that package. No other switch exists.)
//
// Scripting
// ---------
// MOCK_SCRIPT=<path to JSON> is an array of steps. Each step:
//   {
//     "match": {                       // optional; absent = matches any request
//       "systemIncludes": "text",      //   system prompt must contain text
//       "userIncludes": "text",        //   last user text must contain text
//       "hasToolResult": true,         //   request carries a tool_result block
//       "toolNames": ["a","b"]         //   ALL named tools must be offered
//     },
//     "say": "reply text",             // text block (default: "")
//     "tool": { "name": "x", "input": {} },  // one tool_use block
//     "thinking": "text",              // optional thinking block
//     "stop": "end_turn",              // stop_reason override
//     "delayMs": 0,                    // delay before the first SSE event
//     "chunks": 1,                     // split say into N text_delta events
//     "error": { "status": 401, "type": "authentication_error", "message": "..." }
//   }
// Unmatched steps are consumed in file order (queue semantics). A request that
// matches no remaining step is answered by MOCK_REPLY (default: a fixed line).
//
// Environment
// -----------
//   MOCK_PORT=0        listen port (0 = OS picks; the real URL is printed)
//   MOCK_HOST=127.0.0.1
//   MOCK_LOG=<path>    JSONL request log (one line per request)
//   MOCK_SCRIPT=<path> scripted steps (see above)
//   MOCK_REPLY=<text>  fallback text when no step matches
//   MOCK_SEED=<text>   fixed model id reported in message_start
//
// Protocol surface implemented: POST /v1/messages (SSE), GET /health.
// Every request is logged BEFORE the reply is written, including what the host
// sent (system tail, last user text, tool names, assistant text already in
// context), so a test can assert on host behavior without reading dsh internals.

import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HOST = process.env.MOCK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MOCK_PORT ?? 0);
const LOG = process.env.MOCK_LOG ?? '';
const FALLBACK = process.env.MOCK_REPLY ?? 'mock reply: acknowledged.';
const MODEL = process.env.MOCK_SEED ?? 'mock-model';
const SCRIPT_PATH = process.env.MOCK_SCRIPT ?? '';

const script = SCRIPT_PATH.length > 0 ? loadScript(SCRIPT_PATH) : [];
if (LOG.length > 0) mkdirSync(dirname(LOG), { recursive: true });

let seq = 0;

/** Read and validate the script file (fail loud — a broken script must not look like a pass). */
function loadScript(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`mock-llm: ${path} must be a JSON array of steps`);
  return raw.map((step, index) => {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw new Error(`mock-llm: script step ${index} must be an object`);
    }
    return { ...step, used: false };
  });
}

/** Text of a Messages `content` field (string or block array). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/** Which script step answers this request, if any. */
function pickStep(body) {
  const system = textOf(body.system);
  const last = body.messages?.at(-1);
  const lastUser = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user');
  const userText = textOf(lastUser?.content);
  const toolNames = new Set((body.tools ?? []).map((tool) => tool.name));
  const hasToolResult = (body.messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
  );
  for (let index = 0; index < script.length; index += 1) {
    const step = script[index];
    if (step.used) continue;
    const match = step.match ?? {};
    if (match.systemIncludes !== undefined && !system.includes(match.systemIncludes)) continue;
    if (match.userIncludes !== undefined && !userText.includes(match.userIncludes)) continue;
    if (match.hasToolResult !== undefined && hasToolResult !== match.hasToolResult) continue;
    if (match.toolNames !== undefined && !match.toolNames.every((name) => toolNames.has(name))) continue;
    step.used = true;
    return { step, index };
  }
  return { step: undefined, index: null };
}

/** Condensed view of the conversation, enough to assert a round trip. */
function conversationTail(messages) {
  return (messages ?? []).slice(-4).map((message) => ({
    role: message.role,
    text: textOf(message.content).slice(0, 400),
    toolCalls: Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_use').map((block) => block.name)
      : [],
    toolResults: Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id)
      : [],
  }));
}

function logRequest(entry) {
  if (LOG.length === 0) return;
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

/** SSE frame writer. */
function sse(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Split text into at most `count` near-equal pieces (deterministic). */
function chunkText(text, count) {
  const pieces = Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
  if (pieces <= 1 || text.length === 0) return [text];
  const size = Math.ceil(text.length / pieces);
  const out = [];
  for (let offset = 0; offset < text.length; offset += size) {
    out.push(text.slice(offset, offset + size));
  }
  return out;
}

/** Stream one Messages response from a resolved reply. */
async function streamReply(res, body, reply, id) {
  const blocks = [];
  if (reply.thinking !== undefined) blocks.push({ type: 'thinking', text: reply.thinking });
  if (reply.say !== undefined && reply.say !== '') blocks.push({ type: 'text', text: reply.say });
  if (reply.tool !== undefined) {
    if (typeof reply.tool.name !== 'string' || reply.tool.name.length === 0) {
      throw new Error('mock-llm: scripted tool needs a non-empty name');
    }
    blocks.push({ type: 'tool_use', name: reply.tool.name, input: reply.tool.input ?? {} });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: reply.say ?? '' });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Usage is derived from the request size so context meters see real growth.
  const inputTokens = Math.ceil(JSON.stringify([body.system, body.tools, body.messages]).length / 4);
  const outputTokens = Math.ceil(JSON.stringify(blocks).length / 4);
  sse(res, {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: body.model ?? MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });

  let index = 0;
  let usedTool = false;
  for (const block of blocks) {
    if (block.type === 'text') {
      sse(res, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of chunkText(block.text, reply.chunks ?? 1)) {
        if (piece.length === 0) continue;
        sse(res, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
      }
    } else if (block.type === 'thinking') {
      sse(res, {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      sse(res, { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.text } });
      sse(res, { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock' } });
    } else {
      usedTool = true;
      sse(res, {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `call-${id}-${index}`, name: block.name, input: {} },
      });
      sse(res, {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    sse(res, { type: 'content_block_stop', index });
    index += 1;
  }

  sse(res, {
    type: 'message_delta',
    delta: { stop_reason: reply.stop ?? (usedTool ? 'tool_use' : 'end_turn'), stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sse(res, { type: 'message_stop' });
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requests: seq }));
    return;
  }
  if (req.method !== 'POST' || !(req.url ?? '').endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found_error', message: `no route ${req.method} ${req.url}` } }));
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'body is not JSON' } }));
      return;
    }
    const id = `mock-${++seq}`;
    const picked = pickStep(body);
    const step = picked.step ?? {};
    const reply = {
      say: step.say ?? (step.error === undefined && step.tool === undefined ? FALLBACK : ''),
      tool: step.tool,
      thinking: step.thinking,
      stop: step.stop,
      chunks: step.chunks,
    };
    const system = textOf(body.system);
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const assistantBefore = (body.messages ?? [])
      .filter((m) => m.role === 'assistant')
      .map((m) => textOf(m.content))
      .join('\n');

    logRequest({
      seq,
      t: new Date().toISOString(),
      id,
      path: req.url,
      model: body.model ?? null,
      stream: body.stream === true,
      sessionId: req.headers['x-deepseek-harness-session-id'] ?? null,
      messages: body.messages?.length ?? 0,
      systemChars: system.length,
      systemTail: system.slice(-400),
      toolNames: (body.tools ?? []).map((tool) => tool.name),
      lastUserText: textOf(lastUser?.content).slice(0, 800),
      // Full-text copies for assertions. The truncated fields above are for
      // humans reading the JSONL; a probe that greps them fails whenever the
      // host injects a policy longer than the truncation, which it does.
      lastUserFull: textOf(lastUser?.content),
      systemFull: system,
      userTextsAll: (body.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => textOf(m.content)),
      assistantTextTail: assistantBefore.slice(-600),
      conversationTail: conversationTail(body.messages),
      scriptStep: picked.index,
      reply: {
        say: (reply.say ?? '').slice(0, 400),
        tool: reply.tool ? { name: reply.tool.name, input: reply.tool.input ?? {} } : null,
        stop: reply.stop ?? null,
        error: step.error ?? null,
      },
    });

    if (step.error !== undefined) {
      const status = Number(step.error.status ?? 500);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: step.error.type ?? 'api_error',
            message: step.error.message ?? 'mock error',
          },
        }),
      );
      return;
    }

    const delay = Number(step.delayMs ?? 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await streamReply(res, body, reply, id);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'api_error', message: String(error) } }));
      } else {
        res.end();
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  // One machine-readable line; the driver reads it to learn the real port.
  console.log(`mock-llm: http://${HOST}:${port}/v1`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
