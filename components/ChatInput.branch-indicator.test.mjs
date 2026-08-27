import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("accepts currentBranch prop and renders a branch indicator next to model", () => {
  assert.match(source, /currentBranch\?: string \| null;/);
  // The bar prefers an interactive WorktreeSwitcher when worktreeState is
  // available, and falls back to a read-only branch label otherwise (e.g. when
  // the cwd is a repo subdirectory). Both paths must still render the branch.
  assert.match(source, /worktreeState && onCwdChange \? \(/);
  assert.match(source, /<WorktreeSwitcher/);
  assert.match(
    source,
    /: currentBranch && \([\s\S]*?<svg width="11" height="11" viewBox="0 0 24 24"[\s\S]*?<span[^>]*>\s*\{currentBranch\}\s*<\/span>[\s\S]*?\)\}/,
  );
});
