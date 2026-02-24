import fs from "node:fs";
import path from "node:path";
import { CliOptions, ConfigFile, EffectiveConfig, Severity } from "./types";

const VALID_SEVERITIES = new Set<Severity>(["error", "warn", "info"]);

const DEFAULTS: EffectiveConfig = {
  backend: "cursor-cli",
  model: "auto",
  timeoutMs: 120000,
  format: "text",
  failOn: "error",
  base: "origin/main",
  head: "HEAD",
  debug: false,
  rulesDisable: [],
  severityOverrides: {},
  backendExecutables: {
    "cursor-cli": "agent"
  }
};

function readJsonIfExists(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config at ${filePath} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function resolveConfigPath(explicitPath?: string): string | undefined {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const cwd = process.cwd();
  const primary = path.join(cwd, "semlint.json");
  if (fs.existsSync(primary)) {
    return primary;
  }

  const secondary = path.join(cwd, ".semlint.json");
  if (fs.existsSync(secondary)) {
    return secondary;
  }

  return undefined;
}

function sanitizeSeverityOverrides(
  value: Record<string, unknown> | undefined
): Record<string, Severity> {
  if (!value) {
    return {};
  }
  const out: Record<string, Severity> = {};
  for (const [ruleId, severity] of Object.entries(value)) {
    if (typeof severity === "string" && VALID_SEVERITIES.has(severity as Severity)) {
      out[ruleId] = severity as Severity;
    }
  }
  return out;
}

function sanitizeBackendExecutables(
  value: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {
    ...DEFAULTS.backendExecutables
  };
  if (!value) {
    return out;
  }

  for (const [name, candidate] of Object.entries(value)) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "executable" in candidate &&
      typeof (candidate as { executable?: unknown }).executable === "string" &&
      (candidate as { executable: string }).executable.trim() !== ""
    ) {
      out[name] = (candidate as { executable: string }).executable.trim();
    }
  }
  return out;
}

export function loadEffectiveConfig(options: CliOptions): EffectiveConfig {
  const configPath = resolveConfigPath(options.configPath);
  const parsed = configPath ? readJsonIfExists(configPath) : undefined;
  const fileConfig = (parsed ?? {}) as ConfigFile;

  return {
    backend: options.backend ?? fileConfig.backend ?? DEFAULTS.backend,
    model: options.model ?? fileConfig.model ?? DEFAULTS.model,
    timeoutMs:
      typeof fileConfig.budgets?.timeout_ms === "number"
        ? fileConfig.budgets.timeout_ms
        : DEFAULTS.timeoutMs,
    format: options.format ?? fileConfig.output?.format ?? DEFAULTS.format,
    failOn: options.failOn ?? DEFAULTS.failOn,
    base: options.base ?? DEFAULTS.base,
    head: options.head ?? DEFAULTS.head,
    debug: options.debug || DEFAULTS.debug,
    rulesDisable: Array.isArray(fileConfig.rules?.disable)
      ? fileConfig.rules?.disable.filter((item): item is string => typeof item === "string")
      : DEFAULTS.rulesDisable,
    severityOverrides: sanitizeSeverityOverrides(
      (fileConfig.rules?.severity_overrides ?? undefined) as Record<string, unknown> | undefined
    ),
    backendExecutables: sanitizeBackendExecutables(
      (fileConfig.backends ?? undefined) as Record<string, unknown> | undefined
    )
  };
}
