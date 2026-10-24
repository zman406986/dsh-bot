import type {
  ApplicationPort, CapabilityFlags, Clock, ColdBoundary, Disposable, EngineInput, EngineResult,
  RecallId, RecallRecord, ToolResultNode, ToolSpec,
} from '@racoons/core';
import { createDshCapabilities } from './capabilities.js';
import type { DshToolResultItem } from './envelope.js';
import type { DshRevertSession } from './revert.js';
import { createDshTools, registerDshTools } from './tools.js';
import type { DshToolHost } from './tools.js';

/** A structural engine contract keeps fake engines small and the wiring policy-free. */
export interface DshEngine {
  process(input: EngineInput): Promise<EngineResult>;
  recall(id: RecallId): Promise<RecallRecord>;
}

export interface DshAdapterPort extends ApplicationPort {
  deliverToolResult(
    eventId: string, item: DshToolResultItem,
    process: (node: ToolResultNode) => Promise<EngineResult>,
  ): Promise<EngineResult>;
  setColdBoundary(boundary: ColdBoundary): void;
}

/**
 * The optional seams. `revert` is the host session the port appends through;
 * declaring it here as well keeps the exported capability flags honest, because
 * the same object is what the engine reads. `tools` is the additive tool host.
 */
export interface DshAdapterOptions {
  readonly engine: DshEngine;
  readonly port: DshAdapterPort;
  readonly clock: Clock;
  readonly revert?: DshRevertSession;
  readonly tools?: DshToolHost;
}

export interface DshAdapter {
  readonly capabilities: CapabilityFlags;
  onToolResult(eventId: string, result: DshToolResultItem): Promise<EngineResult>;
  onPreStep(eventId: string): Promise<EngineResult>;
  onResume(eventId: string): Promise<EngineResult>;
  onIdlePastTtl(eventId: string): Promise<EngineResult>;
  onModelSwitch(eventId: string): Promise<EngineResult>;
  recall(id: RecallId): Promise<RecallRecord>;
  /**
   * The specs this build can actually register, always filtered to tools with a
   * handler: a model is never offered a tool that would fail (design-protocol
   * §4: only `recall` has an execution path in this milestone).
   */
  toolSpecs(): readonly ToolSpec[];
  /** Registers the tools; absent when no host was supplied, so the flag can never lie. */
  registerTools?(): Disposable;
}

export function createDshAdapter(options: DshAdapterOptions): DshAdapter {
  const { engine, port, clock } = options;
  const capabilities = createDshCapabilities(options.revert !== undefined);
  const tools = createDshTools({ recall: id => engine.recall(id) });
  const host = options.tools;
  const atRest = (eventId: string, reason: Extract<EngineInput, { kind: 'at-rest' }>['reason']) =>
    engine.process({ kind: 'at-rest', eventId, reason });
  const cold = (eventId: string, kind: ColdBoundary['kind']) => {
    port.setColdBoundary({ kind, observedAtMs: clock.nowMs() });
    return atRest(eventId, kind);
  };
  return {
    capabilities,
    onToolResult: (eventId, result) => port.deliverToolResult(eventId, result,
      node => engine.process({ kind: 'entry', eventId, result: node })),
    onPreStep: eventId => atRest(eventId, 'step'),
    onResume: eventId => cold(eventId, 'resume'),
    onIdlePastTtl: eventId => cold(eventId, 'idle-past-ttl'),
    onModelSwitch: eventId => cold(eventId, 'model-switch'),
    recall: id => engine.recall(id),
    toolSpecs: () => tools.map(tool => tool.spec),
    ...(host === undefined ? {} : { registerTools: () => registerDshTools(host, tools) }),
  };
}
