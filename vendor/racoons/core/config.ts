export interface Thresholds {
  readonly capBytes: number;
  readonly capHeadBytes: number | null;
  readonly episodeNoNewPathSteps: number | null;
  readonly sealMaxLatencyTurns: 0 | 1;
  readonly evictAfterClosedTurns: number | null;
}

export interface FreshZoneConfig {
  readonly maxNodes: number | null;
  readonly maxBytes: number | null;
}

export interface RacoonsConfig {
  readonly thresholds: Thresholds;
  readonly freshZone: FreshZoneConfig;
  readonly sealMode: "append" | "replace";
  readonly enableSpans: boolean;
  readonly validationFailureLimit: 2;
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
};

export function validateConfig(config: unknown): string[] {
  if (!isRecord(config)) return ["config must be an object."];
  const problems: string[] = [];
  const thresholds = config["thresholds"];
  if (!isRecord(thresholds)) {
    problems.push("thresholds must be an object.");
  } else {
    checkCount(problems, "thresholds.capBytes", thresholds["capBytes"], false);
    checkCount(problems, "thresholds.capHeadBytes", thresholds["capHeadBytes"], true);
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
