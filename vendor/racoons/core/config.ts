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
  /** Label length shown to the agent; enforcement carries hidden headroom. */
  readonly advertisedLabelLimit: number;
  /** Re-asks allowed before a gate fails open. Zero means one presentation only. */
  readonly retryLimit: number;
  /** Smallest freed-byte payoff a revert cut must reach to be worth applying. */
  readonly minCutFreedBytes: number;
  /** Share of the healthy window at which a full revisit falls due (0, 1]. */
  readonly revisitShare: number;
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
  // Provisional (H-011): measurement sets these. The receipt label the agent
  // reads is 40 characters; enforcement allows 50 (enforcedLabelLimit).
  protocol: {
    // provisional per owner 2026-10-23
    barBytes: 8192,
    advertisedLabelLimit: 40,
    retryLimit: 2,
    minCutFreedBytes: 4096,
    revisitShare: 0.5,
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
  const protocol = config["protocol"];
  if (!isRecord(protocol)) {
    problems.push("protocol must be an object.");
  } else {
    checkCount(problems, "protocol.barBytes", protocol["barBytes"], false);
    checkPositiveCount(problems, "protocol.advertisedLabelLimit", protocol["advertisedLabelLimit"]);
    checkCount(problems, "protocol.retryLimit", protocol["retryLimit"], false);
    checkCount(problems, "protocol.minCutFreedBytes", protocol["minCutFreedBytes"], false);
    const share = protocol["revisitShare"];
    if (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share > 1) {
      problems.push("protocol.revisitShare must be a number greater than 0 and at most 1.");
    }
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
