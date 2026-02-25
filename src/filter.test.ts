import assert from "node:assert/strict";
import test from "node:test";
import { filterDiffByPathGlobs, getRuleCandidateFiles } from "./filter";
import { LoadedRule } from "./types";

function makeRule(overrides: Partial<LoadedRule> = {}): LoadedRule {
  return {
    id: "SEMLINT_TEST_001",
    title: "Test rule",
    severity_default: "warn",
    prompt: "Test",
    sourcePath: "/tmp/SEMLINT_TEST_001.json",
    effectiveSeverity: "warn",
    ...overrides
  };
}

test("getRuleCandidateFiles inherits global include/exclude globs", () => {
  const changedFiles = ["src/a.ts", "src/a.test.ts", "docs/readme.md"];
  const rule = makeRule();

  const candidates = getRuleCandidateFiles(
    rule,
    changedFiles,
    ["src/**/*.ts"],
    ["**/*.test.ts", "**/*.spec.ts"]
  );

  assert.deepEqual(candidates, ["src/a.ts"]);
});

test("getRuleCandidateFiles lets empty rule globs disable global filters", () => {
  const changedFiles = ["src/a.ts", "src/a.test.ts", "docs/readme.md"];
  const rule = makeRule({
    include_globs: [],
    exclude_globs: []
  });

  const candidates = getRuleCandidateFiles(
    rule,
    changedFiles,
    ["src/**/*.ts"],
    ["**/*.test.ts", "**/*.spec.ts"]
  );

  assert.deepEqual(candidates, changedFiles);
});

test("getRuleCandidateFiles uses explicit rule globs instead of globals", () => {
  const changedFiles = ["src/a.ts", "docs/readme.md"];
  const rule = makeRule({
    include_globs: ["docs/**/*.md"]
  });

  const candidates = getRuleCandidateFiles(rule, changedFiles, ["src/**/*.ts"], []);

  assert.deepEqual(candidates, ["docs/readme.md"]);
});

test("filterDiffByPathGlobs applies include and exclude globs", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1 @@",
    "+const a = 1;",
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -0,0 +1 @@",
    "+const test = 1;",
    "diff --git a/docs/readme.md b/docs/readme.md",
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -0,0 +1 @@",
    "+# docs"
  ].join("\n");

  const result = filterDiffByPathGlobs(diff, ["src/**/*.ts"], ["**/*.test.ts"]);

  assert.match(result.filteredDiff, /src\/a\.ts/);
  assert.doesNotMatch(result.filteredDiff, /src\/a\.test\.ts/);
  assert.doesNotMatch(result.filteredDiff, /docs\/readme\.md/);
  assert.deepEqual(result.excludedFiles, ["docs/readme.md", "src/a.test.ts"]);
});

test("filterDiffByPathGlobs keeps all files when include/exclude are empty", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +1 @@",
    "+const a = 1;",
    "diff --git a/docs/readme.md b/docs/readme.md",
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -0,0 +1 @@",
    "+# docs"
  ].join("\n");

  const result = filterDiffByPathGlobs(diff, [], []);

  assert.match(result.filteredDiff, /src\/a\.ts/);
  assert.match(result.filteredDiff, /docs\/readme\.md/);
  assert.deepEqual(result.excludedFiles, []);
});
