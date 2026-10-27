export interface Thresholds {
  /**
   * Accepted and ignored. ADR-0014 (2026-10-23) scrapped the entry-time cap:
   * nothing reads these fields. They stay in the type and in `DEFAULT_CONFIG`
   * so an old config file that names them still loads and mounts; validation
   * never rejects their values.
   */
  readonly capBytes: number;
  /** Accepted and ignored; see `capBytes` (ADR-0014, 2026-10-23). */
  readonly capHeadBytes: number | null;
  readonly episodeNoNewPathSteps: number | null;
  readonly sealMaxLatencyTurns: 0 | 1;
  readonly evictAfterClosedTurns: number | null;
}

export interface FreshZoneConfig {
  readonly maxNodes: number | null;
  readonly maxBytes: number | null;
}

/**
 * The two arms a host config row may name for the retired anchor A/B switch.
 * The arm belonged to the removed judge pass; an entry checkpoint renders its
 * anchors unconditionally (ADR-0028), so a mount accepts the key and reads
 * nothing from it. The type stays exported because the host-facing config row
 * still declares it, and a config file must never crash a mount.
 */
export type AnchorMode = "off" | "on";

/**
 * What the engine does with a settled verdict batch. `apply` plans the revert;
 * only the exact value `record-only` takes the agent's answers and applies
 * nothing. Enforcement defaults to `apply` for configs that omit the field:
 * the owner accepted the measured precision (spike-008 §5) as good enough to
 * ship and adopted no numeric bar (owner ruling 2026-10-23).
 */
export type ProtocolEnforcement = "record-only" | "apply";

/**
 * The verdict protocol's tuning values. PRD §3.7 and H-011 keep every number
 * here as configuration: defaults are provisional until measurement lands them.
 */
export interface ProtocolConfig {
  /** Size at or above which a processing unit must receive a verdict. */
  readonly barBytes: number;
  /** Smallest freed-byte payoff a revert cut must reach to be worth applying. */
  readonly minCutFreedBytes: number;
  /**
   * Enforcement mode. Absent means `apply`: the safe-for-progress value.
   * `record-only` is the opt-out and must be written explicitly.
   */
  readonly enforcement?: ProtocolEnforcement;
}

export interface RacoonsConfig {
  readonly thresholds: Thresholds;
  readonly freshZone: FreshZoneConfig;
  readonly sealMode: "append" | "replace";
  readonly enableSpans: boolean;
  readonly validationFailureLimit: 2;
  readonly protocol: ProtocolConfig;
  /**
   * The size floor in bytes (ADR-0020 Decision 3): a tool result under it lands
   * whole and is never a candidate. Absent means `DEFAULT_CONFIG.floorBytes`;
   * a per-model table (`floorForModel`) overrides it where the mount sees the
   * model id. It is not `protocol.barBytes`, which keeps the bulk-pass job.
   */
  readonly floorBytes?: number;
}

/** The default size floor: the calibration note's average of its nine rows. */
export const DEFAULT_FLOOR_BYTES = 512;

/**
 * Per-model size floors, in bytes (authority:
 * `docs/research/floor-calibration-2026-10-26.md` §6).
 */
export const FLOOR_BYTES_BY_MODEL: Readonly<Record<string, number>> = Object.freeze({
  "deepseek-v4-pro": 768,
  "deepseek-v4.1-flash-1017": 1280,
  "gpt-6-astra": 256,
  "claude-opus-5.5": 512,
  "claude-sonnet-5.5": 512,
  "glm-5.3": 256,
  "gemini-4-argon": 512,
  "grok-4.7": 256,
  "kimi-k3.1-pro": 256,
  "qwen3.8-max-prime": 256,
});

/**
 * The size floor for one model id: the table's exact entry, else the default
 * (authority: `docs/research/floor-calibration-2026-10-26.md` §6).
 */
export function floorForModel(model: string | null | undefined): number {
  if (typeof model !== "string" || !Object.hasOwn(FLOOR_BYTES_BY_MODEL, model)) {
    return DEFAULT_FLOOR_BYTES;
  }
  return FLOOR_BYTES_BY_MODEL[model] ?? DEFAULT_FLOOR_BYTES;
}

