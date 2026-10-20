/**
 * Deterministic microcompact wiring (ticket 124, accepted ADR-0029).
 *
 * ## Where this sits
 *
 * The pure decision and selection live in `src/core/microcompact.ts`. This
 * module is the only place that knows a host Session: it measures, projects the
 * current surface to the facts selection needs, applies the replacement pairs,
 * and writes the boundary marker.
 *
 * ## Trigger
 *
 * An `agent/pre-step` listener — the same hook the host's own compaction uses
 * (`dsh-compaction-basic/lib/index.js:839-855`) and the one ADR-0029 settles
 * on. It fires before every model request, so the pass lands before the request
 * it was decided for.
 *
 * - Usage: `ctx.tokenMeter.measure(session).totalTokens`
 *   (`dsh-token-meter/lib/index.js:722`) — synchronous, deterministic, derived
 *   from the session log per call, so no local usage ledger exists (ADR-0018
 *   U-H).
 * - Window: `session.requestContext()?.contextWindow` — the route capacity the
 *   adapter resolved for this session and the loop logged durably
 *   (`dsh-llm-deepseek/lib/index.js:510-523`,
 *   `dsh-agent-loop/lib/index.js:1262-1271`). `contextPressure.contextWindow`
 *   is deliberately NOT read (not one atomic observation; ADR-0029 §Settled
 *   window source).
 *
 * ## What a pass writes
 *
 * Per cleared node, in one synchronous block, exactly the native pruner's
 * protocol (`dsh-compaction-tool-result-pruner/lib/index.js:189-200`):
 *
 * 1. `compaction/prune { shadowedRange, shadowedSeqs: [seq], shadowedTokenCount }`
 *    — the shadow price the O(1) pressure projections subtract, priced with the
 *    meter's own heuristic;
 * 2. a replacement `tool/result` keeping every original field except `content`,
 *    with `surfaceOp { op: "replace", startSeq: seq, endSeq: seq }` and
 *    `sourceEventSeqs: [seq]`.
 *
 * Pairing stays intact: the replacement is the same role and the same
 * `source.callId`, and every replacement is a single-node replace, so a tool
 * call and its result are never separated.
 *
 * ## Conflict with native dsh compaction
 *
 * Native `compaction-basic` and our pass both listen on `agent/pre-step`, and
 * both mutate the surface. Three rules keep them from fighting:
 *
 * 1. **Our ratio fires first.** 0.55 × window sits below the native threshold
 *    on every default config (0.8 × window, further reduced by the reserved
 *    completion and the headroom). Native only looks at the surface after we
 *    have run.
 * 2. **We never touch native's lock.** We write no `compaction/start`; the
 *    native lock remains exclusively native's (`dsh-compaction-basic`,
 *    `:454`). We do read it: while an unmatched `compaction/start` is open, the
 *    surface is being rewritten by native and this pass declines with
 *    `native-compaction-active`.
 * 3. **We take no lock of our own and no model call.** Our replacement pairs
 *    are individually complete, so native may summarize a node we already
 *    replaced (it is an ordinary priced surface node), and a crash mid-pass
 *    leaves a consistent surface with no boundary row — the next pass
 *    re-evaluates.
 *
 * ## Failure posture
 *
 * Every host read is guarded. An unavailable measurement, an unavailable or
 * implausible window, a missing store, or a missing surface projection all
 * decline with a reason and write nothing. A throw inside the listener is
 * caught and logged; it never fails the step. This follows the native
 * listener's own posture (`:842-851`: a failed compaction logs and continues
 * the turn).
 */

import {
  CLEARED_TOOL_RESULT_TEXT,
  MICROCOMPACT_KEEP_NEWEST,
  MICROCOMPACT_MIN_SAVING_TOKENS,
  MICROCOMPACT_TRIGGER_RATIO,
  isClearedToolResultContent,
  selectToolResultsToClear,
  shouldMicrocompact,
  utf8ByteLength,
  type MicrocompactSurfaceNode,
} from "../core/microcompact.js";
import type { CompactionBoundary } from "../core/durability.js";
import type { ContentBlock } from "./content-blocks.js";

