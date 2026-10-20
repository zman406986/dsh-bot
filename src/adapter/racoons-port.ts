import type { ApplicationPort, ApplyRequest } from "@racoons/core/engine/types.js";
import type { ToolEvidence, ToolResultNode } from "@racoons/core/types/transcript.js";
import { DshApplicationPort } from "racoons-dsh/port.js";
import { toCoreEnvelope, type DshMessageItem, type DshToolResultItem, type DshTranscriptItem } from "racoons-dsh/envelope.js";
import { clock, contentBytes, report, resultItem, row, type PendingEntry, type RacoonsOptions, type RacoonsSession } from "./racoons-session.js";

interface Published {
  readonly id: string;
  readonly evidence?: ToolEvidence;
  readonly embeddedRecords?: NonNullable<DshToolResultItem["embeddedRecords"]>;
  readonly recordId?: string;
}

/** Host projection plus the library's validation, mode checks and receipt map. */
export function createRacoonsPort(session: RacoonsSession, mayPublish: () => boolean = () => true,
  evidenceFor?: RacoonsOptions["evidenceFor"], onError?: RacoonsOptions["onError"]) {
  let observed = "";
  let publishing = false;
  let activeEntryId: string | null = null;
  let staged: { seq: number; node: ToolResultNode } | undefined;
  let step = 0;
  const recordedEvidence = new Map<number, ToolEvidence>();
  const published = new Map<number, Published>();
  const sourceSeqs = new Map<string, number>();
  const revision = (): string => JSON.stringify([session.seq, session.surface.nodes.map(node => node.seq)]);
  const log = (error: unknown): void => report(onError === undefined ? {} : { onError }, error);
  const port = new DshApplicationPort({ sessionId: session.id, clock, publish(request, candidate) {
    try {
      if (!mayPublish() || revision() !== observed) throw new Error("RACOONS host changed before publication");
      const writes: Array<{ role: string; payload: unknown; seq: number | null; metadata: Published }> = [];
      for (const replacement of request.application.replacements) {
        const seq = sourceSeqs.get(replacement.source.nodeId);
        const item = candidate.find(value => value.id === replacement.source.nodeId);
        if (seq === undefined || item?.role !== "tool") throw new Error("Missing replacement source");
        const event = row(session.eventAt(seq));
        if (event["type"] !== "tool/result") throw new Error("Replacement source is not a tool result");
        const payload = { ...row(event["data"]), content: [{ type: "text",
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(item.bytes) }] };
        writes.push({ role: "tool/result", payload, seq, metadata: {
          id: item.id, ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
          ...(item.embeddedRecords === undefined ? {} : { embeddedRecords: item.embeddedRecords }),
        } });
      }
      const records = request.application.appendRecords;
      const firstRecord = records[0];
      if (firstRecord !== undefined) {
        writes.push({ role: "system", payload: { content: records.map(record => ({ type: "text",
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.bytes) })) },
          seq: null, metadata: { id: firstRecord.recordId, recordId: firstRecord.recordId } });
      }
      // One append publishes the complete application. Refuse an unavailable atomic seam.
      if (writes.length > 1) throw new Error("RACOONS requires one atomic host append");
      for (const write of writes) {
        const before = session.surface.nodes.map(node => node.seq);
        const beforeSeq = session.seq;
        publishing = true;
        let outcome: unknown;
        try {
          outcome = session.append(write.role, write.payload, write.seq === null
            ? { surfaceOp: { op: "append" } }
            : { surfaceOp: { op: "replace", startSeq: write.seq, endSeq: write.seq }, sourceEventSeqs: [write.seq] });
        } finally { publishing = false; }
        if (outcome !== null && typeof outcome === "object" && "then" in outcome) {
          void Promise.resolve(outcome).catch(log);
          throw new Error("RACOONS requires synchronous session.append");
        }
        const written = typeof outcome === "number" ? outcome
          : outcome !== null && typeof outcome === "object" ? row(outcome)["seq"] : session.seq;
        if (typeof written !== "number" || !Number.isSafeInteger(written) || written <= beforeSeq) {
          throw new Error("RACOONS append has no fresh receipt sequence");
        }
        const expected = write.seq === null ? [...before, written]
          : before.map(seq => seq === write.seq ? written : seq);
        if (write.seq !== null && !before.includes(write.seq)) throw new Error("Replacement source disappeared");
        if (JSON.stringify(session.surface.nodes.map(node => node.seq)) !== JSON.stringify(expected)) {
          throw new Error("RACOONS append did not publish the complete surface operation");
        }
        published.set(written, structuredClone(write.metadata));
      }
      observed = revision();
    } catch (error) {
      log(error);
      throw error; // The library port records an unknown outcome and blocks replay.
    }
  } });
  const refresh = (): void => {
    const items: DshTranscriptItem[] = [];
    let turn = 0;
    let ordinal = 0;
    sourceSeqs.clear();
    for (const surfaceNode of session.surface.nodes) {
      const seq = surfaceNode.seq;
      const event = row(session.eventAt(seq));
      const type = event["type"];
      const data = row(event["data"]);
      const prior = published.get(seq);
      let item: DshTranscriptItem;
      if (type === "tool/result") {
        if (prior?.recordId !== undefined) throw new Error("RACOONS record changed role");
        const evidence = prior?.evidence ?? recordedEvidence.get(seq);
        item = { ...resultItem(session, seq, event, turn, ordinal, evidenceFor),
          id: prior?.id ?? `${session.id}:${seq}`,
          ...(evidence === undefined ? {} : { evidence: structuredClone(evidence) }),
          ...(prior?.embeddedRecords === undefined ? {} : { embeddedRecords: structuredClone(prior.embeddedRecords) }) };
      } else {
        if (type !== "system" && type !== "developer" && type !== "user" && type !== "assistant") {
          throw new Error(`Unknown dsh surface event: ${String(type)}`);
        }
        if (type === "user") turn += 1;
        if (type === "assistant") ordinal += 1;
        const calls = data["toolCalls"];
        const toolCallIds = Array.isArray(calls) ? calls.map(call => {
          const value = row(call);
          const id = value["callId"] ?? value["id"];
          if (typeof id !== "string") throw new Error("Missing assistant tool call identity");
          return id;
        }) : [];
        const message: DshMessageItem = { id: prior?.id ?? `${session.id}:${seq}`, role: type, bytes: contentBytes(data),
          turnOrdinal: turn, stepOrdinal: ordinal, toolCallIds };
        item = prior?.recordId === undefined ? message : { ...message, recordId: prior.recordId };
      }
      sourceSeqs.set(item.id, seq);
      items.push(item);
    }
    port.setTranscript(items);
    port.updateState({ currentTurnOrdinal: turn, completedThroughTurnOrdinal: turn - 1,
      currentStepOrdinal: Math.max(step, ordinal), cache: { kind: "unknown" },
      protection: { inFlightTurnOrdinal: turn, newestTailNodeIds: [], openApprovalNodeIds: [], policySpans: [], quotedThisTurn: [] } });
    observed = revision();
  };
  const applicationPort: ApplicationPort = {
    async snapshot() {
      const snapshot = await port.snapshot();
      // The staged source is still in dsh, but is incoming to the entry-only guard.
      if (activeEntryId === null) return snapshot;
      const index = snapshot.nodes.findIndex(node => node.id === activeEntryId);
      if (index < 0) throw new Error("Staged entry source disappeared");
      return { ...snapshot, nodes: snapshot.nodes.slice(0, index) };
    },
    async apply(request: ApplyRequest) {
      const prior = await port.lookupReceipt(request.intent.intentId);
      if (prior.status === "not-applied" && (!mayPublish() || revision() !== observed)) {
        return { status: "not-applied", reason: "stale-revision" };
      }
      return port.apply(request);
    },
    lookupReceipt: intentId => port.lookupReceipt(intentId),
  };
  return { port: applicationPort, refresh,
    isPublished(seq: number) { return publishing || published.has(seq); },
    nextStep() { step += 1; return step; },
    observe(entry: PendingEntry) { recordedEvidence.set(entry.seq, structuredClone(entry.evidence)); },
    stage(entry: PendingEntry) {
      const item = port.transcript().find(value => value.id === `${session.id}:${entry.seq}`);
      if (item?.role !== "tool" || item.callId !== entry.callId) throw new Error("Pending result is no longer visible");
      activeEntryId = item.id;
      // Recovery keeps the original input after a host success and a ledger failure.
      if (staged?.seq === entry.seq) return structuredClone(staged.node);
      const node = toCoreEnvelope(item, 0).node;
      const recorded = toCoreEnvelope({ ...item, bytes: entry.bytes }, 0).node;
      if (node.sha256 !== recorded.sha256) throw new Error("Pending result bytes changed");
      const incomingNode = port.stageEntry(`${session.id}:entry:${entry.seq}`, item);
      staged = { seq: entry.seq, node: incomingNode };
      return structuredClone(incomingNode);
    },
    finish(eventId: string) { activeEntryId = null; staged = undefined; port.finishEntry(eventId); },
    endPass() { activeEntryId = null; },
  };
}
