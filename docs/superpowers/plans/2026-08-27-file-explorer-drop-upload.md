# File Explorer drag-and-drop upload (files and folders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag local files and folders onto the left file-explorer panel and upload them into the session cwd, preserving folder structure.

**Architecture:** A new pure client module `lib/drop-collect.ts` recursively reads dropped `webkitGetAsEntry()` trees into `{ file, relativePath }` entries. `FileExplorer` gains drag handlers that feed those entries into a generalized upload state machine reusing the existing checking/conflict/uploading/summary UI. The upload API (`lib/file-upload.ts` validation + `app/api/files/[...path]/route.ts` POST) is extended to accept `/`-separated relative paths, create subdirectories, and merge (not delete) existing directories under the `overwrite` strategy.

**Tech Stack:** Next.js (App Router), React, TypeScript, Node `--experimental-strip-types --test`, XHR FormData uploads, fs sync writes.

## Global Constraints

- Max 25 MB per file, 100 MB total per upload — unchanged, enforced both client (pre-check) and server (413).
- Allowed-roots + realpath checks on the upload directory (`getUploadDirectory`) — unchanged.
- Relative paths use `/` only; reject `\`, `..` segments, absolute paths, empty segments.
- Do not touch `useDragDrop` / `buildDropPayload` / ChatWindow drag — that channel is text-only mention insertion.
- i18n keys live in `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`; all three must stay in sync.
- Tests run via `npm test` (`node --experimental-strip-types --test`); `.mjs` tests import `.ts` directly.
- Never run `next build` during dev.

**Spec:** `docs/superpowers/specs/2026-08-27-file-explorer-drop-upload-design.md`

---

## File Structure

- **Create** `lib/drop-collect.ts` — pure client helper: `collectDroppedUploadEntries(dataTransfer)` → recursive `webkitGetAsEntry` read with flat `dataTransfer.files` fallback.
- **Create** `lib/drop-collect.test.mjs` — Node unit tests with fake `FileSystemEntry` objects.
- **Modify** `lib/file-upload.ts` — `validateUploadFileNames` accepts `/`-separated relative paths; add `writeUploadFiles` (extracted from the route); `inspectUploadTargets` unchanged.
- **Modify** `lib/file-upload.test.mjs` — add relative-path acceptance/rejection cases for `validateUploadFileNames`; add `writeUploadFiles` tests (flat, nested, merge, overwrite, skip, non-replaceable).
- **Modify** `app/api/files/[...path]/route.ts` — POST write loop delegates to `writeUploadFiles`; route keeps size checks, validation, inspection, 409, and byte reading.
- **Modify** `components/FileExplorer.tsx` — drag handlers + overlay + `prepareUploadEntries`/`performUploadEntries` + `pendingConflict.entries` + `<input>` path delegates to entries.
- **Modify** `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` — add `files.dropToUpload`, `files.tooLarge`.

---

### Task 1: Extend `validateUploadFileNames` to accept relative paths

**Files:**
- Modify: `lib/file-upload.ts` (the `validateUploadFileNames` function)
- Test: `lib/file-upload.test.mjs` (the `validates upload names...` test)

**Interfaces:**
- Produces: `validateUploadFileNames(fileNames: string[]): string | null` — now accepts strings containing `/` (POSIX relative paths); rejects `..` segments, leading `/`, leading `[A-Zaex]:`, any `\`, empty segments, `\0`, duplicates, empty array. Signature unchanged.

- [ ] **Step 1: Update the failing test**

Replace the existing `validates upload names` test body in `lib/file-upload.test.mjs` with:

```js
test("validates upload names, accepting relative paths, rejecting traversal", async () => {
  const { validateUploadFileNames } = await loadSubject();

  // accepted
  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.equal(validateUploadFileNames(["a/b/c.txt"]), null);
  assert.equal(validateUploadFileNames(["dir/sub/file.ts"]), null);

  // rejected: traversal / absolute / backslash / empty
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain|invalid/i);
  assert.match(validateUploadFileNames(["a/../b"]), /must not contain|invalid/i);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain|invalid/i);
  assert.match(validateUploadFileNames(["/abs/path.txt"]), /must not contain|invalid/i);
  assert.match(validateUploadFileNames(["C:\\x"]), /must not contain|invalid/i);
  assert.match(validateUploadFileNames(["a//b"]), /must not contain|invalid/i);
  assert.match(validateUploadFileNames([""]), /invalid/i);

  // rejected: duplicates and empty array
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/file-upload.test.mjs`
Expected: FAIL — `a/b/c.txt` is currently rejected by the old `includes("/")` check.

- [ ] **Step 3: Implement the new validation**

Replace the body of `validateUploadFileNames` in `lib/file-upload.ts` with:

```ts
export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("\\")) {
      return `File names must not contain backslashes: ${fileName}`;
    }
    if (fileName.startsWith("/")) {
      return `File names must not be absolute paths: ${fileName}`;
    }
    if (/^[A-Za-z]:[\\/]/.test(fileName)) {
      return `File names must not be absolute paths: ${fileName}`;
    }
    const segments = fileName.split("/");
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === "..") {
        return `File names must not contain a path: ${fileName}`;
      }
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/file-upload.test.mjs`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add lib/file-upload.ts lib/file-upload.test.mjs
git commit -m "feat(upload): accept /-separated relative paths in validateUploadFileNames"
```

