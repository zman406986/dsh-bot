/**
 * Deterministic microcompact (ticket 124, accepted ADR-0029).
 *
 * ## What this layer is
 *
 * When measured context usage crosses a fixed ratio of the advertised window,
 * clear the CONTENT of old tool results — nothing else — and record the pass
 * as a durable boundary marker. No model decides anything here: the same
 * measured usage and the same surface always produce the same decision and the
 * same resulting list (ADR-0029 decision 1).
 *
 * ## What it never touches
 *
 * - system text, developer text, user messages, assistant text (decision 5:
 *   microcompact clears tool results only);
 * - the injected prompt tail (the peer roster lives there, ADR-0027);
 * - the newest {@link MICROCOMPACT_KEEP_NEWEST} tool results — the working set
 *   the dispatcher is actually reading from;
 * - anything already cleared (the pass is idempotent by construction).
 *
 * ## Constants and why
 *
 * - **Ratio 0.55 of the advertised window.** Native `compaction-basic` fires
 *   at `floor(min(W × 0.8, W − reservedCompletion − headroom))`
 *   (`dsh-compaction-basic/lib/index.js:124-134`); on the live route
 *   (W = 1,000,000, maxTokens = 256,000, headroom = 65,536) that is 678,464.
 *   0.55 × W lands at 550,000 — below the native summary, so this model-free
 *   pass gets its chance first. It also matches the placement proposed in
 *   `docs/research/compaction-stack-design-2026-10-19.md` §L1
 *   (0.80 × native threshold = 542,771) while staying a plain fraction of the
 *   advertised window and therefore independent of host config.
 * - **Keep newest 5.** ZCode's precedent, cited in ADR-0029's context.
 * - **Minimum saving 8,192 heuristic tokens.** Every pass rewrites the surface
 *   from the oldest cleared node onward, which invalidates the provider prefix
 *   cache downstream of it. Below ~1.2% of the native threshold the rebuild
 *   costs more than the context it frees, so a pass that cannot clear at least
 *   this much does not run at all.
 *
 * Nothing in this module imports a host package: it is pure arithmetic over
 * caller-supplied numbers and surface facts.
 */

/**
 * Fraction of the advertised context window that triggers a pass.
 *
 * Chosen against the native threshold, not against a bare guess: see the
 * module doc. Raising it past ~0.678 would let the native summarizer win the
 * race; lowering it toward 0.5 would run routine pass rewrites during ordinary
 * work.
 */
export const MICROCOMPACT_TRIGGER_RATIO = 0.55;

/** Newest tool results that always survive a pass. */
export const MICROCOMPACT_KEEP_NEWEST = 5;

/**
 * Smallest useful pass, in heuristic tokens. A pass that cannot free this much
 * is not worth the cache invalidation it causes.
 */
export const MICROCOMPACT_MIN_SAVING_TOKENS = 8_192;

/**
 * What a cleared tool result is replaced with. One fixed line, no ids, no
 * summary: the model is told the content was dropped to save context, and the
 * full output stays in the append-only session log (never indexed by us —
 * ADR-0018 U-H).
 */
export const CLEARED_TOOL_RESULT_TEXT =
  "[old tool result cleared to save context; the full output remains in the session log]";

/**
 * A replacement message carrying only {@link CLEARED_TOOL_RESULT_TEXT} is a
 * cleared result. Used to keep a repeated pass idempotent: an already-cleared
 * node is never eligible again.
 */
export function isClearedToolResultContent(
  content: readonly unknown[] | undefined,
): boolean {
  if (content === undefined || content.length !== 1) return false;
  const block = content[0];
  if (typeof block !== "object" || block === null) return false;
  const record = block as Record<string, unknown>;
  return record["type"] === "text" && record["text"] === CLEARED_TOOL_RESULT_TEXT;
}

/** Why a decision declined to compact (or that it accepted). */
export type MicrocompactReason =
  /** Usage is at or above the ratio threshold; a pass is due. */
  | "ratio-met"
  /** Usage is below the threshold; nothing to do. */
  | "below-threshold"
  /** No window was reported (`requestContext()` had none). */
  | "window-unavailable"
  /** The reported window is 0, negative, NaN, or infinite — never guess. */
  | "window-implausible"
  /** The measured usage is NaN, infinite, or negative — never guess. */
  | "usage-unavailable"
  /** The configured ratio is outside (0, 1] or not finite. */
  | "ratio-implausible";

/** Inputs to the deterministic trigger. */
export interface MicrocompactInput {
  /** Measured request pressure, e.g. `tokenMeter.measure(session).totalTokens`. */
  readonly usedTokens: number | null | undefined;
  /**
   * The advertised route capacity — `session.requestContext()?.contextWindow`
   * (durable `request/context`, `dsh-agent-loop/lib/index.js:1262-1271`).
   * NOT `contextPressure.contextWindow` (non-atomic; ADR-0029 §Settled window
   * source).
   */
  readonly windowTokens: number | null | undefined;
  /** Trigger ratio in (0, 1]. */
  readonly ratio: number;
}

/** The trigger's verdict. `thresholdTokens` is null when it cannot be computed. */
export interface MicrocompactDecision {
  readonly compact: boolean;
  readonly reason: MicrocompactReason;
  readonly thresholdTokens: number | null;
}

