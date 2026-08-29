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