/** Event name the listener registers on. */
export const MICROCOMPACT_EVENT = "agent/pre-step";

/**
 * Why a pre-step pass did nothing. Every value is a distinct, stated reason —
 * the design constraint is "fail safe, with a reason", never a silent no-op.
 */
export type MicrocompactSkipReason =
  | "disabled"
  | "no-session"
  | "no-token-meter"
  | "no-boundary-store"
  | "no-surface"
  | "window-unavailable"
  | "window-implausible"
  | "usage-unavailable"
  | "ratio-implausible"
  | "below-threshold"
  | "native-compaction-active"
  | "nothing-eligible"
  | "insufficient-saving"
  | "invalid-keep"
  | "threw";

/** What one pre-step invocation concluded. */
export interface MicrocompactPassOutcome {
  readonly compacted: boolean;
  /**
   * Why. `ratio-met` when the trigger agreed (whether or not selection then
   * found work — `compacted` says which).
   */
  readonly reason: MicrocompactSkipReason | "ratio-met";
  /** How many tool results this pass cleared; 0 when `compacted` is false. */
  readonly clearedCount: number;
  /** Heuristic tokens freed; 0 when nothing was cleared. */
  readonly freedTokens: number;
  /** The boundary row written by this pass, when it wrote one. */
  readonly boundary: CompactionBoundary | null;
}

/** Structural view of one surface event node. */
interface SessionEventLike {
  readonly type: string;
  readonly data?: unknown;
  readonly seq?: number;
}

/** Structural view of the parts of a dsh Session this module reads. */
export interface MicrocompactSessionLike {
  readonly id: unknown;
  readonly seq: number;
  readonly surface: { readonly nodes: readonly number[] };
  eventAt(seq: number): SessionEventLike | undefined;
  requestContext?(): { readonly contextWindow?: number } | undefined;
  append(
    type: string,
    data: unknown,
    opts?: unknown,
  ): { readonly seq: number };
}

/** Structural view of `ctx.tokenMeter` (only `measure` + `estimateMessage`). */
export interface TokenMeterLike {
  measure(session: unknown): {
    readonly totalTokens: number;
    readonly nodes: readonly {
      readonly seq: number;
      readonly tokens: number;
      readonly heuristicTokens: number;
    }[];
  };
  estimateMessage(message: unknown): number;
}

/** Structural view of the Agent the pre-step payload carries. */
export interface MicrocompactAgentLike {
  readonly session: MicrocompactSessionLike;
}

/** The boundary store surface this module needs. */
export interface BoundaryStoreLike {
  writeCompactionBoundary(boundary: CompactionBoundary): void | Promise<void>;
  readCompactionBoundary(
    sessionId: string,
  ):
    | CompactionBoundary
    | undefined
    | Promise<CompactionBoundary | undefined>;
}

/** Options for {@link installMicrocompact}. */
export interface MicrocompactOptions {
  /** `false` disables the listener entirely (the Config switch, read once). */
  readonly enabled: boolean;
  /** Trigger ratio in (0, 1]; defaults to {@link MICROCOMPACT_TRIGGER_RATIO}. */
  readonly ratio?: number;
  /** Newest tool results that survive; defaults to {@link MICROCOMPACT_KEEP_NEWEST}. */
  readonly keepNewest?: number;
  /** Smallest useful pass in heuristic tokens. */
  readonly minSavingTokens?: number;
  /**
   * Gate: only sessions this returns true for are compacted. The plugin passes
   * the dispatcher-activation predicate so ordinary chats are never rewritten.
   */
  readonly shouldHandle?: (sessionId: string) => boolean;
  /** The plugin's debug sink (never fatal). */
  readonly onOutcome?: (outcome: MicrocompactPassOutcome) => void;
  /** Epoch-ms clock, injectable for tests. */
  readonly now?: () => number;
  /**
   * Monotonic pass counter source, injectable for tests. Defaults to the
   * previous boundary's `passSeq + 1` (read from the store), starting at 1.
   */
  readonly nextPassSeq?: (
    previous: CompactionBoundary | undefined,
  ) => number;
}

