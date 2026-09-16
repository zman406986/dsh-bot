import type { Multitask } from "../core/multitask.js";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
} from "../core/policy/assembler.js";
import { textBlocks } from "./content-blocks.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "./cordis-dsh-host.js";
import { PLUGIN_NAME } from "./wake-copy.js";

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

/** Structural system/plugin context message for `Agent.inject`. */
export interface PluginContextMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: ReturnType<typeof textBlocks>;
  readonly source: {
    readonly kind: "plugin";
    readonly plugin: string;
  };
}

let injectSeq = 0;

function pluginContextMessage(text: string): PluginContextMessage {
  injectSeq += 1;
  return {
    id: `multitask-policy-${Date.now()}-${injectSeq}`,
    role: "user",
    content: textBlocks(text),
    source: {
      kind: "plugin",
      plugin: PLUGIN_NAME,
    },
  };
}

/** Best-effort context inject; no-op when the agent has no inject. */
function tryInject(agent: AgentLike, text: string): void {
  if (typeof agent.inject !== "function") return;
  if (text.length === 0) return;
  try {
    agent.inject(pluginContextMessage(text));
  } catch {
    // Injection is best-effort; never break session-start on it.
  }
}

export interface BindDispatcherLifecycleResult {
  /** Current dispatcher session id, once captured. */
  dispatcherSessionId(): string | null;
  /** Tear down listeners. */
  unbind(): void;
}

export interface BindDispatcherLifecycleOptions {
  /**
   * Session-start flag (ADR-0005). Read once when the dispatcher binds.
   * OFF → no policy inject. Defaults to true.
   */
  readonly policyEnabled?: boolean;
}

/**
 * Capture the live dispatcher Agent on `agent/session-start` and wire
 * child + dispatcher `agent/status` for:
 * - wakeBus session turn bounds (dispatcher running/idle) — T06 follow-up
 * - worker FSM first turn (child running → multitask.noteTurnStarted)
 * - step-boundary (child idle → host.emitStepBoundary)
 * - policy inject at bind + per-turn reminder on dispatcher turn start (T11)
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
  options?: BindDispatcherLifecycleOptions,
): BindDispatcherLifecycleResult {
  const policyEnabled = options?.policyEnabled ?? true;
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
      // ADR-0005: policy is fixed for this session's lifetime.
      if (policyEnabled) {
        tryInject(agent, assembleSessionPolicy(true));
      }
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
          // Per-turn reminder: re-inject ledger + standing rules (T11).
          if (policyEnabled && parentAgentRef !== null) {
            tryInject(
              parentAgentRef,
              assembleTurnReminder(multitask.listTodos(dispatcherSessionId)),
            );
          }
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
