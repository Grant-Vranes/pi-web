import assert from "node:assert/strict";
import test from "node:test";
import { collectDroppedUploadEntries } from "./drop-collect.ts";

// Minimal fake of FileSystemEntry / FileSystemDirectoryEntry / FileSystemFileEntry
// and DataTransferItem, just enough to drive the reader. These mirror the
// real File and Directory Entries API, which is callback-based (not Promise-
// based): file(success, error?) and readEntries(success, error?).
function fakeFileEntry(name, contents = "x") {
  const file = { name, size: contents.length, type: "", arrayBuffer: () => Promise.resolve(new TextEncoder().encode(contents).buffer) };
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success) { queueMicrotask(() => success(file)); },
  };
}

function fakeDirEntry(name, childrenBatches) {
  // childrenBatches: either a single array of children (convenience) or an
  // array of batches (to test multi-batch readEntries accumulation).
  const batches = Array.isArray(childrenBatches) && childrenBatches.length > 0 && Array.isArray(childrenBatches[0])
    ? childrenBatches
    : [childrenBatches, []];
  let reads = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      return {
        readEntries(success) {
          const batch = batches[reads++];
          // readEntries is async in the browser; call back on next tick.
          queueMicrotask(() => success(batch));
        },
      };
    },
  };
}

function fakeItem(entry) {
  return { kind: "file", webkitGetAsEntry: () => entry };
}

function fakeDataTransfer(items) {
  return { items, files: [] };
}

test("collects a flat file with relativePath = name", async () => {
  const dt = fakeDataTransfer([fakeItem(fakeFileEntry("a.txt"))]);
  const { entries, unsupported } = await collectDroppedUploadEntries(dt);
  assert.equal(unsupported, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].relativePath, "a.txt");
  assert.equal(entries[0].file.name, "a.txt");
});

test("collects a directory recursively with prefixed relative paths", async () => {
  const dir = fakeDirEntry("proj", [
    fakeFileEntry("root.txt"),
    fakeDirEntry("src", [
      fakeFileEntry("index.ts"),
      fakeDirEntry("util", [fakeFileEntry("math.ts")]),
    ]),
  ]);
  const dt = fakeDataTransfer([fakeItem(dir)]);
  const { entries, unsupported } = await collectDroppedUploadEntries(dt);
  assert.equal(unsupported, false);
  const paths = entries.map((e) => e.relativePath).sort();
  assert.deepEqual(paths, [
    "proj/root.txt",
    "proj/src/index.ts",
    "proj/src/util/math.ts",
  ].sort());
});

test("empty directory yields no entries", async () => {
  const dir = fakeDirEntry("empty", []);
  const dt = fakeDataTransfer([fakeItem(dir)]);
  const { entries } = await collectDroppedUploadEntries(dt);
  assert.equal(entries.length, 0);
});

test("unsupported (no webkitGetAsEntry) falls back to dataTransfer.files flat", async () => {
  const fileA = { name: "a.txt", size: 1, type: "" };
  const fileB = { name: "b.txt", size: 1, type: "" };
  const dt = {
    items: [{ kind: "file" /* no webkitGetAsEntry */ }],
    files: [fileA, fileB],
  };
  const { entries, unsupported } = await collectDroppedUploadEntries(dt);
  assert.equal(unsupported, true);
  assert.deepEqual(entries.map((e) => e.relativePath), ["a.txt", "b.txt"]);
});

test("mixed file and directory drops preserve drop order", async () => {
  const dir = fakeDirEntry("d", [fakeFileEntry("one.txt")]);
  const file = fakeFileEntry("top.txt");
  const dt = fakeDataTransfer([fakeItem(file), fakeItem(dir)]);
  const { entries } = await collectDroppedUploadEntries(dt);
  const paths = entries.map((e) => e.relativePath);
  // top.txt first, then the directory's child
  assert.equal(paths[0], "top.txt");
  assert.equal(paths[1], "d/one.txt");
});

test("accumulates children across multiple non-empty readEntries batches", async () => {
  // Reader returns [a], then [b], then [] — proves accumulation doesn't stop
  // at the first non-empty batch.
  const dir = fakeDirEntry("multi", [[fakeFileEntry("a.txt")], [fakeFileEntry("b.txt")], []]);
  const dt = fakeDataTransfer([fakeItem(dir)]);
  const { entries } = await collectDroppedUploadEntries(dt);
  const paths = entries.map((e) => e.relativePath).sort();
  assert.deepEqual(paths, ["multi/a.txt", "multi/b.txt"].sort());
});
