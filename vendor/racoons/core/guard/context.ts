import type { Episode } from "../episodes/types.js";
import type { ByteRange } from "../types/identity.js";
import type { TranscriptNode } from "../types/transcript.js";
import type { ValidationCode, ValidationInput, ValidationIssue } from "./types.js";

export interface CheckContext {
  readonly value: ValidationInput;
  readonly nodes: ReadonlyMap<string, TranscriptNode>;
  readonly episodes: readonly Episode[];
  readonly freshStart: number;
  readonly issues: ValidationIssue[];
}
export type Report = (code: ValidationCode, detail: string, nodeId?: string | null) => void;
export function reporter(context: CheckContext, ruleId: string | null, operationIndex: number | null): Report {
  return (code, detail, nodeId = null) => {
    context.issues.push({ code, detail, ruleId, operationIndex, nodeId });
  };
}
export interface DeclaredRange { readonly nodeId: string; readonly range: ByteRange }