/**
 * Structural context surface the installer needs.
 *
 * `tokenMeter` is optional and read through {@link MicrocompactOptions}, not
 * here: the meter is mounted on the host plane (`dsh-base/cordis.patch.yml:348`)
 * and a Cordis context without it in its inject list THROWS on direct property
 * access, so the caller supplies a guarded getter.
 */
export interface MicrocompactContextLike {
  on(name: string, listener: (...args: never[]) => unknown): (() => void) | unknown;
}

/**
 * Project one current surface node to what selection needs, reading the node's
 * EVENT (a replacement node carries its own seq; the original is shadowed).
 */
function projectNode(
  session: MicrocompactSessionLike,
  seq: number,
  pricedTokens: number,
  meter: TokenMeterLike,
): MicrocompactSurfaceNode | null {
  const event = session.eventAt(seq);
  if (event === undefined) return null;
  const role =
    event.type === "tool/result"
      ? "tool"
      : event.type === "user/message"
        ? "user"
        : event.type === "assistant/message"
          ? "assistant"
          : event.type === "system/message"
            ? "system"
            : event.type === "developer/message"
              ? "developer"
              : null;
  if (role === null) return null;

  if (role !== "tool") {
    return {
      seq,
      role,
      tokens: pricedTokens,
      clearedTokens: pricedTokens,
      alreadyCleared: false,
    };
  }

  const data = event.data as { message?: { content?: readonly unknown[] } } | undefined;
  const content = data?.message?.content;
  if (isClearedToolResultContent(content)) {
    return {
      seq,
      role,
      tokens: pricedTokens,
      clearedTokens: pricedTokens,
      alreadyCleared: true,
    };
  }
  // Price the placeholder exactly the way the meter prices any message, so the
  // saving we record is the meter's own number (the shadow price uses the same
  // estimator). Only `role` and `content` are read by the estimator.
  const clearedTokens = meter.estimateMessage({
    role: "tool",
    content: [{ type: "text", text: CLEARED_TOOL_RESULT_TEXT }],
  });
  return {
    seq,
    role,
    tokens: pricedTokens,
    clearedTokens,
    alreadyCleared: false,
  };
}

/** Total character count of a tool result's JSON content (audit figure). */
function contentChars(content: readonly unknown[] | undefined): number {
  if (content === undefined) return 0;
  let chars = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      chars += record["text"].length;
    } else {
      // Non-text blocks (images, structured results): count their serialized
      // size so the audit number is honest about what was dropped.
      try {
        chars += JSON.stringify(block).length;
      } catch {
        // A non-serializable block contributes nothing to the char count.
      }
    }
  }
  return chars;
}

/**
 * True when the session log shows an unmatched `compaction/start` — native
 * compaction owns the surface right now. Mirrors native's own
 * `inspectCompactionEntryState` (`dsh-compaction-basic/lib/index.js:704-736`):
 * scan backwards for the newest `compaction/start` / `compaction/end` pair; an
 * unmatched start older than the newest `session/end-seed` is settled and no
 * longer active. `session/end-seed` also bounds the scan to this lifecycle.
 */
function nativeCompactionActive(session: MicrocompactSessionLike): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === "compaction/start") return true;
    if (event.type === "compaction/end") return false;
    // A restore boundary settles any earlier unmatched opening marker.
    if (event.type === "session/end-seed") return false;
  }
  return false;
}

