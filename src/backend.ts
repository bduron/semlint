import { spawn } from "node:child_process";
import { getStrictJsonRetryInstruction } from "./prompts";
import { BackendResult, EffectiveConfig, RunPromptInput, RunRuleInput } from "./types";
import { debugLog } from "./utils";

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface CommandSpec {
  executable: string;
  args: string[];
}

const STRICT_JSON_RETRY_INSTRUCTION = getStrictJsonRetryInstruction();

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function logBackendCommand(label: string, executable: string, args: string[], prompt: string): void {
  const printableParts = [executable, ...args.map((arg) => (arg === prompt ? "<prompt-redacted>" : arg))];
  process.stderr.write(`[semlint] ${label}: ${printableParts.join(" ")}\n`);
}

function resolveCommandSpecs(config: EffectiveConfig): CommandSpec[] {
  const configuredBackend = config.backendConfigs[config.backend];
  if (!configuredBackend) {
    throw new Error(
      `Backend "${config.backend}" is not configured. Add it under backends.${config.backend} in semlint.json (run "semlint init" to scaffold a complete config).`
    );
  }

  return [
    {
      executable: configuredBackend.executable,
      args: configuredBackend.args
    }
  ];
}

function interpolateArgs(args: string[], prompt: string, model: string): string[] {
  return args.map((arg) => {
    if (arg === "{prompt}") return prompt;
    if (arg === "{model}") return model;
    return arg;
  });
}

function executeBackendCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<CommandExecutionResult> {
  return new Promise<CommandExecutionResult>((resolve, reject) => {
    const startedAt = Date.now();
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
      resolve({ stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}

function executeBackendCommandInteractive(executable: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit"
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Interactive backend command failed with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function canUseInteractiveRecovery(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY);
}

function extractFirstJsonObject(raw: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

function parseBackendResult(raw: string): BackendResult {
  const candidate = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    const extracted = extractFirstJsonObject(candidate);
    if (!extracted) {
      throw new Error(`Backend output is not valid JSON: ${candidate.slice(0, 200)}`);
    }
    parsed = JSON.parse(extracted) as unknown;
  }

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
  runPrompt(input: RunPromptInput): Promise<BackendResult>;
  runRule(input: RunRuleInput): Promise<BackendResult>;
} {
  const commandSpecs = resolveCommandSpecs(config);
  async function runWithRetry(spec: CommandSpec, input: RunPromptInput): Promise<BackendResult | null> {
    const commandName = spec.executable;
    const firstPrompt = input.prompt;
    const firstArgs = interpolateArgs(spec.args, firstPrompt, config.model);
    let interactiveRecoveryAttempted = false;
    try {
      if (config.debug) {
        logBackendCommand(`${input.label} attempt 1`, spec.executable, firstArgs, firstPrompt);
      }
      debugLog(
        config.debug,
        `${input.label}: backend attempt 1 via "${commandName}" (timeout ${input.timeoutMs}ms)`
      );
      const first = await executeBackendCommand(spec.executable, firstArgs, input.timeoutMs);
      debugLog(config.debug, `${input.label}: backend attempt 1 completed in ${first.elapsedMs}ms`);
      return parseBackendResult(first.stdout.trim());
    } catch (firstError) {
      debugLog(
        config.debug,
        `${input.label}: backend attempt 1 failed (${firstError instanceof Error ? firstError.message : String(firstError)})`
      );

      const retryPrompt = `${input.prompt}\n\n${STRICT_JSON_RETRY_INSTRUCTION}`;
      const retryArgs = interpolateArgs(spec.args, retryPrompt, config.model);
      try {
        if (config.debug) {
          logBackendCommand(`${input.label} attempt 2`, spec.executable, retryArgs, retryPrompt);
        }
        debugLog(
          config.debug,
          `${input.label}: backend attempt 2 via "${commandName}" (timeout ${input.timeoutMs}ms)`
        );
        const second = await executeBackendCommand(spec.executable, retryArgs, input.timeoutMs);
        debugLog(config.debug, `${input.label}: backend attempt 2 completed in ${second.elapsedMs}ms`);
        return parseBackendResult(second.stdout.trim());
      } catch (secondError) {
        debugLog(
          config.debug,
          `${input.label}: backend attempt 2 failed (${secondError instanceof Error ? secondError.message : String(secondError)})`
        );
        if (
          !interactiveRecoveryAttempted &&
          !isEnoentError(firstError) &&
          !isEnoentError(secondError) &&
          canUseInteractiveRecovery()
        ) {
          interactiveRecoveryAttempted = true;
          process.stderr.write(
            "[semlint] Backend requires interactive setup. Switching to interactive passthrough once...\n"
          );
          await executeBackendCommandInteractive(spec.executable, firstArgs);
          debugLog(
            config.debug,
            `${input.label}: interactive setup completed; retrying backend in machine mode`
          );
          const recovered = await executeBackendCommand(spec.executable, firstArgs, input.timeoutMs);
          return parseBackendResult(recovered.stdout.trim());
        }
        if (isEnoentError(secondError) || isEnoentError(firstError)) {
          return null;
        }
        throw firstError;
      }
    }
  }

  return {
    async runPrompt(input: RunPromptInput): Promise<BackendResult> {
      let lastError: unknown;

      for (const spec of commandSpecs) {
        try {
          const result = await runWithRetry(spec, input);
          if (result) {
            return result;
          }
          continue;
        } catch (error) {
          lastError = error;
          throw error;
        }
      }

      if (lastError) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
      throw new Error(`No backend command could be executed for "${config.backend}"`);
    },
    async runRule(input: RunRuleInput): Promise<BackendResult> {
      return this.runPrompt({
        label: `Rule ${input.ruleId}`,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs
      });
    }
  };
}
