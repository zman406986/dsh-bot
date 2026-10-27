import type {
  ApplicationPort, CapabilityFlags, Clock, ColdBoundary, Disposable, EngineInput, EngineResult,
  EntryAnswer, ForgetRequest, LedgerSourceReader, RecallId, RecallRecord, ToolResultNode, ToolSpec,
  UnitId,
} from '@racoons/core';
import { createDshCapabilities } from './capabilities.js';
import type { DshToolResultItem } from './envelope.js';
import { decideForget, forgetAnswer, forgetUnavailable } from './forget-tool.js';
import type { DshForgetDecision, DshForgetValue } from './forget-tool.js';
import type { DshAskExchange, DshEntryApplyOutcome, DshEntryRefusal } from './port.js';
import type { DshRevertSession } from './revert.js';
import { createDshTools, registerDshTools } from './tools.js';
import type { DshToolHost } from './tools.js';

/**
 * A structural engine contract keeps fake engines small and the wiring
 * policy-free. `process` receives a manual forget event too (ISSUE-045 chunk
 * D2): the mount queues a resolved request and applies it at its next boundary,
 * and the engine is the one authority on whether that removal lands.
 */
export interface DshEngine {
  process(input: EngineInput): Promise<EngineResult>;
  /**
   * Exact bytes for one recall id. `options.reader` is the source lane
   * (PRD §6.7; ISSUE-053): absent, a ledger miss stays `not-found`. Optional on
   * the structural contract so a fake engine that answers records directly
   * still satisfies it.
   */
  recall(id: RecallId, options?: { readonly reader?: LedgerSourceReader }): Promise<RecallRecord>;
}

export interface DshAdapterPort extends ApplicationPort {
  /**
   * Deliver one landed result, unchanged (ISSUE-058 chunk P3a; ADR-0022 §2).
   * The port hands the engine the node the host already wrote; it never stages,
   * inserts or rewrites one.
   */
  deliverToolResult(
    eventId: string, item: DshToolResultItem,
    process: (node: ToolResultNode) => Promise<EngineResult>,
  ): Promise<EngineResult>;
  /** Record the turns one ask exchange occupies, so its answer can be applied. */
  recordAskExchange(eventId: string, exchange: DshAskExchange): void;
  /**
   * The landed result's whole-result unit id, or `null` when the transcript
   * holds no tool result under that id. The mount stamps an answered entry with
   * it; the guard re-derives the same id from the landed node.
   */
  landedUnitId(nodeId: string): UnitId | null;
  /** The host write the last entry application performed, consumed once. */
  takeEntryWrite(): DshEntryApplyOutcome | null;
  /** Keep-all: drop the ask exchange from the surface (ADR-0022 §11). */
  rewindAskExchange(exchange: DshAskExchange): DshEntryApplyOutcome;
  /** Any forget: rewind past the result turn and land one new turn (ADR-0022 §12). */
  applyEntryShape(
    exchange: DshAskExchange, shapedBytes: Uint8Array,
    embeddedRecords?: readonly { readonly startByte: number; readonly endByteExclusive: number }[],
  ): DshEntryApplyOutcome;
  setColdBoundary(boundary: ColdBoundary): void;
  /**
   * The source index a ledger miss may answer from (PRD §6.7; ISSUE-053).
   * Optional like every other seam: a port that exposes none supplies no
   * source lane, so a ledger miss stays `not-found` exactly as before, and a
   * structural fake needs no stub. `null` is the same statement for a port that
   * has the method but cannot name a boundary.
   */
  recallReader?(): LedgerSourceReader | null;
}

/**
 * The optional seams. `revert` is the host session the port appends through;
 * declaring it here as well keeps the exported capability flags honest, because
 * the same object is what the engine reads. `tools` is the additive tool host.
 *
 * `onForget` is the queue the manual forget tool needs (ISSUE-045 chunk D2): a
 * tool call cannot apply its own removal (`forget-tool.ts` states why), so the
 * adapter resolves the request against the live snapshot and hands the
 * resolved request to the mount, which applies it at its next boundary. Absent
 * on a host that drives no boundary of its own: the tool then answers the
 * refusal it can prove rather than queueing a request nothing would ever apply.
 */
