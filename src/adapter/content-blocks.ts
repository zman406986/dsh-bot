/**
 * Structural ContentBlock helpers for the dsh adapter.
 * Uses the installed `dsh-llm` shape (`{ type: "text", text }`) without
 * importing host packages — core stays free of Cordis/dsh types.
 */

export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * Minimal structural view of dsh-llm ContentBlock.
 * Only the fields the adapter reads; other block kinds are opaque.
 */
export type ContentBlock =
  | TextBlock
  | { readonly type: string; readonly [key: string]: unknown };

/** One text content block. */
export function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

/** Single-element text-block array — the prompt/steer/wake shape. */
export function textBlocks(text: string): ContentBlock[] {
  return [textBlock(text)];
}

/**
 * Concatenate `type === "text"` blocks with "\n\n".
 * Ignores reasoning/tool/other blocks so settle reports stay plain text.
 *
 * Fail-open on junk: a host payload can carry `null`/`undefined`/primitive
 * entries even though the declared type is block objects (the settle path
 * feeds this straight from the `subagent/end` event). Every non-object is
 * skipped instead of throwing, because a throw here aborts settle — no
 * record, no wake, and the worker stays "running".
 */
export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { readonly type?: unknown; readonly text?: unknown };
    if (record.type !== "text") continue;
    const text = record.text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}
