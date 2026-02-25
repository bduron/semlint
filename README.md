# Semlint CLI MVP

## Motivation

Upstream instruction files (`AGENTS.md`, `CURSOR.md`, etc.) are the standard way to guide coding agents — but a [recent study (Gloaguen et al., 2026)](https://arxiv.org/abs/2602.11988) found that such context files tend to *reduce* task success rates compared to providing no context at all, while increasing inference cost by over 20%. The root cause: agents respect the instructions, but unnecessary or over-specified requirements make tasks harder, with no feedback mechanism to catch when rules are ignored or misapplied.

Semlint takes a different approach. Instead of providing guidance upfront and hoping for the best, rules are enforced *after the fact* as a lint pass on the diff — giving agents a deterministic red/green signal and closing the feedback loop.

---

Semlint is a deterministic semantic lint CLI that:

- reads a git diff,
- runs enabled semantic rules in parallel,
- executes an external backend command per rule,
- prints text or JSON diagnostics,
- returns CI-friendly exit codes.

## Install

```bash
pnpm install
pnpm build
```

## Command

```bash
semlint check
```

Scaffold a project config with automatic coding agent CLI detection:

```bash
semlint init
```

If running from source:

```bash
pnpm check
```

## CLI flags

- `--backend <name>`: override backend name
- `--model <name>`: override model name
- `--config <path>`: config file path
- `--format <text|json>`: output format
- `--base <ref>`: base git ref for explicit ref-to-ref diff
- `--head <ref>`: head git ref for explicit ref-to-ref diff
- `--fail-on <error|warn|never>`: failure threshold (default `error`)
- `--batch`: run all selected rules in one backend call
- `--debug`: enable debug logs to stderr
- `init --force`: overwrite an existing `semlint.json`

Default diff behavior (without `--base`/`--head`) uses your local branch state:

- tracked changes across commits since merge-base,
- staged changes,
- unstaged changes,
- untracked files.

If you pass `--base` or `--head`, Semlint uses explicit `git diff <base> <head>` mode.

## Exit codes

- `0`: no blocking diagnostics
- `1`: blocking diagnostics found
- `2`: backend/runtime failure

## Config discovery order

1. `--config <path>`
2. `./semlint.json`
3. `./.semlint.json`
4. defaults

Unknown fields are ignored.

## Minimal config example

```json
{
  "backend": "cursor-cli",
  "budgets": {
    "timeout_ms": 120000
  },
  "output": {
    "format": "text"
  },
  "execution": {
    "batch": false
  },
  "security": {
    "secret_guard": true,
    "allow_patterns": [],
    "allow_files": [],
    "ignore_files": [".gitignore", ".cursorignore", ".semlintignore", ".cursoringore"]
  },
  "rules": {
    "disable": [],
    "severity_overrides": {
      "SEMLINT_API_001": "error"
    }
  },
  "backends": {
    "cursor-cli": {
      "executable": "cursor",
      "model": "auto",
      "args": ["agent", "{prompt}", "--model", "{model}", "--print", "--mode", "ask", "--output-format", "text"]
    }
  }
}
```

## Config scaffolding and auto-detection

Run:

```bash
semlint init
```

This creates `./semlint.json` and auto-detects installed coding agent CLIs in this priority order:

1. `cursor` -> backend `cursor-cli`
2. `claude` -> backend `claude-code`
3. `codex` -> backend `codex-cli`

If no known CLI is detected, Semlint falls back to `cursor-cli` + executable `cursor`.

Use `semlint init --force` to overwrite an existing config file. Init also creates `.semlint/rules/` and copies the bundled Semlint rule files into it.

## Rule files

Rule JSON files are loaded from `.semlint/rules/`. Run `semlint init` to create this folder and copy bundled rules into it.

Required fields:

- `id` (string, unique)
- `title` (string)
- `severity_default` (`error|warn|info`)
- `prompt` (non-empty string)

Optional fields:

- `include_globs`: string[]
- `exclude_globs`: string[]
- `diff_regex`: string[]

Invalid rules cause runtime failure with exit code `2`.

## Backend contract

Semlint is fully config-driven at runtime. For the selected `backend`, it executes:

- `backends.<backend>.executable` as the binary
- `backends.<backend>.model` as the backend-specific model (unless `--model` is passed)
- `backends.<backend>.args` as the argument template

`args` supports placeholder tokens:

- `{prompt}`: replaced with the generated prompt
- `{model}`: replaced with the configured model

Placeholders are exact-match substitutions on whole args. Backends must be fully configured in `semlint.json`; there are no runtime fallbacks.

Example:

```json
{
  "backends": {
    "cursor-cli": {
      "executable": "cursor",
      "model": "auto",
      "args": ["agent", "{prompt}", "--model", "{model}", "--print", "--mode", "ask", "--output-format", "text"]
    }
  }
}
```

Backend stdout must be valid JSON with shape:

```json
{
  "diagnostics": [
    {
      "rule_id": "SEMLINT_API_001",
      "severity": "warn",
      "message": "text",
      "file": "src/file.ts",
      "line": 42
    }
  ]
}
```

If parsing fails, Semlint retries once with appended instruction:
`Return valid JSON only.`

If backend execution still fails and Semlint is running in an interactive terminal (TTY), it automatically performs one interactive passthrough run so you can satisfy backend setup prompts (for example auth/workspace trust), then retries machine parsing once.

## Secret guard

Semlint uses a fail-closed secret guard before any backend call:

- Filters diff chunks using path ignore rules from `.gitignore`, `.cursorignore`, `.semlintignore`
- Applies additional built-in sensitive path deny patterns (`.env*`, key files, secrets/credentials folders)
- Scans added diff lines for high-signal secret keywords and token prefixes (password/token/api key/private key/JWT/provider key prefixes)
- If any potential secrets are found, Semlint exits with code `2` and sends nothing to the backend

Config:

```json
{
  "security": {
    "secret_guard": true,
    "allow_patterns": [],
    "allow_files": [],
    "ignore_files": [".gitignore", ".cursorignore", ".semlintignore", ".cursoringore"]
  }
}
```

- `secret_guard`: enable/disable secret blocking (default `true`)
- `allow_patterns`: regex list to suppress known-safe fixtures from triggering the guard
- `allow_files`: file glob allowlist to skip secret scanning for known-safe files (example: `["src/test-fixtures/**"]`)
- `ignore_files`: ignore files Semlint reads for path-level filtering (default: `.gitignore`, `.cursorignore`, `.semlintignore`, `.cursoringore`)

## Prompt files

Core system prompts are externalized under `prompts/` so prompt behavior is easy to inspect and iterate:

- `prompts/common-contract.md`: shared output schema and base rules used by both modes
- `prompts/rule.md`: single-rule evaluation prompt
- `prompts/batch.md`: batch evaluation prompt
- `prompts/retry-json.md`: strict JSON retry instruction

## Batch mode

Use batch mode to reduce cost by evaluating all runnable rules in a single backend call:

```bash
semlint check --batch
```

Or configure it in `semlint.json`:

```json
{
  "execution": {
    "batch": true
  }
}
```
