# Semlint CLI MVP

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
  "model": "auto",
  "budgets": {
    "timeout_ms": 120000
  },
  "output": {
    "format": "text"
  },
  "execution": {
    "batch": false
  },
  "rules": {
    "disable": ["SEMLINT_EXAMPLE_001"],
    "severity_overrides": {
      "SEMLINT_API_001": "error"
    }
  },
  "backends": {
    "cursor-cli": {
      "executable": "agent"
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

Use `semlint init --force` to overwrite an existing config file. Init also creates `.semlint/rules/` and a starter rule `SEMLINT_EXAMPLE_001.json` (with a placeholder title and prompt) if they do not exist.

## Rule files

Rule JSON files are loaded from `.semlint/rules/`. Run `semlint init` to create this folder and an example rule you can edit.

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

For backend `cursor-cli`, Semlint executes:

```bash
cursor agent "<prompt>" --model <model> --print --output-format text
```

For `cursor-cli`, Semlint always uses `cursor agent` directly.
Other backend names still resolve executables from config:

- `backends.<backend>.executable` if provided

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
