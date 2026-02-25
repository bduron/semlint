import assert from "node:assert/strict";
import test from "node:test";
import { getRuleCandidateFiles } from "./filter";
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
