import type { Note, Rule, RuleContext, RulePlan, SealOp } from "./types.js";

export class SealRule implements Rule {
  readonly id = "seal" as const;

  plan(context: RuleContext): RulePlan | null {
    if (
      context.input.kind !== "at-rest" ||
      context.config.sealMode !== "append" ||
      !context.capabilities.atRest ||
      !context.capabilities.appendRecords
    ) {
      return null;
    }

    const seen = new Set(context.sealedEpisodeIds);
    const notes: Note[] = [];
    const operations: SealOp[] = [];
    for (const episode of context.episodes) {
      if (
        episode.status !== "closed" ||
        seen.has(episode.id) ||
        episode.hitNodeIds.length > 0 ||
        episode.paths.some((path) => path.outcome === "hit") ||
        episode.missNodeIds.length === 0 ||
        episode.closedAtTurn === null
      ) {
        continue;
      }

      const latency = context.snapshot.currentTurnOrdinal - episode.closedAtTurn;
      if (latency < 0 || latency > context.config.thresholds.sealMaxLatencyTurns) {
        continue;
      }

      const noteId = `episode:${episode.id}`;
      notes.push({ id: noteId, kind: "negative-fact", episodeId: episode.id });
      operations.push({
        kind: "seal",
        mode: "append",
        episodeId: episode.id,
        removalId: null,
        noteId,
      });
      seen.add(episode.id);
    }

    if (operations.length === 0) return null;
    return {
      ruleId: this.id,
      baseRevision: context.snapshot.revision,
      removals: [],
      notes,
      operations,
    };
  }
}
