/**
 * Volatile config refs for plugin-level tests.
 *
 * The host passes schemastery `.volatile()` fields to `apply` as stable
 * references (`{ get(): value }`), not plain values. Tests build refs here so
 * they can seed a value, and — for the ADR-0005 freeze pins — mutate the ref
 * after `apply` returned and prove the running session never re-reads it.
 */

/** Minimal structural volatile reference (the plugin's config shape). */
export interface VolatileRef<T> {
  get(): T;
}

/** A ref whose stored value the test may change. */
export interface MutableRef<T> extends VolatileRef<T> {
  set(value: T): void;
}

/** Create a mutable volatile ref. */
export function mutableRef<T>(initial: T): MutableRef<T> {
  let value = initial;
  return {
    get: () => value,
    set(next: T) {
      value = next;
    },
  };
}

/** Plugin config values as a test writes them (plain, not refs). */
export interface TestConfigValues {
  enabled: boolean;
  accessRequestTimeoutMs?: number;
  wakeCoalesceWindowMs?: number;
  inboxEnabled?: boolean;
  inboxDir?: string;
  inboxRescanIntervalMs?: number;
  /** Ticket 124: deterministic microcompact (default off). */
  microcompactEnabled?: boolean;
}

/** Plugin config in the shape `apply` receives (volatile refs). */
export interface TestPluginConfig {
  enabled: VolatileRef<boolean>;
  accessRequestTimeoutMs: VolatileRef<number | undefined>;
  wakeCoalesceWindowMs: VolatileRef<number | undefined>;
  inboxEnabled: VolatileRef<boolean | undefined>;
  inboxDir: VolatileRef<string | undefined>;
  inboxRescanIntervalMs: VolatileRef<number | undefined>;
  microcompactEnabled: VolatileRef<boolean | undefined>;
}

/** Wrap plain values in volatile refs; omitted fields read `undefined`. */
export function volatileConfig(values: TestConfigValues): TestPluginConfig {
  return {
    enabled: mutableRef(values.enabled),
    accessRequestTimeoutMs: mutableRef(values.accessRequestTimeoutMs),
    wakeCoalesceWindowMs: mutableRef(values.wakeCoalesceWindowMs),
    inboxEnabled: mutableRef(values.inboxEnabled),
    inboxDir: mutableRef(values.inboxDir),
    inboxRescanIntervalMs: mutableRef(values.inboxRescanIntervalMs),
    microcompactEnabled: mutableRef(values.microcompactEnabled),
  };
}

/**
 * Plain config values (from the racoons-integration lane): what a test
 * means, not what the host passes. For ref-shaped config use `volatileConfig`.
 */
export function pluginConfig(
  values: { enabled?: boolean; racoonsEnabled?: boolean } = {},
): { enabled: boolean; racoonsEnabled?: boolean } {
  return { enabled: true, racoonsEnabled: false, ...values };
}
