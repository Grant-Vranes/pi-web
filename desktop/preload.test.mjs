import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");

test("exposes only Electron webUtils file-path lookup to the page", () => {
  assert.match(source, /const \{ contextBridge, ipcRenderer, webUtils \} = require\("electron"\)/);
  assert.match(source, /contextBridge\.exposeInMainWorld\("piDesktop", \{\s*getPathForFile\(file\) \{\s*return webUtils\.getPathForFile\(file\);\s*},\s*}\)/);
});
