import { normalizeDiagnostics } from "./diagnostics";
import { buildRulePrompt, buildScopedDiff } from "./filter";
import { renderBatchPrompt } from "./prompts";
import { BackendDiagnostic, EffectiveConfig, LoadedRule } from "./types";
import { debugLog } from "./utils";

interface BackendRunner {
  runPrompt(input: { label: string; prompt: string; timeoutMs: number }): Promise<{ diagnostics: unknown[] }>;
  runRule(input: { ruleId: string; prompt: string; timeoutMs: number }): Promise<{ diagnostics: unknown[] }>;
}

interface DispatchInput {
  rules: LoadedRule[];
  diff: string;
  changedFiles: string[];
  backend: BackendRunner;
  config: EffectiveConfig;
  repoRoot: string | null;
}

export interface DispatchResult {
  diagnostics: BackendDiagnostic[];
  backendErrors: number;
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

  return renderBatchPrompt({ ruleBlocks, diff });
}

export async function runBatchDispatch(input: DispatchInput): Promise<DispatchResult> {
  const { rules, diff, changedFiles, backend, config, repoRoot } = input;
  const diagnostics: BackendDiagnostic[] = [];
  let backendErrors = 0;

  debugLog(config.debug, `Running ${rules.length} rule(s) in batch mode`);
  const combinedDiff = rules
    .map((rule) =>
      buildScopedDiff(rule, diff, changedFiles, config.rulesIncludeGlobs, config.rulesExcludeGlobs)
    )
    .filter((chunk) => chunk.trim() !== "")
    .join("\n");
  const batchPrompt = buildBatchPrompt(rules, combinedDiff || diff);

  try {
    const batchResult = await backend.runPrompt({
      label: "Batch",
      prompt: batchPrompt,
      timeoutMs: config.timeoutMs
    });

    const groupedByRule = (batchResult.diagnostics as unknown[]).reduce<Map<string, unknown[]>>(
      (acc, diagnostic) => {
        if (
          typeof diagnostic === "object" &&
          diagnostic !== null &&
          !Array.isArray(diagnostic) &&
          typeof (diagnostic as { rule_id?: unknown }).rule_id === "string"
        ) {
          const ruleId = (diagnostic as { rule_id: string }).rule_id;
          acc.set(ruleId, [...(acc.get(ruleId) ?? []), diagnostic]);
          return acc;
        }
        debugLog(config.debug, "Batch: dropped diagnostic without valid rule_id");
        return acc;
      },
      new Map<string, unknown[]>()
    );

    const validRuleIds = new Set(rules.map((rule) => rule.id));
    Array.from(groupedByRule.keys())
      .filter((ruleId) => !validRuleIds.has(ruleId))
      .forEach((ruleId) => {
        debugLog(config.debug, `Batch: dropped diagnostic for unknown rule_id ${ruleId}`);
      });

    const normalized = rules.flatMap((rule) =>
      normalizeDiagnostics(rule.id, groupedByRule.get(rule.id) ?? [], config.debug, repoRoot)
    );
    diagnostics.push(...normalized);
  } catch (error) {
    backendErrors += 1;
    const message = error instanceof Error ? error.message : String(error);
    debugLog(config.debug, `Batch backend error: ${message}`);
  }

  return { diagnostics, backendErrors };
}

export async function runParallelDispatch(input: DispatchInput): Promise<DispatchResult> {
  const { rules, diff, changedFiles, backend, config, repoRoot } = input;

  debugLog(config.debug, `Running ${rules.length} rule(s) in parallel`);
  const runResults = await Promise.all(
    rules.map(async (rule) => {
      const ruleStartedAt = Date.now();
      debugLog(config.debug, `Rule ${rule.id}: started`);

      const scopedDiff = buildScopedDiff(
        rule,
        diff,
        changedFiles,
        config.rulesIncludeGlobs,
        config.rulesExcludeGlobs
      );
      const prompt = buildRulePrompt(rule, scopedDiff);

      try {
        const result = await backend.runRule({
          ruleId: rule.id,
          prompt,
          timeoutMs: config.timeoutMs
        });
        const normalized = normalizeDiagnostics(rule.id, result.diagnostics, config.debug, repoRoot);
        debugLog(config.debug, `Rule ${rule.id}: finished in ${Date.now() - ruleStartedAt}ms`);
        return { backendError: false, normalized };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog(config.debug, `Backend error for rule ${rule.id}: ${message}`);
        debugLog(config.debug, `Rule ${rule.id}: finished in ${Date.now() - ruleStartedAt}ms`);
        return { backendError: true, normalized: [] as BackendDiagnostic[] };
      }
    })
  );

  return {
    diagnostics: runResults.flatMap((result) => result.normalized),
    backendErrors: runResults.filter((result) => result.backendError).length
  };
}
