import { spawn } from "node:child_process";
import { BackendResult, EffectiveConfig, RunPromptInput, RunRuleInput } from "./types";

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

interface CommandSpec {
  executable: string;
  argsPrefix: string[];
}

const STRICT_JSON_RETRY_INSTRUCTION = [
  "Return valid JSON only.",
  "Do not include markdown fences.",
  "Do not include commentary, headings, or any text before/after JSON.",
  "The first character of your response must be '{' and the last must be '}'.",
  'Output must match: {"diagnostics":[{"rule_id":"<id>","severity":"error|warn|info","message":"<text>","file":"<path>","line":1}]}'
].join(" ");

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function debugLog(enabled: boolean, message: string): void {
  if (enabled) {
    process.stderr.write(`[debug] ${message}\n`);
  }
}

function resolveCommandSpecs(config: EffectiveConfig): CommandSpec[] {
  if (config.backend === "cursor-cli") {
    // Always use `cursor agent` directly for cursor-cli.
    return [{ executable: "cursor", argsPrefix: ["agent"] }];
  }

  const configuredExecutable = config.backendExecutables[config.backend];
  if (!configuredExecutable) {
    throw new Error(
      `No executable configured for backend "${config.backend}". Configure it under backends.${config.backend}.executable`
    );
  }
  return [{ executable: configuredExecutable, argsPrefix: [] }];
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

  return {
    async runPrompt(input: RunPromptInput): Promise<BackendResult> {
      let lastError: unknown;

      for (const spec of commandSpecs) {
        const commandName = [spec.executable, ...spec.argsPrefix].join(" ");
        const baseArgs = [
          ...spec.argsPrefix,
          input.prompt,
          "--model",
          config.model,
          "--print",
          "--mode",
          "ask",
          "--output-format",
          "text"
        ];

        try {
          debugLog(
            config.debug,
            `${input.label}: backend attempt 1 via "${commandName}" (timeout ${input.timeoutMs}ms)`
          );
          const first = await executeBackendCommand(spec.executable, baseArgs, input.timeoutMs);
          debugLog(
            config.debug,
            `${input.label}: backend attempt 1 completed in ${first.elapsedMs}ms`
          );
          return parseBackendResult(first.stdout.trim());
        } catch (firstError) {
          debugLog(
            config.debug,
            `${input.label}: backend attempt 1 failed (${firstError instanceof Error ? firstError.message : String(firstError)})`
          );
          const retryPrompt = `${input.prompt}\n\n${STRICT_JSON_RETRY_INSTRUCTION}`;
          const retryArgs = [
            ...spec.argsPrefix,
            retryPrompt,
            "--model",
            config.model,
            "--print",
            "--mode",
            "ask",
            "--output-format",
            "text"
          ];
          try {
            debugLog(
              config.debug,
              `${input.label}: backend attempt 2 via "${commandName}" (timeout ${input.timeoutMs}ms)`
            );
            const second = await executeBackendCommand(spec.executable, retryArgs, input.timeoutMs);
            debugLog(
              config.debug,
              `${input.label}: backend attempt 2 completed in ${second.elapsedMs}ms`
            );
            return parseBackendResult(second.stdout.trim());
          } catch (secondError) {
            debugLog(
              config.debug,
              `${input.label}: backend attempt 2 failed (${secondError instanceof Error ? secondError.message : String(secondError)})`
            );
            lastError = secondError;
            if (isEnoentError(secondError)) {
              continue;
            }
            if (isEnoentError(firstError)) {
              continue;
            }
            throw firstError;
          }
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
