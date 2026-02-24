import picomatch from "picomatch";
import { LoadedRule } from "./types";

export function extractChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  const lines = diff.split("\n");

  for (const line of lines) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    const parts = line.split(" ");
    const bPath = parts[3];
    if (!bPath || !bPath.startsWith("b/")) {
      continue;
    }
    const normalized = bPath.slice(2);
    if (normalized !== "/dev/null") {
      files.add(normalized);
    }
  }

  return Array.from(files);
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => picomatch(glob)(filePath));
}

function matchesAnyRegex(diff: string, regexes: string[]): boolean {
  for (const candidate of regexes) {
    try {
      const pattern = new RegExp(candidate, "m");
      if (pattern.test(diff)) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function shouldRunRule(rule: LoadedRule, changedFiles: string[], diff: string): boolean {
  let fileCandidates = changedFiles;

  if (rule.include_globs && rule.include_globs.length > 0) {
    fileCandidates = changedFiles.filter((filePath) => matchesAnyGlob(filePath, rule.include_globs!));
    if (fileCandidates.length === 0) {
      return false;
    }
  }

  if (rule.exclude_globs && rule.exclude_globs.length > 0) {
    fileCandidates = fileCandidates.filter(
      (filePath) => !matchesAnyGlob(filePath, rule.exclude_globs!)
    );
    if (fileCandidates.length === 0) {
      return false;
    }
  }

  if (rule.diff_regex && rule.diff_regex.length > 0 && !matchesAnyRegex(diff, rule.diff_regex)) {
    return false;
  }

  return true;
}

export function buildRulePrompt(rule: LoadedRule, diff: string): string {
  return [
    `RULE_ID: ${rule.id}`,
    `RULE_TITLE: ${rule.title}`,
    `SEVERITY_DEFAULT: ${rule.effectiveSeverity}`,
    "",
    "DIFF:",
    diff,
    "",
    "INSTRUCTIONS:",
    rule.prompt
  ].join("\n");
}
