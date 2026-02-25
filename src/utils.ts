import pc from "picocolors";
import { Severity } from "./types";

export const VALID_SEVERITIES = new Set<Severity>(["error", "warn", "info"]);

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function debugLog(enabled: boolean, message: string): void {
  if (enabled) {
    process.stderr.write(`${pc.gray(`[debug] ${message}`)}\n`);
  }
}
