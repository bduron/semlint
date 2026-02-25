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
    security: {
      secret_guard: true,
      allow_patterns: [] as string[],
      ignore_files: [".gitignore", ".cursorignore", ".semlintignore"]
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

  const bundledRulesDir = path.resolve(__dirname, "..", ".semlint", "rules");
  if (!fs.existsSync(bundledRulesDir) || !fs.statSync(bundledRulesDir).isDirectory()) {
    process.stderr.write(
      pc.yellow(
        `No bundled rules found at ${bundledRulesDir}. Add rule files manually under ${path.join(".semlint", "rules")}.\n`
      )
    );
    return 0;
  }

  const bundledRules = fs
    .readdirSync(bundledRulesDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of bundledRules) {
    const source = path.join(bundledRulesDir, fileName);
    const target = path.join(rulesDir, fileName);
    if (!force && fs.existsSync(target)) {
      continue;
    }
    fs.copyFileSync(source, target);
    process.stdout.write(pc.green(`Copied ${path.join(".semlint", "rules", fileName)}\n`));
  }

  return 0;
}
