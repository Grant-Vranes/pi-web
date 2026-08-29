# File Explorer Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create, rename, move, and permanently delete files and directories from the left file explorer through a right-click menu and internal drag-and-drop.

**Architecture:** A server-only `lib/file-mutations.ts` module will validate and execute filesystem mutations behind the existing `/api/files/[...path]` authorization boundary. `FileExplorer` will own contextual-menu, dialog, and drag state while emitting completed mutations to `AppShell`, whose pure tab-state helper updates or removes open file tabs.

**Tech Stack:** Next.js 16 route handlers, React 19, TypeScript, Node `fs`/`path`, Node built-in test runner with `jiti`, existing Pi Web i18n.

## Global Constraints

- Keep mutations inside `getAllowedFileRoots()` and retain both lexical `isFilePathAllowed()` and canonical `isExistingFilePathAllowed()` checks.
- Call `isApiRequestAllowed()` before accepting every mutation request body.
- Never overwrite an existing destination; report it as HTTP `409`.
- Reject empty names, `.`, `..`, any path separator, and absolute paths.
- Delete permanently only after client-side confirmation; delete directory symlinks as links, not their targets.
- Reuse `normalizeFilePathSlashes()`, `getFileDirectory()`, `getFileName()`, `joinFilePath()`, and `samePath()` rather than comparing raw paths.
- Add every user-visible explorer string to `en.ts`, `zh-CN.ts`, and `zh-TW.ts`.
- Do not run `next build`; validate with focused tests, `node_modules/.bin/tsc --noEmit`, and `npm run lint`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/file-mutations.ts` | Validate mutation input, safely resolve existing parents, execute create/rename/move/delete, and expose typed results/errors. |
| `lib/file-mutations.test.mjs` | Direct filesystem tests for success, conflict, invalid name, escape, symlink, and recursive deletion behavior. |
| `app/api/files/[...path]/route.ts` | Parse mutation `type`, apply request/root authorization, and translate module errors to JSON HTTP responses. |
| `app/api/files/mutation-route.test.mjs` | Route source-contract tests that prevent mutations bypassing request or canonical-path authorization. |
| `components/file-tab-state.ts` | Purely reconcile open tabs after a successful file rename, move, or deletion. |
| `components/file-tab-state.test.mjs` | Test tab path/id/label reconciliation and active-tab selection inputs. |
| `components/FileExplorer.tsx` | Render contextual actions, name and move dialogs, operation feedback, and native explorer drag/drop. |
| `components/FileExplorer.mutations.test.mjs` | Source-level interaction contract tests for the menu, confirmation, picker restrictions, and internal drag payload. |
| `components/AppShell.tsx` | Pass mutation callback to the sidebar and reconcile file tabs/active tab after explorer changes. |
| `components/SessionSidebar.tsx` | Forward the explorer mutation callback without owning its state. |
| `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` | Localize menu labels, dialogs, operation errors, and drag/move feedback. |

## Interfaces

```ts
// lib/file-mutations.ts
export type FileMutation =
  | { type: "create-file" | "create-directory"; directory: string; name: string }
  | { type: "rename"; sourcePath: string; name: string }
  | { type: "move"; sourcePath: string; destinationDirectory: string }
  | { type: "delete"; sourcePath: string };

export type FileMutationResult = {
  sourcePath: string;
  destinationPath?: string;
  deleted: boolean;
};

export class FileMutationError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string);
}

export function mutateFile(
  mutation: FileMutation,
  allowedRoots: Set<string>,
): FileMutationResult;

// components/file-tab-state.ts
export type FileTabMutation =
  | { kind: "rename" | "move"; sourcePath: string; destinationPath: string }
  | { kind: "delete"; sourcePath: string };

