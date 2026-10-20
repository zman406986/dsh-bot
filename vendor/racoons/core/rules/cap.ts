import { complementByteRanges, splitLineOffsets } from "../util/lines.js";
import type { Rule, RuleContext, RulePlan } from "./types.js";

const CAPPED_PREFIX = "[Capped:";

function alreadyCapped(bytes: Uint8Array): boolean {
  if (bytes.byteLength < CAPPED_PREFIX.length) return false;
  for (let index = 0; index < CAPPED_PREFIX.length; index += 1) {
    if (bytes[index] !== CAPPED_PREFIX.charCodeAt(index)) return false;
  }
  return true;
}

export class CapRule implements Rule {
  readonly id = "cap" as const;

  plan(context: RuleContext): RulePlan | null {
    if (context.input.kind !== "entry" || !context.capabilities.mutateResult) {
      return null;
    }
    const result = context.input.result;
    // Keep this runtime check even though EngineInput declares a tool result.
    if (result.kind !== "tool-result") return null;
    const { capBytes, capHeadBytes } = context.config.thresholds;
    if (
      capHeadBytes === null ||
      result.byteLength <= capBytes ||
      context.reservedNodeIds.includes(result.id) ||
      alreadyCapped(result.bytes)
    ) {
      return null;
    }

    // A boundary already at a line end stays there; otherwise extend forward.
    const headLine = splitLineOffsets(result.bytes).find(
      (line) => line.endByteExclusive >= capHeadBytes,
    );
    if (headLine === undefined) return null;
    const keepHeadEndByte = headLine.endByteExclusive;
    const ranges = complementByteRanges(result.byteLength, [
      { startByte: 0, endByteExclusive: keepHeadEndByte },
    ]);
    if (ranges.length === 0) return null;

    const removalId = "body";
    const noteId = "marker";
    return {
      ruleId: this.id,
      baseRevision: context.snapshot.revision,
      removals: [
        {
          id: removalId,
          title: `Capped tool result ${result.id}`,
          sources: [
            {
              source: {
                nodeId: result.id,
                sha256: result.sha256,
                byteLength: result.byteLength,
              },
              ranges,
            },
          ],
        },
      ],
      notes: [{ id: noteId, kind: "cap-marker", removalId }],
      operations: [{ kind: "cap", removalId, keepHeadEndByte, noteId }],
    };
  }
}
