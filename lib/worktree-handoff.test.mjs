import assert from "node:assert/strict";
import test from "node:test";

const { createJiti } = await import("jiti");
const { decideWorktreeHandoff, snapshotWorktreeTopology } = await createJiti(import.meta.url).import("./worktree-handoff.ts");

const main = { path: "/repo", branch: "main", isMain: true };
const feature = { path: "/repo/.worktrees/feature", branch: "feature", isMain: false };

test("selects the sole worktree added during the same project run", () => {
  const before = snapshotWorktreeTopology({
    projectKey: "/repo",
    currentWorktreePath: "/repo",
    worktrees: [main],
  });

  assert.deepEqual(decideWorktreeHandoff(before, {
    projectKey: "/repo",
    projectRoot: "/repo",
    currentWorktreePath: "/repo",
    worktrees: [main, feature],
  }), { kind: "created", cwd: feature.path });
});

test("does not guess when more than one worktree was added", () => {
  const before = snapshotWorktreeTopology({
    projectKey: "/repo",
    currentWorktreePath: "/repo",
    worktrees: [main],
  });

  assert.equal(decideWorktreeHandoff(before, {
    projectKey: "/repo",
    projectRoot: "/repo",
    currentWorktreePath: "/repo",
    worktrees: [main, feature, { ...feature, path: "/repo/.worktrees/other" }],
  }), null);
});

test("returns the main checkout when the active linked worktree disappeared", () => {
  const before = snapshotWorktreeTopology({
    projectKey: "/repo",
    currentWorktreePath: feature.path,
    worktrees: [main, feature],
  });

  assert.deepEqual(decideWorktreeHandoff(before, {
    projectKey: "/repo",
    projectRoot: "/repo",
    currentWorktreePath: null,
    worktrees: [main],
  }), { kind: "removed", cwd: "/repo" });
});

test("ignores unchanged and cross-project topology", () => {
  const before = snapshotWorktreeTopology({
    projectKey: "/repo",
    currentWorktreePath: "/repo",
    worktrees: [main],
  });

  assert.equal(decideWorktreeHandoff(before, {
    projectKey: "/repo",
    projectRoot: "/repo",
    currentWorktreePath: "/repo",
    worktrees: [main],
  }), null);
  assert.equal(decideWorktreeHandoff(before, {
    projectKey: "/other",
    projectRoot: "/other",
    currentWorktreePath: "/other",
    worktrees: [{ ...main, path: "/other" }],
  }), null);
});
