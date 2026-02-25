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

const SECRET_DETECTORS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "private_key_block", pattern: /BEGIN [A-Z ]*PRIVATE KEY/i },
  { kind: "openai_key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { kind: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/i },
  { kind: "github_token", pattern: /ghp_[A-Za-z0-9]{36}/ },
  { kind: "aws_access_key_id", pattern: /AKIA[0-9A-Z]{16}/ },
  {
    kind: "generic_secret_assignment",
    pattern:
      /(api[_-]?key|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=]{8,}/i
  }
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

function extractHighEntropyToken(line: string): string | undefined {
  const matches = line.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? [];
  for (const token of matches) {
    const hasLower = /[a-z]/.test(token);
    const hasUpper = /[A-Z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    if (hasLower && hasUpper && hasDigit) {
      return token;
    }
  }
  return undefined;
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
        const detector = SECRET_DETECTORS.find((entry) => entry.pattern.test(added));
        const detectedValue = detector ? (added.match(detector.pattern)?.[0] ?? added) : undefined;
        const highEntropy = detector ? undefined : extractHighEntropyToken(added);
        if (detectedValue || highEntropy) {
          findings.push({
            file: currentFile,
            line: newLine,
            kind: detector?.kind ?? "high_entropy_token",
            redactedSample: redactSample(detectedValue ?? highEntropy ?? added)
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
