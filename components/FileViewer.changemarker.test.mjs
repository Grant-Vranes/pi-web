import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { diffLinesBetween } from "../lib/diff-lines.ts";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

// The optional TS import above is only for documentation; re-derive the tested
// pure functions from the source file's own helpers is not possible (they are
// module-scope), so the system-level assertions focus on the wiring.

test("editorExtensions wires a change-marker gutter left of the line numbers", () => {
  // The change gutter must be declared before lineNumbers so it appears to the
  // far left (VS Code style), and must read from the debounced marker state.
  const gutterIndex = source.indexOf("gutter({");
  const lineNumbersIndex = source.indexOf("lineNumbers()");
  assert.ok(gutterIndex !== -1 && lineNumbersIndex !== -1, "gutter and lineNumbers extensions must exist");
  assert.ok(gutterIndex < lineNumbersIndex, "change gutter must precede lineNumbers");
  assert.match(source, /markers: \(\) => changeMarkerSet \?\? /);
  assert.match(source, /initialSpacer: \(\) => new ChangeSpacer\(\)/);
  assert.match(source, /renderEmptyElements: true/);
  assert.match(source, /class: "cm-change-gutter"/);
});

test("editing baseline is snapshotted when entering edit mode, not read from live data", () => {
  assert.match(source, /editorBaselineRef = useRef<string>\(""\)/);
  // The snapshot must happen in enterEditMode before/at setting the draft, and
  // must NOT read from `data.content` later (watcher can refresh it).
  const enter = source.slice(source.indexOf("const enterEditMode = useCallback"), source.indexOf("const exitEditMode = useCallback"));
  assert.match(enter, /editorBaselineRef\.current = data\.content/);
  assert.match(enter, /setEditorText\(data\.content\)/);
  // Data.content must not be the diff input after the snapshot — the debounced
  // effect compares baseline (ref) to editorText (state).
  assert.match(source, /diffLinesBetween\(editorBaselineRef\.current, editorText\)/);
});

test("change markers are debounced so the diff does not run on every keystroke", () => {
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /setChangeMarkerSet\(/);
  assert.match(source, /150\)/);
  assert.match(source, /clearTimeout\(handle\)/);
  // Clearing (back to null) when leaving edit mode.
  assert.match(source, /if \(editorText === null\) \{\s*setChangeMarkerSet\(null\);/);
});

test("a matching RangeSet<GutterMarker> dependency keeps reconfiguration in sync", () => {
  assert.match(source, /}, \[changeMarkerSet, clampedActiveIndex, isDark, isEditing, language, searchMatches, searchOpen\]\);/);
  assert.match(source, /buildChangeMarkers\(changed, editorText\)/);
});

test("marker DOM and bar classes exist for added vs modified lines", () => {
  assert.match(source, /class ChangeMark extends GutterMarker/);
  assert.match(source, /el\.className = this\.kind === "added" \? "cm-change-add-bar" : "cm-change-mod-bar"/);
  assert.match(source, /backgroundColor: "#4ade80"/); // added = green
  assert.match(source, /backgroundColor: "#f59e0b"/); // modified = amber
});

test("pure diff: added lines produce added markers, edited lines produce modified", () => {
  const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  const current = "const a = 1;\nconst b = 22;\nconst c = 3;\nconst d = 4;\n";
  const { changed } = diffLinesBetween(original, current);
  assert.equal(changed.get(1), "modified");
  assert.equal(changed.get(3), "added");
  assert.ok(!changed.has(0) && !changed.has(2));
  assert.ok([...changed.values()].every((k) => k === "added" || k === "modified"));
});

test("pure diff: no changes means an empty marker map", () => {
  const text = "one\ntwo\nthree\n";
  const { changed } = diffLinesBetween(text, text);
  assert.equal(changed.size, 0);
});