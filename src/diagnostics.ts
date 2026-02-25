import fs from "node:fs";
import path from "node:path";
import { BackendDiagnostic, Severity } from "./types";
import { isPositiveInteger, VALID_SEVERITIES } from "./utils";

/**
 * @param resolveRoot - Directory to resolve diagnostic file paths against (e.g. git repo root).
 *   Git diff paths are repo-relative; resolving from repo root ensures paths exist when running from subdirs.
 */
export function normalizeDiagnostics(
  ruleId: string,
  diagnostics: unknown[],
  debug: boolean,
  resolveRoot?: string | null
): BackendDiagnostic[] {
  const baseDir = resolveRoot && resolveRoot.length > 0 ? resolveRoot : process.cwd();
  return diagnostics.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      if (debug) {
        process.stderr.write(`[debug] Dropped diagnostic for ${ruleId}: not an object\n`);
      }
      return [];
    }

    const candidate = raw as Record<string, unknown>;
    const severity = candidate.severity;
    const file = candidate.file;
    const line = candidate.line;
    const message = candidate.message;
    const candidateRuleId = candidate.rule_id;

    if (
      typeof candidateRuleId !== "string" ||
      candidateRuleId !== ruleId ||
      typeof file !== "string" ||
      file.trim() === "" ||
      typeof message !== "string" ||
      message.trim() === "" ||
      typeof severity !== "string" ||
      !VALID_SEVERITIES.has(severity as Severity) ||
      !isPositiveInteger(line)
    ) {
      if (debug) {
        process.stderr.write(
          `[debug] Dropped diagnostic for ${ruleId}: failed required field validation\n`
        );
      }
      return [];
    }

    if (!fs.existsSync(path.resolve(baseDir, file))) {
      if (debug) {
        process.stderr.write(
          `[debug] Dropped diagnostic for ${ruleId}: file does not exist (${file})\n`
        );
      }
      return [];
    }

    return [
      {
        rule_id: candidateRuleId,
        severity: severity as Severity,
        message,
        file,
        line,
        column: isPositiveInteger(candidate.column) ? candidate.column : undefined,
        end_line: isPositiveInteger(candidate.end_line) ? candidate.end_line : undefined,
        end_column: isPositiveInteger(candidate.end_column) ? candidate.end_column : undefined,
        evidence: typeof candidate.evidence === "string" ? candidate.evidence : undefined,
        confidence: typeof candidate.confidence === "number" ? candidate.confidence : undefined
      }
    ];
  });
}

const SEVERITY_ORDER: Record<Severity, number> = {
  error: 3,
  warn: 2,
  info: 1
};

export function sortDiagnostics(input: BackendDiagnostic[]): BackendDiagnostic[] {
  return [...input].sort((a, b) => {
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) {
      return fileCompare;
    }

    if (a.line !== b.line) {
      return a.line - b.line;
    }

    return SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  });
}

export function hasBlockingDiagnostic(
  diagnostics: BackendDiagnostic[],
  threshold: "error" | "warn" | "never"
): boolean {
  if (threshold === "never") {
    return false;
  }
  if (threshold === "warn") {
    return diagnostics.some((d) => d.severity === "warn" || d.severity === "error");
  }
  return diagnostics.some((d) => d.severity === "error");
}