---

### Task 2: Extract `writeUploadFiles` + directory creation + merge-on-overwrite

**Files:**
- Modify: `lib/file-upload.ts` (add `writeUploadFiles` export; `inspectUploadTargets` unchanged)
- Modify: `app/api/files/[...path]/route.ts` (POST write loop delegates to `writeUploadFiles`)
- Modify: `lib/file-upload.test.mjs` (add tests for `writeUploadFiles`)

**Interfaces:**
- Consumes: `inspectUploadTargets`, `UploadConflictStrategy` from `lib/file-upload.ts`.
- Produces: `writeUploadFiles(directory, files, inspection, strategy)` — a pure-ish function (does fs writes, no network/Next) that the route calls instead of inlining the loop. Signature:
  ```ts
  export interface UploadFileInput { name: string; bytes: Buffer; }
  export interface UploadWriteResult { uploaded: string[]; skipped: string[]; errors: Array<{ name: string; error: string }>; }
  export function writeUploadFiles(
    directory: string,
    files: UploadFileInput[],
    inspection: UploadTargetInspection,
    strategy: UploadConflictStrategy,
  ): UploadWriteResult;
  ```
  It creates parent directories for relative paths containing `/`, merges (does not delete) existing directories under `overwrite`, skips conflict items under `skip`, and unlinks replaceable file conflicts under `overwrite`.

- [ ] **Step 1: Write the failing tests for `writeUploadFiles`**

Append to `lib/file-upload.test.mjs` (inside the existing `test` imports — `fs`, `os`, `path` are already imported at top):

