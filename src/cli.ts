#!/usr/bin/env node
import pc from "picocolors";
import { scaffoldConfig } from "./init";
import { runSemlint } from "./main";
import { CliOptions, FailOn, OutputFormat } from "./types";

const HELP_TEXT = [
  "Usage:",
  "  semlint check [--backend <name>] [--model <name>] [--config <path>] [--format <text|json>] [--base <ref>] [--head <ref>] [--fail-on <error|warn|never>] [--batch] [--debug]",
  "  semlint init [--force]",
  "  semlint --help",
  "",
  "Commands:",
  "  check   Run semantic lint rules against your git diff",
  "  init    Create semlint.json, .semlint/rules/, and an example rule to edit",
  "",
  "Options:",
  "  -h, --help   Show this help text"
].join("\n");

class HelpRequestedError extends Error {
  constructor() {
    super(HELP_TEXT);
  }
}

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
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    throw new HelpRequestedError();
  }

  const [command, ...rest] = argv;

  if (!command || (command !== "check" && command !== "init")) {
    throw new Error(HELP_TEXT);
  }

  if (command === "init") {
    const options: CliOptions = {
      command: "init",
      debug: false
    };
    for (const token of rest) {
      if (token === "--force") {
        options.force = true;
        continue;
      }
      throw new Error(`Unknown flag for init: ${token}`);
    }
    return options;
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
    if (token === "--batch") {
      options.batch = true;
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
    const exitCode =
      options.command === "init" ? scaffoldConfig(options.force) : await runSemlint(options);
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HelpRequestedError) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 0;
    } else {
      process.stderr.write(pc.red(`Error: ${message}\n`));
      process.exitCode = 2;
    }
  }
}

void main();
