/**
 * RACOONS M1: observe tool results now; publish entry applications at pre-step.
 * Blob store and SQLite ledger are in memory; archives expire on unload.
 * This registration does not expose a model-facing recall tool.
 * SQLite is imported inside the guarded factory, because node:sqlite may be absent.
 * The injected unavailable ledger refuses storage; the engine returns recovery-pending.
 * session.append must be synchronous. An uncertain publication is never replayed.
 */
import { DEFAULT_CONFIG } from "@racoons/core/config.js";
import type { EngineOptions, EngineResult } from "@racoons/core/engine/types.js";
import { MemoryBlobStore } from "@racoons/core/ledger/memory-blob-store.js";
import type { Ledger, SqliteLedgerOptions } from "@racoons/core/ledger/types.js";
import { Meter } from "@racoons/core/meter/meter.js";
import { CharHeuristicTokenMeter } from "@racoons/core/meter/token-meter.js";
import { CapRule } from "@racoons/core/rules/cap.js";
import { SealRule } from "@racoons/core/rules/seal.js";
import { toCoreEnvelope } from "racoons-dsh/envelope.js";
import { createRacoonsPort } from "./racoons-port.js";
import { clock, report, resultItem, row, type PendingEntry, type RacoonsContext,
  type RacoonsEngineLike, type RacoonsOptions, type RacoonsSession } from "./racoons-session.js";

export { createRacoonsPort } from "./racoons-port.js";
export type { RacoonsContext, RacoonsEngineLike, RacoonsOptions, RacoonsSession } from "./racoons-session.js";

/**
 * Library defaults leave head retention unset, which makes CapRule skip every result.
 * The registered path needs a head size, or turning the flag on changes nothing.
 * 2048 bytes of the original head keeps enough for the agent to recognise the file.
 */
const M1_RUNTIME_CONFIG = {
  ...DEFAULT_CONFIG,
  thresholds: { ...DEFAULT_CONFIG.thresholds, capHeadBytes: 2048 },
} as const;

/** No fake storage success: even an empty pass must stop in recovery. */export function createUnavailableLedger(): Ledger {
  const unavailable = (): never => { throw new Error("racoons ledger unavailable"); };
  return {
    async prepare() { return unavailable(); },
    async append() { return unavailable(); },
    async *events() { unavailable(); },
    async recall() { return unavailable(); },
    async close() {},
  };
}

