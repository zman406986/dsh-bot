import type { SessionId, UnitId } from "../types/identity.js";
import type { Clock } from "../types/transcript.js";
import type { TelemetryEvent, TelemetrySink } from "../types/telemetry.js";
import type { ProcessingUnit } from "../units/types.js";
import type { Verdict, VerdictBatch } from "../verdicts/types.js";
import type { GateBudget, GateKind, GateOutcome, GatePresentation } from "./types.js";

/**
 * The two telemetry shapes a gate owns, taken from the Slice-1 union so the
 * gate cannot drift from the event contract. The base fields are added on emit.
 */
type GateEvent = Extract<TelemetryEvent, { kind: "gate-presented" | "gate-settled" }>;
/** Distributive, so each payload keeps its own fields rather than the shared ones. */
type GatePayload = GateEvent extends infer T
  ? T extends GateEvent ? Omit<T, "sessionId" | "atMs"> : never
  : never;

/** What both gates need: the session, the budget the agent sees, the clock, and the sink. */
export interface GateCoreOptions {
  readonly sessionId: SessionId;
  readonly kind: GateKind;
  readonly budget: GateBudget;
  readonly clock: Clock;
  readonly onTelemetry: TelemetrySink | null;
  /**
   * A turn gate remembers every answer for the session, so a unit judged once
   * is never put to the agent again. A revisit asks all live content each pass,
   * so its answers live only as long as the visit.
   */
  readonly answersPersist: boolean;
  /**
   * The circuit breaker probe. A disabled gate presents nothing: no unit is
   * listed, no round or retry is spent, and no telemetry fires, because a
   * disabled protocol must not keep asking. Absent means always enabled.
   */
  readonly enabled?: () => boolean;
}

/**
 * The presentation state machine behind `TurnGate` and `RevisitGate`. It is
 * internal: `index.ts` never re-exports it and only `gates/revisit.ts` imports
 * it. One implementation keeps the retry cap and incremental completion
 * identical for both gates.
 */
export class GateCore {
  readonly #sessionId: SessionId;
  readonly #kind: GateKind;
  readonly #budget: GateBudget;
  readonly #clock: Clock;
  readonly #onTelemetry: TelemetrySink | null;
  readonly #answersPersist: boolean;
  readonly #enabled: (() => boolean) | undefined;

  /** Answers that survive a resume within this gate's scope. */
  readonly #answered = new Map<UnitId, Verdict>();
  /** Units of the open window, in listing order; answered ones are filtered out at open. */
  #window: readonly ProcessingUnit[] = [];
  /** The one outstanding presentation, if any: a second `present` lists nothing. */
  #presentation: readonly ProcessingUnit[] | null = null;
  #windowOpen = false;
  /** Presentations made in the open window; `retryLimit` re-asks follow the first. */
  #presentations = 0;
  #round = 0;
  /** Units of a window that failed open; that window alone stays silent afterwards. */
  #failed: ReadonlySet<UnitId> | null = null;