export interface DshAdapterOptions {
  readonly engine: DshEngine;
  readonly port: DshAdapterPort;
  readonly clock: Clock;
  readonly revert?: DshRevertSession;
  readonly tools?: DshToolHost;
  readonly onForget?: (decision: Extract<DshForgetDecision, { status: 'scheduled' }>) => void;
}

export interface DshAdapter {
  readonly capabilities: CapabilityFlags;
  /**
   * One landed result (ISSUE-058 chunk P3a; ADR-0022 §2). The host already
   * wrote it, so this only hands the engine the landed node — no staging, no
   * rewrite, no ask. An over-floor result is asked by the mount at its next
   * append point, in a separate turn.
   */
  onToolResult(eventId: string, result: DshToolResultItem): Promise<EngineResult>;
  /**
   * One answer to an ask exchange the mount appended (ADR-0022 §11–§12). The
   * adapter processes the answered entry event and, when core planned a shape,
   * the port performs the one host write that lands it. A keep-all plans nothing
   * and the adapter rewinds the exchange itself, because core plans no
   * operation for it.
   *
   * `node` is the LANDED result already normalized (the mount's own envelope, or
   * the port's transcript node); `exchange` is the mount's record of the turns
   * it appended. The port keys the exchange by `eventId` so `apply` can find it
   * when the engine applies that event's shape. The answer is never re-derived
   * here: the mount parsed it.
   */
  onEntryAnswer(
    eventId: string, node: ToolResultNode, exchange: DshAskExchange,
    answer: EntryAnswer, answerText: string,
  ): Promise<DshEntryAnswerOutcome>;
  onPreStep(eventId: string): Promise<EngineResult>;
  onResume(eventId: string): Promise<EngineResult>;
  onIdlePastTtl(eventId: string): Promise<EngineResult>;
  onModelSwitch(eventId: string): Promise<EngineResult>;
  recall(id: RecallId): Promise<RecallRecord>;
  /**
   * Resolve one manual forget request against the live snapshot (PRD §6.2).
   * The answer is what the tool returns: a scheduled request or the lookup's own
   * refusal. A scheduled request reaches the mount through `onForget`, never
   * the engine from here — the boundary owns when a removal applies.
   */
  forget(request: ForgetRequest): Promise<DshForgetValue>;
  /**
   * The specs this build can actually register, always filtered to tools with a
   * handler: a model is never offered a tool that would fail (design-protocol
   * §4). `forget` joins `recall` when the mount supplied a queue for it.
   */
  toolSpecs(): readonly ToolSpec[];
  /** Registers the tools; absent when no host was supplied, so the flag can never lie. */
  registerTools?(): Disposable;
}

/**
 * What one answered checkpoint did on the host surface (ISSUE-058 chunk P3a;
 * ADR-0022 §11–§14). Every arm is data: no throw escapes an answer, because an
 * ask failure is fail-open by law — the result stays landed, whole.
 *
 * - `rewound` — a keep-all: the exchange left the surface and the conversation
 *   continues from the result-landed state.
 * - `landed` — a forget: one new turn replaced the result turn (and the
 *   exchange is gone).
 * - `fail-open` — core refused the answer, the write was refused, or the host
 *   answer is uncertain. `refusal` names the host-side code when there was one;
 *   `null` means core planned nothing to apply. The mount journals the code and
 *   arms no retry here.
 */
export type DshEntryAnswerOutcome =
  | { readonly status: 'rewound'; readonly engine: EngineResult }
  | { readonly status: 'landed'; readonly engine: EngineResult }
  | { readonly status: 'fail-open'; readonly engine: EngineResult;
      readonly refusal: DshEntryRefusal | null };

