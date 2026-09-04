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

test("command construction is delegated to the shared platform builder", () => {
  assert.match(source, /const \{ command, args \} = buildFileBrowserCommand\(process\.platform, nativePath, isDirectory\)/);
});

test("lexical authorization precedes existence probing, which precedes the realpath check and the helper invocation", () => {
  const postStart = source.indexOf("export async function POST");
  const postSource = source.slice(postStart);
  const lexical = postSource.indexOf("isFilePathAllowed(targetPath, allowedRoots)");
  const exists = postSource.indexOf("existsSync(targetPath)");
  const realpath = postSource.indexOf("isExistingFilePathAllowed(targetPath, allowedRoots)");
  const openInFileBrowserCall = postSource.indexOf("const result = await openInFileBrowser(targetPath, isDirectory);");
  assert.ok(lexical !== -1, "lexical allowed-roots check must exist");
  assert.ok(exists !== -1, "existsSync must exist");
  assert.ok(realpath !== -1, "realpath containment check must exist");
  assert.ok(openInFileBrowserCall !== -1, "openInFileBrowser helper call must exist");
  assert.ok(lexical < exists, "lexical allowed-roots check must precede existsSync");
  assert.ok(exists < realpath, "existsSync must precede the realpath check");
  assert.ok(realpath < openInFileBrowserCall, "no helper call may happen before all authorization passes");
});

test("spawn is detached, ignores stdio, and unrefs the child", () => {
  assert.match(source, /spawn\(command, args, \{ detached: true, stdio: "ignore" \}\)/);
  assert.match(source, /child\.unref\(\)/);
});
