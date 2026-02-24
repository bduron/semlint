import pc from "picocolors";
import { createSpinner, Spinner } from "nanospinner";
import path from "node:path";
import { createBackendRunner } from "./backend";
import { loadEffectiveConfig } from "./config";
import { hasBlockingDiagnostic, normalizeDiagnostics, sortDiagnostics } from "./diagnostics";
import { shouldRunRule, buildRulePrompt, extractChangedFilesFromDiff, buildScopedDiff } from "./filter";
import { getGitDiff, getLocalBranchDiff } from "./git";
import { formatJsonOutput, formatTextOutput } from "./reporter";
import { loadRules } from "./rules";
import { BackendDiagnostic, CliOptions, LoadedRule } from "./types";

const VERSION = "0.1.0";

function debugLog(enabled: boolean, message: string): void {
  if (enabled) {
    process.stderr.write(`${pc.gray(`[debug] ${message}`)}\n`);
  }
}

function timed<T>(enabled: boolean, label: string, action: () => T): T {
  const startedAt = Date.now();
  const result = action();
  debugLog(enabled, `${label} in ${Date.now() - startedAt}ms`);
  return result;
}

async function timedAsync<T>(enabled: boolean, label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const result = await action();
  debugLog(enabled, `${label} in ${Date.now() - startedAt}ms`);
  return result;
}

function buildBatchPrompt(rules: LoadedRule[], diff: string): string {
  const ruleBlocks = rules
    .map((rule) =>
      [
        `RULE_ID: ${rule.id}`,
        `RULE_TITLE: ${rule.title}`,
        `SEVERITY_DEFAULT: ${rule.effectiveSeverity}`,
        "INSTRUCTIONS:",
        rule.prompt
      ].join("\n")
    )
    .join("\n\n---\n\n");

  return [
    "You are Semlint, an expert semantic code reviewer.",
    "BATCH_MODE: true",
    "Evaluate all rules below against the DIFF in one pass.",
    "Analyze ONLY the modified code present in the DIFF below.",
    "Return JSON only (no markdown, no prose, no code fences).",
    "Output schema:",
    "{",
    "  \"diagnostics\": [",
    "    {",
    "      \"rule_id\": string,",
    "      \"severity\": \"error\" | \"warn\" | \"info\",",
    "      \"message\": string,",
    "      \"file\": string,",
    "      \"line\": number,",
    "      \"column\"?: number,",
    "      \"end_line\"?: number,",
    "      \"end_column\"?: number,",
    "      \"evidence\"?: string,",
    "      \"confidence\"?: number",
    "    }",
    "  ]",
    "}",
    "Rules:",
    "- If there are no findings, return {\"diagnostics\":[]}.",
    "- Each diagnostic must reference a changed file from the DIFF.",
    "- rule_id must match one of the RULE_ID values listed below.",
    "- Keep messages concise and actionable.",
    "",
    "RULES:",
    ruleBlocks,
    "",
    "DIFF:",
    diff
  ].join("\n");
}