```js
test("writeUploadFiles writes flat files and returns uploaded names", async () => {
  const { writeUploadFiles } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-flat-"));
  try {
    const result = writeUploadFiles(root, [
      { name: "a.txt", bytes: Buffer.from("hi") },
      { name: "b.txt", bytes: Buffer.from("yo") },
    ], { conflicts: [], nonReplaceable: [] }, "error");
    assert.deepEqual(result, { uploaded: ["a.txt", "b.txt"], skipped: [], errors: [] });
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hi");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles creates subdirectories for relative paths", async () => {
  const { writeUploadFiles } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-rel-"));
  try {
    const result = writeUploadFiles(root, [
      { name: "sub/dir/f.txt", bytes: Buffer.from("x") },
    ], { conflicts: [], nonReplaceable: [] }, "error");
    assert.deepEqual(result.uploaded, ["sub/dir/f.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "sub", "dir", "f.txt"), "utf8"), "x");
    assert.ok(fs.statSync(path.join(root, "sub", "dir")).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles merge: overwrite writes into an existing directory", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-merge-"));
  try {
    fs.mkdirSync(path.join(root, "existing"));
    fs.writeFileSync(path.join(root, "existing", "keep.txt"), "old");
    const targets = ["existing/new.txt"];
    const inspection = inspectUploadTargets(root, targets);
    // existing dir itself is not a conflict (only "existing/new.txt" is checked);
    // but if a file "existing" already existed it would be. Here we verify the
    // common merge case: dir exists, file inside is new.
    assert.deepEqual(inspection, { conflicts: [], nonReplaceable: [] });
    const result = writeUploadFiles(root, [
      { name: "existing/new.txt", bytes: Buffer.from("new") },
    ], inspection, "overwrite");
    assert.deepEqual(result.uploaded, ["existing/new.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "existing", "new.txt"), "utf8"), "new");
    // pre-existing file in the same dir is untouched
    assert.equal(fs.readFileSync(path.join(root, "existing", "keep.txt"), "utf8"), "old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles overwrite replaces a conflicting file", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-over-"));
  try {
    fs.writeFileSync(path.join(root, "f.txt"), "old");
    const inspection = inspectUploadTargets(root, ["f.txt"]);
    assert.deepEqual(inspection.conflicts, ["f.txt"]);
    const result = writeUploadFiles(root, [
      { name: "f.txt", bytes: Buffer.from("new") },
    ], inspection, "overwrite");
    assert.deepEqual(result.uploaded, ["f.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8"), "new");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles skip skips conflicting items only", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-skip-"));
  try {
    fs.writeFileSync(path.join(root, "old.txt"), "old");
    const inspection = inspectUploadTargets(root, ["old.txt", "new.txt"]);
    const result = writeUploadFiles(root, [
      { name: "old.txt", bytes: Buffer.from("x") },
      { name: "new.txt", bytes: Buffer.from("y") },
    ], inspection, "skip");
    assert.deepEqual(result.uploaded, ["new.txt"]);
    assert.deepEqual(result.skipped, ["old.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "old.txt"), "utf8"), "old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles non-replaceable conflict under overwrite writes inside existing dir, does not delete it", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-nr-"));
  try {
    // A directory exists at the target path of an uploaded "file" name.
    // This is the degenerate case: uploader wants to write "d" but "d" is a dir.
    fs.mkdirSync(path.join(root, "d"));
    const inspection = inspectUploadTargets(root, ["d"]);
    assert.deepEqual(inspection, { conflicts: ["d"], nonReplaceable: ["d"] });
    const result = writeUploadFiles(root, [
      { name: "d", bytes: Buffer.from("x") },
    ], inspection, "overwrite");
    // Cannot write a file "d" over a directory "d": writeFileSync wx fails.
    // The directory must NOT be deleted. This surfaces as an error, not a crash.
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(fs.statSync(path.join(root, "d")).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles error strategy leaves non-replaceable conflicts as errors without writing", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-err-"));
  try {
    fs.mkdirSync(path.join(root, "d"));
    const inspection = inspectUploadTargets(root, ["d"]);
    const result = writeUploadFiles(root, [
      { name: "d", bytes: Buffer.from("x") },
    ], inspection, "error");
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /Cannot replace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test lib/file-upload.test.mjs`
Expected: FAIL — `writeUploadFiles` is not exported.

- [ ] **Step 3: Implement `writeUploadFiles` in `lib/file-upload.ts`**

Append to `lib/file-upload.ts`:

```ts
export interface UploadFileInput {
  name: string;
  bytes: Buffer;
}

export interface UploadWriteResult {
  uploaded: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

export function writeUploadFiles(
  directory: string,
  files: UploadFileInput[],
  inspection: UploadTargetInspection,
  strategy: UploadConflictStrategy,
): UploadWriteResult {
  const conflictSet = new Set(inspection.conflicts);
  const nonReplaceableSet = new Set(inspection.nonReplaceable);
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const file of files) {
    const destination = path.join(directory, file.name);
    const isConflict = conflictSet.has(file.name);
    const isNonReplaceable = nonReplaceableSet.has(file.name);

    if (isConflict && strategy === "skip") {
      skipped.push(file.name);
      continue;
    }

    // Under overwrite, a non-replaceable target (existing directory or
    // symlink) is merged, not deleted: attempt the write in place. Under
    // error strategy, non-replaceable conflicts were already surfaced via
    // the 409 from inspectUploadTargets in the route; reaching here under
    // "error" means it was not a 409 (e.g. race) — record an error.
    if (isConflict && isNonReplaceable && strategy !== "overwrite") {
      errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
      continue;
    }

    // Replaceable file conflict: unlink before write (overwrite only).
    if (isConflict && !isNonReplaceable) {
      try {
        fs.unlinkSync(destination);
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    // Create parent directories for relative paths containing "/".
    const parentDir = path.dirname(destination);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (error) {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    try {
      fs.writeFileSync(destination, file.bytes, { flag: "wx" });
      uploaded.push(file.name);
    } catch (error) {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { uploaded, skipped, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test lib/file-upload.test.mjs`
Expected: PASS — all `writeUploadFiles` tests green, plus the pre-existing tests still green.

