import path from "node:path";
import { createBackendRunner } from "./backend";
import { loadEffectiveConfig } from "./config";
import { hasBlockingDiagnostic, normalizeDiagnostics, sortDiagnostics } from "./diagnostics";
import { shouldRunRule, buildRulePrompt, extractChangedFilesFromDiff } from "./filter";
import { getGitDiff } from "./git";
import { formatJsonOutput, formatTextOutput } from "./reporter";
import { loadRules } from "./rules";
import { BackendDiagnostic, CliOptions } from "./types";

const VERSION = "0.1.0";

function debugLog(enabled: boolean, message: string): void {
  if (enabled) {
    process.stderr.write(`[debug] ${message}\n`);
  }
}

export async function runSemlint(options: CliOptions): Promise<number> {
  const startedAt = Date.now();
  try {
    const config = loadEffectiveConfig(options);
    const rulesDir = path.join(process.cwd(), "rules");
    const rules = loadRules(rulesDir, config.rulesDisable, config.severityOverrides);

    debugLog(config.debug, `Loaded ${rules.length} rule(s)`);

    const diff = await getGitDiff(config.base, config.head);
    const changedFiles = extractChangedFilesFromDiff(diff);
    debugLog(config.debug, `Detected ${changedFiles.length} changed file(s)`);

    const backend = createBackendRunner(config);
    let backendErrors = 0;
    let rulesRun = 0;
    const diagnostics: BackendDiagnostic[] = [];

    for (const rule of rules) {
      if (!shouldRunRule(rule, changedFiles, diff)) {
        debugLog(config.debug, `Skipping rule ${rule.id}: filters did not match`);
        continue;
      }

      rulesRun += 1;
      const prompt = buildRulePrompt(rule, diff);

      try {
        const result = await backend.runRule({
          ruleId: rule.id,
          prompt,
          timeoutMs: config.timeoutMs
        });

        const normalized = normalizeDiagnostics(rule.id, result.diagnostics, config.debug);
        diagnostics.push(...normalized);
      } catch (error) {
        backendErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        debugLog(config.debug, `Backend error for rule ${rule.id}: ${message}`);
      }
    }

    const sorted = sortDiagnostics(diagnostics);
    const durationMs = Date.now() - startedAt;

    if (config.format === "json") {
      process.stdout.write(
        `${formatJsonOutput(VERSION, sorted, { rulesRun, durationMs, backendErrors })}\n`
      );
    } else {
      process.stdout.write(`${formatTextOutput(sorted)}\n`);
    }

    if (backendErrors > 0) {
      return 2;
    }
    if (hasBlockingDiagnostic(sorted, config.failOn)) {
      return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}
