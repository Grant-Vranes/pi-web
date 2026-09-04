import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("reveal requests are guarded like /api/files and /api/terminal/open", () => {
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(source, /isFilePathAllowed\(targetPath, allowedRoots\)/);
  assert.match(source, /isExistingFilePathAllowed\(targetPath, allowedRoots\)/);
  assert.match(source, /existsSync\(targetPath\)/);
});

test("file vs directory behaviour is implemented per platform", () => {
  // macOS: reveal files with `open -R`, open directories with `open`.
  assert.match(source, /command = "open";\s*\n\s*args = isDirectory \? \[nativePath\] : \["-R", nativePath\];/);
  // Windows: explorer /select,<file> — no space after the comma.
  assert.match(source, /command = "explorer";/);
  assert.match(source, /`\/select,\$\{nativePath\}`/);
  // Linux: xdg-open (directory itself, or the parent for files).
  assert.match(source, /command = "xdg-open";/);
  assert.match(source, /dirname\(nativePath\)/);
});

test("spawn is detached, ignores stdio, and unrefs the child", () => {
  assert.match(source, /spawn\(command, args, \{ detached: true, stdio: "ignore" \}\)/);
  assert.match(source, /child\.unref\(\)/);
});
