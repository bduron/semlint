import pc from "picocolors";
import { BackendDiagnostic, CanonicalJsonReport, RunStats } from "./types";

function formatSeverity(severity: string) {
  if (severity === "error") return pc.red(severity);
  if (severity === "warn") return pc.yellow(severity);
  if (severity === "info") return pc.cyan(severity);
  return severity;
}

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

export function formatTextOutput(diagnostics: BackendDiagnostic[], stats: RunStats): string {
  const lines: string[] = [];
  let currentFile = "";

  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== currentFile) {
      if (lines.length > 0) {
        lines.push("");
      }
      currentFile = diagnostic.file;
      lines.push(pc.underline(currentFile));
    }

    const column = diagnostic.column ?? 1;
    lines.push(
      `  ${pc.dim(`${diagnostic.line}:${column}`)}  ${formatSeverity(diagnostic.severity)}  ${pc.gray(diagnostic.rule_id)}  ${diagnostic.message}`
    );
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warn").length;
  const problems = diagnostics.length;

  if (lines.length > 0) {
    lines.push("");
  }
  
  const summary = `✖ ${problems} problems (${errors} errors, ${warnings} warnings)`;
  const timeInfo = ` in ${(stats.durationMs / 1000).toFixed(1)}s`;

  if (problems === 0) {
    if (stats.rulesRun === 0) {
      lines.push(pc.green(`✔ 0 problems (no rules matched changed files)`));
    } else {
      lines.push(pc.green(`✔ 0 problems (0 errors, 0 warnings)`));
    }
  } else if (errors > 0) {
    lines.push(pc.red(summary) + pc.gray(timeInfo));
  } else {
    lines.push(pc.yellow(summary) + pc.gray(timeInfo));
  }

  if (problems === 0 && stats.durationMs > 0) {
    lines[lines.length - 1] += pc.gray(timeInfo);
  }

  return lines.join("\n");
}