export function applyFileTabMutation(tabs: Tab[], mutation: FileTabMutation): Tab[];
export function getNextActiveFileTabId(
  tabsBefore: Tab[], activeTabId: string | null, mutation: FileTabMutation,
): string | null;
```

### Task 1: Implement and test safe filesystem mutation primitives

**Files:**
- Create: `lib/file-mutations.ts`
- Create: `lib/file-mutations.test.mjs`

**Consumes:** `lib/file-access.ts` authorization helpers and `lib/paths.ts` `samePath()`.

**Produces:** `FileMutation`, `FileMutationResult`, `FileMutationError`, and `mutateFile()` for the route handler.

- [ ] **Step 1: Write failing mutation tests**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { mutateFile, FileMutationError } = await createJiti(import.meta.url).import("./file-mutations.ts");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mutations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, roots: new Set([root]) };
}

test("creates files and directories only below an authorized directory", (t) => {
  const { root, roots } = fixture(t);
  const directory = path.join(root, "src");
  fs.mkdirSync(directory);
  assert.deepEqual(mutateFile({ type: "create-directory", directory, name: "nested" }, roots), {
    sourcePath: path.join(directory, "nested"), destinationPath: path.join(directory, "nested"), deleted: false,
  });
  mutateFile({ type: "create-file", directory: path.join(directory, "nested"), name: "index.ts" }, roots);
  assert.equal(fs.readFileSync(path.join(directory, "nested", "index.ts"), "utf8"), "");
});

test("rejects invalid names, conflicts, and lexical root escapes", (t) => {
  const { root, roots } = fixture(t);
  fs.writeFileSync(path.join(root, "exists.txt"), "x");
  for (const name of ["", ".", "..", "a/b", "../outside"]) {
    assert.throws(() => mutateFile({ type: "create-file", directory: root, name }, roots), FileMutationError);
  }
  assert.throws(() => mutateFile({ type: "create-file", directory: root, name: "exists.txt" }, roots), (error) => error.status === 409);
});

test("rejects source or destination that escapes through a symlink", (t) => {
  const { root, roots } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => mutateFile({ type: "create-file", directory: path.join(root, "escape"), name: "x.txt" }, roots), (error) => error.status === 403);
});

test("renames, moves, and recursively deletes directories without following directory symlinks", (t) => {
  const { root, roots } = fixture(t);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-link-target-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(source); fs.mkdirSync(target); fs.writeFileSync(path.join(source, "a.txt"), "a");
  const renamed = path.join(root, "renamed");
  mutateFile({ type: "rename", sourcePath: source, name: "renamed" }, roots);
  mutateFile({ type: "move", sourcePath: renamed, destinationDirectory: target }, roots);
  fs.symlinkSync(outside, path.join(target, "renamed", "link"), process.platform === "win32" ? "junction" : "dir");
  mutateFile({ type: "delete", sourcePath: path.join(target, "renamed") }, roots);
  assert.equal(fs.existsSync(path.join(target, "renamed")), false);
  assert.equal(fs.existsSync(outside), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test lib/file-mutations.test.mjs`

Expected: FAIL because `lib/file-mutations.ts` does not exist.

- [ ] **Step 3: Implement the minimal mutation module**

