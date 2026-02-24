import { BackendDiagnostic, CanonicalJsonReport, RunStats } from "./types";

export function formatJsonOutput(
  version: string,
  diagnostics: BackendDiagnostic[],
  stats: RunStats
): string {
  const payload: CanonicalJsonReport = {
    tool: {
      name: "semlint",
      version
    },
    diagnostics,
    stats: {
      rules_run: stats.rulesRun,
      duration_ms: stats.durationMs,
      backend_errors: stats.backendErrors
    }
  };
  return JSON.stringify(payload, null, 2);
}

export function formatTextOutput(diagnostics: BackendDiagnostic[]): string {
  const lines: string[] = [];
  let currentFile = "";

  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== currentFile) {
      if (lines.length > 0) {
        lines.push("");
      }
      currentFile = diagnostic.file;
      lines.push(currentFile);
    }

    const column = diagnostic.column ?? 1;
    lines.push(
      `  ${diagnostic.line}:${column}  ${diagnostic.severity}  ${diagnostic.rule_id}  ${diagnostic.message}`
    );
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warn").length;
  const problems = diagnostics.length;

  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`✖ ${problems} problems (${errors} errors, ${warnings} warnings)`);

  return lines.join("\n");
}
