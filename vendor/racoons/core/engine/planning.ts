import { EpisodeTracker } from '../episodes/tracker.js';
import type { Episode } from '../episodes/types.js';
import { computeFreshZone, computeProtectedRanges } from '../guard/protection.js';
import type { RulePlan } from '../rules/types.js';
import type { SessionSnapshot } from '../types/transcript.js';
import type { EngineInput, EngineOptions } from './types.js';

export function detectEpisodes(options: EngineOptions, snapshot: SessionSnapshot): readonly Episode[] {
  return new EpisodeTracker({ noNewPathSteps: options.config.thresholds.episodeNoNewPathSteps }).detect({
    sessionId: snapshot.sessionId,
    results: snapshot.nodes.filter(node => node.kind === 'tool-result'),
    currentStepOrdinal: snapshot.currentStepOrdinal,
    completedThroughTurnOrdinal: snapshot.completedThroughTurnOrdinal,
  });
}

export function planApplication(
  options: EngineOptions, input: EngineInput, snapshot: SessionSnapshot,
  episodes: readonly Episode[], sealedEpisodeIds: readonly string[], nowMs: number,
): RulePlan[] {
  const freshZone = computeFreshZone(snapshot, options.config);
  // Rules receive no authority to change protection; Guard recomputes it independently.
  computeProtectedRanges(snapshot);
  const estimatedContentTokens = snapshot.nodes.reduce(
    (sum, node) => sum + options.meter.estimate(node.bytes.slice()), 0,
  ) + (input.kind === 'entry' ? options.meter.estimate(input.result.bytes.slice()) : 0);
  const reserved = new Set<string>();
  const plans: RulePlan[] = [];
  for (const rule of options.rules) {
    try {
      const plan = rule.plan(structuredClone({
        input, snapshot, capabilities: options.capabilities, config: options.config,
        freshZone, episodes, sealedEpisodeIds, reservedNodeIds: [...reserved],
        estimatedContentTokens, latestUsage: options.meter.latest(), nowMs,
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
