import picomatch from "picomatch";
import { renderRulePrompt } from "./prompts";
import { LoadedRule } from "./types";

function unquoteDiffPath(raw: string): string {
  if (raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return raw;
}

function parseDiffGitHeader(line: string): { aPath: string; bPath: string } | undefined {
  const match = line.match(
    /^diff --git (?:"a\/((?:[^"\\]|\\.)+)"|a\/(\S+)) (?:"b\/((?:[^"\\]|\\.)+)"|b\/(\S+))$/
  );
  if (!match) {
    return undefined;
  }
  const aRaw = match[1] ?? match[2];
  const bRaw = match[3] ?? match[4];
  if (!aRaw || !bRaw) {
    return undefined;
  }
  return {
    aPath: unquoteDiffPath(aRaw),
    bPath: unquoteDiffPath(bRaw)
  };
}

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

export function getRuleCandidateFiles(rule: LoadedRule, changedFiles: string[]): string[] {
  let fileCandidates = changedFiles;
  const includeMatcher =
    rule.include_globs && rule.include_globs.length > 0 ? picomatch(rule.include_globs) : null;
  const excludeMatcher =
    rule.exclude_globs && rule.exclude_globs.length > 0 ? picomatch(rule.exclude_globs) : null;

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

export function shouldRunRule(rule: LoadedRule, changedFiles: string[], diff: string): boolean {
  const fileCandidates = getRuleCandidateFiles(rule, changedFiles);
  if (fileCandidates.length === 0) {
    return false;
  }

  if (rule.diff_regex && rule.diff_regex.length > 0 && !matchesAnyRegex(diff, rule.diff_regex)) {
    return false;
  }

  return true;
}

function splitDiffIntoFileChunks(diff: string): Array<{ file: string; chunk: string }> {
  const lines = diff.split("\n");
  const chunks: Array<{ file: string; chunk: string }> = [];

  let currentLines: string[] = [];
  let currentFile = "";

  const flush = (): void => {
    if (currentLines.length === 0) {
      return;
    }
    chunks.push({
      file: currentFile,
      chunk: currentLines.join("\n")
    });
    currentLines = [];
    currentFile = "";
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const parsed = parseDiffGitHeader(line);
      if (parsed) {
        currentFile = parsed.bPath;
      }
    }
    currentLines.push(line);
  }

  flush();
  return chunks;
}

export function buildScopedDiff(rule: LoadedRule, fullDiff: string, changedFiles: string[]): string {
  const candidateFiles = new Set(getRuleCandidateFiles(rule, changedFiles));
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
