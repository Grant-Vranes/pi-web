import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { buildFileBrowserCommand } = await jiti.import("./file-browser-commands.ts");

test("darwin reveals files with `open -R` and opens directories in place", () => {
  assert.deepEqual(buildFileBrowserCommand("darwin", "/tmp/a.txt", false), {
    command: "open",
    args: ["-R", "/tmp/a.txt"],
  });
  assert.deepEqual(buildFileBrowserCommand("darwin", "/tmp/dir", true), {
    command: "open",
    args: ["/tmp/dir"],
  });
});

test("win32 uses `explorer /select,<file>` with no space after the comma", () => {
  assert.deepEqual(buildFileBrowserCommand("win32", "C:\\tmp\\a.txt", false), {
    command: "explorer",
    args: ["/select,C:\\tmp\\a.txt"],
  });
  assert.deepEqual(buildFileBrowserCommand("win32", "C:\\tmp\\dir", true), {
    command: "explorer",
    args: ["C:\\tmp\\dir"],
  });
});

test("linux xdg-opens the directory itself, or the parent directory for files", () => {
  assert.deepEqual(buildFileBrowserCommand("linux", "/tmp/dir", true), {
    command: "xdg-open",
    args: ["/tmp/dir"],
  });
  assert.deepEqual(buildFileBrowserCommand("linux", "/tmp/dir/a.txt", false), {
    command: "xdg-open",
    args: ["/tmp/dir"],
  });
});
