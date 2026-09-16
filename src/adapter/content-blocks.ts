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
 */
export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const text = (block as TextBlock).text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
}