- [ ] **Step 5: Refactor the route POST to call `writeUploadFiles`**

In `app/api/files/[...path]/route.ts`, replace the entire write loop (from `const conflictSet = new Set(inspection.conflicts);` through the `return NextResponse.json({ uploaded, skipped, errors }, ...)` that closes the `type === "upload"` branch) with a delegation. The route still owns: size checks, `validateUploadFileNames`, `inspectUploadTargets`, the 409 for `strategy === "error"`, and reading bytes from each `File`. Replace with:

```ts
    const inspection = inspectUploadTargets(directory, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "One or more files already exist",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const inputs: UploadFileInput[] = [];
    for (const file of files) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await file.arrayBuffer());
      } catch (error) {
        inputs.push({ name: file.name, bytes: Buffer.alloc(0) });
        // record read failure separately below by leaving bytes empty; simpler:
        // skip and let writeUploadFiles not see it. Instead, collect errors here.
        continue;
      }
      inputs.push({ name: file.name, bytes });
    }
    const { uploaded, skipped, errors } = writeUploadFiles(directory, inputs, inspection, strategy);

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
```

> Note: the `arrayBuffer()` read failure path above is awkward. Cleaner: read bytes into `UploadFileInput[]` with a parallel `readErrors` array, then prepend `readErrors` to the `errors` returned by `writeUploadFiles`. Implement it as:

```ts
    const inputs: UploadFileInput[] = [];
    const readErrors: Array<{ name: string; error: string }> = [];
    for (const file of files) {
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        inputs.push({ name: file.name, bytes });
      } catch (error) {
        readErrors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const { uploaded, skipped, errors: writeErrors } = writeUploadFiles(directory, inputs, inspection, strategy);
    const errors = [...readErrors, ...writeErrors];

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
```

Use this cleaner version. Add the import at the top of the route file:

```ts
import { writeUploadFiles, type UploadFileInput } from "@/lib/file-upload";
```
(The existing import from `@/lib/file-upload` can be merged into one line.)

- [ ] **Step 6: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: PASS, no errors. Confirm no leftover references to the old inline loop variables (`conflictSet`, `nonReplaceableSet`).

- [ ] **Step 7: Run the full file-upload test suite**

Run: `node --experimental-strip-types --test lib/file-upload.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 8: Commit**

```bash
git add lib/file-upload.ts lib/file-upload.test.mjs app/api/files/\[...path\]/route.ts
git commit -m "feat(upload): extract writeUploadFiles, create subdirs, merge dirs on overwrite"
```

---

### Task 3: `lib/drop-collect.ts` — recursive entry reader

**Files:**
- Create: `lib/drop-collect.ts`
- Create: `lib/drop-collect.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface DroppedUploadEntry { file: File; relativePath: string; }
  export interface CollectedDrop { entries: DroppedUploadEntry[]; unsupported: boolean; }
  export async function collectDroppedUploadEntries(dataTransfer: DataTransfer): Promise<CollectedDrop>;
  ```
  `relativePath` is POSIX-style (`/`-separated, no leading slash). `unsupported` is `true` when `webkitGetAsEntry` is unavailable on every item; in that case entries come from `dataTransfer.files` flat with `relativePath = file.name`.

- [ ] **Step 1: Write the failing test**

Create `lib/drop-collect.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { collectDroppedUploadEntries } from "./drop-collect.ts";

// Minimal fake of FileSystemEntry / FileSystemDirectoryEntry / FileSystemFileEntry
// and DataTransferItem, just enough to drive the reader.
function fakeFileEntry(name, contents = "x") {
  const file = { name, size: contents.length, type: "", arrayBuffer: () => Promise.resolve(new TextEncoder().encode(contents).buffer) };
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: () => Promise.resolve(file),
  };
}