```ts
import fs from "fs";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { isWindowsAbsolutePath, samePath } from "./paths";

export class FileMutationError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export type FileMutation =
  | { type: "create-file" | "create-directory"; directory: string; name: string }
  | { type: "rename"; sourcePath: string; name: string }
  | { type: "move"; sourcePath: string; destinationDirectory: string }
  | { type: "delete"; sourcePath: string };
export type FileMutationResult = { sourcePath: string; destinationPath?: string; deleted: boolean };

function resolverFor(...paths: string[]) { return paths.some(isWindowsAbsolutePath) ? path.win32 : path; }
function assertName(name: string) {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || path.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new FileMutationError(400, "Invalid file name");
  }
}
function assertExistingAllowed(target: string, roots: Set<string>) {
  if (!fs.existsSync(target)) throw new FileMutationError(404, "File or directory not found");
  if (!isFilePathAllowed(target, roots) || !isExistingFilePathAllowed(target, roots)) {
    throw new FileMutationError(403, "Access denied");
  }
}
function assertParentAllowed(target: string, roots: Set<string>) {
  const parent = resolverFor(target).dirname(target);
  if (!isFilePathAllowed(target, roots) || !fs.existsSync(parent)) throw new FileMutationError(403, "Access denied");
  if (!isExistingFilePathAllowed(parent, roots)) throw new FileMutationError(403, "Access denied");
}
function assertVacant(target: string) {
  if (fs.existsSync(target)) throw new FileMutationError(409, "A file or directory with this name already exists");
}
function assertDirectory(target: string, roots: Set<string>) {
  assertExistingAllowed(target, roots);
  if (!fs.statSync(target).isDirectory()) throw new FileMutationError(400, "Target is not a directory");
}
function isSameOrDescendant(candidate: string, ancestor: string) {
  const resolver = resolverFor(candidate, ancestor);
  const relative = resolver.relative(ancestor, candidate);
  return relative === "" || (!relative.startsWith("..") && !resolver.isAbsolute(relative));
}

export function mutateFile(mutation: FileMutation, roots: Set<string>): FileMutationResult {
  if (mutation.type === "create-file" || mutation.type === "create-directory") {
    assertName(mutation.name); assertDirectory(mutation.directory, roots);
    const destinationPath = resolverFor(mutation.directory).join(mutation.directory, mutation.name);
    assertParentAllowed(destinationPath, roots); assertVacant(destinationPath);
    if (mutation.type === "create-file") fs.writeFileSync(destinationPath, "", { flag: "wx" });
    else fs.mkdirSync(destinationPath);
    return { sourcePath: destinationPath, destinationPath, deleted: false };
  }
  assertExistingAllowed(mutation.sourcePath, roots);
  if (mutation.type === "delete") {
    fs.rmSync(mutation.sourcePath, { recursive: fs.lstatSync(mutation.sourcePath).isDirectory(), force: false });
    return { sourcePath: mutation.sourcePath, deleted: true };
  }
  const destinationDirectory = mutation.type === "rename"
    ? resolverFor(mutation.sourcePath).dirname(mutation.sourcePath)
    : mutation.destinationDirectory;
  const name = mutation.type === "rename" ? mutation.name : resolverFor(mutation.sourcePath).basename(mutation.sourcePath);
  assertName(name); assertDirectory(destinationDirectory, roots);
  const destinationPath = resolverFor(destinationDirectory).join(destinationDirectory, name);
  assertParentAllowed(destinationPath, roots); assertVacant(destinationPath);
  if (fs.lstatSync(mutation.sourcePath).isDirectory() && isSameOrDescendant(destinationPath, mutation.sourcePath)) {
    throw new FileMutationError(400, "A folder cannot be moved into itself or one of its subfolders");
  }
  if (samePath(mutation.sourcePath, destinationPath)) throw new FileMutationError(400, "Source and destination are the same");
  fs.renameSync(mutation.sourcePath, destinationPath);
  return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
}
```

Keep the implementation above as the complete mutation behavior. Convert filesystem races caught from `ENOENT` to `404` and `EEXIST` to `409`; rethrow other unexpected errors for the route's generic `500`. On Windows use `path.win32` when path forms require it, matching `lib/path-security.ts` conventions. Do not rely on a lexical check alone for existing parents or move destinations.

- [ ] **Step 4: Run the mutation tests to verify they pass**

Run: `node --experimental-strip-types --test lib/file-mutations.test.mjs`

Expected: PASS with all four tests.

- [ ] **Step 5: Commit the mutation primitive**

```bash
git add lib/file-mutations.ts lib/file-mutations.test.mjs
git commit -m "feat: add safe file mutation primitives"
```

### Task 2: Expose mutations through the authorized files API

**Files:**
- Modify: `app/api/files/[...path]/route.ts`
- Create: `app/api/files/mutation-route.test.mjs`

