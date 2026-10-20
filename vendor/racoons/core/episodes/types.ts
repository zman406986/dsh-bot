import type {
  EpisodeId,
  NodeId,
  SessionId,
} from "../types/identity.js";
import type {
  PathEvidence,
  ToolResultNode,
} from "../types/transcript.js";

export type EpisodeCloseReason = "path-idle" | "turn-end";

export interface Episode {
  readonly id: EpisodeId;
  readonly target: NonNullable<ToolResultNode["evidence"]["target"]>;
  readonly status: "open" | "closed";
  readonly openedAtStep: number;
  readonly lastNewPathStep: number;
  readonly memberNodeIds: readonly NodeId[];
  readonly hitNodeIds: readonly NodeId[];
  readonly missNodeIds: readonly NodeId[];
  readonly unknownNodeIds: readonly NodeId[];
  readonly paths: readonly PathEvidence[];
  readonly closedAtStep: number | null;
  readonly closedAtTurn: number | null;
  readonly closeReason: EpisodeCloseReason | null;
}

export interface EpisodeTrackerOptions {
  readonly noNewPathSteps: number | null;
}

export interface EpisodeDetectionInput {
  readonly sessionId: SessionId;
  readonly results: readonly ToolResultNode[];
  readonly currentStepOrdinal: number;
  readonly completedThroughTurnOrdinal: number;
}
