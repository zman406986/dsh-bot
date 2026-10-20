import type { RacoonsConfig } from "@racoons/core/config.js";
import type { EngineInput, EngineOptions, EngineResult } from "@racoons/core/engine/types.js";
import type { MemoryBlobStore } from "@racoons/core/ledger/memory-blob-store.js";
import type { Ledger } from "@racoons/core/ledger/types.js";
import type { Meter } from "@racoons/core/meter/meter.js";
import type { ToolEvidence } from "@racoons/core/types/transcript.js";
import type { DshToolResultItem } from "racoons-dsh/envelope.js";
import type { DshEvidenceInput } from "racoons-dsh/evidence.js";

export type Row = Record<string, unknown>;
export interface RacoonsSession {
  readonly id: string;
  readonly seq: number;
  readonly surface: { readonly nodes: readonly { readonly seq: number }[] };
  eventAt(seq: number): unknown;
  append(role: string, payload: unknown, options: {
    surfaceOp: { op: "replace"; startSeq: number; endSeq: number } | { op: "append" };
    sourceEventSeqs?: number[];
  }): unknown;
}
export interface RacoonsContext {
  on(name: string, listener: (...args: never[]) => void): () => void;
}
export interface RacoonsEngineLike { process(input: EngineInput): Promise<EngineResult> }
export interface RacoonsOptions {
  readonly enabled: boolean;
  readonly shouldHandle: (sessionId: string) => boolean;
  readonly config?: RacoonsConfig;
  readonly meter?: Meter;
  readonly onError?: (error: unknown) => void;
  readonly createEngine?: (options: EngineOptions) => Promise<RacoonsEngineLike>;
  readonly openLedger?: (options: {
    databasePath: string; blobStore: MemoryBlobStore; clock: { nowMs(): number };
  }) => Promise<Ledger>;
  readonly unavailableLedger?: Ledger;
  /** Explicit tool facts only. Missing evidence cannot justify a seal. */
  readonly evidenceFor?: (session: RacoonsSession, seq: number) => DshEvidenceInput;
}
export interface PendingEntry {
  readonly seq: number;
  readonly callId: string;
  readonly role: "tool/result";
  readonly bytes: Uint8Array;
  readonly evidence: ToolEvidence;
}
export function row(value: unknown): Row {
  if (value === null || typeof value !== "object") throw new Error("Invalid dsh event shape");
  return value as Row;
}
export const clock = { nowMs: () => Date.now() };
export function report(options: Pick<RacoonsOptions, "onError">, error: unknown): void {
  try {
    if (options.onError !== undefined) options.onError(error);
    else console.warn("[multitask-dispatcher] racoons:", error);
  } catch { /* Logging cannot fail a turn. */ }
}

/** Only plain text is eligible. Mixed or unknown content stays opaque. */
export function contentBytes(data: Row): Uint8Array {
  const content = data["content"];
  if (!Array.isArray(content) || content.some(block => {
    const value = row(block);
    return value["type"] !== "text" || typeof value["text"] !== "string";
  })) throw new Error("RACOONS needs a plain text content array");
  return new TextEncoder().encode(content.map(block => row(block)["text"] as string).join(""));
}
export function resultItem(session: RacoonsSession, seq: number, event: Row,
  turnOrdinal: number, stepOrdinal: number, evidenceFor?: RacoonsOptions["evidenceFor"]): DshToolResultItem {
  const data = row(event["data"]);
  if (typeof data["callId"] !== "string") throw new Error("Tool result has no callId");
  return {
    id: `${session.id}:${seq}`, role: "tool", callId: data["callId"],
    toolName: typeof data["toolName"] === "string" ? data["toolName"] : "unknown",
    bytes: contentBytes(data), turnOrdinal, stepOrdinal,
    // Only explicit structured evidence is accepted; display text never proves a miss.
    ...evidenceFor?.(session, seq),
  };
}
