import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("fetches current branch for active cwd and passes it to ChatInput", () => {
  assert.match(source, /fetch\(`\/api\/worktrees\?cwd=\$\{encodeURIComponent\(activeCwd\)\}`/);
  assert.match(source, /setCurrentBranch\(d\.currentBranch \?\? null\)/);
  assert.match(source, /<ChatInput[\s\S]*?currentBranch=\{currentBranch\}/);
});

test("refreshes branch on visibility, focus, online, and visible polling", () => {
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibility\)/);
  assert.match(source, /window\.addEventListener\("focus", handleWindowRefresh\)/);
  assert.match(source, /window\.addEventListener\("online", handleWindowRefresh\)/);
  assert.match(source, /if \(document\.visibilityState !== "visible"\) return;[\s\S]*?setInterval\(/);
});
