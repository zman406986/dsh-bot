import type { Multitask } from "../core/multitask.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "./cordis-dsh-host.js";

/**
 * Top-level dispatcher: no parent lineage, delegation depth 0.
 * Accepts the first session-started agent when header is inaccessible.
 */
export function isTopLevel(agent: AgentLike): boolean {
  const header = agent.session?.header;
  if (header == null) return true;
  const parent = header.parentSession;
  const depth = header.delegationDepth ?? 0;
  return (parent === null || parent === undefined) && depth === 0;
}

export interface BindDispatcherLifecycleResult {
  /** Current dispatcher session id, once captured. */
  dispatcherSessionId(): string | null;
  /** Tear down listeners. */
  unbind(): void;
}

/**
 * Capture the live dispatcher Agent on `agent/session-start` and wire
 * child + dispatcher `agent/status` for:
 * - wakeBus session turn bounds (dispatcher running/idle) — T06 follow-up
 * - worker FSM first turn (child running → multitask.noteTurnStarted)
 * - step-boundary (child idle → host.emitStepBoundary)
 *
 * Distinct id spaces — do not conflate:
 * | Call | Id |
 * |---|---|
 * | multitask.noteTurnStarted | workerId |
 * | wakeBus.noteTurnStarted/Ended | dispatcherSessionId |
 */
export function bindDispatcherLifecycle(
  ctx: AdapterContext,
  host: CordisDshHost,
  multitask: Multitask,
): BindDispatcherLifecycleResult {
  let dispatcherSessionId: string | null = null;
  let parentAgentRef: AgentLike | null = null;
  const disposers: Array<() => void> = [];

  disposers.push(
    ctx.on("agent/session-start", (payload: never) => {
      const { agent } = payload as { agent: AgentLike };
      if (!isTopLevel(agent)) return;
      if (parentAgentRef !== null) {
        // Multi-agent profile residual: first top-level wins; ignore later ones.
        return;
      }
      const sessionId = String(agent.session.id);
      parentAgentRef = agent;
      dispatcherSessionId = sessionId;
      host.bindParent(agent, sessionId);
    }),
  );

  disposers.push(
    ctx.on("agent/disposed", (payload: never) => {
      const { agent } = payload as { agent: AgentLike };
      if (parentAgentRef === agent) {
        parentAgentRef = null;
        dispatcherSessionId = null;
        host.unbindParent();
      }
    }),
  );

  disposers.push(
    ctx.on("agent/status", (payload: never) => {
      const { agent, status } = payload as {
        agent: AgentLike;
        status: "idle" | "running";
      };
      const agentSessionId = String(agent.session.id);

      // Dispatcher mid-turn hold so settles queue instead of flushing (T06).
      if (dispatcherSessionId !== null && agentSessionId === dispatcherSessionId) {
        if (status === "running") {
          multitask.wakeBus.noteTurnStarted(dispatcherSessionId);
        }
        if (status === "idle") {
          multitask.wakeBus.noteTurnEnded(dispatcherSessionId);
        }
        return;
      }

      // Worker paths — only our spawned children.
      const workerId = host.workerIdOf(agentSessionId);
      if (workerId === undefined) return;
      if (status === "running") {
        // First real activity: spawned → running on the core FSM.
        multitask.noteTurnStarted(workerId);
      }
      if (status === "idle") {
        // Steer delivery point: core pops a parked last-wins steer.
        host.emitStepBoundary(workerId);
      }
    }),
  );

  return {
    dispatcherSessionId(): string | null {
      return dispatcherSessionId;
    },
    unbind(): void {
      for (const dispose of disposers) {
        dispose();
      }
      disposers.length = 0;
      parentAgentRef = null;
      dispatcherSessionId = null;
    },
  };
}
