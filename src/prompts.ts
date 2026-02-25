import fs from "node:fs";
import path from "node:path";

const promptCache = new Map<string, string>();

function readPromptFile(fileName: string): string {
  const cached = promptCache.get(fileName);
  if (cached !== undefined) {
    return cached;
  }

  const promptPath = path.resolve(__dirname, "..", "prompts", fileName);
  const content = fs.readFileSync(promptPath, "utf8").trim();
  promptCache.set(fileName, content);
  return content;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value),
    template
  );
}

export function getStrictJsonRetryInstruction(): string {
  return readPromptFile("retry-json.md").replace(/\s+/g, " ").trim();
}

export function renderRulePrompt(values: {
  ruleId: string;
  ruleTitle: string;
  severityDefault: string;
  instructions: string;
  diff: string;
}): string {
  const commonContract = readPromptFile("common-contract.md");
  return renderTemplate(readPromptFile("rule.md"), {
    COMMON_CONTRACT: commonContract,
    RULE_ID: values.ruleId,
    RULE_TITLE: values.ruleTitle,
    SEVERITY_DEFAULT: values.severityDefault,
    INSTRUCTIONS: values.instructions,
    DIFF: values.diff
  });
}

export function renderBatchPrompt(values: { ruleBlocks: string; diff: string }): string {
  const commonContract = readPromptFile("common-contract.md");
  return renderTemplate(readPromptFile("batch.md"), {
    COMMON_CONTRACT: commonContract,
    RULE_BLOCKS: values.ruleBlocks,
    DIFF: values.diff
  });
}
