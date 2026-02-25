import { parseDiffGitHeader, splitDiffIntoFileChunks } from "./diff";
import picomatch from "picomatch";
import { renderRulePrompt } from "./prompts";
import { LoadedRule } from "./types";

export function extractChangedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  const lines = diff.split("\n");

  for (const line of lines) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    const parsed = parseDiffGitHeader(line);
    if (!parsed) {
      continue;
    }
    const normalized = parsed.bPath;
    if (normalized !== "/dev/null") {
      files.add(normalized);
    }
  }

  return Array.from(files);
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

function resolveRuleGlobs(ruleGlobs: string[] | undefined, globalGlobs: string[]): string[] {
  if (ruleGlobs === undefined) {
    return globalGlobs;
  }
  return ruleGlobs;
}

export function getRuleCandidateFiles(
  rule: LoadedRule,
  changedFiles: string[],
  globalIncludeGlobs: string[] = [],
  globalExcludeGlobs: string[] = []
): string[] {
  let fileCandidates = changedFiles;
  const effectiveIncludeGlobs = resolveRuleGlobs(rule.include_globs, globalIncludeGlobs);
  const effectiveExcludeGlobs = resolveRuleGlobs(rule.exclude_globs, globalExcludeGlobs);
  const includeMatcher =
    effectiveIncludeGlobs.length > 0 ? picomatch(effectiveIncludeGlobs) : null;
  const excludeMatcher =
    effectiveExcludeGlobs.length > 0 ? picomatch(effectiveExcludeGlobs) : null;

  if (includeMatcher) {
    fileCandidates = changedFiles.filter((filePath) => includeMatcher(filePath));
    if (fileCandidates.length === 0) {
      return [];
    }
  }

  if (excludeMatcher) {
    fileCandidates = fileCandidates.filter((filePath) => !excludeMatcher(filePath));
  }

  return fileCandidates;
}

export function shouldRunRule(
  rule: LoadedRule,
  changedFiles: string[],
  diff: string,
  globalIncludeGlobs: string[] = [],
  globalExcludeGlobs: string[] = []
): boolean {
  const fileCandidates = getRuleCandidateFiles(
    rule,
    changedFiles,
    globalIncludeGlobs,
    globalExcludeGlobs
  );
  if (fileCandidates.length === 0) {
    return false;
  }

  if (rule.diff_regex && rule.diff_regex.length > 0 && !matchesAnyRegex(diff, rule.diff_regex)) {
    return false;
  }

  return true;
}

export function buildScopedDiff(
  rule: LoadedRule,
  fullDiff: string,
  changedFiles: string[],
  globalIncludeGlobs: string[] = [],
  globalExcludeGlobs: string[] = []
): string {
  const candidateFiles = new Set(
    getRuleCandidateFiles(rule, changedFiles, globalIncludeGlobs, globalExcludeGlobs)
  );
  if (candidateFiles.size === 0) {
    return fullDiff;
  }

  const chunks = splitDiffIntoFileChunks(fullDiff);
  const scoped = chunks
    .filter((chunk) => chunk.file !== "" && candidateFiles.has(chunk.file))
    .map((chunk) => chunk.chunk)
    .join("\n");

  return scoped.trim() === "" ? fullDiff : scoped;
}

export function buildRulePrompt(rule: LoadedRule, diff: string): string {
  return renderRulePrompt({
    ruleId: rule.id,
    ruleTitle: rule.title,
    severityDefault: rule.effectiveSeverity,
    instructions: rule.prompt,
    diff
  });
}
