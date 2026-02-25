export type Severity = "error" | "warn" | "info";
export type OutputFormat = "text" | "json";
export type FailOn = "error" | "warn" | "never";

export interface CliOptions {
  command: "check" | "init" | "security";
  backend?: string;
  model?: string;
  configPath?: string;
  format?: OutputFormat;
  base?: string;
  head?: string;
  failOn?: FailOn;
  batch?: boolean;
  autoAccept?: boolean;
  force?: boolean;
  debug: boolean;
}

export interface LoadedConfig {
  path?: string;
  raw: Record<string, unknown>;
}

export interface ConfigFile {
  backend?: string;
  budgets?: {
    timeout_ms?: number;
  };
  output?: {
    format?: OutputFormat;
  };
  rules?: {
    disable?: string[];
    severity_overrides?: Record<string, Severity>;
    include_globs?: string[];
    exclude_globs?: string[];
  };
  execution?: {
    batch?: boolean;
  };
  backends?: Record<
    string,
    {
      executable?: string;
      args?: string[];
      model?: string;
    }
  >;
  security?: {
    secret_guard?: boolean;
    allow_patterns?: string[];
    ignore_files?: string[];
    allow_files?: string[];
  };
}

export interface EffectiveConfig {
  backend: string;
  model: string;
  timeoutMs: number;
  format: OutputFormat;
  failOn: FailOn;
  base: string;
  head: string;
  debug: boolean;
  batchMode: boolean;
  rulesDisable: string[];
  severityOverrides: Record<string, Severity>;
  rulesIncludeGlobs: string[];
  rulesExcludeGlobs: string[];
  backendConfigs: Record<
    string,
    {
      executable: string;
      args: string[];
      model?: string;
    }
  >;
  security: {
    secretGuard: boolean;
    allowPatterns: string[];
    ignoreFiles: string[];
    allowFiles: string[];
  };
}

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  redactedSample: string;
}

export interface RuleFile {
  id: string;
  title: string;
  severity_default: Severity;
  prompt: string;
  include_globs?: string[];
  exclude_globs?: string[];
  diff_regex?: string[];
}

export interface LoadedRule extends RuleFile {
  sourcePath: string;
  effectiveSeverity: Severity;
}

export interface RunRuleInput {
  ruleId: string;
  prompt: string;
  timeoutMs: number;
}

export interface RunPromptInput {
  label: string;
  prompt: string;
  timeoutMs: number;
}

export interface BackendResult {
  diagnostics: BackendDiagnostic[];
}

export interface BackendDiagnostic {
  rule_id: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column?: number;
  end_line?: number;
  end_column?: number;
  evidence?: string;
  confidence?: number;
}

export interface CanonicalJsonReport {
  tool: {
    name: "semlint";
    version: string;
  };
  diagnostics: BackendDiagnostic[];
  stats: {
    rules_run: number;
    duration_ms: number;
    backend_errors: number;
  };
}

export interface RunStats {
  rulesRun: number;
  durationMs: number;
  backendErrors: number;
}