/** True only for finite numbers of the given sign constraint. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Decide whether a microcompact pass is due. Pure, total, deterministic.
 *
 * Fail safe (design constraint 5): an unavailable or implausible window, an
 * implausible ratio, or an implausible measurement all decline with a stated
 * reason. There is no fallback estimate and no default window.
 *
 * The gate is `usedTokens >= threshold`, matching the native engine's
 * `measurement.totalTokens < thresholdTokens → return null`
 * (`dsh-compaction-basic/lib/index.js:940-941`), so the two agree on the
 * boundary.
 */
export function shouldMicrocompact(
  input: MicrocompactInput,
): MicrocompactDecision {
  const { usedTokens, windowTokens, ratio } = input;

  if (!isFiniteNumber(ratio) || ratio <= 0 || ratio > 1) {
    return { compact: false, reason: "ratio-implausible", thresholdTokens: null };
  }
  if (windowTokens === null || windowTokens === undefined) {
    return { compact: false, reason: "window-unavailable", thresholdTokens: null };
  }
  if (!isFiniteNumber(windowTokens) || windowTokens <= 0) {
    return { compact: false, reason: "window-implausible", thresholdTokens: null };
  }
  if (usedTokens === null || usedTokens === undefined) {
    return { compact: false, reason: "usage-unavailable", thresholdTokens: null };
  }
  if (!isFiniteNumber(usedTokens) || usedTokens < 0) {
    return { compact: false, reason: "usage-unavailable", thresholdTokens: null };
  }

  const thresholdTokens = Math.floor(windowTokens * ratio);
  return usedTokens >= thresholdTokens
    ? { compact: true, reason: "ratio-met", thresholdTokens }
    : { compact: false, reason: "below-threshold", thresholdTokens };
}

/** Roles a surface node can carry, as far as eligibility is concerned. */
export type MicrocompactRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

/**
 * One current surface node, projected to the facts selection needs. The
 * adapter builds these from the live session; tests build them directly, so
 * eligibility is provable without a host.
 */
export interface MicrocompactSurfaceNode {
  /** Durable seq of the CURRENT surface node (a replacement has its own seq). */
  readonly seq: number;
  readonly role: MicrocompactRole;
  /** Tokens this node's current content costs under the fixed heuristic. */
  readonly tokens: number;
  /** Tokens the node would cost once its content is the cleared placeholder. */
  readonly clearedTokens: number;
  /** True when this node already carries the cleared placeholder. */
  readonly alreadyCleared: boolean;
}

/** Selection inputs after the trigger fired. */
export interface MicrocompactSelectionOptions {
  /** Newest tool results that always survive. */
  readonly keepNewest: number;
  /** Do not run a pass that frees less than this. */
  readonly minSavingTokens: number;
}

/** Why selection produced or withheld a list. */
export type MicrocompactSelectionReason =
  /** At least one old tool result is eligible and the saving justifies a pass. */
  | "selected"
  /** No eligible old tool result (too few tools, or all already cleared). */
  | "nothing-eligible"
  /** Eligible results exist, but clearing all of them frees too little. */
  | "insufficient-saving"
  /** The requested keep count is not a non-negative integer. */
  | "invalid-keep";

/** What a selection pass chose. `selected` is oldest-first. */
export interface MicrocompactSelection {
  readonly selected: readonly MicrocompactSurfaceNode[];
  readonly reason: MicrocompactSelectionReason;
  /** Heuristic tokens the selected nodes free once replaced. */
  readonly freedTokens: number;
}

/**
 * Choose old tool results to clear: oldest first, newest `keepNewest` kept,
 * already-cleared nodes skipped, and stop as soon as `minSavingTokens` is
 * covered.
 *
 * Only `role === "tool"` nodes are ever candidates — user messages, assistant
 * text, system/developer text, and therefore the injected prompt tail are
 * structurally ineligible (ADR-0027, ADR-0029 decision 5). The surface order is
 * the array order; the caller passes current surface nodes head-to-tail.
 */
export function selectToolResultsToClear(
  nodes: readonly MicrocompactSurfaceNode[],
  options: MicrocompactSelectionOptions,
): MicrocompactSelection {
  const { keepNewest, minSavingTokens } = options;
  if (!Number.isInteger(keepNewest) || keepNewest < 0) {
    return { selected: [], reason: "invalid-keep", freedTokens: 0 };
  }

  const tools = nodes.filter((node) => node.role === "tool");
  const protectedFrom = Math.max(0, tools.length - keepNewest);
  const eligible = tools
    .slice(0, protectedFrom)
    .filter((node) => !node.alreadyCleared);

  if (eligible.length === 0) {
    return { selected: [], reason: "nothing-eligible", freedTokens: 0 };
  }

  const selected: MicrocompactSurfaceNode[] = [];
  let freedTokens = 0;
  for (const node of eligible) {
    freedTokens += Math.max(0, node.tokens - node.clearedTokens);
    selected.push(node);
    if (freedTokens >= minSavingTokens) break;
  }

  if (freedTokens < minSavingTokens) {
    return { selected: [], reason: "insufficient-saving", freedTokens };
  }
  return { selected, reason: "selected", freedTokens };
}

/**
 * UTF-8 byte length of one string. Pure (the `TextEncoder` is a standard
 * built-in), used for the audit figures the boundary row records.
 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
