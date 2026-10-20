import { EpisodeTracker } from "../episodes/tracker.js";
import type { Ledger } from "../ledger/types.js";
import type { TranscriptNode } from "../types/transcript.js";
import { Breaker } from "./breaker.js";
import { buildCandidate } from "./candidate.js";
import { checkInput, checkProtection } from "./checks-input.js";
import { checkOperations } from "./checks-operations.js";
import { isPlan, privateCopy } from "./checks-shape.js";
import { checkSources, checkTranscript } from "./checks-sources.js";
import type { CheckContext } from "./context.js";
import { reporter } from "./context.js";
import { finalizeCandidate } from "./finalize.js";
import { computeFreshZone, computeProtectedRanges } from "./protection.js";
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
    if (this.#breaker.state().disabled) return { ok: false, issues: [
      ...issues, this.#issue("breaker-disabled", "Two consecutive failures disabled this session guard"),
    ], breaker: this.state() };
    this.#breaker.recordFailure();
    return { ok: false, issues, breaker: this.state() };
  }
  async #validate(value: ValidationInput): Promise<ValidationResult> {
    if (this.state().disabled) return this.#reject([]);
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
      if (value.input.kind === "entry") nodes.set(value.input.result.id, value.input.result);
      const episodes = new EpisodeTracker({ noNewPathSteps: value.config.thresholds.episodeNoNewPathSteps }).detect({
        sessionId: value.snapshot.sessionId,
        results: value.snapshot.nodes.filter(node => node.kind === "tool-result"),
        currentStepOrdinal: value.snapshot.currentStepOrdinal,
        completedThroughTurnOrdinal: value.snapshot.completedThroughTurnOrdinal,
      });
      // Incoming content is eligible before insertion; in-flight protection still covers history.
      const incoming = value.input.kind === "entry" ? value.input.result : null;
      let protection = computeProtectedRanges(value.snapshot);
      if (incoming !== null && !value.snapshot.nodes.some(n => n.id === incoming.id)) {
        const entryProtection = computeProtectedRanges({ ...value.snapshot,
          nodes: [incoming], protection: { ...value.snapshot.protection, inFlightTurnOrdinal: null } });
        const ranges = new Map(protection.ranges), recordRanges = new Map(protection.recordRanges);
        const entryRanges = entryProtection.ranges.get(incoming.id), records = entryProtection.recordRanges.get(incoming.id);
        if (entryRanges !== undefined) ranges.set(incoming.id, entryRanges);
        if (records !== undefined) recordRanges.set(incoming.id, records);
        protection = { ranges, recordRanges };
      }
      const c: CheckContext = { value, nodes, episodes, protection,
        freshStart: computeFreshZone(value.snapshot, value.config).startNodeIndex, issues };
      checkTranscript(c);
      checkProtection(c);
      checkSources(c, value.plans);
      checkOperations(c, value.plans);
      if (issues.length > 0) return this.#reject(issues);
      await checkEvidenceRecalls(c, this.#ledger, reporter(c, null, null));
      if (issues.length > 0) return this.#reject(issues);
      const candidate = await buildCandidate(c);
      const finalized = finalizeCandidate(c, candidate);
      if (!finalized.ok) return this.#reject(finalized.issues);
      this.#breaker.recordSuccess(candidate.replacements.length + candidate.appendRecords.length > 0);
      return { ok: true, application: finalized.application, breaker: this.state() };
    } catch (error) {
      report("invalid-plan", error instanceof Error ? error.message : "Validation failed on malformed input");
      return this.#reject(issues);
    }
  }
}
