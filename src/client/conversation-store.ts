/**
 * Conversation store (ticket 80, ADR-0020 slice 4): the turn-model reduction
 * from the host's session event window to a text-only transcript, plus the
 * per-session store the shell's main pane binds.
 *
 * THE SEAM (verified, `docs/research/wrapper-vehicle-seams.md` Finding 7;
 * file:line citations in ticket 80's Phase 1 comment): a session's replay
 * face is `sessions.binding(id).eventSource` — an
 * `ObservableSnapshot<SessionEventWindow>` whose `entries` fold history pages
 * and the live tail together, `hasMore` gates the scoped `loadOlder()`
 * pagination, and the window opens when the session is STAGED
 * (`sessions.open(id)`, which the shell's selection already rides — ticket
 * 79's `onOpen` hook). This module mirrors those shapes STRUCTURALLY (no
 * import from `@deepseek-ai/*` — the established discipline of
 * `shell-feed.ts`), so a runtime serving the verified face reads directly and
 * any deviation degrades honestly instead of lying.
 *
 * Turn-model reduction (the ticket's offline constraint: "turn-model
 * reduction from session/event-shaped payloads"). Over the window's entries
 * IN ORDER (single pass; the whole window is re-reduced per snapshot, so no
 * client-side attempt ledger exists — the host owns the window):
 * - `user/message` (its data IS the `UserMessage`) with
 *   `source.kind === "user"` → a user turn (text blocks joined verbatim).
 *   Other user-role sources (the host's synthetic injected context — file
 *   notices, skill content, goal rounds) are model-facing context, not the
 *   user's speech: SKIPPED, never rendered as the user's words (recorded
 *   gap, module tail).
 * - `assistant/message` → an assistant turn (text blocks joined; U-E keeps
 *   delivery text-only). `interrupted: true` is carried so the pane can say
 *   so; usage/model/stream records are outside the text-only minimum
 *   (recorded gap). An assistant message with NO text (a tool-call-only
 *   step) renders nothing — its tool rows carry the activity; an empty
 *   bubble would claim content that is not there.
 * - `assistant/live-chunk` transients → ONE streaming item per attempt:
 *   `text-delta` chunks accumulate in place (streaming-in-place assistant
 *   text); any other chunk still opens the attempt's row so the honest
 *   working state shows. The durable settlement supersedes the transients
 *   because the host REPLACES the attempt's transient rows in the window on
 *   settle (`contract/events.d.ts` settle-assistant) and this reduction
 *   recomputes from the full window — nothing to clean up client-side.
 * - `tool/call` + paired `tool/result` → ONE collapsible per-tool row keyed
 *   by `callId`, re-hosting ticket 24's toolview parsers
 *   (`describeToolview`) over `{args, result}`. `args` is the raw arguments
 *   JSON parsed; the result record is the tool's structured payload: a
 *   record-shaped `meta` when the tool attached one, else the first text
 *   block of the result message parsed as JSON (the serialized structured
 *   result) — a failure at either degrades to ticket 24's safe `degraded`
 *   row (never a fabricated field). The pairing identity is the result
 *   MESSAGE's `source.callId` (ToolMessageSource; the event data has no
 *   top-level callId), falling back to the first block's `toolCallId`. A
 *   call whose result has not landed renders as an unsettled row.
 * - everything else (`turn/*`, `step/*`, `request/*`, `system/message`,
 *   `assistant/attempt`, `session/end-seed`, unknown/plugin types) is
 *   log/derived-only: SKIPPED (U-C excludes timeline cards — the transcript
 *   is chat turns, not a log view; recorded gap). `turn/start`/`turn/end`
 *   feed only the derived running flag below.
 *
 * Worker results need no special path: delivery = the dispatcher speaking,
 * i.e. ordinary `assistant/message` events in THIS session's window (the
 * core's delivery obligation) — they render as ordinary assistant turns.
 *
 * Honest states (fail-closed, ticket 79's discipline): a window the store
 * cannot read (`entries` not an array) is `unavailable`, never an empty
 * transcript (empty and unreadable are different facts); a session with no
 * window yet is `waiting` (the host pulls on staging — latency is honest);
 * no binding face / no binding for the id is `unavailable`.
 *
 * Running state for the pane is DERIVED from the window (an open
 * `turn/start`, or any live transient row): pull-only, like every attention
 * signal here — no push seam is simulated.
 *
 * Pure data + view models, no React: offline tests drive reduction, store
 * transitions, and composer states end to end (S8); the component factory in
 * `shell.tsx` is covered by build + typecheck.
 */
