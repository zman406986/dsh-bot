import type { Multitask } from "../core/multitask.js";
import {
  assembleSessionPolicy,
  assembleTurnReminder,
} from "../core/policy/assembler.js";
import { textBlocks } from "./content-blocks.js";
import type { AdapterContext, AgentLike, CordisDshHost } from "./cordis-dsh-host.js";
import { PLUGIN_NAME, wakeUserMessage } from "./wake-copy.js";

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
    // Injection is best-effort; never break activation on it.
  }
}

/**
 * Best-effort *waking* delivery (ticket 57, register D-4).
 *
 * The difference from `tryInject` is the host primitive, not the payload:
 * `Agent.followup` is `send(input, "next-turn", wakeup=true)`, and a wake
 * submitted while the agent is idle always opens its turn boundary. `inject`
 * is `send(input, "next-step", wakeup=false)` — it queues context into a turn
 * that may never come. Verified against the installed host in the ticket-52
 * pass (`docs/research/dsh-loop-capability-map.md`, stage 7).
 *
 * Use this whenever the message MUST be acted on without the user happening
 * to send something next: activation-time recovery, and the settle wake. Use
 * `tryInject` when a turn is already open and extra model calls are waste.
 */
function tryWake(agent: AgentLike, text: string): void {
  if (text.length === 0) return;
  try {
    agent.followup(wakeUserMessage(text));
  } catch {
    // Waking is best-effort; never break activation on it.
  }
}

/**
 * Result of an activation attempt (ticket 19). Activation is explicit,
 * once per session, and refused with a reason the command handler maps
 * to user-facing copy.
 */
export type ActivationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "not-top-level"
        | "already-active-here"
        | "already-active-elsewhere"
        | "unbound";
    };

export interface BindDispatcherLifecycleResult {
  /**
   * Activate this chat as the dispatcher (ADR-0009): bind the parent,
   * inject policy once. Idempotent-refusing — never re-binds while a
   * dispatcher session is live.
   */
  activate(agent: AgentLike): ActivationOutcome;
  /**
   * Best-effort one-shot **waking** delivery into the activated chat
   * (ticket 57, register D-4): opens a recovery turn rather than waiting for
   * one. Used at activation for the restart-honesty notice, so recovery is
   * driven by us exactly as the reference drives it on boot.
   *
   * Named for activation, not boot: activation is our only trigger today
   * (ADR-0009). If ADR-0016 is signed into a boot hook, that hook calls this
   * same primitive — the trigger model is a separate decision (item U-1).
   */
  wakeNotice(text: string): void;
  /** Current dispatcher session id, once activated. */
  dispatcherSessionId(): string | null;
  /** Tear down listeners and the activation, if any. */
  unbind(): void;
}

export interface BindDispatcherLifecycleOptions {
  /**
   * Session-start flag (ADR-0005). Read once when the dispatcher binds.
   * OFF → no policy inject. Defaults to true.
   */
  readonly policyEnabled?: boolean;
  /**
   * Fired after a successful activation (parent bound + policy injected).
   * The plugin registers the deferred dispatcher tool surface here.
   */
  readonly onActivated?: (sessionId: string) => void;
  /**
   * Fired when the activation ends: dispatcher session disposed, or the
   * lifecycle itself is unbound (unload/HMR). The plugin unregisters the
   * dispatcher tool surface here.
   */
  readonly onDeactivated?: () => void;
}

/**
 * Activation lifecycle for the dispatcher parent agent (ticket 19, ADR-0009).
 *
 * Nothing is captured on load or on `agent/session-start` — the plugin boots
 * dormant and stock. An explicit command handler calls {@link activate} in
 * the chat the user chose; that binds the live Agent as the host's single
 * parent and injects the session policy once. `agent/disposed` and `unbind`
 * reverse the activation; the passive `agent/status` listener wires:
 * - wakeBus session turn bounds (dispatcher running/idle)
 * - worker FSM first turn (child running → multitask.noteTurnStarted)
 * - step-boundary (child idle → host.emitStepBoundary)
 * - per-turn reminder on dispatcher turn start (T11)
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
  const onActivated = options?.onActivated;
  const onDeactivated = options?.onDeactivated;
  let dispatcherSessionId: string | null = null;
  let parentAgentRef: AgentLike | null = null;
  let unbound = false;
  const disposers: Array<() => void> = [];

  function deactivate(): void {
    if (parentAgentRef === null && dispatcherSessionId === null) return;
    parentAgentRef = null;
    dispatcherSessionId = null;
    host.unbindParent();
    onDeactivated?.();
  }

  disposers.push(
    ctx.on("agent/disposed", (payload: never) => {
      const { agent } = payload as { agent: AgentLike };
      if (parentAgentRef === agent) {
        deactivate();
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
          // Ticket 58 (register D-5): decide the delivery redrive BEFORE the
          // bus is told the turn ended. Ordering matters twice over — the pass
          // only counts an attempt if the result is still undelivered (so a
          // turn that delivered costs nothing), and while the bus is still
          // busy the redrive becomes a pending flag, so the turn-end flush
          // delivers it exactly once alongside anything else waiting.
          if (policyEnabled) {
            multitask.redriveUndelivered(dispatcherSessionId);
          }
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
    activate(agent: AgentLike): ActivationOutcome {
      // HMR/unload safety: a torn-down lifecycle never re-binds.
      if (unbound) {
        return { ok: false, reason: "unbound" };
      }
      // Fail-open preserved: an inaccessible session header still counts as
      // top-level (documented isTopLevel behavior).
      if (!isTopLevel(agent)) {
        return { ok: false, reason: "not-top-level" };
      }
      const sessionId = String(agent.session.id);
      if (parentAgentRef !== null) {
        return dispatcherSessionId === sessionId
          ? { ok: false, reason: "already-active-here" }
          : { ok: false, reason: "already-active-elsewhere" };
      }
      parentAgentRef = agent;
      dispatcherSessionId = sessionId;
      host.bindParent(agent, sessionId);
      // ADR-0005: policy is fixed for this session's lifetime.
      if (policyEnabled) {
        tryInject(agent, assembleSessionPolicy(true));
      }
      onActivated?.(sessionId);
      return { ok: true };
    },

    wakeNotice(text: string): void {
      // Ticket 57 (D-4): the recovery notice must OPEN the turn it lands in.
      // `inject` only queues, so before this fix the notice sat in context
      // until the user happened to speak next — the chain stopped after a
      // restart. Waking is what the reference does on boot.
      if (parentAgentRef === null) return;
      tryWake(parentAgentRef, text);
    },

    dispatcherSessionId(): string | null {
      return dispatcherSessionId;
    },

    unbind(): void {
      deactivate();
      unbound = true;
      for (const dispose of disposers) {
        dispose();
      }
      disposers.length = 0;
    },
  };
}
