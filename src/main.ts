import pc from "picocolors";
import { createSpinner, Spinner } from "nanospinner";
import path from "node:path";
import { version as VERSION } from "../package.json";
import { createBackendRunner } from "./backend";
import { loadEffectiveConfig } from "./config";
import { hasBlockingDiagnostic, sortDiagnostics } from "./diagnostics";
import { runBatchDispatch, runParallelDispatch } from "./dispatch";
import { shouldRunRule, extractChangedFilesFromDiff } from "./filter";
import { getGitDiff, getLocalBranchDiff, getRepoRoot } from "./git";
import { formatJsonOutput, formatTextOutput } from "./reporter";
import { loadRules } from "./rules";
import { BackendDiagnostic, CliOptions } from "./types";
import { debugLog } from "./utils";

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

    const repoRoot = await timedAsync(config.debug, "Resolved git repo root", () => getRepoRoot());

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

    let diagnostics: BackendDiagnostic[] = [];
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

    if (runnableRules.length > 0) {
      const dispatchLabel = config.batchMode ? "batch" : "parallel";
      const result = await timedAsync(config.debug, `Dispatch (${dispatchLabel})`, () =>
        config.batchMode
          ? runBatchDispatch({
              rules: runnableRules,
              diff,
              changedFiles,
              backend,
              config,
              repoRoot
            })
          : runParallelDispatch({
              rules: runnableRules,
              diff,
              changedFiles,
              backend,
              config,
              repoRoot
            })
      );
      diagnostics = result.diagnostics;
      backendErrors = result.backendErrors;
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