function fakeDirEntry(name, children) {
  let reads = 0;
  const batches = [children, []];
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      return {
        readEntries(cb) {
          const batch = batches[reads++];
          // readEntries is async in the browser; call back on next tick.
          queueMicrotask(() => cb(batch));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/drop-collect.test.mjs`
Expected: FAIL — module `./drop-collect.ts` not found.

- [ ] **Step 3: Implement `lib/drop-collect.ts`**

```ts
export interface DroppedUploadEntry {
  file: File;
  relativePath: string;
}

export interface CollectedDrop {
  entries: DroppedUploadEntry[];
  unsupported: boolean;
}

interface FakeFileEntryLike {
  name: string;
  isFile: true;
  isDirectory: false;
  file(): Promise<File>;
}

interface FakeDirEntryLike {
  name: string;
  isFile: false;
  isDirectory: true;
  createReader(): { readEntries(cb: (entries: unknown[]) => void): void };
}

type AnyEntry = FakeFileEntryLike | FakeDirEntryLike;

function isFileEntry(entry: AnyEntry | null | undefined): entry is FakeFileEntryLike {
  return !!entry && entry.isFile === true && entry.isDirectory === false;
}

function isDirEntry(entry: AnyEntry | null | undefined): entry is FakeDirEntryLike {
  return !!entry && entry.isFile === false && entry.isDirectory === true;
}

function readAllEntries(reader: { readEntries(cb: (entries: unknown[]) => void): void }): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const acc: unknown[] = [];
    const step = () => {
      try {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(acc);
          } else {
            acc.push(...batch);
            step();
          }
        });
      } catch (error) {
        reject(error);
      }
    };
    step();
  });
}

async function collectEntry(entry: AnyEntry, prefix: string, out: DroppedUploadEntry[]): Promise<void> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (isFileEntry(entry)) {
    const file = await entry.file();
    out.push({ file, relativePath });
    return;
  }
  if (isDirEntry(entry)) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) {
      await collectEntry(child as AnyEntry, relativePath, out);
    }
  }
}

