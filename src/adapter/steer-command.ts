/**
 * Host slash-command registration for mid-run steer input (ticket 22,
 * design-16 §4.3). The transport does not change: the handler routes into
 * the same core last-wins steer queue the `steer_worker` tool uses — the
 * command is an input path, not new steer semantics (no restart, context
 * preserved, last-wins).
 *
 * Registered at apply (flag ON) with an in-handler activation gate, per the
 * dsh-bot activation lifecycle pattern (ticket 19; the command was renamed
 * from /dispatcher-start by ADR-0030): the dormant plugin shows
 * the command, but the handler refuses anything that is not the activated
 * dispatcher chat. The v2 `conversation.input.dock` affordance is deferred
 * (see ticket 22 comments) — offline, the dock's submit wiring cannot be
 * verified against the shipped command/core path.
 *
 * All copy below is original clean-room text (design-16 §6).
 * Structural only — no import of `@deepseek-ai/dsh-commands` (peer surface).
 */

import type { SteerResult } from "../core/types.js";
import type { PolicyLanguage } from "../core/policy/prompts.js";
import type {
  AdapterContext,
  AgentLike,
  CommandDefinitionLike,
  CommandResultLike,
} from "./cordis-dsh-host.js";

/** Globally unique host command name (`dispatcher-` prefix, design-16 §5). */
export const DISPATCHER_STEER_COMMAND = "dispatcher-steer";

/** Command menu description. */
export const DISPATCHER_STEER_DESCRIPTION =
  "Send a mid-run instruction to a running worker. The most recent " +
  "instruction wins.";

/** Input hint advertised with the command (design-16 §6). */
export const DISPATCHER_STEER_INPUT_HINT = "worker id, then your instruction";

/** Success copy (design-16 §6 template, worker id substituted). */
export function dispatcherSteerSuccess(workerId: string): string {
  return `Steer queued for ${workerId}.`;
}

/** No dispatcher is active — nothing to steer through. */
export const DISPATCHER_STEER_NOT_ACTIVE =
  "No dispatcher is active yet. Run /dsh-bot in a top-level chat first.";

/**
 * A dispatcher is active, but not in the chat that invoked the command.
 * A non-top-level chat can never hold the activation (activation refuses
 * it), so this refusal covers child/delegated chats too.
 */
export const DISPATCHER_STEER_NOT_DISPATCHER =
  "Steering runs in the dispatcher chat. Send /dispatcher-steer from the " +
  "chat where you ran /dsh-bot.";

/** Missing or empty input. */
export const DISPATCHER_STEER_USAGE =
  "Provide a worker id and an instruction. Example: /dispatcher-steer " +
  "worker-1 focus on the failing test first.";

/** Unknown worker id (core refusal vocabulary: `unknown-worker`). */
export function dispatcherSteerUnknownWorker(workerId: string): string {
  return `Unknown worker: ${workerId}. Check the worker roster for live ids.`;
}

/** Worker exists but is not steerable (core refusal vocabulary: `not-running`). */
export function dispatcherSteerNotRunning(workerId: string): string {
  return `Worker ${workerId} is not running; it may already be done.`;
}

/**
 * One language face of the command copy. The EN face is the pre-existing,
 * byte-identical copy above; the ZH face is new client/host copy written for
 * this repo.
 */
export interface DispatcherSteerCopy {
  readonly description: string;
  readonly inputHint: string;
  success(workerId: string): string;
  readonly notActive: string;
  readonly notDispatcher: string;
  readonly usage: string;
  unknownWorker(workerId: string): string;
  notRunning(workerId: string): string;
}

/** EN copy — every string is the shipped pre-153 byte-for-byte copy. */
export const DISPATCHER_STEER_COPY_EN: DispatcherSteerCopy = {
  description: DISPATCHER_STEER_DESCRIPTION,
  inputHint: DISPATCHER_STEER_INPUT_HINT,
  success: dispatcherSteerSuccess,
  notActive: DISPATCHER_STEER_NOT_ACTIVE,
  notDispatcher: DISPATCHER_STEER_NOT_DISPATCHER,
  usage: DISPATCHER_STEER_USAGE,
  unknownWorker: dispatcherSteerUnknownWorker,
  notRunning: dispatcherSteerNotRunning,
};

/** ZH copy (new text, no reference material consulted). */
export const DISPATCHER_STEER_COPY_ZH: DispatcherSteerCopy = {
  description: "向正在运行的工作者发送中途指示。最新的指示生效。",
  inputHint: "工作者 ID，然后是你要说的指示",
  success: (workerId) => `已为 ${workerId} 排队中途指示。`,
  notActive: "还没有激活的调度器。请先在顶层聊天中运行 /dsh-bot。",
  notDispatcher:
    "中途指示在调度器聊天中进行。请在运行过 /dsh-bot 的聊天中发送 /dispatcher-steer。",
  usage:
    "请提供工作者 ID 和指示。示例：/dispatcher-steer worker-1 先处理失败的测试。",
  unknownWorker: (workerId) =>
    `未知工作者：${workerId}。请查看工作者名单中的有效 ID。`,
  notRunning: (workerId) =>
    `工作者 ${workerId} 未在运行；它可能已经完成。`,
};

