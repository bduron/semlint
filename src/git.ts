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

function isMissingRefError(message: string): boolean {
  return /(not a valid object name|unknown revision|bad revision|no upstream configured|no upstream branch)/i.test(
    message
  );
}

async function resolveLocalComparisonBase(): Promise<string> {
  const candidates = ["@{upstream}", "origin/main", "main"];
  for (const candidate of candidates) {
    try {
      const result = await runGitCommand(["merge-base", "HEAD", candidate]);
      const mergeBase = result.stdout.trim();
      if (mergeBase !== "") {
        return mergeBase;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isMissingRefError(message)) {
        throw error;
      }
      continue;
    }
  }
  return "HEAD";
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

export async function getLocalBranchDiff(): Promise<string> {
  const base = await resolveLocalComparisonBase();
  const trackedDiff = await runGitCommand(["diff", base]);
  const untrackedFiles = await getUntrackedFiles();

  const untrackedDiffChunks: string[] = [];
  for (const filePath of untrackedFiles) {
    const fileDiff = await getNoIndexDiffForFile(filePath);
    if (fileDiff.trim() !== "") {
      untrackedDiffChunks.push(fileDiff);
    }
  }

  return [trackedDiff.stdout, ...untrackedDiffChunks].filter((chunk) => chunk !== "").join("\n");
}
