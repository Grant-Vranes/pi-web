import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

const textViewer = functionBlock("TextFileViewer", null);

test("TextFileViewer saves drafts through the write endpoint with conflict base", () => {
  assert.match(textViewer, /getFileApiUrl\(filePath, "write", sourceSessionId\)/);
  assert.match(textViewer, /baseMtimeMs: options\.force \? null : viewerStateRef\.current\.baseMtimeMs/);
  assert.match(textViewer, /response\.status === 409/);
});

test("TextFileViewer keeps edits safe from live reload and navigation", () => {
  assert.match(textViewer, /if \(dirtyRef\.current\) return;/);
  assert.match(textViewer, /addEventListener\("beforeunload"/);
  assert.match(textViewer, /draft: initialDraft/);
  assert.match(textViewer, /baseMtimeMs: initialBaseMtimeMs/);
});

test("TextFileViewer exposes overwrite failures after a stale conflict banner", () => {
  assert.match(textViewer, /if \(!response\.ok\) \{[\s\S]*?setSaveConflict\(false\);[\s\S]*?setSaveError\(payload\?\.error \?\? t\("i18n\.saveFailed"\)\);[\s\S]*?return;/);
  assert.match(textViewer, /catch \(error\) \{\s*setSaveConflict\(false\);\s*setSaveError\(String\(error\)\);\s*\}/);
});

test("TextFileViewer renders edit controls, dirty dot, and conflict banner", () => {
  assert.match(textViewer, /onClick=\{enterEditMode\}/);
  assert.match(textViewer, /onClick=\{exitEditMode\}/);
  assert.match(textViewer, /className="file-viewer-dirty-dot"/);
  assert.match(textViewer, /file-viewer-conflict-banner/);
  assert.match(textViewer, /reloadFromDisk/);
  assert.match(textViewer, /saveDraft\(\{ force: true \}\)/);
  assert.match(textViewer, /event\.key\.toLowerCase\(\) === "s"/);
});

test("edit styles exist", () => {
  assert.match(cssSource, /\.file-viewer-dirty-dot \{/);
  assert.match(cssSource, /\.file-viewer-conflict-banner \{/);
});