export const DEFAULT_CONFIG: RacoonsConfig = {
  thresholds: {
    capBytes: 8 * 1024,
    capHeadBytes: null,
    episodeNoNewPathSteps: null,
    sealMaxLatencyTurns: 1,
    evictAfterClosedTurns: null,
  },
  freshZone: {
    maxNodes: null,
    maxBytes: null,
  },
  sealMode: "append",
  enableSpans: false,
  validationFailureLimit: 2,
  // ADR-0020 Decision 3: the measured default, not a provisional guess
  // (`docs/research/floor-calibration-2026-10-26.md` §6).
  floorBytes: DEFAULT_FLOOR_BYTES,
  // Provisional (H-011): measurement sets these.
  protocol: {
    // provisional per owner 2026-10-23
    barBytes: 8192,
    minCutFreedBytes: 4096,
    // Owner ruling 2026-10-23: measured precision accepted, no numeric bar
    // adopted; a wired verdict source applies by default (ADR-0008).
    enforcement: "apply",
  },
};

export function validateConfig(config: unknown): string[] {
  if (!isRecord(config)) return ["config must be an object."];
  const problems: string[] = [];
  const thresholds = config["thresholds"];
  if (!isRecord(thresholds)) {
    problems.push("thresholds must be an object.");
  } else {
    // ADR-0014 (2026-10-23): the entry-time cap is scrapped. `capBytes` and
    // `capHeadBytes` are accepted-and-ignored, not validated: an old config file
    // naming them must never crash a mount, and no value of theirs has meaning.
    checkCount(problems, "thresholds.episodeNoNewPathSteps", thresholds["episodeNoNewPathSteps"], true);
    checkCount(problems, "thresholds.evictAfterClosedTurns", thresholds["evictAfterClosedTurns"], true);
    if (thresholds["sealMaxLatencyTurns"] !== 0 && thresholds["sealMaxLatencyTurns"] !== 1) {
      problems.push("thresholds.sealMaxLatencyTurns must be 0 or 1.");
    }
  }

  const freshZone = config["freshZone"];
  if (!isRecord(freshZone)) {
    problems.push("freshZone must be an object.");
  } else {
    checkCount(problems, "freshZone.maxNodes", freshZone["maxNodes"], true);
    checkCount(problems, "freshZone.maxBytes", freshZone["maxBytes"], true);
  }
  if (config["sealMode"] !== "append" && config["sealMode"] !== "replace") {
    problems.push('sealMode must be "append" or "replace".');
  }
  if (typeof config["enableSpans"] !== "boolean") {
    problems.push("enableSpans must be a boolean.");
  }
  if (config["validationFailureLimit"] !== 2) {
    problems.push("validationFailureLimit must be 2.");
  }
  // ADR-0020 Decision 3: the size floor is optional (the default is 512) but a
  // declared value must be a positive integer; zero would floor nothing.
  if (config["floorBytes"] !== undefined) {
    checkPositiveCount(problems, "floorBytes", config["floorBytes"]);
  }
  // Optional with a default: absent is valid, a declared value must be a count.
  const protocol = config["protocol"];
  if (!isRecord(protocol)) {
    problems.push("protocol must be an object.");
  } else {
    checkCount(problems, "protocol.barBytes", protocol["barBytes"], false);
    checkCount(problems, "protocol.minCutFreedBytes", protocol["minCutFreedBytes"], false);
    const enforcement = protocol["enforcement"];
    if (enforcement !== undefined && enforcement !== "record-only" && enforcement !== "apply") {
      problems.push('protocol.enforcement must be "record-only" or "apply" when declared.');
    }
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkCount(
  problems: string[],
  name: string,
  value: unknown,
  nullable: boolean,
): void {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    problems.push(`${name} must be a non-negative safe integer${nullable ? " or null" : ""}.`);
  }
}

/** A limit of zero would advertise a label the agent cannot write. */
function checkPositiveCount(problems: string[], name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    problems.push(`${name} must be a positive safe integer.`);
  }
}
