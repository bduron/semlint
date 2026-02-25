import assert from "node:assert/strict";
import test from "node:test";
import { selectLocalBranchDiffChunks } from "./git";

test("selectLocalBranchDiffChunks includes only selected change kinds", () => {
  const combined = selectLocalBranchDiffChunks(
    {
      stagedDiff: "STAGED_DIFF",
      unstagedDiff: "UNSTAGED_DIFF",
      untrackedDiffs: ["UNTRACKED_ONE", "", "UNTRACKED_TWO"]
    },
    ["staged", "untracked"]
  );

  assert.equal(combined, ["STAGED_DIFF", "UNTRACKED_ONE", "UNTRACKED_TWO"].join("\n"));
});

test("selectLocalBranchDiffChunks returns empty string for empty selection", () => {
  const combined = selectLocalBranchDiffChunks(
    {
      stagedDiff: "STAGED_DIFF",
      unstagedDiff: "UNSTAGED_DIFF",
      untrackedDiffs: ["UNTRACKED_ONE"]
    },
    []
  );

  assert.equal(combined, "");
});
