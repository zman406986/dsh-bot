/**
 * Volatile config refs for plugin-level tests.
 *
 * The host passes schemastery `.volatile()` fields to `apply` as stable
 * references (`{ get(): value }`), not plain values. Tests build refs here so
 * they can seed a value, and — for the ADR-0005 freeze pins — mutate the ref
 * after `apply` returned and prove the running session never re-reads it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * One per-process temp root for racoons ledgers (ticket 145). The mount is
 * unconditional, so every `apply` in a test file would otherwise derive
 * `<DSH_HOME>/storages/racoons` and write real ledgers into the developer's
 * home directory. The dir is never cleaned up: it lives under the OS temp
 * directory, and the OS owns its lifetime.
 */
export const TEST_RACOONS_STORAGE_ROOT = mkdtempSync(join(tmpdir(), "dsh-racoons-"));

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
  /** Owner ruling 2026-11-05: racoons mount (default off, manual test only). */
  racoonsEnabled?: boolean;
  /** Ticket 145: racoons record-only mode (default off → enforcement `apply`). */
  racoonsRecordOnly?: boolean;
  /** Ticket 145: durable racoons root; defaults to {@link TEST_RACOONS_STORAGE_ROOT}. */
  racoonsStorageRoot?: string;
  /** Ticket 145: half-window prune denominator; 0 means off. */
  racoonsContextWindowTokens?: number;
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
  racoonsEnabled: VolatileRef<boolean | undefined>;
  racoonsRecordOnly: VolatileRef<boolean | undefined>;
  racoonsStorageRoot: VolatileRef<string | undefined>;
  racoonsContextWindowTokens: VolatileRef<number | undefined>;
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
    racoonsEnabled: mutableRef(values.racoonsEnabled),
    racoonsRecordOnly: mutableRef(values.racoonsRecordOnly),
    racoonsStorageRoot: mutableRef(
      values.racoonsStorageRoot === undefined
        ? TEST_RACOONS_STORAGE_ROOT
        : values.racoonsStorageRoot,
    ),
    racoonsContextWindowTokens: mutableRef(values.racoonsContextWindowTokens),
  };
}

/**
 * Plain config values: what a test means, not what the host passes. For
 * ref-shaped config use `volatileConfig`.
 */
export function pluginConfig(
  values: {
    enabled?: boolean;
    racoonsRecordOnly?: boolean;
    racoonsStorageRoot?: string;
    racoonsContextWindowTokens?: number;
  } = {},
): {
  enabled: boolean;
  racoonsRecordOnly: boolean;
  racoonsStorageRoot: string;
  racoonsContextWindowTokens: number;
} {
  return {
    enabled: true,
    racoonsRecordOnly: false,
    racoonsStorageRoot: TEST_RACOONS_STORAGE_ROOT,
    racoonsContextWindowTokens: 0,
    ...values,
  };
}
