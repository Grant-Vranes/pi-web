import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("explorer nodes expose a native contextual mutation menu", () => {
  assert.match(source, /onContextMenu=\{\(event\) => onContextMenu\?\.\(node, event\)\}/);
  assert.match(source, /type: "create-file" \| "create-directory" \| "rename" \| "move" \| "delete"/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /role="menu"/);
});

test("destructive and move controls enforce the agreed safeguards", () => {
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /source\.isDir && isPathWithin\(destinationDirectory, source\.fullPath\)/);
  assert.match(source, /dataTransfer\.setData\("application\/x-pi-web-file-path", node\.fullPath\)/);
  assert.match(source, /onFileMutation\?\.\(\{ kind: "delete", sourcePath: target\.fullPath \}\)/);
});

test("move picker discards stale and out-of-cwd directory listings", () => {
  assert.match(source, /moveDirectoryRequestRef\.current \+= 1/);
  assert.match(source, /requestId !== moveDirectoryRequestRef\.current/);
  assert.match(source, /isPathWithin\(entry\.fullPath, cwd\)/);
  assert.match(source, /setMoveDirectories\(\[\]\)/);
});

test("mutation errors remain available inside active dialogs", () => {
  assert.match(source, /pendingMutation && mutationError && \(\s*<div role="alert"/);
  assert.match(source, /moveSource && mutationError && \(\s*<div role="alert"/);
  assert.doesNotMatch(source, /fetchEntries\([^)]*\)\.then\(/);
});

test("context menu actions are disabled during mutations", () => {
  const menuSection = source.slice(source.indexOf("{contextMenu && ("), source.indexOf("{pendingMutation && ("));
  // The shared create-file/create-directory button plus rename, move, and delete
  // cover all five rendered menu actions.
  assert.equal((menuSection.match(/disabled=\{mutationBusy\}/g) ?? []).length, 4);
});

test("name dialog handles Escape from the form and associates its label", () => {
  const dialogForm = source.slice(source.indexOf("<form onSubmit="), source.indexOf("</form>"));
  assert.match(dialogForm, /onKeyDown=\{\(event\) => \{ if \(event\.key === "Escape"\) setPendingMutation\(null\); \}\}/);
  assert.match(dialogForm, /<label htmlFor="file-mutation-name"/);
  assert.match(dialogForm, /<input id="file-mutation-name"/);
});

test("rejects malformed success responses with empty or whitespace paths", () => {
  const validationBlock = source.slice(
    source.indexOf("if (\n    !data"),
    source.indexOf("return data as MutationResponse;"),
  );
  assert.match(validationBlock, /data\.sourcePath\.trim\(\)\.length === 0/);
  assert.match(validationBlock, /data\.destinationPath\.trim\(\)\.length === 0/);
});
