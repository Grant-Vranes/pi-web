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

test("search bar drives both read and edit modes", () => {
  assert.match(textViewer, /findMatches\(searchText, searchQuery, searchCaseSensitive\)/);
  assert.match(textViewer, /editor\.setSelectionRange\(match\.start, match\.end\)/);
  assert.match(textViewer, /file-source-line\[data-line-number="\$\{match\.line\}"\]/);
});

test("replace actions rewrite the draft", () => {
  assert.match(textViewer, /replaceOne\(editorText, match, replacement\)/);
  assert.match(textViewer, /replaceAll\(editorText, searchMatches, replacement\)/);
});

test("Cmd/Ctrl+F opens search without hijacking other inputs", () => {
  assert.match(textViewer, /event\.key\.toLowerCase\(\) !== "f"/);
  assert.match(textViewer, /closest\("input, textarea, \[contenteditable='true'\]"\)/);
});

test("search styles exist", () => {
  assert.match(cssSource, /\.file-search-input \{/);
  assert.match(cssSource, /\.file-source-search-hit \{/);
  assert.match(cssSource, /\.file-source-search-hit-active \{/);
});