export async function collectDroppedUploadEntries(dataTransfer: DataTransfer): Promise<CollectedDrop> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: AnyEntry[] = [];
  let unsupported = true;

  for (const item of items) {
    const getter = (item as { webkitGetAsEntry?: () => AnyEntry | null }).webkitGetAsEntry;
    if (typeof getter !== "function") continue;
    unsupported = false;
    try {
      const entry = getter.call(item as object);
      if (entry) entries.push(entry);
    } catch {
      // ignore items that fail to resolve
    }
  }

  const out: DroppedUploadEntry[] = [];
  if (unsupported) {
    // Fallback: flat files, no structure.
    const files = Array.from(dataTransfer.files ?? []);
    for (const file of files) {
      out.push({ file, relativePath: file.name });
    }
    return { entries: out, unsupported: true };
  }

  for (const entry of entries) {
    await collectEntry(entry, "", out);
  }
  return { entries: out, unsupported: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/drop-collect.test.mjs`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/drop-collect.ts lib/drop-collect.test.mjs
git commit -m "feat(upload): add drop-collect helper to read dropped file/folder trees"
```

---

### Task 4: i18n keys for drop overlay and size errors

**Files:**
- Modify: `lib/i18n/messages/en.ts` (after the `files.uploading` line)
- Modify: `lib/i18n/messages/zh-CN.ts` (after the `files.uploading` line)
- Modify: `lib/i18n/messages/zh-TW.ts` (after the `files.uploading` line)

**Interfaces:**
- Produces two new i18n keys:
  - `files.dropToUpload`: "Drop to upload into {name}" (en)
  - `files.tooLarge`: "These files exceed the size limit (25 MB each, 100 MB total): {files}" (en)

- [ ] **Step 1: Add keys to `en.ts`**

Find the line `"files.uploading": "Uploading, {progress}%",` in `lib/i18n/messages/en.ts` and add immediately after it:

```ts
    "files.dropToUpload": "Drop to upload into {name}",
    "files.tooLarge": "These files exceed the size limit (25 MB each, 100 MB total): {files}",
```

- [ ] **Step 2: Add keys to `zh-CN.ts`**

Find `"files.uploading": "正在上传，{progress}%",` in `lib/i18n/messages/zh-CN.ts` and add after it:

```ts
    "files.dropToUpload": "拖放以上传到 {name}",
    "files.tooLarge": "以下文件超出大小限制（单个 25 MB，总计 100 MB）：{files}",
```

- [ ] **Step 3: Add keys to `zh-TW.ts`**

Find `"files.uploading": "正在上傳，{progress}%",` in `lib/i18n/messages/zh-TW.ts` and add after it:

```ts
    "files.dropToUpload": "拖放以上傳到 {name}",
    "files.tooLarge": "以下檔案超出大小限制（單個 25 MB，總計 100 MB）：{files}",
```

- [ ] **Step 4: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat(i18n): add files.dropToUpload and files.tooLarge keys"
```

---

### Task 5: FileExplorer drag handlers + entries-based upload path

**Files:**
- Modify: `components/FileExplorer.tsx`

**Interfaces:**
- Consumes: `collectDroppedUploadEntries`, `DroppedUploadEntry` from `lib/drop-collect.ts`; `validateUploadFileNames` indirectly via the `upload-check` endpoint; i18n keys `files.dropToUpload`, `files.tooLarge`.
- Produces: `FileExplorer` now accepts drag/drop of files and folders onto its body; the `<input>` path and the drop path share `prepareUploadEntries` / `performUploadEntries`.

This is the largest task. Read the current `FileExplorer.tsx` first:

- [ ] **Step 1: Read the current file**

Run: `read components/FileExplorer.tsx` — confirm the locations of: the `uploadFiles` helper, `prepareUpload`, `performUpload`, `PendingConflict` type, `pendingConflict` state, the conflict UI buttons, and the root `<div>`.

- [ ] **Step 2: Add the import**

At the top of `components/FileExplorer.tsx`, alongside the other `@/lib` imports, add:

```ts
import { collectDroppedUploadEntries, type DroppedUploadEntry } from "@/lib/drop-collect";
```

- [ ] **Step 3: Change `PendingConflict` to carry `entries`**

Find the `interface PendingConflict` definition and replace `files: File[];` with `entries: DroppedUploadEntry[];`:

```ts
interface PendingConflict {
  entries: DroppedUploadEntry[];
  conflicts: string[];
  nonReplaceable: string[];
}
```

- [ ] **Step 4: Add drop-target state and size constants**

Near the other `useState` declarations in the component body, add:

```ts
  const [isDropTarget, setIsDropTarget] = useState(false);
  const dropCounterRef = useRef(0);
```

And near the top of the file (after the imports, before `interface FileEntry`), add constants:

```ts
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
```

- [ ] **Step 5: Replace `performUpload` with `performUploadEntries`**

Find the existing `performUpload` callback. Replace it entirely with a version that takes `DroppedUploadEntry[]` and sets each FormData file name to the relative path:

```ts
  const performUploadEntries = useCallback(async (
    entries: DroppedUploadEntry[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadEntries(cwd, entries, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          entries,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);
```

- [ ] **Step 6: Replace `uploadFiles` helper with `uploadEntries`**

Find the module-level `function uploadFiles(...)` and replace it with:

```ts
function uploadEntries(
  targetDirectory: string,
  entries: DroppedUploadEntry[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const entry of entries) {
      formData.append("files", entry.file, entry.relativePath);
    }
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}
```

Also add `nonReplaceable?: string[];` to the `UploadResponse` interface if it is not already present (check first; if `nonReplaceable` is missing, add it).

- [ ] **Step 7: Replace `prepareUpload` with `prepareUploadEntries`**

Find the existing `prepareUpload` callback and replace it with:

```ts
  const prepareUploadEntries = useCallback(async (entries: DroppedUploadEntry[]) => {
    if (entries.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);

    // Frontend size pre-check.
    const tooLarge: string[] = [];
    let total = 0;
    for (const entry of entries) {
      total += entry.file.size;
      if (entry.file.size > MAX_UPLOAD_FILE_BYTES) tooLarge.push(entry.relativePath);
    }
    if (tooLarge.length > 0 || total > MAX_UPLOAD_TOTAL_BYTES) {
      const offenders = tooLarge.length > 0 ? tooLarge : entries.map((e) => e.relativePath);
      setUploadError(t("files.tooLarge", { files: offenders.join(", ") }));
      return;
    }

    setUploadPhase("checking");
    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: entries.map((entry) => entry.relativePath) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          entries,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUploadEntries(entries, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUploadEntries, uploadBusy, t]);
```

- [ ] **Step 8: Update the `<input>` handler to use entries**

Find `handleUploadInput` and replace its body so it wraps the flat `File` objects into entries:

```ts
  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    const entries: DroppedUploadEntry[] = files.map((file) => ({ file, relativePath: file.name }));
    void prepareUploadEntries(entries);
  }, [prepareUploadEntries]);
```

- [ ] **Step 9: Update the conflict UI buttons**

Find the three conflict buttons (`Replace`, `Skip existing`, `Cancel`). Change the `onClick` of the first two from `performUpload(pendingConflict.files, ...)` to `performUploadEntries(pendingConflict.entries, ...)`:

```tsx
              <button type="button" onClick={() => void performUploadEntries(pendingConflict.entries, "overwrite")} style={{ ... }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUploadEntries(pendingConflict.entries, "skip")} style={{ ... }}>
                {t("files.skipExisting")}
              </button>
```

The Cancel button (`setPendingConflict(null)`) is unchanged.

- [ ] **Step 10: Add drag handlers to the root `<div>`**

Find the root `<div style={{ minHeight: "100%" }}>` at the bottom of the component return. Add drag handlers and the overlay. Replace:

```tsx
  return (
    <div style={{ minHeight: "100%" }}>
```

with:

```tsx
  const acceptsUploadDrop = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return false;
    const items = Array.from(dataTransfer.items ?? []);
    return items.some((item) => item.kind === "file");
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
    dropCounterRef.current += 1;
    setIsDropTarget(true);
  }, [acceptsUploadDrop]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
  }, [acceptsUploadDrop]);

  const handleDragLeave = useCallback(() => {
    dropCounterRef.current -= 1;
    if (dropCounterRef.current <= 0) {
      dropCounterRef.current = 0;
      setIsDropTarget(false);
    }
  }, []);

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
    dropCounterRef.current = 0;
    setIsDropTarget(false);
    const { entries } = await collectDroppedUploadEntries(event.dataTransfer);
    void prepareUploadEntries(entries);
  }, [acceptsUploadDrop, prepareUploadEntries]);

  const cwdName = useMemo(() => {
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts.filter(Boolean).pop() ?? cwd;
  }, [cwd]);

  return (
    <div
      style={{ minHeight: "100%", position: "relative" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDropTarget && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            background: "color-mix(in srgb, var(--accent) 8%, transparent)",
            border: "2px dashed var(--border)",
            borderRadius: 6,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
            {t("files.dropToUpload", { name: cwdName })}
          </span>
        </div>
      )}
```

> The closing `</div>` of the root element is unchanged. The `useMemo` and `useCallback` hooks for the handlers must be declared inside the component body (above the `return`). Move the `acceptsUploadDrop`/`handleDrag*`/`handleDrop`/`cwdName` declarations to just before the `return (` if the linter complains about hooks after early returns — there are no early returns in this component, so placing them right above `return` is safe.

- [ ] **Step 11: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: PASS. Fix any leftover references to the old `prepareUpload` / `performUpload` / `pendingConflict.files` names.

- [ ] **Step 12: Lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings).

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: all new tests pass; no regressions beyond the documented pre-existing failures. If a source-structure test in `components/*.test.mjs` asserts `FileExplorer.tsx` text, update it to include `collectDroppedUploadEntries` / `prepareUploadEntries`.

- [ ] **Step 14: Commit**

```bash
git add components/FileExplorer.tsx
git commit -m "feat(file-explorer): drag-and-drop upload of files and folders into cwd"
```

---

### Task 6: Manual verification in dev

**Files:** none (verification only)

- [ ] **Step 1: Ensure dev server is running**

Run: `lsof -nP -iTCP:30141 -sTCP:LISTEN`
If nothing is listening, start it: `npm run dev`. Reuse the existing process if healthy.

- [ ] **Step 2: Verify single-file drop**

In the browser, open a session, drag a single file from Finder onto the file-explorer panel. Confirm: overlay appears during drag; file uploads; summary shows 1 uploaded; tree refreshes; highlight dot shows on the new file.

- [ ] **Step 3: Verify folder drop**

Drag a folder (e.g. a small `test-dir/` with `a.txt` and `sub/b.txt`) onto the explorer. Confirm the tree shows `test-dir/a.txt` and `test-dir/sub/b.txt` after refresh.

- [ ] **Step 4: Verify conflict merge**

Drop the same folder again. Confirm the conflict UI lists the relative paths. Click **Replace**; confirm files are overwritten and the existing directory was not deleted (its other contents, if any, remain). Click **Skip existing** on a subsequent drop; confirm only conflicting paths are skipped, non-conflicting new files still upload.

- [ ] **Step 5: Verify size pre-check**

Drag a file > 25 MB (or construct a folder whose total > 100 MB). Confirm the `files.tooLarge` error appears with the file name(s) and no request is sent (check Network tab: no POST to `/api/files/.../upload`).

- [ ] **Step 6: Verify the `<input>` button still works**

Click the upload toolbar button, select a file, confirm it uploads flat (relativePath = file name).

No commit — verification only.