export async function runSemlint(options: CliOptions): Promise<number> {
  const startedAt = Date.now();
  let spinner: Spinner | null = null;
  try {
    const config = timed(options.debug, "Loaded effective config", () => loadEffectiveConfig(options));
    const rulesDir = path.join(process.cwd(), ".semlint", "rules");
    const rules = timed(config.debug, "Loaded and validated rules", () =>
      loadRules(rulesDir, config.rulesDisable, config.severityOverrides)
    );

    debugLog(config.debug, `Loaded ${rules.length} rule(s)`);
    debugLog(config.debug, `Rule IDs: ${rules.map((rule) => rule.id).join(", ")}`);

    const useLocalBranchDiff = !options.base && !options.head;
    const diff = await timedAsync(config.debug, "Computed git diff", () =>
      useLocalBranchDiff ? getLocalBranchDiff() : getGitDiff(config.base, config.head)
    );
    const changedFiles = timed(config.debug, "Parsed changed files from diff", () =>
      extractChangedFilesFromDiff(diff)
    );
    debugLog(
      config.debug,
      useLocalBranchDiff
        ? "Using local branch diff (staged + unstaged + untracked only)"
        : `Using explicit ref diff (${config.base}..${config.head})`
    );
    debugLog(config.debug, `Detected ${changedFiles.length} changed file(s)`);

    const backend = timed(config.debug, "Initialized backend runner", () => createBackendRunner(config));
    const runnableRules = rules.filter((rule) => {
      const filterStartedAt = Date.now();
      const shouldRun = shouldRunRule(rule, changedFiles, diff);
      debugLog(config.debug, `Rule ${rule.id}: filter check in ${Date.now() - filterStartedAt}ms`);
      if (!shouldRun) {
        debugLog(config.debug, `Skipping rule ${rule.id}: filters did not match`);
        return false;
      }
      return true;
    });

    const diagnostics: BackendDiagnostic[] = [];
    const rulesRun = runnableRules.length;
    let backendErrors = 0;

    if (config.format !== "json" && rulesRun > 0) {
      process.stdout.write(`${pc.bold("Running rules:")}\n`);
      for (const rule of runnableRules) {
        process.stdout.write(`  ${pc.cyan(rule.id)} ${pc.dim(rule.title)}\n`);
      }
      process.stdout.write("\n");
    }

    spinner =
      config.format !== "json" && rulesRun > 0
        ? createSpinner(
            `Analyzing ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} with ${config.backend} in ${
              config.batchMode ? "batch" : "parallel"
            } mode...`
          ).start()
        : null;

    if (config.batchMode && runnableRules.length > 0) {
      debugLog(config.debug, `Running ${runnableRules.length} rule(s) in batch mode`);
      const combinedDiff = timed(config.debug, "Batch: combined scoped diff build", () =>
        runnableRules
          .map((rule) => buildScopedDiff(rule, diff, changedFiles))
          .filter((chunk) => chunk.trim() !== "")
          .join("\n")
      );
      const batchPrompt = timed(config.debug, "Batch: prompt build", () =>
        buildBatchPrompt(runnableRules, combinedDiff || diff)
      );

      try {
        const batchResult = await timedAsync(config.debug, "Batch: backend run", () =>
          backend.runPrompt({
            label: "Batch",
            prompt: batchPrompt,
            timeoutMs: config.timeoutMs
          })
        );

        const groupedByRule = new Map<string, unknown[]>();
        for (const diagnostic of batchResult.diagnostics as unknown[]) {
          if (
            typeof diagnostic === "object" &&
            diagnostic !== null &&
            !Array.isArray(diagnostic) &&
            typeof (diagnostic as { rule_id?: unknown }).rule_id === "string"
          ) {
            const ruleId = (diagnostic as { rule_id: string }).rule_id;
            const current = groupedByRule.get(ruleId) ?? [];
            current.push(diagnostic);
            groupedByRule.set(ruleId, current);
          } else {
            debugLog(config.debug, "Batch: dropped diagnostic without valid rule_id");
          }
        }

        const validRuleIds = new Set(runnableRules.map((rule) => rule.id));
        for (const [ruleId] of groupedByRule) {
          if (!validRuleIds.has(ruleId)) {
            debugLog(config.debug, `Batch: dropped diagnostic for unknown rule_id ${ruleId}`);
          }
        }

        for (const rule of runnableRules) {
          const normalized = timed(
            config.debug,
            `Batch: diagnostics normalization for ${rule.id}`,
            () => normalizeDiagnostics(rule.id, groupedByRule.get(rule.id) ?? [], config.debug)
          );
          diagnostics.push(...normalized);
        }
      } catch (error) {
        backendErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        debugLog(config.debug, `Batch backend error: ${message}`);
      }
    } else {
      debugLog(config.debug, `Running ${runnableRules.length} rule(s) in parallel`);
      const runResults = await Promise.all(
        runnableRules.map(async (rule) => {
          let backendError = false;
          let normalized: BackendDiagnostic[] = [];

          const ruleStartedAt = Date.now();
          debugLog(config.debug, `Rule ${rule.id}: started`);

          const scopedDiff = timed(config.debug, `Rule ${rule.id}: scoped diff build`, () =>
            buildScopedDiff(rule, diff, changedFiles)
          );

          const prompt = timed(config.debug, `Rule ${rule.id}: prompt build`, () =>
            buildRulePrompt(rule, scopedDiff)
          );

          try {
            const result = await timedAsync(config.debug, `Rule ${rule.id}: backend run`, () =>
              backend.runRule({
                ruleId: rule.id,
                prompt,
                timeoutMs: config.timeoutMs
              })
            );

            normalized = timed(config.debug, `Rule ${rule.id}: diagnostics normalization`, () =>
              normalizeDiagnostics(rule.id, result.diagnostics, config.debug)
            );
          } catch (error) {
            backendError = true;
            const message = error instanceof Error ? error.message : String(error);
            debugLog(config.debug, `Backend error for rule ${rule.id}: ${message}`);
          }

          debugLog(config.debug, `Rule ${rule.id}: finished in ${Date.now() - ruleStartedAt}ms`);
          return { backendError, normalized };
        })
      );

      for (const result of runResults) {
        if (result.backendError) {
          backendErrors += 1;
        }
        diagnostics.push(...result.normalized);
      }
    }

    const sorted = timed(config.debug, "Sorted diagnostics", () => sortDiagnostics(diagnostics));
    const durationMs = Date.now() - startedAt;

    if (spinner) {
      if (backendErrors > 0) {
        spinner.error({ text: "Analysis completed with backend errors" });
      } else {
        spinner.success({ text: "Analysis complete" });
      }
    }

    const outputStartedAt = Date.now();
    if (config.format === "json") {
      process.stdout.write(
        `${formatJsonOutput(VERSION, sorted, { rulesRun, durationMs, backendErrors })}\n`
      );
    } else {
      process.stdout.write(`${formatTextOutput(sorted, { rulesRun, durationMs, backendErrors })}\n`);
    }
    debugLog(config.debug, `Rendered output in ${Date.now() - outputStartedAt}ms`);
    debugLog(config.debug, `Total run duration ${durationMs}ms`);

    if (backendErrors > 0) {
      return 2;
    }
    if (hasBlockingDiagnostic(sorted, config.failOn)) {
      return 1;
    }
    return 0;
  } catch (error) {
    if (spinner) {
      spinner.error({ text: "Analysis failed" });
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}
