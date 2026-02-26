import { spawn } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";
import { DiffFileKind } from "./types";

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LocalBranchDiffParts {
  stagedDiff: string;
  unstagedDiff: string;
  untrackedDiffs: string[];
}

function runGitCommand(args: string[], okExitCodes: number[] = [0]): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (!okExitCodes.includes(exitCode)) {
        reject(new Error(`git ${args.join(" ")} failed with code ${exitCode}: ${stderr.trim()}`));
        return;
      }
      resolve({
        code: exitCode,
        stdout,
        stderr
      });
    });
  });
}

function withRepoRootArgs(repoRoot: string | null, args: string[]): string[] {
  return repoRoot ? ["-C", repoRoot, ...args] : args;
}

export async function getGitDiff(base: string, head: string, repoRoot?: string | null): Promise<string> {
  const result = await runGitCommand(withRepoRootArgs(repoRoot ?? null, ["diff", base, head]));
  return result.stdout;
}

/**
 * Returns the absolute path of the git repository root, or null if not in a git repo.
 * Used to resolve diagnostic file paths, which are always repo-relative in git diff output.
 */
export async function getRepoRoot(): Promise<string | null> {
  try {
    const result = await runGitCommand(["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    return root !== "" ? root : null;
  } catch {
    return null;
  }
}

async function getUntrackedFiles(repoRoot?: string | null): Promise<string[]> {
  const result = await runGitCommand(
    withRepoRootArgs(repoRoot ?? null, ["ls-files", "--others", "--exclude-standard", "--full-name"])
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function getNoIndexDiffForFile(filePath: string, repoRoot?: string | null): Promise<string> {
  const resolvedPath = repoRoot ? path.relative(repoRoot, path.join(repoRoot, filePath)) : filePath;
  const result = await runGitCommand(
    withRepoRootArgs(repoRoot ?? null, ["diff", "--no-index", "--", devNull, resolvedPath]),
    [0, 1]
  );
  return result.stdout;
}

/**
 * Returns the diff for the current branch limited to:
 * - Staged changes (--cached: index vs HEAD)
 * - Unstaged changes (working tree vs index)
 * - Untracked files (as full-file diffs)
 * Does not include already-committed changes on the branch.
 */
export async function getLocalBranchDiff(
  fileKinds: DiffFileKind[] = ["staged", "unstaged", "untracked"],
  repoRoot?: string | null
): Promise<string> {
  const parts: LocalBranchDiffParts = {
    stagedDiff: "",
    unstagedDiff: "",
    untrackedDiffs: []
  };

  if (fileKinds.includes("staged")) {
    const stagedResult = await runGitCommand(withRepoRootArgs(repoRoot ?? null, ["diff", "--cached"]));
    parts.stagedDiff = stagedResult.stdout;
  }

  if (fileKinds.includes("unstaged")) {
    const unstagedResult = await runGitCommand(withRepoRootArgs(repoRoot ?? null, ["diff"]));
    parts.unstagedDiff = unstagedResult.stdout;
  }

  if (fileKinds.includes("untracked")) {
    const untrackedFiles = await getUntrackedFiles(repoRoot);
    for (const filePath of untrackedFiles) {
      const fileDiff = await getNoIndexDiffForFile(filePath, repoRoot);
      if (fileDiff.trim() !== "") {
        parts.untrackedDiffs.push(fileDiff);
      }
    }
  }

  return selectLocalBranchDiffChunks(parts, fileKinds);
}

export function selectLocalBranchDiffChunks(
  parts: LocalBranchDiffParts,
  fileKinds: DiffFileKind[] = ["staged", "unstaged", "untracked"]
): string {
  const selectedKinds = new Set(fileKinds);
  const chunks: string[] = [];

  if (selectedKinds.has("staged") && parts.stagedDiff !== "") {
    chunks.push(parts.stagedDiff);
  }
  if (selectedKinds.has("unstaged") && parts.unstagedDiff !== "") {
    chunks.push(parts.unstagedDiff);
  }
  if (selectedKinds.has("untracked")) {
    chunks.push(...parts.untrackedDiffs.filter((chunk) => chunk !== ""));
  }

  return chunks.join("\n");
}
