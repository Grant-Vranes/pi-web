import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("explorer nodes expose a native contextual mutation menu", () => {
  assert.match(source, /onContextMenu=\{\(event\) => onContextMenu\?\.\(node, event\)\}/);
  assert.match(source, /type: "create-file" \| "create-directory" \| "rename" \| "move" \| "copy" \| "delete"/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /role="menu"/);
});

test("destructive and drag-move controls enforce the agreed safeguards", () => {
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /dataTransfer\.setData\("application\/x-pi-web-file-path", node\.fullPath\)/);
  assert.match(source, /onFileMutation\?\.\(\{ kind: "delete", sourcePath: target\.fullPath \}\)/);
  // Drag-move rejects dropping a folder onto itself or a descendant.
  assert.match(source, /sameFilePath\(target\.fullPath, sourcePath\) \|\| \(sourceIsDir && isPathWithin\(target\.fullPath, sourcePath\)\)/);
});

test("the contextual menu no longer offers a move-to picker", () => {
  assert.doesNotMatch(source, /openMovePicker/);
  assert.doesNotMatch(source, /files\.moveTo/);
  assert.doesNotMatch(source, /files\.selectDestination/);
});

test("mutation errors remain available inside the active name dialog", () => {
  assert.match(source, /pendingMutation && mutationError && \(\s*<div role="alert"/);
  assert.doesNotMatch(source, /fetchEntries\([^)]*\)\.then\(/);
});

test("context menu actions are disabled during mutations", () => {
  const menuSection = source.slice(source.indexOf("{contextMenu && ("), source.indexOf("{pendingMutation && ("));
  // Create-file/create-directory (2), copy, cut, rename and delete use the
  // shared busy guard; paste adds its own clipboard-null guard.
  assert.equal((menuSection.match(/disabled=\{mutationBusy\}/g) ?? []).length, 6);
});

test("clipboard holds a single entry set from the context menu", () => {
  assert.match(source, /useState<\{ path: string; mode: "copy" \| "cut" \} \| null>\(null\)/);
  assert.match(source, /setLastContextEntry\(\{ path: target\.fullPath, isDir: target\.isDir \}\)/);
  assert.match(source, /setClipboard\(\{ path: contextMenu\.target\.fullPath, mode: "copy" \}\)/);
  assert.match(source, /setClipboard\(\{ path: contextMenu\.target\.fullPath, mode: "cut" \}\)/);
});

test("entries held as cut render dimmed", () => {
  assert.match(source, /const isCut = cutPath !== null && cutPath !== undefined && sameFilePath\(cutPath, node\.fullPath\)/);
  assert.match(source, /opacity: isCut \? 0\.5 : 1/);
  assert.match(source, /cutPath=\{cutPath\}/);
});

test("copy and cut menu labels exist in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"files\.copy":/);
    assert.match(messages, /"files\.cut":/);
  }
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
