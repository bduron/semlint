import pc from "picocolors";
import { createSpinner, Spinner } from "nanospinner";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { version as VERSION } from "../package.json";
import { createBackendRunner } from "./backend";
import { loadEffectiveConfig } from "./config";
import { hasBlockingDiagnostic, sortDiagnostics } from "./diagnostics";
import { runBatchDispatch, runParallelDispatch } from "./dispatch";
import { shouldRunRule, extractChangedFilesFromDiff } from "./filter";
import { getGitDiff, getLocalBranchDiff, getRepoRoot } from "./git";
import { formatJsonOutput, formatTextOutput } from "./reporter";
import { loadRules } from "./rules";
import { filterDiffByIgnoreRules, scanDiffForSecrets } from "./secrets";
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

function formatFileList(title: string, files: string[]): string {
  if (files.length === 0) {
    return `${title} (0):\n  (none)\n`;
  }
  return `${title} (${files.length}):\n${files.map((file) => `  - ${file}`).join("\n")}\n`;
}

async function confirmDiffPreview(
  includedFiles: string[],
  excludedFiles: string[],
  autoAccept: boolean | undefined
): Promise<boolean> {
  process.stdout.write("\n");
  process.stdout.write(pc.blue(pc.bold("Semlint diff preview\n\n")));
  process.stdout.write(
    pc.red(
      "Warning: any sensitive file included below will be sent to your agent.\nMake sure you understand the security implications (run `semlint-cli security` for more information).\n\n"
    )
  );
  process.stdout.write(formatFileList("Included files", includedFiles));
  process.stdout.write("\n");
  process.stdout.write(formatFileList("Excluded files", excludedFiles));
  process.stdout.write("\n");

  if (autoAccept) {
    process.stdout.write(pc.dim("Auto-accepted with --yes.\n\n"));
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      pc.red(
        "Diff confirmation is required by default. Re-run with --yes (-y) to auto-accept in non-interactive environments.\n"
      )
    );
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(pc.yellow("Proceed with Semlint analysis? [y/N] "));
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
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
    const repoRoot = await timedAsync(config.debug, "Resolved git repo root", () => getRepoRoot());
    const scanRoot = repoRoot ?? process.cwd();
    debugLog(config.debug, `Using diff/ignore scan root: ${scanRoot}`);
    const rawDiff = await timedAsync(config.debug, "Computed git diff", () =>
      useLocalBranchDiff ? getLocalBranchDiff() : getGitDiff(config.base, config.head)
    );
    const { filteredDiff: diff, excludedFiles } = timed(config.debug, "Filtered diff by ignore rules", () =>
      filterDiffByIgnoreRules(rawDiff, scanRoot, config.security.ignoreFiles)
    );
    if (excludedFiles.length > 0) {
      debugLog(
        config.debug,
        `Excluded ${excludedFiles.length} file(s) by ignore/security rules: ${excludedFiles.join(", ")}`
      );
    }
    if (config.security.secretGuard) {
      const findings = timed(config.debug, "Scanned diff for secrets", () =>
        scanDiffForSecrets(diff, config.security.allowPatterns, config.security.allowFiles)
      );
      if (findings.length > 0) {
        process.stderr.write(
          pc.red(
            "Secret guard blocked analysis: potential secrets were detected in the diff. Nothing was sent to the backend.\n"
          )
        );
        process.stderr.write(
          "Allow a known-safe file by adding a glob to security.allow_files in semlint.json (example: \"allow_files\": [\"src/my-sensitive-file.ts\"]).\n"
        );
        findings.slice(0, 20).forEach((finding) => {
          process.stderr.write(
            `  ${finding.file}:${finding.line}  ${finding.kind}  sample=${finding.redactedSample}\n`
          );
        });
        if (findings.length > 20) {
          process.stderr.write(`  ...and ${findings.length - 20} more finding(s)\n`);
        }
        return 2;
      }
    }
    const changedFiles = timed(config.debug, "Parsed changed files from diff", () =>
      extractChangedFilesFromDiff(diff)
    );
    const confirmed = await timedAsync(config.debug, "User confirmation", () =>
      confirmDiffPreview(changedFiles, excludedFiles, options.autoAccept)
    );
    if (!confirmed) {
      process.stderr.write("Aborted by user.\n");
      return 2;
    }
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
