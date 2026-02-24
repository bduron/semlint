import fs from "node:fs";
import path from "node:path";
import { LoadedRule, RuleFile, Severity } from "./types";

const VALID_SEVERITIES = new Set<Severity>(["error", "warn", "info"]);

function assertNonEmptyString(value: unknown, fieldName: string, filePath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid rule in ${filePath}: "${fieldName}" must be a non-empty string`);
  }
  return value;
}

function assertStringArray(value: unknown, fieldName: string, filePath: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid rule in ${filePath}: "${fieldName}" must be an array of strings`);
  }
  return value;
}

function validateRuleObject(raw: unknown, filePath: string): RuleFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid rule in ${filePath}: root must be a JSON object`);
  }

  const obj = raw as Record<string, unknown>;
  const severity = assertNonEmptyString(obj.severity_default, "severity_default", filePath);
  if (!VALID_SEVERITIES.has(severity as Severity)) {
    throw new Error(`Invalid rule in ${filePath}: "severity_default" must be one of error|warn|info`);
  }

  return {
    id: assertNonEmptyString(obj.id, "id", filePath),
    title: assertNonEmptyString(obj.title, "title", filePath),
    severity_default: severity as Severity,
    prompt: assertNonEmptyString(obj.prompt, "prompt", filePath),
    include_globs: assertStringArray(obj.include_globs, "include_globs", filePath),
    exclude_globs: assertStringArray(obj.exclude_globs, "exclude_globs", filePath),
    diff_regex: assertStringArray(obj.diff_regex, "diff_regex", filePath)
  };
}

export function loadRules(
  rulesDir: string,
  disabledRuleIds: string[],
  severityOverrides: Record<string, Severity>
): LoadedRule[] {
  if (!fs.existsSync(rulesDir)) {
    return [];
  }
  if (!fs.statSync(rulesDir).isDirectory()) {
    throw new Error(`Rules path is not a directory: ${rulesDir}`);
  }

  const entries = fs
    .readdirSync(rulesDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  const seenIds = new Set<string>();
  const disabled = new Set(disabledRuleIds);
  const loaded: LoadedRule[] = [];

  for (const fileName of entries) {
    const filePath = path.join(rulesDir, fileName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse rule JSON in ${filePath}: ${message}`);
    }

    const validated = validateRuleObject(parsed, filePath);

    if (seenIds.has(validated.id)) {
      throw new Error(`Duplicate rule id detected: ${validated.id}`);
    }
    seenIds.add(validated.id);

    if (disabled.has(validated.id)) {
      continue;
    }

    const overrideSeverity = severityOverrides[validated.id];
    const effectiveSeverity = overrideSeverity ?? validated.severity_default;
    if (!VALID_SEVERITIES.has(effectiveSeverity)) {
      throw new Error(`Invalid severity override for rule ${validated.id}`);
    }

    loaded.push({
      ...validated,
      sourcePath: filePath,
      effectiveSeverity
    });
  }

  return loaded.sort((a, b) => a.id.localeCompare(b.id));
}
