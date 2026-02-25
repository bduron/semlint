import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

type DetectedBackend = {
  backend: string;
  executable: string;
  args: string[];
  model: string;
  reason: string;
};

const SCAFFOLD_BACKENDS: Record<
  string,
  {
    executable: string;
    args: string[];
    model: string;
  }
> = {
  "cursor-cli": {
    executable: "cursor",
    args: ["agent", "{prompt}", "--model", "{model}", "--print", "--mode", "ask", "--output-format", "text"],
    model: "auto"
  },
  "claude-code": {
    executable: "claude",
    args: ["{prompt}", "--model", "{model}", "--output-format", "json"],
    model: "auto"
  },
  "codex-cli": {
    executable: "codex",
    args: ["{prompt}", "--model", "{model}"],
    model: "auto"
  }
};

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore"
  });
  return result.status === 0 || result.status === 1;
}

function detectBackend(): DetectedBackend {
  const candidates: Array<{ executable: string; backend: string; reason: string }> = [
    {
      executable: "cursor",
      backend: "cursor-cli",
      reason: "detected Cursor CLI"
    },
    {
      executable: "claude",
      backend: "claude-code",
      reason: "detected Claude Code CLI"
    },
    {
      executable: "codex",
      backend: "codex-cli",
      reason: "detected Codex CLI"
    }
  ];

  for (const candidate of candidates) {
    if (commandExists(candidate.executable)) {
      const scaffold = SCAFFOLD_BACKENDS[candidate.backend];
      return {
        backend: candidate.backend,
        executable: scaffold.executable,
        args: scaffold.args,
        model: scaffold.model,
        reason: candidate.reason
      };
    }
  }

  return {
    backend: "cursor-cli",
    executable: SCAFFOLD_BACKENDS["cursor-cli"].executable,
    args: SCAFFOLD_BACKENDS["cursor-cli"].args,
    model: SCAFFOLD_BACKENDS["cursor-cli"].model,
    reason: "no known agent CLI detected, using default Cursor setup"
  };
}

export function scaffoldConfig(force = false): number {
  const targetPath = path.join(process.cwd(), "semlint.json");
  if (fs.existsSync(targetPath) && !force) {
    process.stderr.write(
      `Refusing to overwrite existing ${targetPath}. Re-run with "semlint init --force" to replace it.\n`
    );
    return 2;
  }

  const detected = detectBackend();
  const scaffold = {
    backend: detected.backend,
    budgets: {
      timeout_ms: 120000
    },
    output: {
      format: "text"
    },
    execution: {
      batch: false
    },
    rules: {
      disable: [] as string[],
      severity_overrides: {} as Record<string, string>
    },
    backends: {
      [detected.backend]: {
        executable: detected.executable,
        args: detected.args,
        model: detected.model
      }
    }
  };

  fs.writeFileSync(targetPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8");
  process.stdout.write(pc.green(`Created ${targetPath}\n`));
  process.stdout.write(pc.cyan(`Backend setup: ${detected.backend} (${detected.reason})\n`));

  const rulesDir = path.join(process.cwd(), ".semlint", "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
    process.stdout.write(pc.green(`Created ${path.join(".semlint", "rules")}/\n`));
  }

  const exampleRulePath = path.join(rulesDir, "SEMLINT_EXAMPLE_001.json");
  if (!fs.existsSync(exampleRulePath)) {
    const exampleRule = {
      id: "SEMLINT_EXAMPLE_001",
      title: "My first rule",
      severity_default: "warn",
      prompt: "Describe what the agent should check in the changed code. Example: flag when new functions lack JSDoc, or when error handling is missing."
    };
    fs.writeFileSync(exampleRulePath, `${JSON.stringify(exampleRule, null, 2)}\n`, "utf8");
    process.stdout.write(pc.green(`Created ${path.join(".semlint", "rules", "SEMLINT_EXAMPLE_001.json")} `) + pc.dim(`(edit the title and prompt to define your rule)\n`));
  }

  return 0;
}
