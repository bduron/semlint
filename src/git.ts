import { spawn } from "node:child_process";
import { devNull } from "node:os";

interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
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

export async function getGitDiff(base: string, head: string): Promise<string> {
  const result = await runGitCommand(["diff", base, head]);
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

async function getUntrackedFiles(): Promise<string[]> {
  const result = await runGitCommand(["ls-files", "--others", "--exclude-standard"]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function getNoIndexDiffForFile(filePath: string): Promise<string> {
  const result = await runGitCommand(["diff", "--no-index", "--", devNull, filePath], [0, 1]);
  return result.stdout;
}

/**
 * Returns the diff for the current branch limited to:
 * - Staged changes (--cached: index vs HEAD)
 * - Unstaged changes (working tree vs index)
 * - Untracked files (as full-file diffs)
 * Does not include already-committed changes on the branch.
 */
export async function getLocalBranchDiff(): Promise<string> {
  const stagedResult = await runGitCommand(["diff", "--cached"]);
  const unstagedResult = await runGitCommand(["diff"]);
  const untrackedFiles = await getUntrackedFiles();

  const untrackedDiffChunks: string[] = [];
  for (const filePath of untrackedFiles) {
    const fileDiff = await getNoIndexDiffForFile(filePath);
    if (fileDiff.trim() !== "") {
      untrackedDiffChunks.push(fileDiff);
    }
  }

  return [stagedResult.stdout, unstagedResult.stdout, ...untrackedDiffChunks]
    .filter((chunk) => chunk !== "")
    .join("\n");
}
