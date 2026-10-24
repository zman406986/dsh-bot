export type Bytes = Uint8Array;
export type Sha256 = string;
export type SessionId = string;
export type Revision = string;
export type NodeId = string;
export type ToolCallId = string;
export type EpisodeId = string;
export type RuleId = string;
export type RemovalId = string;
export type NoteId = string;
export type RecallId = string;
export type IntentId = string;
export type EventId = string;
/** "unit:sha256:<hex over [sessionId, nodeId, node.sha256, start, end]>" */
export type UnitId = string;

export interface ByteRange {
  readonly startByte: number;
  readonly endByteExclusive: number;
}

export interface LineRange {
  readonly startLine: number;
  readonly endLineInclusive: number;
}

export interface SourceRef {
  readonly nodeId: NodeId;
  readonly sha256: Sha256;
  readonly byteLength: number;
}

export interface SourceRange {
  readonly source: SourceRef;
  readonly range: ByteRange;
}

export interface SearchTarget {
  readonly key: string;
  readonly label: string;
}
