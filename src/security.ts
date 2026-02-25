import pc from "picocolors";

const SECURITY_TEXT = [
  pc.bold("Semlint security guide"),
  "",
  "Semlint applies security controls before backend execution:",
  "- It filters diff paths using ignore files and built-in sensitive globs.",
  "- It scans added lines for high-signal secret patterns.",
  "- It blocks backend execution when potential secrets are found.",
  "",
  "Your responsibilities:",
  "- Keep `.gitignore`, `.cursorignore`, `.semlintignore` (and configured `security.ignore_files`) up to date.",
  "- Tune `security.allow_patterns` and `security.allow_files` only for known-safe cases.",
  "- Review your agent native access and security policy.",
  "",
  "More details: README.md#security-responsibility-model"
].join("\n");

export function printSecurityGuide(): number {
  process.stdout.write(`${SECURITY_TEXT}\n`);
  return 0;
}
