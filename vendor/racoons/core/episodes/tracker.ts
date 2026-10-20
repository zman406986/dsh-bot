import type { EpisodeId, NodeId, SessionId } from "../types/identity.js";
import type { PathEvidence, ToolResultNode } from "../types/transcript.js";
import { sha256Sync } from "../util/hash.js";
import type {
  Episode,
  EpisodeCloseReason,
  EpisodeDetectionInput,
  EpisodeTrackerOptions,
} from "./types.js";

type Target = NonNullable<ToolResultNode["evidence"]["target"]>;

interface WorkingEpisode {
  readonly id: EpisodeId;
  readonly target: Target;
  readonly openedAtStep: number;
  lastNewPathStep: number;
  lastNewPathTurn: number;
  readonly memberNodeIds: NodeId[];
  readonly hitNodeIds: NodeId[];
  readonly missNodeIds: NodeId[];
  readonly unknownNodeIds: NodeId[];
  readonly paths: Map<string, PathEvidence>;
  closedAtStep: number | null;
  closedAtTurn: number | null;
  closeReason: EpisodeCloseReason | null;
}

function openEpisode(
  sessionId: SessionId,
  target: Target,
  first: ToolResultNode,
): WorkingEpisode {
  // An ordered JSON tuple avoids delimiter collisions and ignores display labels.
  const identity = JSON.stringify([sessionId, target.key, first.id]);
  return {
    id: `episode:sha256:${sha256Sync(new TextEncoder().encode(identity))}`,
    target: { ...target },
    openedAtStep: first.stepOrdinal,
    // Empty evidence uses the opening step as its idle baseline.
    lastNewPathStep: first.stepOrdinal,
    lastNewPathTurn: first.turnOrdinal,
    memberNodeIds: [],
    hitNodeIds: [],
    missNodeIds: [],
    unknownNodeIds: [],
    paths: new Map(),
    closedAtStep: null,
    closedAtTurn: null,
    closeReason: null,
  };
}

function addResult(episode: WorkingEpisode, result: ToolResultNode): void {
  episode.memberNodeIds.push(result.id);
  const paths = result.evidence.paths;
  if (paths.some((path) => path.outcome === "hit")) {
    episode.hitNodeIds.push(result.id);
  } else if (paths.length > 0 && paths.every((path) => path.outcome === "miss")) {
    episode.missNodeIds.push(result.id);
  } else {
    episode.unknownNodeIds.push(result.id);
  }

  for (const path of paths) {
    const previous = episode.paths.get(path.pathKey);
    if (previous === undefined) {
      episode.paths.set(path.pathKey, { ...path });
      episode.lastNewPathStep = result.stepOrdinal;
      episode.lastNewPathTurn = result.turnOrdinal;
    } else if (path.outcome === "hit" && previous.outcome !== "hit") {
      episode.paths.set(path.pathKey, { ...previous, outcome: "hit" });
    }
  }
}

function snapshot(episode: WorkingEpisode): Episode {
  return {
    id: episode.id,
    target: episode.target,
    status: episode.closeReason === null ? "open" : "closed",
    openedAtStep: episode.openedAtStep,
    lastNewPathStep: episode.lastNewPathStep,
    memberNodeIds: [...episode.memberNodeIds],
    hitNodeIds: [...episode.hitNodeIds],
    missNodeIds: [...episode.missNodeIds],
    unknownNodeIds: [...episode.unknownNodeIds],
    paths: [...episode.paths.values()],
    closedAtStep: episode.closedAtStep,
    closedAtTurn: episode.closedAtTurn,
    closeReason: episode.closeReason,
  };
}

function turnAtStep(
  results: readonly ToolResultNode[],
  step: number,
  fallback: number,
): number {
  let lower = 0;
  let upper = results.length;
  let turn = fallback;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const result = results[middle];
    if (result === undefined) break;
    if (result.stepOrdinal <= step) {
      turn = result.turnOrdinal;
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return turn;
}

export class EpisodeTracker {
  private readonly noNewPathSteps: number | null;

  constructor(options: EpisodeTrackerOptions) {
    const threshold = options.noNewPathSteps;
    if (threshold !== null && (!Number.isSafeInteger(threshold) || threshold < 0)) {
      throw new RangeError("noNewPathSteps must be null or a non-negative safe integer");
    }
    this.noNewPathSteps = threshold;
  }

  detect(input: EpisodeDetectionInput): readonly Episode[] {
    const episodes: WorkingEpisode[] = [];
    const active = new Map<string, WorkingEpisode>();
    const turnEndSteps = new Map<number, number>();
    // Results are normalized transcript order. Do not infer path aliases or targets.
    for (const result of input.results) {
      const lastStep = turnEndSteps.get(result.turnOrdinal) ?? result.stepOrdinal;
      turnEndSteps.set(result.turnOrdinal, Math.max(lastStep, result.stepOrdinal));
    }

    const closeDue = (step: number, completedThroughTurn: number): void => {
      for (const [key, episode] of active) {
        const threshold = this.noNewPathSteps;
        if (threshold !== null && step - episode.lastNewPathStep >= threshold) {
          episode.closeReason = "path-idle";
          episode.closedAtStep = episode.lastNewPathStep + threshold;
          episode.closedAtTurn = turnAtStep(
            input.results, episode.closedAtStep, episode.lastNewPathTurn,
          );
        } else if (completedThroughTurn >= episode.lastNewPathTurn) {
          // "Completed through" includes the named turn.
          episode.closeReason = "turn-end";
          episode.closedAtTurn = episode.lastNewPathTurn;
          episode.closedAtStep =
            turnEndSteps.get(episode.lastNewPathTurn) ?? episode.lastNewPathStep;
        } else {
          continue;
        }
        active.delete(key);
      }
    };

    let previous: ToolResultNode | null = null;
    for (const result of input.results) {
      const completedBeforeResult = Math.min(
        input.completedThroughTurnOrdinal, result.turnOrdinal - 1,
      );
      if (previous !== null && previous.turnOrdinal < result.turnOrdinal) {
        // Replay known turn ends before a later turn's potentially much larger step.
        closeDue(previous.stepOrdinal, completedBeforeResult);
      }
      closeDue(result.stepOrdinal, completedBeforeResult);
      previous = result;
      const target = result.evidence.target;
      if (target === null) continue;
      let episode = active.get(target.key);
      if (episode === undefined) {
        episode = openEpisode(input.sessionId, target, result);
        active.set(target.key, episode);
        episodes.push(episode);
      }
      addResult(episode, result);
    }
    closeDue(input.currentStepOrdinal, input.completedThroughTurnOrdinal);
    return episodes.map(snapshot);
  }
}
