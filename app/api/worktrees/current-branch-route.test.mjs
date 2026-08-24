import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("GET /api/worktrees returns currentBranch from resolved project", () => {
  assert.match(source, /const project = await resolveProject\(cwd\);/);
  assert.match(source, /currentBranch:\s*project\.branch\s*\?\?\s*null/);
});