import { describeToolview, type ToolviewModel } from "./toolviews.js";
import { SPAWN_WORKER_TOOL } from "../core/policy/prompts.js";
import {
  projectDispatchCard,
  type WorkerDispatchCard,
} from "./dispatch-card.js";

/** Minimal structural face of one durable session event (envelope + data). */
export interface ConversationEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

/**
 * One window entry: a durable event, or a client-only live-chunk transient
 * (`SessionEventLikeEntry`, `contract/events.d.ts:20-27`).
 */
export type ConversationEntryLike =
  | { readonly type: "event"; readonly event: ConversationEventLike }
  | { readonly type: "transient"; readonly event: ConversationEventLike };

/**
 * Minimal structural face of the event window (`SessionEventWindow`,
 * `contract/events.d.ts:56-61`). Absent fields degrade: `entries` not an
 * array marks the window unreadable, `hasMore` absent means `false`.
 */
export interface ConversationWindowLike {
  readonly entries?: readonly ConversationEntryLike[];
  readonly hasMore?: boolean;
  readonly revision?: number;
}

/** The source face: `ObservableSnapshot` (getSnapshot + subscribe). */
export interface ConversationSourceLike {
  getSnapshot(): ConversationWindowLike;
  subscribe(listener: () => void): () => void;
}

/** One transcript item; `seq` is the event's durable position (ordering). */
export type ConversationItem =
  | { readonly kind: "user"; readonly seq: number; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly seq: number;
      readonly text: string;
      readonly interrupted: boolean;
    }
  | {
      readonly kind: "assistant-streaming";
      readonly seq: number;
      /** The attempt id the transient rows belong to (stream grouping). */
      readonly attemptId: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool";
      readonly seq: number;
      readonly callId: string;
      readonly toolName: string;
      /** Ticket 24's re-hosted view model (detail fields or degraded). */
      readonly view: ToolviewModel;
      /**
       * Ticket 81: the presentation-time worker-dispatch card for a
       * `spawn_worker` record (ticket 69 §3.2) — projected from THIS item's
       * parsed args + structured result, so a replayed window yields the
       * identical card. `null` for every other tool, for an unsettled call,
       * and for records too malformed to name a spawn (the generic row
       * covers those — never a fabricated card).
       */
      readonly dispatch: WorkerDispatchCard | null;
      /** True when the paired result reported an error. */
      readonly failed: boolean;
      /** False until the paired `tool/result` arrives. */
      readonly settled: boolean;
    };

/** The reduced transcript: ordered items + pagination + derived running. */
export interface ConversationTranscript {
  readonly items: readonly ConversationItem[];
  /** Older history remains — the pane offers the scoped `loadOlder()`. */
  readonly hasMore: boolean;
  /**
   * Derived running state: an open `turn/start` or any live transient row.
   * Pull-only; the composer uses it for its honest busy affordance.
   */
  readonly running: boolean;
}

/** The store's per-session transcript state (honest states, module comment). */
export type ConversationState =
  | { readonly kind: "waiting" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly transcript: ConversationTranscript };

/** The store's immutable state: one transcript slot per known session. */
export interface ConversationStoreState {
  readonly transcripts: ReadonlyMap<string, ConversationState>;
  readonly version: number;
}

/** Narrow `value` to a plain record (arrays are not records here). */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Text of the text-shaped content blocks, narrowed defensively; "" if none. */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("");
}

/** `isError` of a tool-result message's FIRST block (the correlation one). */
function toolResultIsError(message: unknown): boolean {
  const record = asRecord(message);
  if (record === null || !Array.isArray(record.content)) return false;
  const first = asRecord(record.content[0]);
  return first?.isError === true;
}

/**
 * The correlation identity of a tool-result event: the result MESSAGE's
 * `source.callId` (ToolMessageSource), falling back to the first block's
 * `toolCallId`. `null` when neither is readable (the result pairs with
 * nothing — skipped, never attributed to a wrong call).
 */
function resultCallId(data: Record<string, unknown>): string | null {
  const message = asRecord(data.message);
  const source = asRecord(message?.source);
  if (typeof source?.callId === "string") return source.callId;
  const first = asRecord(
    Array.isArray(message?.content) ? message.content[0] : undefined,
  );
  if (typeof first?.toolCallId === "string") return first.toolCallId;
  return null;
}

