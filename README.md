# Semlint CLI MVP

Semlint is a deterministic semantic lint CLI that:

- reads a git diff,
- runs enabled semantic rules sequentially,
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

If running from source:

```bash
pnpm check
```

## CLI flags

- `--backend <name>`: override backend name
- `--model <name>`: override model name
- `--config <path>`: config file path
- `--format <text|json>`: output format
- `--base <ref>`: base git ref (default `origin/main`)
- `--head <ref>`: head git ref (default `HEAD`)
- `--fail-on <error|warn|never>`: failure threshold (default `error`)
- `--debug`: enable debug logs to stderr

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

## Rule files

Rule JSON files are loaded from `rules/`.

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
<executable> "<prompt>" --model <model> --print --output-format text
```

Where `<executable>` resolves from config:

- `backends.cursor-cli.executable` if provided
- otherwise default `agent`

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