/** Call inside ctx.effect and return this disposer as the effect's cleanup. */
export function registerRacoons(ctx: RacoonsContext, options: RacoonsOptions): () => void {
  if (!options.enabled) return () => {};
  let disposed = false;
  const disposers: Array<() => void> = [];
  const states = new Map<string, {
    session: RacoonsSession;
    pending: Map<number, PendingEntry>;
    notApplied: Map<number, EngineResult["status"]>;
    seen: Set<number>;
    bridge: ReturnType<typeof createRacoonsPort>;
    engine?: Promise<RacoonsEngineLike>;
    ledger?: Ledger;
    queue: Promise<void>;
  }>();
  const stateFor = (session: RacoonsSession) => {
    let state = states.get(session.id);
    if (state === undefined) {
      state = { session, pending: new Map(), notApplied: new Map(), seen: new Set(),
        bridge: createRacoonsPort(session, () => !disposed && options.shouldHandle(session.id), options.evidenceFor, options.onError),
        queue: Promise.resolve() };
      states.set(session.id, state);
    }
    if (state.session !== session) throw new Error("RACOONS session identity changed");
    return state;
  };
  const engineFor = (state: ReturnType<typeof stateFor>): Promise<RacoonsEngineLike> => {
    state.engine ??= (async () => {
      const blobStore = new MemoryBlobStore();
      let ledger: Ledger;
      try {
        const open = options.openLedger ?? (async (settings: SqliteLedgerOptions) => {
          const { SqliteLedger } = await import("@racoons/core/ledger/sqlite-ledger.js");
          return SqliteLedger.open(settings);
        });
        ledger = await open({ databasePath: ":memory:", blobStore, clock });
      } catch (error) {
        report(options, error);
        ledger = options.unavailableLedger ?? createUnavailableLedger();
      }
      state.ledger = ledger;
      const createEngine = options.createEngine ?? (async (settings: EngineOptions) => {
        const { RacoonsEngine } = await import("@racoons/core/engine/engine.js");
        return RacoonsEngine.open(settings);
      });
      return createEngine({ sessionId: state.session.id,
        config: options.config ?? M1_RUNTIME_CONFIG, clock, ledger, port: state.bridge.port,
        meter: options.meter ?? new Meter(new CharHeuristicTokenMeter()),
        capabilities: { mutateResult: true, rewriteHistory: false, atRest: true,
          liveTokens: false, log: true, appendRecords: true, rehydrateOnResume: false },
        rules: [new CapRule(), new SealRule()],
        onTelemetry: event => { if (event.kind === "error") report(options, event); },
      });
    })().catch((error): RacoonsEngineLike => {
      report(options, error);
      return { async process(): Promise<EngineResult> {
        return { status: "recovery-pending", intentId: null, receipt: null, validation: null };
      } };
    });
    return state.engine;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const off of disposers.splice(0).reverse()) {
      try { off(); } catch (error) { report(options, error); }
    }
    for (const state of states.values()) {
      void state.queue.then(async () => { await state.ledger?.close(); }).catch(error => report(options, error));
    }
    states.clear();
  };
  try {
    disposers.push(ctx.on("session/event", (...args: never[]) => {
      try {
        const [session, rawEvent] = args as unknown as [RacoonsSession, unknown];
        if (disposed || !options.shouldHandle(session.id)) return;
        const event = row(rawEvent);
        if (event["type"] !== "tool/result") return;
        const seq = event["seq"];
        if (typeof seq !== "number" || !Number.isSafeInteger(seq)) throw new Error("Missing result sequence");
        const state = stateFor(session);
        if (state.bridge.isPublished(seq) || state.seen.has(seq)) return;
        const item = resultItem(session, seq, event, 0, 0, options.evidenceFor);
        const node = toCoreEnvelope(item, 0).node;
        const entry: PendingEntry = { seq, callId: item.callId, role: "tool/result",
          bytes: new Uint8Array(item.bytes), evidence: structuredClone(node.evidence) };
        state.pending.set(seq, entry);
        state.seen.add(seq);
        state.bridge.observe(entry);
      } catch (error) { report(options, error); }
    }));
    disposers.push(ctx.on("agent/pre-step", async (...args: never[]) => {
      try {
        const payload = row((args as unknown[])[0]);
        const agent = row(payload["agent"] ?? payload);
        const session = agent["session"] as RacoonsSession;
        if (disposed || !options.shouldHandle(session.id)) return;
        const state = stateFor(session);
        const pass = state.queue.then(async () => {
          if (disposed || !options.shouldHandle(session.id)) return;
          const stepId = state.bridge.nextStep();
          try {
            state.bridge.refresh();
            const engine = await engineFor(state);
            for (const entry of [...state.pending.values()].sort((a, b) => a.seq - b.seq)) {
              if (disposed || !options.shouldHandle(session.id)) return;
              state.bridge.refresh();
              const eventId = `${session.id}:entry:${entry.seq}`;
              const result = await engine.process({ kind: "entry", eventId, result: state.bridge.stage(entry) });
              if (result.status === "recovery-pending") return;
              state.bridge.finish(eventId);
              state.pending.delete(entry.seq);
              if (result.status !== "applied") state.notApplied.set(entry.seq, result.status);
            }
            if (disposed || !options.shouldHandle(session.id)) return;
            state.bridge.refresh();
            await engine.process({ kind: "at-rest", eventId: `${session.id}:step:${stepId}`, reason: "step" });
          } finally { state.bridge.endPass(); }
        });
        state.queue = pass.catch(error => report(options, error));
        await state.queue;
      } catch (error) { report(options, error); }
    }));
  } catch (error) { report(options, error); dispose(); }
  return dispose;
}