/** Parse the raw arguments JSON of a tool call; junk narrows to null. */
function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * The structured result record for ticket 24's toolview parsers: a
 * record-shaped `meta` when the tool attached one, else the first text block
 * of the tool-result payload parsed as JSON (where the harness serializes
 * the tool's structured payload — nested in the tool-result block's inner
 * content). Anything else is `null` — the parsers degrade.
 */
function toolResultRecord(data: Record<string, unknown>): unknown {
  const meta = asRecord(data.meta);
  if (meta !== null) return meta;
  const message = asRecord(data.message);
  if (message === null || !Array.isArray(message.content)) return null;
  const firstJsonText = (blocks: unknown[]): unknown => {
    for (const block of blocks) {
      const record = asRecord(block);
      if (record === null || record.type !== "text") continue;
      const text = record.text;
      if (typeof text !== "string" || text.length === 0) continue;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null; // first text block is not JSON: no structured record
      }
    }
    return null;
  };
  for (const block of message.content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record.type === "tool-result" && Array.isArray(record.content)) {
      const parsed = firstJsonText(record.content);
      if (parsed !== null) return parsed;
      continue;
    }
    if (record.type === "text" && typeof record.text === "string") {
      // A bare text block at the message level (defensive: the same JSON
      // contract, one nesting shallower).
      const parsed = firstJsonText([record]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

/** The `source.kind` of a message record ("user" = the user's own words). */
function sourceKind(source: unknown): string | null {
  const record = asRecord(source);
  const kind = record?.kind;
  return typeof kind === "string" ? kind : null;
}

type ToolItem = Extract<ConversationItem, { kind: "tool" }>;
type StreamingItem = Extract<ConversationItem, { kind: "assistant-streaming" }>;

/**
 * Reduce one window's entries into the text-only transcript (pure; module
 * comment). A window without an array `entries` is unreadable → `null` (the
 * caller marks the session unavailable — empty and unreadable differ).
 */
export function reduceConversationWindow(
  window: ConversationWindowLike,
): ConversationTranscript | null {
  const entries = window.entries;
  if (!Array.isArray(entries)) return null;

  const items: ConversationItem[] = [];
  const streaming = new Map<string, StreamingItem>();
  const toolCalls = new Map<string, { item: ToolItem; args: unknown }>();
  const openTurns = new Set<number>();

  for (const entry of entries) {
    const event = entry?.event;
    if (
      event === null ||
      event === undefined ||
      typeof event !== "object" ||
      typeof event.type !== "string" ||
      typeof event.seq !== "number" ||
      !Number.isFinite(event.seq)
    ) {
      continue; // junk envelope: skipped, never normalized into a turn
    }
    const data = asRecord(event.data);

    if (entry.type === "transient") {
      // Live-chunk presentation: accumulate text per attempt, in place.
      const attemptId =
        typeof data?.attemptId === "string" ? data.attemptId : "?";
      const chunk = asRecord(data?.chunk);
      const delta =
        chunk !== null &&
        chunk.type === "text-delta" &&
        typeof chunk.text === "string"
          ? chunk.text
          : "";
      const existing = streaming.get(attemptId);
      if (existing !== undefined) {
        if (delta.length > 0) {
          const updated: StreamingItem = {
            ...existing,
            text: existing.text + delta,
            seq: event.seq,
          };
          streaming.set(attemptId, updated);
          const at = items.indexOf(existing);
          if (at >= 0) items[at] = updated;
        }
      } else {
        const created: StreamingItem = {
          kind: "assistant-streaming",
          seq: event.seq,
          attemptId,
          text: delta,
        };
        streaming.set(attemptId, created);
        items.push(created);
      }
      continue;
    }

    if (entry.type !== "event") continue; // unknown entry discriminator
    switch (event.type) {
      case "user/message": {
        // The event data IS the UserMessage (content + source at top level).
        if (data === null || sourceKind(data.source) !== "user") continue;
        items.push({
          kind: "user",
          seq: event.seq,
          text: textOfContent(data.content),
        });
        break;
      }
      case "assistant/message": {
        const message = data === null ? null : asRecord(data.message);
        if (message === null) continue; // malformed payload: skipped
        const text = textOfContent(message.content);
        if (text.length === 0) continue; // tool-call-only step: rows speak
        items.push({
          kind: "assistant",
          seq: event.seq,
          text,
          interrupted: data?.interrupted === true,
        });
        break;
      }
      case "tool/call": {
        if (data === null) continue;
        const callId = data.callId;
        const name = data.name;
        if (typeof callId !== "string" || typeof name !== "string") continue;
        const args = parseToolArguments(data.arguments);
        const item: ToolItem = {
          kind: "tool",
          seq: event.seq,
          callId,
          toolName: name,
          view: describeToolview(name, { args, result: null }),
          // No result yet: the dispatch card projects only from a settled
          // record (the row's own running state is the pending presentation).
          dispatch: null,
          failed: false,
          settled: false,
        };
        toolCalls.set(callId, { item, args });
        items.push(item);
        break;
      }
      case "tool/result": {
        if (data === null) continue;
        // Correlation identity: the tool-result MESSAGE carries it (its
        // `source.callId`, ToolMessageSource; mirrored by the first block's
        // `toolCallId`) — the event data itself has no top-level callId.
        const callId = resultCallId(data);
        if (callId === null) continue;
        const call = toolCalls.get(callId);
        if (call === undefined) continue; // result without a loaded call
        const resultRecord = toolResultRecord(data);
        const updated: ToolItem = {
          ...call.item,
          view: describeToolview(call.item.toolName, {
            args: call.args,
            result: resultRecord,
          }),
          // Ticket 81: spawn records additionally project the frozen
          // worker-dispatch card from their own args + result (pure in the
          // record → replay-safe; ticket 69 §3.2, C15 holds).
          dispatch:
            call.item.toolName === SPAWN_WORKER_TOOL
              ? projectDispatchCard({
                  callId,
                  args: call.args,
                  result: resultRecord,
                })
              : null,
          failed:
            toolResultIsError(data.message) ||
            (data.error !== undefined && data.error !== null),
          settled: true,
        };
        toolCalls.set(callId, { item: updated, args: call.args });
        const at = items.indexOf(call.item);
        if (at >= 0) items[at] = updated;
        break;
      }
      case "turn/start": {
        if (data !== null && typeof data.turn === "number") {
          openTurns.add(data.turn);
        }
        break;
      }
      case "turn/end": {
        if (data !== null && typeof data.turn === "number") {
          openTurns.delete(data.turn);
        }
        break;
      }
      default:
        break; // log/derived-only vocabulary: skipped (module comment)
    }
  }

  return {
    items,
    hasMore: window.hasMore === true,
    running: openTurns.size > 0 || streaming.size > 0,
  };
}

/** The store face the pane component binds through `useSyncExternalStore`. */
export interface ConversationStoreBox {
  readonly state: ConversationStoreState;
}

export interface ConversationStore {
  subscribe(listener: () => void): () => void;
  getBox(): ConversationStoreBox;
  /**
   * Apply one raw event-window snapshot for a session. A window without an
   * array `entries` marks the session `unavailable` (unreadable ≠ empty);
   * a well-formed window reduces to `ready`. Junk session ids are refused.
   */
  applyWindow(sessionId: string, window: ConversationWindowLike): void;
  /** Honest degrade: no readable window exists for this session. */
  markUnavailable(sessionId: string): void;
  /** The state for one session (`waiting` before the first window). */
  stateFor(sessionId: string): ConversationState;
}

export function createConversationStore(): ConversationStore {
  const transcripts = new Map<string, ConversationState>();
  let version = 0;
  let box: ConversationStoreBox = {
    state: { transcripts, version },
  };
  const listeners = new Set<() => void>();

  function emit(next: Map<string, ConversationState>): void {
    version += 1;
    box = { state: { transcripts: next, version } };
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getBox() {
      return box;
    },
    applyWindow(sessionId, window) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const transcript = reduceConversationWindow(window);
      const next = new Map(box.state.transcripts);
      next.set(
        sessionId,
        transcript === null
          ? ({ kind: "unavailable" } as const)
          : ({ kind: "ready", transcript } as const),
      );
      emit(next);
    },
    markUnavailable(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (box.state.transcripts.get(sessionId)?.kind === "unavailable") return;
      const next = new Map(box.state.transcripts);
      next.set(sessionId, { kind: "unavailable" });
      emit(next);
    },
    stateFor(sessionId) {
      return (
        box.state.transcripts.get(sessionId) ??
        ({ kind: "waiting" } as const)
      );
    },
  };
}