export function createDshAdapter(options: DshAdapterOptions): DshAdapter {
  const { engine, port, clock } = options;
  const capabilities = createDshCapabilities(options.revert !== undefined);
  const queue = options.onForget;
  // The tool answers what it can prove and nothing it cannot: with no queue to
  // hand a resolved request to, offering the tool would promise a removal no
  // path applies. `revertHistory` is the other half of the same honesty: a
  // forget is applied by checkpoint-revert, so a build without that seam cannot
  // honour the queue either.
  const forgetSource = queue === undefined || capabilities.revertHistory !== true
    ? undefined
    : async (request: ForgetRequest): Promise<DshForgetValue> => {
      const snapshot = await port.snapshot();
      const decision = decideForget({
        snapshot, sessionId: snapshot.sessionId, request,
      });
      if (decision.status === 'scheduled') queue(decision);
      return forgetAnswer(decision);
    };
  /**
   * One recall, through the engine, with the mount's source index when it has
   * one (PRD §6.7; ISSUE-053). The reader is the port's: it names the files the
   * archives this mount applied came from, and only while the mount can name a
   * workspace root. Absent, a ledger miss stays `not-found` exactly as before.
   */
  const recallFromSource = (id: RecallId): Promise<RecallRecord> => {
    const reader = port.recallReader?.() ?? null;
    return reader === null ? engine.recall(id) : engine.recall(id, { reader });
  };
  const tools = createDshTools({ recall: id => recallFromSource(id),
    ...(forgetSource === undefined ? {} : { forget: forgetSource }) });
  const host = options.tools;
  const atRest = (eventId: string, reason: Extract<EngineInput, { kind: 'at-rest' }>['reason']) =>
    engine.process({ kind: 'at-rest', eventId, reason });
  const cold = (eventId: string, kind: ColdBoundary['kind']) => {
    port.setColdBoundary({ kind, observedAtMs: clock.nowMs() });
    return atRest(eventId, kind);
  };
  /**
   * The stamp an answered entry carries (design §1 "Stamp (N20)"): the landed
   * unit's own id, read from the port's transcript — the same bytes the guard
   * re-derives it from. A node the transcript no longer holds has no unit, and
   * an absent stamp plans nothing (fail-open, ADR-0022 §14).
   */
  const stampFor = (node: ToolResultNode): { unitId: UnitId; answeredInRound: 0 } | undefined => {
    const unitId = port.landedUnitId(node.id);
    return unitId === null ? undefined : { unitId, answeredInRound: 0 };
  };
  return {
    capabilities,
    onToolResult: (eventId, result) => port.deliverToolResult(eventId, result,
      node => engine.process({ kind: 'entry', eventId, result: node })),
    onEntryAnswer: async (eventId, node, exchange, answer, answerText) => {
      // The port keys the exchange by this event id, so the application the
      // engine plans below can find the turns it must move (ADR-0022 §11–§12).
      port.recordAskExchange(eventId, exchange);
      // A keep-all plans no operation and therefore no host application: the
      // engine answers `unchanged`, and the exchange is the mount's to rewind
      // (§11). Every other answer is shaped by the engine, and its one
      // `mode: 'entry'` application is the port's own host write.
      if (answer.action === 'keepall') {
        const stamp = stampFor(node);
        const engineResult = await engine.process({ kind: 'entry', eventId, result: node,
          answer, answerText, ...(stamp === undefined ? {} : { stamp }) });
        const written = port.rewindAskExchange(exchange);
        if (written.status === 'applied') return { status: 'rewound', engine: engineResult };
        return { status: 'fail-open', engine: engineResult,
          refusal: written.status === 'refused' ? written : null };
      }
      const stamp = stampFor(node);
      const engineResult = await engine.process({ kind: 'entry', eventId, result: node,
        answer, answerText, ...(stamp === undefined ? {} : { stamp }) });
      // The engine's own outcome is authoritative: a refusal planned nothing and
      // wrote nothing, so the landed result stands whole (ADR-0022 §14). Only
      // an applied entry means the shaped turn landed.
      if (engineResult.status !== 'applied') {
        const written = port.takeEntryWrite();
        return { status: 'fail-open', engine: engineResult,
          refusal: written?.status === 'refused' ? written : null };
      }
      return { status: 'landed', engine: engineResult };
    },
    onPreStep: eventId => atRest(eventId, 'step'),
    onResume: eventId => cold(eventId, 'resume'),
    onIdlePastTtl: eventId => cold(eventId, 'idle-past-ttl'),
    onModelSwitch: eventId => cold(eventId, 'model-switch'),
    recall: id => recallFromSource(id),
    forget: async request => {
      if (forgetSource === undefined) {
        // No queue and no revert seam: the request cannot be honoured, and the
        // answer says so in the guard's own vocabulary rather than pretending.
        return forgetUnavailable();
      }
      return forgetSource(request);
    },
    toolSpecs: () => tools.map(tool => tool.spec),
    ...(host === undefined ? {} : { registerTools: () => registerDshTools(host, tools) }),
  };
}
