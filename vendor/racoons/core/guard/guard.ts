import { EpisodeTracker } from "../episodes/tracker.js";
import type { Ledger } from "../ledger/types.js";
import type { TranscriptNode } from "../types/transcript.js";
import { Breaker } from "./breaker.js";
import { buildCandidate } from "./candidate.js";
import { checkSources, checkTranscript } from "./checks-sources.js";
import { checkInput } from "./checks-input.js";
import { checkOperations } from "./checks-operations.js";
import { checkForget } from "./checks-forget.js";
import { checkInvalidation } from "./checks-invalidation.js";
import { checkProofs } from "./checks-proofs.js";
import { isPlan, privateCopy } from "./checks-shape.js";
import { checkVerdicts } from "./checks-verdicts.js";
import type { CheckContext } from "./context.js";
import { reporter } from "./context.js";
import { finalizeCandidate } from "./finalize.js";
import { computeFreshZone } from "./fresh-zone.js";
import { checkEvidenceRecalls } from "./recall.js";
import type { BreakerState, GuardOptions, ValidationInput, ValidationIssue, ValidationResult } from "./types.js";

export class Guard {
  readonly #ledger: Ledger;
  readonly #breaker: Breaker;
  #sessionId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  constructor(options: GuardOptions) {
    this.#ledger = options.ledger;
    this.#breaker = new Breaker(options.initialState);
  }
  state(): BreakerState { return this.#breaker.state(); }
  /**
   * A validation whose plan set is empty. It is a completed validation, so it
   * resets the streak exactly as an applied one does. It writes no ledger
   * event: nothing was applied, so there is no application to record.
   */
  recordNoPlan(): Promise<void> {
    // Queued like a validation, so a real one cannot overtake it mid-flight.
    const done = this.#queue.then(() => { this.#breaker.recordSuccess(); });
    this.#queue = done.then(() => undefined, () => undefined);
    return done;
  }
  validate(input: ValidationInput): Promise<ValidationResult> {
    // Capture now, not when a queued validation starts. Never expose this copy to rules.
    let value: ValidationInput;
    try { value = privateCopy(input); }
    catch (error) {
      return this.#enqueue(() => this.#reject([this.#issue("invalid-plan",
        error instanceof Error ? error.message : "Uncopyable validation input")]));
    }
    return this.#enqueue(() => this.#validate(value));
  }
  #enqueue(work: () => ValidationResult | Promise<ValidationResult>): Promise<ValidationResult> {
    const result = this.#queue.then(work);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
  #issue(code: ValidationIssue["code"], detail: string): ValidationIssue {
    return { code, detail, ruleId: null, operationIndex: null, nodeId: null };
  }
  #reject(issues: readonly ValidationIssue[]): ValidationResult {
    // A refusal while the breaker is already quiet names that fact; it never
    // extends the disable, which is per-ask (ISSUE-057).
    if (this.#breaker.state().disabled) return { ok: false, issues: [
      ...issues, this.#issue("breaker-disabled", "Two consecutive refusals quieted the breaker until a validation completes"),
    ], breaker: this.state() };
    this.#breaker.recordFailure();
    return { ok: false, issues, breaker: this.state() };
  }
  async #validate(value: ValidationInput): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];
    const report = (code: ValidationIssue["code"], detail: string): void => { issues.push(this.#issue(code, detail)); };
    try {
      checkInput(value, report);
      if (this.#sessionId === null) this.#sessionId = value.snapshot.sessionId;
      else if (this.#sessionId !== value.snapshot.sessionId) report("wrong-session", "Guard instance is bound to another session");
      if (!Array.isArray(value.plans) || !value.plans.every(isPlan)) {
        report("invalid-plan", "Plans must contain only declared fields, sources, ranges, notes and operations");
      }
      if (issues.length > 0) return this.#reject(issues);
      const nodes = new Map<string, TranscriptNode>(value.snapshot.nodes.map(node => [node.id, node]));
      // Under the land-first protocol the host wrote the result before the entry
      // event was built (ISSUE-058 chunk P3a; ADR-0022 §2), so the snapshot
      // USUALLY carries it already — and then the snapshot's own node is the
      // authoritative one. Setting the event's copy unconditionally would both
      // re-key an already-present node and plant a second node id in the map the
      // checks read; the event's node is added only when the snapshot lacks it.
      if (value.input.kind === "entry" && !nodes.has(value.input.result.id)) {
        nodes.set(value.input.result.id, value.input.result);
      }
      const episodes = new EpisodeTracker({ noNewPathSteps: value.config.thresholds.episodeNoNewPathSteps }).detect({
        sessionId: value.snapshot.sessionId,
        results: value.snapshot.nodes.filter(node => node.kind === "tool-result"),
        currentStepOrdinal: value.snapshot.currentStepOrdinal,
        completedThroughTurnOrdinal: value.snapshot.completedThroughTurnOrdinal,
      });
      // ADR-0020: no component pre-decides which content is kept. The guard
      // validates the agent's own plan; candidate scope is the tracker's rule
      // and nothing here filters a removal by content class.
      const c: CheckContext = { value, nodes, episodes,
        freshStart: computeFreshZone(value.snapshot, value.config).startNodeIndex, issues };
      checkTranscript(c);
      checkVerdicts(c, value.plans);
      checkSources(c, value.plans);
      checkOperations(c, value.plans);
      // The proof, forget and write-invalidation lanes (ISSUE-045 chunks C4, C1,
      // C6). Each is silent until its own chunk fills it; the seam is here so a
      // later chunk adds behaviour, not a wiring change.
      checkProofs(c, value.plans);
      checkForget(c);
      checkInvalidation(c, value.plans);
      if (issues.length > 0) return this.#reject(issues);
      await checkEvidenceRecalls(c, this.#ledger, reporter(c, null, null));
      if (issues.length > 0) return this.#reject(issues);
      const candidate = await buildCandidate(c);
      const finalized = finalizeCandidate(c, candidate);
      if (!finalized.ok) return this.#reject(finalized.issues);
      // Any completed validation resets — an empty application included, so a
      // keep-only window is a success, not a skipped pass (ISSUE-057 defect 1).
      this.#breaker.recordSuccess();
      return { ok: true, application: finalized.application, breaker: this.state() };
    } catch (error) {
      report("invalid-plan", error instanceof Error ? error.message : "Validation failed on malformed input");
      return this.#reject(issues);
    }
  }
}
