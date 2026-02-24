#!/usr/bin/env node
import { runSemlint } from "./main";
import { CliOptions, FailOn, OutputFormat } from "./types";

const FLAGS_WITH_VALUES = new Set([
  "--backend",
  "--model",
  "--config",
  "--format",
  "--base",
  "--head",
  "--fail-on"
]);

function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json";
}

function isFailOn(value: string): value is FailOn {
  return value === "error" || value === "warn" || value === "never";
}

function parseArgs(argv: string[]): CliOptions {
  const [command, ...rest] = argv;

  if (!command || command !== "check") {
    throw new Error("Usage: semlint check [--backend <name>] [--model <name>] [--config <path>] [--format <text|json>] [--base <ref>] [--head <ref>] [--fail-on <error|warn|never>] [--debug]");
  }

  const options: CliOptions = {
    command: "check",
    debug: false
  };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--debug") {
      options.debug = true;
      continue;
    }

    if (!FLAGS_WITH_VALUES.has(token)) {
      throw new Error(`Unknown flag: ${token}`);
    }

    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for flag: ${token}`);
    }
    i += 1;

    switch (token) {
      case "--backend":
        options.backend = value;
        break;
      case "--model":
        options.model = value;
        break;
      case "--config":
        options.configPath = value;
        break;
      case "--format":
        if (!isOutputFormat(value)) {
          throw new Error(`Invalid --format value: ${value}`);
        }
        options.format = value;
        break;
      case "--base":
        options.base = value;
        break;
      case "--head":
        options.head = value;
        break;
      case "--fail-on":
        if (!isFailOn(value)) {
          throw new Error(`Invalid --fail-on value: ${value}`);
        }
        options.failOn = value;
        break;
      default:
        throw new Error(`Unsupported flag: ${token}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const exitCode = await runSemlint(options);
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}

void main();
