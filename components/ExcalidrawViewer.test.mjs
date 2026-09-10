import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ExcalidrawViewer.tsx", import.meta.url), "utf8");
const fileViewerSource = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("loads the Excalidraw canvas lazily, client-only", () => {
  assert.match(source, /dynamic\(\s*\(\)\s*=>\s*[\s\S]*?import\("@excalidraw\/excalidraw"\)/s);
  assert.match(source, /\{\s*ssr:\s*false/);
});

test("renders view-only canvas in view mode", () => {
  assert.match(source, /viewModeEnabled=\{mode === "view"\}/);
});

test("persists only scene fields and preserves unknown top-level keys", () => {
  assert.match(source, /\.\.\.original/);
  assert.match(source, /SAVED_APP_STATE_KEYS\s*=\s*\[["'`]?viewBackgroundColor/);
  assert.doesNotMatch(source, /type:\s*"excalidraw"/);
  assert.doesNotMatch(source, /version:\s*typeof original\.version/);
  assert.match(
    source,
    /const merged:[\s\S]*?= \{[\s\S]*?\.\.\.original,[\s\S]*?elements:[\s\S]*?appState:[\s\S]*?files:[\s\S]*?\};/,
  );
});

test("clears stale scene on load failures and hides the canvas while an error is shown", () => {
  assert.match(source, /if \(d\.error\) \{[\s\S]*?setScene\(null\);[\s\S]*?setError\(d\.error\);/);
  assert.match(source, /catch \(parseError\) \{[\s\S]*?setScene\(null\);/);
  assert.match(source, /\.catch\(\(e\) => \{[\s\S]*?setScene\(null\);[\s\S]*?setError\(String\(e\)\);/);
  assert.match(source, /\{scene && !error && !saveConflict && \(/);
});

test("save sends baseMtimeMs and handles 409 conflicts", () => {
  assert.match(source, /baseMtimeMs:\s*options\.force\s*\?\s*null\s*:\s*baseMtimeMsRef\.current/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /setSaveConflict\(true\)/);
});

test("asks before discarding unsaved edits on exit", () => {
  assert.match(source, /window\.confirm\(t\("i18n\.confirmDiscard"\)\)/);
});

test("external file changes reload the scene only outside edit mode", () => {
  assert.match(source, /modeRef\.current === "view"[\s\S]*?loadScene\(\)/);
});

test("offers a text-viewer fallback when the scene cannot be parsed", () => {
  assert.match(source, /onFallbackToText\(\)/);
});

test("FileViewer dispatches .excalidraw files to ExcalidrawViewer before the text viewer", () => {
  assert.match(fileViewerSource, /isExcalidrawPath\(filePath\)/);
  assert.match(fileViewerSource, /<ExcalidrawViewer/);
  assert.match(fileViewerSource, /onFallbackToText=\{\(\) => setTextFallback\(true\)\}/);
});
