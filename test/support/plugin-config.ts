import type { PluginConfig } from "../../src/plugin.js";

export function pluginConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { enabled: true, racoonsEnabled: false, ...overrides };
}