  constructor(options: GateCoreOptions) {
    if (!Number.isSafeInteger(options.budget.retryLimit) || options.budget.retryLimit < 0) {
      throw new Error("A gate retryLimit must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(options.budget.advertisedLabelLimit)
      || options.budget.advertisedLabelLimit < 1) {
      throw new Error("A gate advertisedLabelLimit must be a positive safe integer.");
    }
    this.#sessionId = options.sessionId;
    this.#kind = options.kind;
    this.#budget = { ...options.budget };
    this.#clock = options.clock;
    this.#onTelemetry = options.onTelemetry;
    this.#answersPersist = options.answersPersist;
    this.#enabled = options.enabled;
  }

  /**
   * Put the window's units to the agent. A `null` list means no bar is
   * configured or nothing reached it: nothing is presented, and no round or
   * retry is spent proving it. Only units still unanswered are listed, so a
   * resumed gate is incremental — nine of ten answered means the tenth is
   * asked, not all ten again (PRD §6.2). One presentation is outstanding at a
   * time, so no unit is ever put twice in one round.
   */
  present(units: readonly ProcessingUnit[] | null): GatePresentation | null {
    // A disabled protocol asks nothing: the breaker's verdict is read before
    // any window state changes, so a later re-enable resumes where it stood.
    if (this.#enabled !== undefined && !this.#enabled()) return null;
    if (units === null || units.length === 0) return null;
    if (this.#presentation !== null) return null;
    const listed = dedupe(units);
    // A window that failed open stays silent for the units it asked; a unit it
    // never asked opens a new window with a fresh retry budget (§7 Q4 ruling:
    // silence lasts the window, not the session).
    const failed = this.#failed;
    if (!this.#windowOpen && failed !== null && listed.every(unit => failed.has(unit.id))) {
      return null;
    }
    if (this.#windowOpen) {
      this.#window = appendUnanswered(this.#window, listed, this.#answered);
    } else {
      if (!this.#answersPersist) this.#answered.clear();
      this.#window = listed.filter(unit => !this.#answered.has(unit.id));
      this.#presentations = 0;
      this.#windowOpen = true;
      this.#failed = null;
    }
    const ask = this.#window.filter(unit => !this.#answered.has(unit.id));
    if (ask.length === 0) return null;
    this.#presentations += 1;
    this.#round += 1;
    this.#presentation = ask;
    this.#emit({
      kind: "gate-presented", gate: this.#kind, round: this.#round,
      unitIds: ask.map(unit => unit.id),
      advertisedLabelLimit: this.#budget.advertisedLabelLimit,
    });
    return { kind: this.#kind, round: this.#round, units: ask, budget: { ...this.#budget } };
  }

  /**
   * Take the round's answers. A verdict for a unit this gate never listed is
   * not an answer to anything and is ignored; the first answer for a unit wins
   * (rejecting a duplicate is the verdict tracker's job, design §5). An
   * incomplete round spends one retry; when the cap is spent the gate fails
   * open, returns the unanswered units, and emits `gate-settled` with outcome
   * `failed-open`, so nothing is applied and the failure is reported.
   */
  settle(batch: VerdictBatch): GateOutcome {
    const presented = this.#presentation;
    if (presented === null) throw new Error("No gate presentation is outstanding to settle.");
    const listed = new Set(presented.map(unit => unit.id));
    const answers = new Map<UnitId, Verdict>();
    for (const verdict of batch.verdicts) {
      if (!listed.has(verdict.unitId) || answers.has(verdict.unitId)) continue;
      answers.set(verdict.unitId, verdict);
    }
    for (const [unitId, verdict] of answers) this.#answered.set(unitId, verdict);
    const unanswered = this.#window.filter(unit => !this.#answered.has(unit.id));
    const answered = this.#window.filter(unit => this.#answered.has(unit.id));
    this.#presentation = null;
    if (unanswered.length === 0) {
      this.#windowOpen = false;
      this.#emit({
        kind: "gate-settled", gate: this.#kind, round: this.#round,
        outcome: "settled", answered: answered.length, unanswered: 0,
      });
      return { status: "settled", batch: { round: this.#round, verdicts: windowVerdicts(answered, this.#answered) } };
    }
    const retriesLeft = this.#budget.retryLimit - (this.#presentations - 1);
    if (retriesLeft <= 0) {
      this.#failed = new Set(this.#window.map(unit => unit.id));
      this.#windowOpen = false;
      this.#emit({
        kind: "gate-settled", gate: this.#kind, round: this.#round,
        outcome: "failed-open", answered: answered.length, unanswered: unanswered.length,
      });
      return { status: "failed-open", unanswered: unanswered.map(unit => unit.id), reason: "retry-cap" };
    }
    this.#emit({
      kind: "gate-settled", gate: this.#kind, round: this.#round,
      outcome: "incomplete", answered: answered.length, unanswered: unanswered.length,
    });
    return { status: "incomplete", unanswered: unanswered.map(unit => unit.id), retriesLeft };
  }

  #emit(event: GatePayload): void {
    const sink = this.#onTelemetry;
    if (sink === null) return;
    try {
      sink({ ...event, sessionId: this.#sessionId, atMs: this.#clock.nowMs() } as TelemetryEvent);
    } catch {
      // Telemetry failures cannot alter a gate outcome (the engine's rule).
    }
  }
}

/** First occurrence wins: a content-addressed id names exactly one unit. */
function dedupe(units: readonly ProcessingUnit[]): readonly ProcessingUnit[] {
  const seen = new Set<UnitId>();
  const listed: ProcessingUnit[] = [];
  for (const unit of units) {
    if (seen.has(unit.id)) continue;
    seen.add(unit.id);
    listed.push(unit);
  }
  return listed;
}

/** A resumed window keeps its units and gains arrivals; a resent unit is not listed twice. */
function appendUnanswered(
  window: readonly ProcessingUnit[],
  listed: readonly ProcessingUnit[],
  answered: ReadonlyMap<UnitId, Verdict>,
): readonly ProcessingUnit[] {
  const known = new Set(window.map(unit => unit.id));
  const added = listed.filter(unit => !known.has(unit.id) && !answered.has(unit.id));
  return [...window, ...added];
}

/** The window's verdicts in listing order; every listed unit has one by now. */
function windowVerdicts(
  window: readonly ProcessingUnit[],
  answered: ReadonlyMap<UnitId, Verdict>,
): readonly Verdict[] {
  const verdicts: Verdict[] = [];
  for (const unit of window) {
    const verdict = answered.get(unit.id);
    if (verdict !== undefined) verdicts.push(verdict);
  }
  return verdicts;
}

export interface TurnGateOptions {
  readonly sessionId: SessionId;
  readonly budget: GateBudget;
  readonly clock: Clock;
  readonly onTelemetry?: TelemetrySink;
  /** The circuit breaker probe; see `GateCoreOptions.enabled`. */
  readonly enabled?: () => boolean;
}

/**
 * The turn gate (PRD §6.5, ADR-0006). Units above the bar that reached this
 * seam unjudged are put to the agent as one list; every listed unit must
 * receive keep or forget, bounded by the retry cap, then fail-open with
 * telemetry. It plans no removals, renders nothing, persists no verdicts.
 */
export class TurnGate {
  readonly #core: GateCore;

  constructor(options: TurnGateOptions) {
    this.#core = new GateCore({
      sessionId: options.sessionId,
      kind: "turn",
      budget: options.budget,
      clock: options.clock,
      onTelemetry: options.onTelemetry ?? null,
      answersPersist: true,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    });
  }

  /** Presents the window's unanswered units; `null` presents nothing. */
  present(units: readonly ProcessingUnit[] | null): GatePresentation | null {
    return this.#core.present(units);
  }

  /** Settles the outstanding presentation; see `GateCore.settle`. */
  settle(batch: VerdictBatch): GateOutcome {
    return this.#core.settle(batch);
  }
}
