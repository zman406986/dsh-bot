/**
 * Per-dispatcher shadow for stock `subagent`. It supplies a stored worker route
 * as an ordinary stock selection request, so stock's Session allowlist,
 * preflight, Runtime authority and manager still decide whether a child starts.
 */

export interface StockWorkerModelRoute {
  readonly provider: string;
  readonly model: string;
}

export interface StockWorkerToolDefinition {
  readonly name?: string;
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>;
  readonly [key: string]: unknown;
}

export interface StockWorkerModelDefaultBridgeOptions {
  readonly agent: object;
  readonly tools: {
    get(name: string, scope: object): StockWorkerToolDefinition | undefined;
    /** Called without step admission, so a conditional registration is absent. */
    executable(name: string, scope: object): StockWorkerToolDefinition | undefined;
    register(definition: StockWorkerToolDefinition): () => void;
  };
  /** Public parent-scope lookup without removing the own-layer shadow. */
  readonly inherited: () => { definition: StockWorkerToolDefinition | undefined; executable: StockWorkerToolDefinition | undefined };
  readonly onToolsChange: (listener: () => void) => () => void;
  /** Must resolve only after this agent's durable default has been restored. */
  readonly getDefault: (agent: object) => Promise<StockWorkerModelRoute | undefined>;
}

/**
 * Shadow the currently inherited stock definition on exactly one Agent scope.
 * Registry changes first remove the shadow, then re-read and wrap the current
 * inherited definition. This avoids capturing ourselves and follows provider
 * removal/replacement without patching the stock package.
 */
export function registerStockWorkerModelDefaultBridge(
  options: StockWorkerModelDefaultBridgeOptions,
): () => void {
  const { agent, tools, getDefault } = options;
  let active = true;
  let refreshing = false;
  let current: StockWorkerToolDefinition | undefined;
  let disposeCurrent: (() => void) | undefined;
  let capturedSource: StockWorkerToolDefinition | undefined;

  const refresh = (): void => {
    if (!active || refreshing) return;
    refreshing = true;
    try {
      const inherited = options.inherited();
      if (current !== undefined && inherited.definition === capturedSource &&
        inherited.executable === capturedSource && tools.get("subagent", agent) === current) return;
      if (disposeCurrent !== undefined) {
        const dispose = disposeCurrent;
        disposeCurrent = undefined;
        current = undefined;
        dispose();
      }
      const source = tools.get("subagent", agent);
      if (source === undefined || source.name !== "subagent" || typeof source.execute !== "function" ||
        tools.executable("subagent", agent) !== source || inherited.definition !== source || inherited.executable !== source) {
        return;
      }

      let wrapper: StockWorkerToolDefinition;
      wrapper = {
        ...source,
        async execute(args: unknown, exec: unknown): Promise<unknown> {
          if (
            !active ||
            current !== wrapper ||
            exec === null ||
            typeof exec !== "object" ||
            (exec as { agent?: unknown }).agent !== agent ||
            tools.get("subagent", agent) !== wrapper
          ) {
            throw new Error("stock subagent definition is no longer active for this dispatcher");
          }

          if (args === null || typeof args !== "object" || Array.isArray(args)) {
            return source.execute.call(source, args, exec);
          }
          const request = args as Record<string, unknown>;
          if (request.provider !== undefined || request.model !== undefined) {
            return source.execute.call(source, args, exec);
          }
          const route = await getDefault(agent);
          if (!active || current !== wrapper) {
            throw new Error("stock subagent definition is no longer active for this dispatcher");
          }
          if (route === undefined) return source.execute.call(source, args, exec);
          return source.execute.call(
            source,
            { ...request, provider: route.provider, model: route.model },
            exec,
          );
        },
      };
      current = wrapper;
      capturedSource = source;
      disposeCurrent = tools.register(wrapper);
    } finally {
      refreshing = false;
    }
  };

  const offChange = options.onToolsChange(refresh);
  try {
    refresh();
  } catch (error) {
    active = false;
    offChange();
    throw error;
  }

  return () => {
    if (!active) return;
    active = false;
    offChange();
    if (disposeCurrent !== undefined) {
      const dispose = disposeCurrent;
      disposeCurrent = undefined;
      current = undefined;
      dispose();
    }
  };
}
