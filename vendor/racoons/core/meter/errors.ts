export type MeterErrorCode =
  | "invalid-count"
  | "inconsistent-usage"
  | "script-exhausted";

export class MeterError extends Error {
  readonly code: MeterErrorCode;

  constructor(code: MeterErrorCode, message: string) {
    super(message);
    this.name = "MeterError";
    this.code = code;
  }
}
