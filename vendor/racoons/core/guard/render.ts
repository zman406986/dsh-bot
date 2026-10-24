import { negativeFact, receiptLine } from "../rules/assets.js";
import type { Note } from "../rules/types.js";
import type {
  EventId, LineRange, NodeId, NoteId, RecallId, RuleId, SessionId,
} from "../types/identity.js";
import type { PathEvidence } from "../types/transcript.js";
import { digest } from "./bytes.js";
import type { RenderedRecord } from "./types.js";

/** The facts a receipt line names; the recall id comes from `makeRecall`. */
export interface ReceiptAssets {
  readonly path: string;
  readonly ranges: readonly LineRange[];
  readonly label: string | null;
  readonly recallId: RecallId;
}
export interface RecordAssets {
  readonly negative: ReadonlyMap<string, {
    readonly target: string;
    readonly entries: readonly PathEvidence[];
  }>;
  readonly receipt: ReadonlyMap<string, ReceiptAssets>;
}
/**
 * The record id a note carries once rendered: derived from the session, event,
 * rule and the note's own id, so one plan renders the same record ids on every
 * run and a note id from another application cannot be replayed.
 */
export function renderedNoteId(
  value: { readonly snapshot: { readonly sessionId: SessionId };
    readonly input: { readonly eventId: EventId } },
  ruleId: RuleId,
  noteId: NoteId,
): NodeId {
  return `racoons:${digest(new TextEncoder().encode(JSON.stringify([
    value.snapshot.sessionId, value.input.eventId, ruleId, noteId,
  ])))}`;
}
/**
 * The cap marker's replacement renderer left the product with the entry-time
 * cap (ADR-0014, 2026-10-23): no in-place rewrite exists any more, so a
 * `cap-marker` note has no render path.
 */
export function renderRecords(notes: readonly Note[], assets: RecordAssets): RenderedRecord[] {
  return notes.map(note => {
    let text: string;
    if (note.kind === "negative-fact") {
      const data = assets.negative.get(note.id);
      if (data === undefined) throw new Error(`Missing episode assets for ${note.id}`);
      text = negativeFact(data);
    } else if (note.kind === "receipt") {
      const data = assets.receipt.get(note.id);
      if (data === undefined) throw new Error(`Missing receipt assets for ${note.id}`);
      // The note's own fields are the plan's; the assets carry the archive id.
      // They must agree, or a receipt would name a different label than planned.
      if (data.path !== note.path || data.label !== note.label
        || !sameLineRanges(data.ranges, note.ranges)) {
        throw new Error(`Receipt assets disagree with note ${note.id}`);
      }
      text = receiptLine(data);
    } else throw new Error(`Unsupported record kind: ${note.kind}`);
    const bytes = new TextEncoder().encode(text);
    return { recordId: note.id, bytes, sha256: digest(bytes) };
  });
}
function sameLineRanges(a: readonly LineRange[], b: readonly LineRange[]): boolean {
  return a.length === b.length && a.every((range, i) => range.startLine === b[i]?.startLine
    && range.endLineInclusive === b[i]?.endLineInclusive);
}
