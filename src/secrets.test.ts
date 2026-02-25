import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { filterDiffByIgnoreRules, scanDiffForSecrets } from "./secrets";

test("filterDiffByIgnoreRules aggregates ignore files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "semlint-ignore-"));
  try {
    fs.writeFileSync(path.join(cwd, ".cursorignore"), "cursor-only/**\n", "utf8");
    fs.writeFileSync(path.join(cwd, ".semlintignore"), "semlint-only/**\n", "utf8");
    fs.writeFileSync(path.join(cwd, ".cursoringore"), "typo-ignore/**\n", "utf8");

    const diff = [
      "diff --git a/cursor-only/a.ts b/cursor-only/a.ts",
      "--- a/cursor-only/a.ts",
      "+++ b/cursor-only/a.ts",
      "@@ -0,0 +1 @@",
      "+const a = 1;",
      "diff --git a/semlint-only/b.ts b/semlint-only/b.ts",
      "--- a/semlint-only/b.ts",
      "+++ b/semlint-only/b.ts",
      "@@ -0,0 +1 @@",
      "+const b = 1;",
      "diff --git a/typo-ignore/c.ts b/typo-ignore/c.ts",
      "--- a/typo-ignore/c.ts",
      "+++ b/typo-ignore/c.ts",
      "@@ -0,0 +1 @@",
      "+const c = 1;",
      "diff --git a/src/safe.ts b/src/safe.ts",
      "--- a/src/safe.ts",
      "+++ b/src/safe.ts",
      "@@ -0,0 +1 @@",
      "+const safe = 1;"
    ].join("\n");

    const result = filterDiffByIgnoreRules(diff, cwd, [
      ".cursorignore",
      ".semlintignore",
      ".cursoringore"
    ]);

    assert.deepEqual(result.excludedFiles, [
      "cursor-only/a.ts",
      "semlint-only/b.ts",
      "typo-ignore/c.ts"
    ]);
    assert.match(result.filteredDiff, /src\/safe\.ts/);
    assert.doesNotMatch(result.filteredDiff, /cursor-only\/a\.ts/);
    assert.doesNotMatch(result.filteredDiff, /semlint-only\/b\.ts/);
    assert.doesNotMatch(result.filteredDiff, /typo-ignore\/c\.ts/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("scanDiffForSecrets flags keyword matches on added lines", () => {
  const diff = [
    "diff --git a/src/test2.ts b/src/test2.ts",
    "--- a/src/test2.ts",
    "+++ b/src/test2.ts",
    "@@ -0,0 +4 @@",
    '+const payload = { "PASSWORD": "password", "API_KEY": "api-key" };'
  ].join("\n");

  const findings = scanDiffForSecrets(diff, [], []);
  assert.ok(findings.length >= 1);
  assert.equal(findings[0].file, "src/test2.ts");
  assert.equal(findings[0].line, 4);
  assert.match(findings[0].kind, /^keyword:/);
});

test("scanDiffForSecrets skips files listed in allow_files", () => {
  const diff = [
    "diff --git a/src/test2.ts b/src/test2.ts",
    "--- a/src/test2.ts",
    "+++ b/src/test2.ts",
    "@@ -0,0 +1 @@",
    '+const password = "should-not-block-when-allowed";'
  ].join("\n");

  const findings = scanDiffForSecrets(diff, [], ["src/test2.ts"]);
  assert.equal(findings.length, 0);
});
