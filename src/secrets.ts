import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { parseDiffGitHeader, splitDiffIntoFileChunks } from "./diff";
import { SecretFinding } from "./types";

const BUILTIN_SENSITIVE_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.*",
  "**/secrets/**",
  "**/credentials/**",
  "**/*credentials*.json"
];

const SECRET_KEYWORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "private key",
  "certificate",
  "cert",
  "sk-",
  "sk_",
  "ghp_",
  "akia",
  "key"
];

function readIgnorePatterns(cwd: string, ignoreFiles: string[]): string[] {
  return ignoreFiles.flatMap((fileName) => {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  });
}

function redactSample(sample: string): string {
  const compact = sample.trim();
  if (compact.length <= 6) {
    return "***";
  }
  return `${compact.slice(0, 2)}***${compact.slice(-2)}`;
}

function parseAllowMatchers(patterns: string[]): RegExp[] {
  return patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern)];
    } catch {
      return [];
    }
  });
}

export function filterDiffByIgnoreRules(
  diff: string,
  cwd: string,
  ignoreFiles: string[]
): { filteredDiff: string; excludedFiles: string[] } {
  const ignorePatterns = [...readIgnorePatterns(cwd, ignoreFiles), ...BUILTIN_SENSITIVE_GLOBS];
  const ignoreMatcher = picomatch(ignorePatterns, { dot: true });
  const chunks = splitDiffIntoFileChunks(diff);

  const excludedFiles = chunks
    .filter((chunk) => chunk.file !== "" && ignoreMatcher(chunk.file))
    .map((chunk) => chunk.file);

  const filteredDiff = chunks
    .filter((chunk) => chunk.file === "" || !ignoreMatcher(chunk.file))
    .map((chunk) => chunk.chunk)
    .join("\n");

  return {
    filteredDiff,
    excludedFiles: Array.from(new Set(excludedFiles)).sort((a, b) => a.localeCompare(b))
  };
}

export function scanDiffForSecrets(diff: string, allowPatterns: string[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const allowMatchers = parseAllowMatchers(allowPatterns);
  const lines = diff.split("\n");

  let currentFile = "(unknown)";
  let newLine = 1;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const parsed = parseDiffGitHeader(line);
      if (parsed) {
        currentFile = parsed.bPath;
      }
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      const allowed = allowMatchers.some((matcher) => matcher.test(added));
      if (!allowed) {
        const lowered = added.toLowerCase();
        const matchedKeyword = SECRET_KEYWORDS.find((keyword) => lowered.includes(keyword));
        if (matchedKeyword) {
          findings.push({
            file: currentFile,
            line: newLine,
            kind: `keyword:${matchedKeyword}`,
            redactedSample: redactSample(added)
          });
        }
      }
      newLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      newLine += 1;
      continue;
    }
  }

  return findings;
}