**Consumes:** `mutateFile()` from Task 1 and the existing route segment parser, allowed-root loader, and request-security guard.

**Produces:** JSON POST APIs at `/api/files/<path>?type=create-file|create-directory|rename|move|delete`.

- [ ] **Step 1: Write a failing route contract test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("mutation requests are guarded and delegated to the canonical mutation service", () => {
  assert.match(source, /const FILE_MUTATION_TYPES = \["create-file", "create-directory", "rename", "move", "delete"\] as const/);
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(source, /mutateFile\(mutation, allowedRoots\)/);
  assert.match(source, /error instanceof FileMutationError/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test app/api/files/mutation-route.test.mjs`

Expected: FAIL because the mutation type registry and delegation are absent.

- [ ] **Step 3: Add mutation request parsing and response mapping**

Add `FILE_MUTATION_TYPES`, a `Set` parser, and a small `parseMutation(type, filePath, body)` helper above `POST`. Keep uploads in their existing branch. For mutation types, require JSON objects with string `name` or `destinationDirectory` fields as appropriate; route path is the parent directory for creates and source for rename/move/delete.

```ts
if (mutationType) {
  const body = await request.json().catch(() => null);
  const mutation = parseMutation(mutationType, filePathFromSegments(segments), body);
  const allowedRoots = await getAllowedFileRoots();
  const result = mutateFile(mutation, allowedRoots);
  return NextResponse.json(result);
}
```

Catch `FileMutationError` separately and return `NextResponse.json({ error: error.message }, { status: error.status })`; preserve the existing generic 500 fallback for unexpected exceptions. Add mutation types to the POST handling before `getUploadDirectory()`, because `rename`, `move`, and `delete` use a source path rather than an upload directory.

- [ ] **Step 4: Run API and existing file-route tests**

Run: `node --experimental-strip-types --test app/api/files/mutation-route.test.mjs app/api/files/watch-route.test.mjs app/api/files/stream-route.test.mjs lib/file-mutations.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the route integration**

```bash
git add app/api/files/'[...path]'/route.ts app/api/files/mutation-route.test.mjs
git commit -m "feat: expose file mutations through files api"
```

### Task 3: Reconcile open tabs after explorer mutations

**Files:**
- Modify: `components/file-tab-state.ts`
- Modify: `components/file-tab-state.test.mjs`
- Modify: `components/AppShell.tsx:11,469-477,925-960,1085,1100-1120`
- Modify: `components/SessionSidebar.tsx:Props declaration,1471-1485`

**Consumes:** `FileTabMutation` from the tab state helper and successful mutation events emitted by `FileExplorer` in Task 4.

**Produces:** Correctly renamed/moved/closed tabs and active-tab selection without stale paths.

- [ ] **Step 1: Add failing tab reconciliation tests**

```js
import { applyFileTabMutation, getNextActiveFileTabId } from "./file-tab-state.ts";

test("renaming or moving an open tab replaces its path, id, and label", () => {
  const mutation = { kind: "move", sourcePath: "/repo/a.ts", destinationPath: "/repo/src/b.ts" };
  const next = applyFileTabMutation([tabA, tabB], mutation);
  assert.deepEqual(next[0], { ...tabA, id: "file:/repo/src/b.ts", filePath: "/repo/src/b.ts", label: "b.ts" });
  assert.strictEqual(next[1], tabB);
});

test("deleting the active tab selects the final surviving tab", () => {
  const mutation = { kind: "delete", sourcePath: "/repo/a.ts" };
  const next = applyFileTabMutation([tabA, tabB], mutation);
  assert.deepEqual(next, [tabB]);
  assert.equal(getNextActiveFileTabId([tabA, tabB], tabA.id, mutation), tabB.id);
});
```

- [ ] **Step 2: Run the tab-state tests to verify they fail**

Run: `node --experimental-strip-types --test components/file-tab-state.test.mjs`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement pure tab reconciliation and wire it to AppShell**

Add the exported mutation union and functions to `components/file-tab-state.ts`. Match tab paths with `samePath()`. On rename/move update `id` to `file:${destinationPath}`, `filePath`, and `label` from `getFileName(destinationPath)`, preserving viewer state. On delete remove only matching tabs. For an active removed tab, return the prior final remaining tab ID, otherwise retain the active ID if it still exists.

In `AppShell`, add `handleFileMutation(mutation)` that calculates the next tabs and next active ID from the same pre-update snapshot, closes the right panel when no tabs survive, and bumps `explorerRefreshKey`. Add `onFileMutation={handleFileMutation}` to `SessionSidebar`; add the corresponding optional prop to `SessionSidebar` and forward it to `FileExplorer`.

- [ ] **Step 4: Run tab and AppShell regression tests**

Run: `node --experimental-strip-types --test components/file-tab-state.test.mjs components/AppShell.file-viewer-state.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit tab synchronization**

```bash
git add components/file-tab-state.ts components/file-tab-state.test.mjs components/AppShell.tsx components/SessionSidebar.tsx
git commit -m "feat: synchronize tabs after file mutations"
```

### Task 4: Add contextual explorer controls, move picker, and internal drag/drop

**Files:**
- Modify: `components/FileExplorer.tsx`
- Create: `components/FileExplorer.mutations.test.mjs`
- Modify: `lib/i18n/messages/en.ts:250-280`
- Modify: `lib/i18n/messages/zh-CN.ts:250-280`
- Modify: `lib/i18n/messages/zh-TW.ts:250-280`

**Consumes:** Files API in Task 2 and `onFileMutation` callback in Task 3.

**Produces:** Right-click mutation controls, create/rename/delete dialogs, cwd-bounded folder selector, and explorer-internal move drag/drop.

- [ ] **Step 1: Add failing explorer interaction contract tests**

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test components/FileExplorer.mutations.test.mjs`

Expected: FAIL because mutation state and handlers are absent.

- [ ] **Step 3: Implement mutation client state and request helper**

Define a local `ExplorerMutation` union and `requestFileMutation(targetPath, type, body)` next to `fetchEntries()`. It must POST JSON to the encoded existing target path, parse `{ error?: string; sourcePath: string; destinationPath?: string; deleted: boolean }`, and throw the returned message or `File operation failed (HTTP ${res.status})`.

Extend `Props` with:

```ts
onFileMutation?: (mutation: FileTabMutation) => void;
```

Maintain one active context target, pointer position, name-dialog state, destination-picker state, mutation busy state, and a local mutation error. Close the menu on Escape and capture-phase outside pointer down with one document listener only while it is open. Clear mutation error when opening a new action. Keep upload drag detection separate from internal explorer drags by recognizing `application/x-pi-web-file-path` before treating `DataTransfer.items` as uploads.

- [ ] **Step 4: Implement the menu and action flows**

Pass `onContextMenu`, `draggable`, `onDragStart`, and internal-folder-drop handlers from `FileExplorer` to every `TreeNode` instance, including search results. Add `onContextMenu` to the tree container to target `cwd` when right-clicking blank space. Tree nodes call `preventDefault()` and `stopPropagation()` before opening the menu.

Render a `role="menu"` with keyboard-focusable buttons. Based on target type, show exactly the actions from the approved design. Use a small in-explorer dialog for create and rename with auto-focused name input; Enter submits and Escape closes. For delete, call `window.confirm(t("files.confirmDelete", { name: target.name }))` before requesting `delete`; request only after confirmation.

Use a new explorer-local folder chooser rather than `DirectoryPicker`, because the existing picker can browse the machine outside `cwd`. Reuse `fetchEntries()` to lazily list only directories and root it at `cwd`; disable current parent, the source directory, and descendants of a directory source. Its confirm button issues `move` with `{ destinationDirectory }`.

After every successful response, call `onFileMutation` with `{ kind: "delete", sourcePath }` or `{ kind: type === "rename" ? "rename" : "move", sourcePath, destinationPath }`, increment `treeRefreshKey`, close dialogs/menu, and clear error. Disable action buttons while busy. Render errors in a `role="alert"` status strip near the existing upload feedback without hiding upload results.

- [ ] **Step 5: Add translations**

Add the same key set to each locale, with localized values:

```ts
"files.newFile": "New File",
"files.newFolder": "New Folder",
"files.rename": "Rename",
"files.moveTo": "Move to…",
"files.delete": "Delete",
"files.fileName": "Name",
"files.create": "Create",
"files.confirmDelete": "Permanently delete {name}?",
"files.moveHere": "Move here",
"files.selectDestination": "Select destination folder",
"files.invalidMoveTarget": "A folder cannot be moved into itself or one of its subfolders.",
"files.operationFailed": "File operation failed",
"files.dismissOperationError": "Dismiss file operation error",
"files.dropToMove": "Move to {name}",
```

Translate all of these in `zh-CN.ts` and `zh-TW.ts`; do not fall back to English.

- [ ] **Step 6: Run explorer and related regressions**

Run: `node --experimental-strip-types --test components/FileExplorer.mutations.test.mjs components/SessionSidebar.file-search.test.mjs components/file-tab-state.test.mjs lib/i18n/registry.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the explorer user interface**

```bash
git add components/FileExplorer.tsx components/FileExplorer.mutations.test.mjs lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat: add explorer file mutation controls"
```

### Task 5: Verify the complete feature

**Files:**
- Modify only if verification exposes a concrete defect in files changed by Tasks 1-4.

**Consumes:** Completed implementation and test suite.

**Produces:** Verified mutation feature with no unrelated build artifacts.

- [ ] **Step 1: Run all focused regression tests**

Run:

```bash
node --experimental-strip-types --test \
  lib/file-mutations.test.mjs \
  lib/file-access.test.mjs \
  app/api/files/mutation-route.test.mjs \
  app/api/files/stream-route.test.mjs \
  app/api/files/watch-route.test.mjs \
  components/FileExplorer.mutations.test.mjs \
  components/file-tab-state.test.mjs \
  components/AppShell.file-viewer-state.test.mjs \
  components/SessionSidebar.file-search.test.mjs \
  lib/i18n/registry.test.mjs
```

Expected: PASS with no skipped or failing subtests.

- [ ] **Step 2: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`

Expected: exit code 0.

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: exit code 0 with no new warnings.

- [ ] **Step 4: Inspect the final change set**

Run:

```bash
git diff --check HEAD~4..HEAD
git status --short
git log --oneline -4
```

Expected: no whitespace errors, only intended tracked changes, and four feature commits matching Tasks 1-4.

- [ ] **Step 5: Commit any verification-only correction**

```bash
git add lib/file-mutations.ts app/api/files/'[...path]'/route.ts components/FileExplorer.tsx components/file-tab-state.ts components/AppShell.tsx components/SessionSidebar.tsx lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "fix: harden explorer file mutations"
```

Run this step only when Steps 1-4 required a correction; otherwise leave the working tree clean.

## Plan Self-Review

- **Spec coverage:** Tasks 1-2 enforce safe create, rename, move, and permanent deletion with root, symlink, conflict, and self-descendant protection. Task 4 covers right-click actions, folder-only move selection, drag-to-folder movement, confirmations, error feedback, and i18n. Task 3 handles open-tab rename/move/delete synchronization. Task 5 verifies all required checks.
- **Placeholder scan:** No deferred behaviors or unspecified validations remain; each task identifies its files, interfaces, test command, and completion criteria.
- **Type consistency:** Route results use `FileMutationResult`; explorer notifications use `FileTabMutation`; AppShell receives only the notification union produced by the explorer.
