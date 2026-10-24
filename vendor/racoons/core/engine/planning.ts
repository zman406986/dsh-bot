import { EpisodeTracker } from '../episodes/tracker.js';
import type { Episode } from '../episodes/types.js';
import { pruneVerdicts, pruneWindow } from '../guard/checks-verdicts.js';
import { computeFreshZone, computeProtectedRanges } from '../guard/protection.js';
import type { RulePlan } from '../rules/types.js';
import type { UnitId } from '../types/identity.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { ProcessingUnit } from '../units/types.js';
import { planVerdictApplication } from '../verdicts/plan.js';
import type { VerdictBatch } from '../verdicts/types.js';
import { estimatedContentTokens, judgeWindow, liveUnits, unitsFromWindow } from './protocol.js';
import type { EngineInput, EngineOptions } from './types.js';

export function detectEpisodes(options: EngineOptions, snapshot: SessionSnapshot): readonly Episode[] {
  return new EpisodeTracker({ noNewPathSteps: options.config.thresholds.episodeNoNewPathSteps }).detect({
    sessionId: snapshot.sessionId,
    results: snapshot.nodes.filter(node => node.kind === 'tool-result'),
    currentStepOrdinal: snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: snapshot.completedThroughTurnOrdinal,
  });
}

/**
 * The units a verdict event judges, in listing order. The event's own window is
 * authoritative when present (the gate recorded what it actually presented);
 * absent, the batch names the units it answers.
 */
export function verdictUnits(
  options: EngineOptions,
  event: { readonly verdicts: VerdictBatch; readonly window?: readonly UnitId[] },
  snapshot: SessionSnapshot,
): readonly ProcessingUnit[] {
  const barBytes = options.config.protocol.barBytes;
  if (event.window !== undefined) {
    return unitsFromWindow(snapshot, options.sessionId, barBytes, event.window);
  }
  const named = new Set(event.verdicts.verdicts.map(verdict => verdict.unitId));
  return liveUnits(snapshot, options.sessionId, barBytes).filter(unit => named.has(unit.id));
}

/**
 * Verdict state to operations. There is no rule pass: a verdict event is the
 * application of one settled batch, so `options.rules` never see it and
 * `RuleContext` carries no protocol state (design-protocol §3).
 */
export function planVerdicts(
  snapshot: SessionSnapshot, units: readonly ProcessingUnit[], batch: VerdictBatch,
): RulePlan[] {
  // `nodes` is what makes a `keeplines` verdict plannable: the planner resolves
  // line spans to byte ranges from the authoritative node bytes, never from the
  // answer's own arithmetic.
  const plan = planVerdictApplication({
    state: judgeWindow(units, batch), baseRevision: snapshot.revision, nodes: snapshot.nodes,
  });
  return plan === null ? [] : [plan];
}

/**
 * A prune pass's merged document to operations (ISSUE-022 chunk 4; ADR-0009).
 * The pass has already asked the model; the engine never does. Its removals are
 * read as one verdict batch over exactly the units the document names, so every
 * removal in the pass lands in one plan and therefore in one checkpoint-revert.
 * A stale document (a unit whose bytes changed) plans the units still present;
 * the guard refuses the event rather than this helper inventing one.
 */
export function planPrune(
  options: EngineOptions, snapshot: SessionSnapshot,
  event: Extract<EngineInput, { readonly kind: 'prune' }>,
): RulePlan[] {
  const units = unitsFromWindow(
    snapshot, options.sessionId, options.config.protocol.barBytes, pruneWindow(event),
  );
  return planVerdicts(snapshot, units, pruneVerdicts(event));
}

export function planApplication(
  options: EngineOptions, input: EngineInput, snapshot: SessionSnapshot,
  episodes: readonly Episode[], sealedEpisodeIds: readonly string[], nowMs: number,
): RulePlan[] {
  // Verdict and prune inputs route to the verdict planner, never to `options.rules`.
  if (input.kind === 'verdict') {
    return planVerdicts(snapshot, verdictUnits(options, input, snapshot), input.verdicts);
  }
  if (input.kind === 'prune') return planPrune(options, snapshot, input);
  const freshZone = computeFreshZone(snapshot, options.config);
  // Rules receive no authority to change protection; Guard recomputes it independently.
  computeProtectedRanges(snapshot);
  // The same arithmetic `estimatedContentTokens` exports, which the mount's
  // half-window trigger also uses: one definition (CRITIC-022 P3 #15). Core
  // holds no wire capture, so this reading is transcript content only; the
  // mount's trigger adds the captured system+tools prefix (ADR-0009 §Amendment
  // 2026-10-24).
  const estimated = estimatedContentTokens(options.meter, snapshot,
    input.kind === 'entry' ? input.result.bytes : null, null);
  const reserved = new Set<string>();
  const plans: RulePlan[] = [];
  for (const rule of options.rules) {
    try {
      const plan = rule.plan(structuredClone({
        input, snapshot, capabilities: options.capabilities, config: options.config,
        freshZone, episodes, sealedEpisodeIds, reservedNodeIds: [...reserved],
        estimatedContentTokens: estimated, latestUsage: options.meter.latest(), nowMs,
      }));
      if (plan === null) continue;
      const copy = structuredClone(plan);
      for (const removal of copy.removals) {
        for (const source of removal.sources) reserved.add(source.source.nodeId);
      }
      // Guard qualifies removal/note IDs by ruleId while building the candidate.
      plans.push(copy.ruleId === rule.id ? copy
        : { ...copy, baseRevision: `${snapshot.revision}:invalid-rule` });
    } catch {
      // A throwing/malformed rule rejects every plan through the ordinary guard path.
      plans.push({ ruleId: rule.id, baseRevision: `${snapshot.revision}:invalid`,
        removals: [], notes: [], operations: [] });
    }
  }
  return plans;
}
