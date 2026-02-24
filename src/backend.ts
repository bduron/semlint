import { spawn } from "node:child_process";
import { BackendResult, EffectiveConfig, RunRuleInput } from "./types";

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
}

function executeBackendCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<CommandExecutionResult> {
  return new Promise<CommandExecutionResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Backend timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Backend command failed with code ${code}. stderr: ${stderr.trim() || "(empty)"}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseBackendResult(raw: string): BackendResult {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Backend output JSON root must be an object");
  }
  const diagnostics = (parsed as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) {
    throw new Error("Backend output must contain diagnostics array");
  }
  return { diagnostics: diagnostics as BackendResult["diagnostics"] };
}

export function createBackendRunner(config: EffectiveConfig): {
  runRule(input: RunRuleInput): Promise<BackendResult>;
} {
  const executable = config.backendExecutables[config.backend];
  if (!executable) {
    throw new Error(
      `No executable configured for backend "${config.backend}". Configure it under backends.${config.backend}.executable`
    );
  }

  return {
    async runRule(input: RunRuleInput): Promise<BackendResult> {
      const baseArgs = [
        input.prompt,
        "--model",
        config.model,
        "--print",
        "--output-format",
        "text"
      ];

      try {
        const first = await executeBackendCommand(executable, baseArgs, input.timeoutMs);
        return parseBackendResult(first.stdout.trim());
      } catch (firstError) {
        const retryPrompt = `${input.prompt}\n\nReturn valid JSON only.`;
        const retryArgs = [
          retryPrompt,
          "--model",
          config.model,
          "--print",
          "--output-format",
          "text"
        ];
        try {
          const second = await executeBackendCommand(executable, retryArgs, input.timeoutMs);
          return parseBackendResult(second.stdout.trim());
        } catch {
          throw firstError;
        }
      }
    }
  };
}