/**
 * Resolve the copy face. Only the two shipped languages exist; anything else
 * fails closed to EN (`resolvePolicyLanguage` already does this upstream).
 */
export function dispatcherSteerCopy(
  language: PolicyLanguage | undefined,
): DispatcherSteerCopy {
  return language === "zh" ? DISPATCHER_STEER_COPY_ZH : DISPATCHER_STEER_COPY_EN;
}

/**
 * Map a core steer refusal to user-visible command copy. The worker id comes
 * from the parsed invocation, not the core detail string.
 */
export function steerRefusalCopy(
  result: SteerResult,
  workerId: string,
  copy: DispatcherSteerCopy = DISPATCHER_STEER_COPY_EN,
): CommandResultLike {
  if (result.ok) {
    // Not a refusal — the caller handles success; never invent copy here.
    return { kind: "error", text: copy.usage };
  }
  switch (result.reason) {
    case "unknown-worker":
      return { kind: "error", text: copy.unknownWorker(workerId) };
    case "not-running":
      return { kind: "error", text: copy.notRunning(workerId) };
  }
}

/** Parsed steer payload: first token is the worker id, rest is the instruction. */
export interface ParsedSteerInput {
  readonly workerId: string;
  readonly instruction: string;
}

/**
 * Parse "<worker id> <instruction>" raw command input. Returns null when
 * either part is missing or blank — the caller refuses with usage copy.
 */
export function parseSteerInput(
  rawInput: string | undefined,
): ParsedSteerInput | null {
  const text = (rawInput ?? "").trim();
  const match = /^(\S+)\s+([\s\S]+)$/.exec(text);
  if (match === null) return null;
  const workerId = match[1];
  if (workerId === undefined) return null;
  const instruction = (match[2] ?? "").trim();
  if (instruction.length === 0) return null;
  return { workerId, instruction };
}

export interface RegisterDispatcherSteerCommandOptions {
  readonly ctx: AdapterContext;
  /**
   * Every activated dispatcher session id (ADR-0019: there may be several —
   * the handler gates on the INVOKING chat's own activation, not a single
   * slot). Empty while dormant.
   */
  readonly activeSessionIds: () => readonly string[];
  /**
   * Enqueue a steer through the core's existing last-wins queue path —
   * the same `Multitask.steerWorker` call the `steer_worker` tool makes.
   */
  readonly steer: (workerId: string, message: string) => Promise<SteerResult>;
  /**
   * Lazy model-facing language getter (ticket 153's settled language). Read
   * per invocation so a late settlement is honored; absent means EN, keeping
   * every pre-localization caller byte-identical.
   */
  readonly language?: () => PolicyLanguage;
}

/**
 * Build the `dispatcher-steer` command definition. The handler gates on the
 * invoking chat's own dispatcher activation (per session, ADR-0019), parses
 * the payload, validates worker and steerability through the core's own
 * refusals, and never re-implements steer semantics.
 */
export function createDispatcherSteerCommand(
  options: RegisterDispatcherSteerCommandOptions,
): CommandDefinitionLike {
  const initialCopy = dispatcherSteerCopy(options.language?.());
  return {
    name: DISPATCHER_STEER_COMMAND,
    description: initialCopy.description,
    input: { hint: initialCopy.inputHint },
    handler(invocation) {
      const copy = dispatcherSteerCopy(options.language?.());
      const agent: AgentLike | undefined = invocation?.agent;
      const active = options.activeSessionIds();
      const sessionId =
        agent?.session == null ? undefined : String(agent.session.id);
      if (active.length === 0 || sessionId === undefined) {
        return { kind: "error", text: copy.notActive };
      }
      if (!active.includes(sessionId)) {
        return { kind: "error", text: copy.notDispatcher };
      }
      const parsed = parseSteerInput(invocation.rawInput);
      if (parsed === null) {
        return { kind: "error", text: copy.usage };
      }
      return options.steer(parsed.workerId, parsed.instruction).then(
        (result): CommandResultLike =>
          result.ok
            ? { kind: "success", text: copy.success(parsed.workerId) }
            : steerRefusalCopy(result, parsed.workerId, copy),
      );
    },
  };
}

/**
 * Register the steer command on ctx.commands. Returns the disposer, or a
 * no-op when the registry is unavailable (stub contexts).
 */
export function registerDispatcherSteerCommand(
  options: RegisterDispatcherSteerCommandOptions,
): () => void {
  const commands = options.ctx.commands;
  if (commands === undefined || typeof commands.register !== "function") {
    return () => {};
  }
  return commands.register(createDispatcherSteerCommand(options));
}