/** Read the session id as a string (the boundary key). */
function sessionIdOf(session: MicrocompactSessionLike): string | null {
  const id = session.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

/** Outcome helper: a declined pass. */
function declined(
  reason: MicrocompactSkipReason,
  freedTokens = 0,
): MicrocompactPassOutcome {
  return {
    compacted: false,
    reason,
    clearedCount: 0,
    freedTokens,
    boundary: null,
  };
}

/**
 * Run one pass against the given session. Exported for tests so the whole
 * measure → decide → select → apply → record chain is provable without a
 * Cordis bus.
 */
export async function runMicrocompactPass(
  options: MicrocompactOptions,
  meter: TokenMeterLike | undefined,
  store: BoundaryStoreLike | undefined,
  session: MicrocompactSessionLike,
): Promise<MicrocompactPassOutcome> {
  if (!options.enabled) return declined("disabled");
  if (meter === undefined) return declined("no-token-meter");
  if (store === undefined) return declined("no-boundary-store");

  const sessionId = sessionIdOf(session);
  if (sessionId === null) return declined("no-session");
  if (options.shouldHandle !== undefined && !options.shouldHandle(sessionId)) {
    return declined("disabled");
  }

  // 1. Window from the durable request context — the same value the loop will
  //    use for the request it is about to make.
  const requestedWindow = session.requestContext?.()?.contextWindow;
  // 2. Measurement from the meter (deterministic, derived per call).
  let usedTokens: number;
  let nodePrices: ReadonlyMap<number, number>;
  try {
    const measured = meter.measure(session);
    usedTokens = measured.totalTokens;
    nodePrices = new Map(measured.nodes.map((node) => [node.seq, node.tokens]));
  } catch {
    return declined("usage-unavailable");
  }

  const decision = shouldMicrocompact({
    usedTokens,
    windowTokens: requestedWindow,
    ratio: options.ratio ?? MICROCOMPACT_TRIGGER_RATIO,
  });
  if (!decision.compact) {
    // Map the pure decision's reason onto this module's vocabulary.
    if (decision.reason === "window-unavailable") return declined("window-unavailable");
    if (decision.reason === "window-implausible") return declined("window-implausible");
    if (decision.reason === "usage-unavailable") return declined("usage-unavailable");
    if (decision.reason === "ratio-implausible") return declined("ratio-implausible");
    return declined("below-threshold");
  }

  // 3. Never fight native: an open native compaction owns the surface.
  if (nativeCompactionActive(session)) {
    return declined("native-compaction-active");
  }

  // 4. Project the CURRENT surface; a node the meter priced but cannot be read
  //    is skipped rather than guessed. `surface.nodes` is a live array, so the
  //    projection loop walks a snapshot.
  const nodes: MicrocompactSurfaceNode[] = [];
  for (const seq of [...session.surface.nodes]) {
    const priced = nodePrices.get(seq);
    if (priced === undefined) continue;
    const node = projectNode(session, seq, priced, meter);
    if (node !== null) nodes.push(node);
  }
  if (nodes.length === 0) return declined("no-surface");

  const keepNewest = options.keepNewest ?? MICROCOMPACT_KEEP_NEWEST;
  const selection = selectToolResultsToClear(nodes, {
    keepNewest,
    minSavingTokens: options.minSavingTokens ?? MICROCOMPACT_MIN_SAVING_TOKENS,
  });
  if (selection.reason === "invalid-keep") return declined("invalid-keep");
  if (selection.reason === "nothing-eligible") return declined("nothing-eligible");
  if (selection.reason === "insufficient-saving") {
    return declined("insufficient-saving", selection.freedTokens);
  }

  // 5. Apply. One `compaction/prune` + replacement pair per node, synchronous
  //    and adjacent — the shadow-price protocol. Selection ran against the
  //    current surface, and every replacement is a single-node replace, so the
  //    surface positions of nodes we have not reached yet are untouched.
  const now = options.now ?? Date.now;
  const clearedSeqs: number[] = [];
  const replacementSeqs: number[] = [];
  let clearedChars = 0;
  let clearedBytes = 0;
  let boundarySeq = -1;

  for (const node of selection.selected) {
    const event = session.eventAt(node.seq);
    if (event === undefined || event.type !== "tool/result") continue;
    const data = event.data as
      | { message?: { content?: readonly unknown[] } }
      | undefined;
    const originalContent = data?.message?.content;
    clearedChars += contentChars(originalContent);
    if (originalContent !== undefined) {
      for (const block of originalContent) {
        if (typeof block !== "object" || block === null) continue;
        const record = block as Record<string, unknown>;
        if (record["type"] === "text" && typeof record["text"] === "string") {
          clearedBytes += utf8ByteLength(record["text"]);
        }
      }
    }

    const replacementMessage = {
      ...(data?.message ?? {}),
      content: [{ type: "text", text: CLEARED_TOOL_RESULT_TEXT }],
    };

    session.append("compaction/prune", {
      shadowedRange: { start: node.seq, end: node.seq },
      shadowedSeqs: [node.seq],
      shadowedTokenCount: node.tokens,
    });
    const replacement = session.append(
      "tool/result",
      { ...(data ?? {}), message: replacementMessage },
      {
        surfaceOp: { op: "replace", startSeq: node.seq, endSeq: node.seq },
        sourceEventSeqs: [node.seq],
      },
    );
    clearedSeqs.push(node.seq);
    replacementSeqs.push(replacement.seq);
    boundarySeq = replacement.seq;
  }

  // Nothing landed (every selected node changed shape between projection and
  // apply). Decline honestly instead of writing an empty boundary.
  if (clearedSeqs.length === 0) return declined("nothing-eligible");

  // 6. One rollback unit: the boundary row is written ONLY now, after every
  //    replacement landed, and it describes exactly what was replaced. Either
  //    the whole boundary is present or no compaction is recorded.
  //
  //    Ordering is deliberate: the surface appends are synchronous and cannot
  //    be undone, so writing the row first could record a pass that then
  //    failed to land (a FALSE success marker, the worse error). Written
  //    second, a crash or a failed store write leaves the pass unrecorded —
  //    resume then sees "no compaction" and the next pass detects the already
  //    cleared nodes and skips them. A store failure still propagates so the
  //    listener reports `threw` instead of pretending it succeeded.
  const previous = await Promise.resolve(
    store.readCompactionBoundary(sessionId),
  ).catch(() => undefined);
  const passSeq =
    options.nextPassSeq !== undefined
      ? options.nextPassSeq(previous)
      : (previous?.passSeq ?? 0) + 1;
  const boundary: CompactionBoundary = {
    sessionId,
    passSeq,
    status: "applied",
    layer: "microcompact",
    trigger: "ratio",
    ratio: options.ratio ?? MICROCOMPACT_TRIGGER_RATIO,
    keepNewest,
    usedTokens,
    windowTokens: requestedWindow as number,
    thresholdTokens: decision.thresholdTokens ?? 0,
    clearedSeqs,
    replacementSeqs,
    boundarySeq,
    clearedCount: clearedSeqs.length,
    clearedChars,
    clearedBytes,
    freedTokens: selection.freedTokens,
    updatedAtMs: now(),
  };
  await store.writeCompactionBoundary(boundary);

  return {
    compacted: true,
    reason: "ratio-met",
    clearedCount: clearedSeqs.length,
    freedTokens: selection.freedTokens,
    boundary,
  };
}

/**
 * Register the pre-step listener. Returns the disposer; the caller owns it
 * through the usual `ctx.effect` contract.
 *
 * `resolveMeter` is a guarded getter: the meter lives on the host plane, and a
 * Cordis context that did not declare it throws on direct access, so the
 * plugin wraps that read. A missing meter declines the pass with a reason.
 */
export function registerMicrocompact(
  ctx: MicrocompactContextLike,
  options: MicrocompactOptions,
  store: BoundaryStoreLike | undefined,
  resolveMeter: () => TokenMeterLike | undefined,
): () => void {
  if (!options.enabled) return () => {};

  const report = (outcome: MicrocompactPassOutcome): void => {
    try {
      options.onOutcome?.(outcome);
    } catch {
      // A broken sink must never break the turn.
    }
  };

  const listener = async (
    payload: never,
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const { agent } = payload as unknown as { agent?: MicrocompactAgentLike };
    const session = agent?.session;
    if (session === undefined) {
      report(declined("no-session"));
      return next();
    }
    try {
      const outcome = await runMicrocompactPass(
        options,
        resolveMeter(),
        store,
        session,
      );
      report(outcome);
    } catch {
      // Native's own posture: a failed automatic pass logs and continues the
      // turn. Ours writes nothing on failure.
      report(declined("threw"));
    }
    return next();
  };

  const disposer = ctx.on(MICROCOMPACT_EVENT, listener as never);
  return typeof disposer === "function"
    ? (disposer as () => void)
    : () => {};
}
