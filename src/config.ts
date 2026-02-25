import fs from "node:fs";
import path from "node:path";
import { CliOptions, ConfigFile, EffectiveConfig, Severity } from "./types";
import { VALID_SEVERITIES } from "./utils";

const DEFAULTS: EffectiveConfig = {
  backend: "cursor-cli",
  model: "auto",
  timeoutMs: 120000,
  format: "text",
  failOn: "error",
  base: "origin/main",
  head: "HEAD",
  debug: false,
  batchMode: false,
  rulesDisable: [],
  severityOverrides: {},
  rulesIncludeGlobs: [],
  rulesExcludeGlobs: [],
  backendConfigs: {},
  security: {
    secretGuard: true,
    allowPatterns: [],
    ignoreFiles: [".gitignore", ".cursorignore", ".semlintignore"],
    allowFiles: []
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
  return Object.fromEntries(
    Object.entries(value).flatMap(([ruleId, severity]) =>
      typeof severity === "string" && VALID_SEVERITIES.has(severity as Severity)
        ? [[ruleId, severity as Severity]]
        : []
    )
  );
}

function sanitizeBackendConfigs(
  value: Record<string, unknown> | undefined
): Record<string, { executable: string; args: string[]; model?: string }> {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([name, candidate]) => {
      if (typeof candidate !== "object" || candidate === null) {
        return [];
      }

      const executable =
        "executable" in candidate && typeof (candidate as { executable?: unknown }).executable === "string"
          ? (candidate as { executable: string }).executable.trim()
          : "";
      const args = "args" in candidate ? (candidate as { args?: unknown }).args : undefined;
      const model =
        "model" in candidate && typeof (candidate as { model?: unknown }).model === "string"
          ? (candidate as { model: string }).model.trim()
          : undefined;
      if (!executable || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        return [];
      }

      const normalizedArgs = args as string[];
      if (!normalizedArgs.includes("{prompt}")) {
        return [];
      }

      return [[name, { executable, args: normalizedArgs, model: model && model !== "" ? model : undefined }]];
    })
  );
}

function sanitizeAllowPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      return [];
    }
    try {
      new RegExp(candidate);
      return [candidate];
    } catch {
      return [];
    }
  });
}

function sanitizeIgnoreFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULTS.security.ignoreFiles];
  }
  const normalized = value.flatMap((candidate) => {
    if (typeof candidate !== "string") {
      return [];
    }
    const trimmed = candidate.trim();
    if (trimmed === "") {
      return [];
    }
    return [trimmed];
  });
  return normalized.length > 0 ? normalized : [...DEFAULTS.security.ignoreFiles];
}

function sanitizeAllowFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (typeof candidate !== "string") {
      return [];
    }
    const trimmed = candidate.trim();
    return trimmed === "" ? [] : [trimmed];
  });
}

function sanitizeGlobList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (typeof candidate !== "string") {
      return [];
    }
    const trimmed = candidate.trim();
    return trimmed === "" ? [] : [trimmed];
  });
}

function ensureSelectedBackendIsConfigured(
  backend: string,
  backendConfigs: Record<string, { executable: string; args: string[]; model?: string }>
): void {
  if (!(backend in backendConfigs)) {
    throw new Error(
      `Backend "${backend}" is not configured. Add it under backends.${backend} with executable and args (including "{prompt}") in semlint.json.`
    )
  }
}

export function loadEffectiveConfig(options: CliOptions): EffectiveConfig {
  const configPath = resolveConfigPath(options.configPath);
  const parsed = configPath ? readJsonIfExists(configPath) : undefined;
  const fileConfig = (parsed ?? {}) as ConfigFile;

  const backend = options.backend ?? fileConfig.backend ?? DEFAULTS.backend;
  const backendConfigs = sanitizeBackendConfigs(
    (fileConfig.backends ?? undefined) as Record<string, unknown> | undefined
  );
  ensureSelectedBackendIsConfigured(backend, backendConfigs);
  const backendModel = backendConfigs[backend]?.model;

  return {
    backend,
    model: options.model ?? backendModel ?? DEFAULTS.model,
    timeoutMs:
      typeof fileConfig.budgets?.timeout_ms === "number"
        ? fileConfig.budgets.timeout_ms
        : DEFAULTS.timeoutMs,
    format: options.format ?? fileConfig.output?.format ?? DEFAULTS.format,
    failOn: options.failOn ?? DEFAULTS.failOn,
    base: options.base ?? DEFAULTS.base,
    head: options.head ?? DEFAULTS.head,
    debug: options.debug || DEFAULTS.debug,
    batchMode:
      options.batch ??
      (typeof fileConfig.execution?.batch === "boolean"
        ? fileConfig.execution.batch
        : DEFAULTS.batchMode),
    rulesDisable: Array.isArray(fileConfig.rules?.disable)
      ? fileConfig.rules?.disable.filter((item): item is string => typeof item === "string")
      : DEFAULTS.rulesDisable,
    severityOverrides: sanitizeSeverityOverrides(
      (fileConfig.rules?.severity_overrides ?? undefined) as Record<string, unknown> | undefined
    ),
    rulesIncludeGlobs: sanitizeGlobList(fileConfig.rules?.include_globs),
    rulesExcludeGlobs: sanitizeGlobList(fileConfig.rules?.exclude_globs),
    backendConfigs,
    security: {
      secretGuard:
        typeof fileConfig.security?.secret_guard === "boolean"
          ? fileConfig.security.secret_guard
          : DEFAULTS.security.secretGuard,
      allowPatterns: sanitizeAllowPatterns(fileConfig.security?.allow_patterns),
      ignoreFiles: sanitizeIgnoreFiles(fileConfig.security?.ignore_files),
      allowFiles: sanitizeAllowFiles(fileConfig.security?.allow_files)
    }
  };
}
