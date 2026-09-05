# File Explorer Clipboard (Copy / Cut / Paste) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ⌘C/⌘X/⌘V (Ctrl on Win/Linux) copy/cut/paste with context-menu entries and a name-conflict dialog to the sidebar file explorer.

**Architecture:** A new server-side `copy` mutation (plus a `conflict` mode on `copy`/`move`) in `lib/file-mutations.ts`, served through the existing `/api/files` POST route. The client (`components/FileExplorer.tsx`) keeps a single-entry clipboard state, derives a smart paste directory from the last right-clicked entry, resends conflicting pastes through an Overwrite/Keep-both/Cancel dialog, and reuses the existing `move` mutation for cut.

**Tech Stack:** Next.js App Router route handlers, React (function components, inline styles), node:fs, node:test + jiti for behavioral route tests, i18n locale plugins in `lib/i18n/messages/`.

**Spec:** `docs/superpowers/specs/2026-09-05-file-explorer-clipboard-design.md`

## Global Constraints

- Never run `next build` during development (it pollutes `.next/` and breaks `npm run dev`).
- Run tests with: `node --experimental-strip-types --test <file>` (the repo's `npm test` globs all `*.test.mjs`).
- Typecheck with: `node_modules/.bin/tsc --noEmit`. Lint with: `npm run lint`.
- File paths from `path`/fs calls are platform-native; compare with the helpers in `lib/file-paths.ts` / `lib/paths.ts`, never raw `===`.
- All new server paths must pass through the existing authorization helpers (`assertExistingAllowed`, `assertParentAllowed`, `assertDirectory`, `assertName`, `assertVacant`) — never touch fs without them.
- Keep-both naming is deterministic and server-side: `a.txt` → `a copy.txt` → `a copy 2.txt`; extension-less names use `name copy`, `name copy 2`, …
- UI strings must be added to all three locale files: `lib/i18n/messages/en.ts`, `zh-CN.ts`, `zh-TW.ts`.
- `FileTabMutation` must NOT gain a copy kind: the source of a copy still exists, so open tabs never follow a copy. Only cut (move) keeps the existing tab-following behavior.
- Commit after every task; commit messages use conventional prefixes (`feat:`, `test:`).

---

### Task 1: Server — `copy` mutation and `conflict` mode for `copy`/`move`

**Files:**
- Modify: `lib/file-mutations.ts`
- Modify: `app/api/files/[...path]/route.ts`
- Test: `app/api/files/mutation-route.test.mjs`

**Interfaces:**
- Consumes: existing `FileMutation`, `FileMutationError`, `mutateFile()` in `lib/file-mutations.ts`; route's `parseMutation()`.
- Produces: `export type FileMutationConflictMode = "error" | "overwrite" | "keep-both"`; `FileMutation` gains two members `{ type: "move" | "copy"; sourcePath: string; destinationDirectory: string; conflict: FileMutationConflictMode }`; `mutateFile` accepts both and returns `{ sourcePath, destinationPath, deleted: false }` with `destinationPath` set to the final path. Route accepts `?type=copy` and body field `conflict`.

- [ ] **Step 1: Rewrite the failing test file**

Replace the entire content of `app/api/files/mutation-route.test.mjs` with:

```mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("mutation requests are guarded and delegated to the canonical mutation service", () => {
  assert.match(source, /const FILE_MUTATION_TYPES = \["create-file", "create-directory", "rename", "move", "copy", "delete", "write"\] as const/);
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(source, /mutateFile\(mutation, allowedRoots\)/);
  assert.match(source, /error instanceof FileMutationError/);
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-mutation-"));
  allowFileRoot(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function routeContext(filePath) {
  return { params: Promise.resolve({ path: filePath.split("/").filter(Boolean) }) };
}

async function callMutation(filePath, type, body) {
  const segments = filePath.split("/").filter(Boolean).map(encodeURIComponent);
  const url = `http://localhost/api/files/${segments.join("/")}?type=${type}`;
  const request = new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body ?? {}),
  });
  return POST(request, routeContext(filePath));
}

test("copy duplicates files and directories within the allowed root", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "hello");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "m.ts"), "export {}");
  fs.symlinkSync(path.join(root, "a.txt"), path.join(root, "src", "link.txt"));

  const response = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, false);
  assert.equal(body.destinationPath, path.join(root, "a copy.txt"));
  assert.equal(fs.readFileSync(path.join(root, "a copy.txt"), "utf8"), "hello");
  assert.ok(fs.existsSync(path.join(root, "a.txt")));

  const directoryResponse = await callMutation(path.join(root, "src"), "copy", { destinationDirectory: root });
  assert.equal(directoryResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "src copy", "m.ts"), "utf8"), "export {}");
  // Symlinks are copied as links, never dereferenced.
  assert.ok(fs.lstatSync(path.join(root, "src copy", "link.txt")).isSymbolicLink());
});

test("keep-both picks successive copy names with and without extensions", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "1");
  fs.writeFileSync(path.join(root, "a copy.txt"), "2");
  fs.writeFileSync(path.join(root, "README"), "r");

  const response = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root, conflict: "keep-both" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(path.basename(body.destinationPath), "a copy 2.txt");

  const readmeResponse = await callMutation(path.join(root, "README"), "copy", { destinationDirectory: root, conflict: "keep-both" });
  assert.equal(readmeResponse.status, 200);
  const readmeBody = await readmeResponse.json();
  assert.equal(path.basename(readmeBody.destinationPath), "README copy");
});

test("copy and move default to 409 on name conflicts", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "1");

  const copyResponse = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root });
  assert.equal(copyResponse.status, 409);
  const moveResponse = await callMutation(path.join(root, "a.txt"), "move", { destinationDirectory: root });
  assert.equal(moveResponse.status, 409);
});

test("overwrite removes the existing destination before copying or moving", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "dir"));
  fs.writeFileSync(path.join(root, "a.txt"), "new");
  fs.writeFileSync(path.join(root, "dir", "a.txt"), "old");
  fs.writeFileSync(path.join(root, "b.txt"), "moved");

  const copyResponse = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: path.join(root, "dir"), conflict: "overwrite" });
  assert.equal(copyResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "dir", "a.txt"), "utf8"), "new");

  const moveResponse = await callMutation(path.join(root, "b.txt"), "move", { destinationDirectory: path.join(root, "dir"), conflict: "overwrite" });
  assert.equal(moveResponse.status, 200);
  assert.equal(fs.readFileSync(path.join(root, "dir", "b.txt"), "utf8"), "moved");
  assert.ok(!fs.existsSync(path.join(root, "b.txt")));
});

test("move keep-both renames the incoming entry instead of failing", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "from"));
  fs.mkdirSync(path.join(root, "to"));
  fs.writeFileSync(path.join(root, "from", "a.txt"), "A");
  fs.writeFileSync(path.join(root, "to", "a.txt"), "B");

  const response = await callMutation(path.join(root, "from", "a.txt"), "move", { destinationDirectory: path.join(root, "to"), conflict: "keep-both" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(path.basename(body.destinationPath), "a copy.txt");
  assert.equal(fs.readFileSync(path.join(root, "to", "a.txt"), "utf8"), "B");
  assert.equal(fs.readFileSync(path.join(root, "to", "a copy.txt"), "utf8"), "A");
});

test("copy rejects sources and destinations outside allowed roots", async (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.txt"), "1");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");

  const badDestination = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: outside });
  assert.equal(badDestination.status, 403);
  const badSource = await callMutation(path.join(outside, "secret.txt"), "copy", { destinationDirectory: root });
  assert.equal(badSource.status, 403);
});

test("copy refuses to copy a directory into itself", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  const response = await callMutation(path.join(root, "src"), "copy", { destinationDirectory: path.join(root, "src", "nested") });
  assert.equal(response.status, 400);
});

test("invalid conflict mode is a 400", async (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.txt"), "1");
  const response = await callMutation(path.join(root, "a.txt"), "copy", { destinationDirectory: root, conflict: "merge" });
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node --experimental-strip-types --test app/api/files/mutation-route.test.mjs`
Expected: FAIL — the guard test fails on the `FILE_MUTATION_TYPES` regex ("copy" missing), and behavioral copy tests fail (409 "Invalid file request type" / unknown type).

- [ ] **Step 3: Implement the `copy` mutation and `conflict` mode in `lib/file-mutations.ts`**

3a. Add the conflict type and extend the union (top of file, replacing the existing `FileMutation`):

```ts
export type FileMutationConflictMode = "error" | "overwrite" | "keep-both";

export type FileMutation =
  | { type: "create-file" | "create-directory"; directory: string; name: string }
  | { type: "rename"; sourcePath: string; name: string }
  | { type: "move"; sourcePath: string; destinationDirectory: string; conflict: FileMutationConflictMode }
  | { type: "copy"; sourcePath: string; destinationDirectory: string; conflict: FileMutationConflictMode }
  | { type: "delete"; sourcePath: string }
  | { type: "write"; sourcePath: string; content: string; baseMtimeMs: number | null };
```

3b. Add two helpers immediately after `pathEntryExists`:

```ts
function resolveKeepBothName(directory: string, name: string): string {
  const resolver = resolverFor(directory, name);
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0
      ? `${base} copy${extension}`
      : `${base} copy ${attempt + 1}${extension}`;
    if (!pathEntryExists(resolver.join(directory, candidate))) return candidate;
  }
  throw new FileMutationError(409, "A file or directory with this name already exists");
}

function removeExistingForOverwrite(target: string, allowedRoots: Set<string>): void {
  if (!isExistingFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
  const stat = fs.lstatSync(target);
  fs.rmSync(target, { recursive: stat.isDirectory(), force: false });
}
```

3c. Replace the shared rename/move tail of `executeMutation` (everything after the `delete` block, from `assertExistingAllowed(mutation.sourcePath, allowedRoots);` down to the final `return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };`) with:

```ts
  assertExistingAllowed(mutation.sourcePath, allowedRoots);
  const sourceResolver = resolverFor(mutation.sourcePath);
  const destinationDirectory = mutation.type === "rename"
    ? sourceResolver.dirname(mutation.sourcePath)
    : mutation.destinationDirectory;
  const name = mutation.type === "rename"
    ? mutation.name
    : sourceResolver.basename(mutation.sourcePath);

  assertName(name);
  assertDirectory(destinationDirectory, allowedRoots);
  let destinationPath = resolverFor(destinationDirectory).join(destinationDirectory, name);
  assertParentAllowed(destinationPath, allowedRoots);

  if (mutation.type !== "rename" && pathEntryExists(destinationPath)) {
    if (mutation.conflict === "error") {
      throw new FileMutationError(409, "A file or directory with this name already exists");
    }
    if (mutation.conflict === "overwrite") {
      removeExistingForOverwrite(destinationPath, allowedRoots);
    } else {
      destinationPath = resolverFor(destinationDirectory).join(
        destinationDirectory,
        resolveKeepBothName(destinationDirectory, name),
      );
    }
  } else {
    assertVacant(destinationPath, allowedRoots);
  }

  if (fs.lstatSync(mutation.sourcePath).isDirectory()) {
    const canonicalSourcePath = fs.realpathSync(mutation.sourcePath);
    const canonicalDestinationDirectory = fs.realpathSync(destinationDirectory);
    const canonicalDestinationPath = resolverFor(
      canonicalDestinationDirectory,
      canonicalSourcePath,
    ).join(canonicalDestinationDirectory, resolverFor(destinationDirectory).basename(destinationPath));
    if (isSameOrDescendant(canonicalDestinationPath, canonicalSourcePath)) {
      throw new FileMutationError(
        400,
        mutation.type === "copy"
          ? "A folder cannot be copied into itself or one of its subfolders"
          : "A folder cannot be moved into itself or one of its subfolders",
      );
    }
  }

  if (mutation.type === "copy") {
    if (fs.lstatSync(mutation.sourcePath).isDirectory()) {
      fs.cpSync(mutation.sourcePath, destinationPath, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
    } else {
      fs.copyFileSync(mutation.sourcePath, destinationPath);
    }
    return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
  }

  fs.renameSync(mutation.sourcePath, destinationPath);
  return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
```

- [ ] **Step 4: Wire the route (`app/api/files/[...path]/route.ts`)**

4a. Add `"copy"` to the type list:

```ts
const FILE_MUTATION_TYPES = ["create-file", "create-directory", "rename", "move", "copy", "delete", "write"] as const;
```

4b. Extend the import from `@/lib/file-mutations` with `type FileMutationConflictMode` (add it to the existing `type FileMutation` import list).

4c. Add a parser next to `parseFileMutationType`:

```ts
function parseConflictMode(value: unknown): FileMutationConflictMode {
  if (value === undefined || value === null) return "error";
  if (value === "error" || value === "overwrite" || value === "keep-both") return value;
  throw new FileMutationError(400, "conflict must be one of: error, overwrite, keep-both");
}
```

4d. In `parseMutation`, merge the `move` branch with `copy` (replace the existing `if (type === "move") { ... }` block):

```ts
  if (type === "move" || type === "copy") {
    if (typeof input.destinationDirectory !== "string") {
      throw new FileMutationError(400, "destinationDirectory must be a string");
    }
    return {
      type,
      sourcePath: filePath,
      destinationDirectory: input.destinationDirectory,
      conflict: parseConflictMode(input.conflict),
    };
  }
```

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node --experimental-strip-types --test app/api/files/mutation-route.test.mjs`
Expected: all tests PASS. If the keep-both or overwrite tests fail, check that `pathEntryExists` is consulted before every write and that `removeExistingForOverwrite` runs before the self-nest check's realpath.

- [ ] **Step 6: Typecheck and commit**

Run: `node_modules/.bin/tsc --noEmit` — expect no errors.

```bash
git add lib/file-mutations.ts "app/api/files/[...path]/route.ts" app/api/files/mutation-route.test.mjs
git commit -m "feat(files): copy mutation with conflict modes for copy and move"
```

---

### Task 2: Client — clipboard state, context menu copy/cut, cut dimming, i18n

**Files:**
- Modify: `components/FileExplorer.tsx`
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`
- Test: `components/FileExplorer.mutations.test.mjs`

**Interfaces:**
- Consumes: `copy` mutation from Task 1 exists server-side (not called yet in this task).
- Produces: `ExplorerMutation.type` includes `"copy"`; `TreeNode` gains prop `cutPath: string | null` (dims matching rows); component state `clipboard: { path: string; mode: "copy" | "cut" } | null` and `lastContextEntry: { path: string; isDir: boolean } | null` set by `openContextMenu`. i18n keys `files.copy`, `files.cut` in all locales.

- [ ] **Step 1: Add the failing test assertions**

In `components/FileExplorer.mutations.test.mjs`, update the disabled-count test and append three tests (add after the existing tests):

```mjs
test("context menu actions are disabled during mutations", () => {
  const menuSection = source.slice(source.indexOf("{contextMenu && ("), source.indexOf("{pendingMutation && ("));
  // Create-file/create-directory (2), copy, cut, rename and delete use the
  // shared busy guard; paste adds its own clipboard-null guard.
  assert.equal((menuSection.match(/disabled=\{mutationBusy\}/g) ?? []).length, 6);
});

test("clipboard holds a single entry set from the context menu", () => {
  assert.match(source, /useState<\{ path: string; mode: "copy" \| "cut" \} \| null>\(null\)/);
  assert.match(source, /setLastContextEntry\(\{ path: target\.fullPath, isDir: target\.isDir \}\)/);
  assert.match(source, /setClipboard\(\{ path: contextMenu\.target\.fullPath, mode: "copy" \}\)/);
  assert.match(source, /setClipboard\(\{ path: contextMenu\.target\.fullPath, mode: "cut" \}\)/);
});

test("entries held as cut render dimmed", () => {
  assert.match(source, /const isCut = cutPath !== null && cutPath !== undefined && sameFilePath\(cutPath, node\.fullPath\)/);
  assert.match(source, /opacity: isCut \? 0\.5 : 1/);
  assert.match(source, /cutPath=\{cutPath\}/);
});

test("copy and cut menu labels exist in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"files\.copy":/);
    assert.match(messages, /"files\.cut":/);
  }
});
```

(Replace the old `context menu actions are disabled during mutations` test — it asserted count `3`.)

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test components/FileExplorer.mutations.test.mjs`
Expected: FAIL — count is still 3 and the new patterns are absent.

- [ ] **Step 3: Implement in `components/FileExplorer.tsx`**

3a. Extend the mutation type union (the `ExplorerMutation` type near the top):

```ts
type ExplorerMutation = {
  type: "create-file" | "create-directory" | "rename" | "move" | "copy" | "delete";
  target: FileNode;
};
```

3b. Add clipboard + last-context state inside the `FileExplorer` component, right after the `mutationError` state line:

```ts
  const [clipboard, setClipboard] = useState<{ path: string; mode: "copy" | "cut" } | null>(null);
  const [lastContextEntry, setLastContextEntry] = useState<{ path: string; isDir: boolean } | null>(null);
```

3c. Update `openContextMenu` to record the entry:

```ts
  const openContextMenu = useCallback((target: FileNode, event: React.MouseEvent, isRoot = false) => {
    event.preventDefault();
    event.stopPropagation();
    setMutationError(null);
    setLastContextEntry({ path: target.fullPath, isDir: target.isDir });
    setContextMenu({ target, x: event.clientX, y: event.clientY, isRoot });
  }, []);
```

3d. Extend `TreeNode`: add `cutPath` to the destructured props and the props type (after `onInternalFolderDrop?: ...`):

```ts
  cutPath,
```
```ts
  cutPath?: string | null;
```

3e. In the `TreeNode` body, next to the `highlighted` line, add:

```ts
  const isCut = cutPath !== null && cutPath !== undefined && sameFilePath(cutPath, node.fullPath);
```

3f. In the row `style` object (the one with `position: "relative"`), add `opacity: isCut ? 0.5 : 1,` as the last property.

3g. Pass `cutPath` down in the recursive children map (inside `{node.isDir && open && ...}`) and at both top-level render sites (search tree and main roots), e.g.:

```tsx
                cutPath={cutPath}
```

Add `cutPath={clipboard?.mode === "cut" ? clipboard.path : null}` at the two `FileExplorer`-level `<TreeNode>` usages; the recursive one forwards the prop unchanged.

3h. In the context menu JSX, inside the `{!contextMenu.isRoot && <>...</>}` fragment, add copy and cut buttons before the rename button (same button style as the existing items):

```tsx
            <button type="button" role="menuitem" disabled={mutationBusy} onClick={() => { setClipboard({ path: contextMenu.target.fullPath, mode: "copy" }); setContextMenu(null); }} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t("files.copy")}</button>
            <button type="button" role="menuitem" disabled={mutationBusy} onClick={() => { setClipboard({ path: contextMenu.target.fullPath, mode: "cut" }); setContextMenu(null); }} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t("files.cut")}</button>
```

- [ ] **Step 4: Add the i18n keys**

In each locale file, directly after the `"files.dropToMove"` line:

`en.ts`:
```ts
    "files.copy": "Copy",
    "files.cut": "Cut",
```
`zh-CN.ts`:
```ts
    "files.copy": "复制",
    "files.cut": "剪切",
```
`zh-TW.ts`:
```ts
    "files.copy": "複製",
    "files.cut": "剪下",
```

- [ ] **Step 5: Run to verify pass, typecheck, commit**

Run: `node --experimental-strip-types --test components/FileExplorer.mutations.test.mjs` — expect PASS.
Run: `node_modules/.bin/tsc --noEmit` — expect no errors.

```bash
git add components/FileExplorer.tsx components/FileExplorer.mutations.test.mjs lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat(explorer): copy and cut clipboard state with context menu and cut dimming"
```

---

### Task 3: Client — keyboard shortcuts, paste flow, conflict dialog

**Files:**
- Modify: `components/FileExplorer.tsx`
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`
- Test: `components/FileExplorer.mutations.test.mjs`

**Interfaces:**
- Consumes: Task 1 `copy` mutation (`?type=copy`, body `{ destinationDirectory, conflict }`, 409 on conflict, response `destinationPath`); Task 2 `clipboard`/`lastContextEntry` state and `files.copy`/`files.cut` keys.
- Produces: `FileMutationServerError` gains `readonly status: number`; `requestFileMutation` requires `destinationPath` for `copy` too; handlers `performPaste(mode, sourcePath, destinationDirectory, conflict)` and `handleExplorerKeyDown(event)`; i18n keys `files.paste`, `files.conflictTitle`, `files.conflictMessage`, `files.conflictOverwrite`, `files.conflictKeepBoth`.

- [ ] **Step 1: Add the failing test assertions**

Append to `components/FileExplorer.mutations.test.mjs`:

```mjs
test("mutation server errors carry the HTTP status for conflict detection", () => {
  assert.match(source, /class FileMutationServerError extends Error \{/);
  assert.match(source, /public readonly status: number/);
  assert.match(source, /throw new FileMutationServerError\(data\.error, response\.status\)/);
  assert.match(source, /type === "rename" \|\| type === "move" \|\| type === "copy"/);
});

test("keyboard shortcuts scope copy, cut and paste to the explorer tree", () => {
  assert.match(source, /const handleExplorerKeyDown = useCallback\(\(event: React\.KeyboardEvent\) => \{/);
  assert.match(source, /if \(!\(event\.metaKey \|\| event\.ctrlKey\) \|\| event\.altKey \|\| event\.shiftKey\) return;/);
  assert.match(source, /target\.tagName === "INPUT" \|\| target\.tagName === "TEXTAREA" \|\| target\.isContentEditable/);
  assert.match(source, /selection\.toString\(\)\.length > 0/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /onKeyDown=\{handleExplorerKeyDown\}/);
});

test("paste resolves a smart destination and reports conflicts via dialog", () => {
  assert.match(source, /const pasteDestinationDirectory = useMemo\(/);
  assert.match(source, /cause\.status === 409 && conflict === "error"/);
  assert.match(source, /setPasteConflict\(\{ type, sourcePath, destinationDirectory, name: getFileName\(sourcePath\) \}\)/);
  assert.match(source, /t\("files\.conflictOverwrite"\)/);
  assert.match(source, /t\("files\.conflictKeepBoth"\)/);
  assert.match(source, /disabled=\{mutationBusy \|\| !clipboard\}/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test components/FileExplorer.mutations.test.mjs`
Expected: FAIL — the three new tests fail on missing patterns.

- [ ] **Step 3: Implement in `components/FileExplorer.tsx`**

3a. Give the server-error class a status (replace `class FileMutationServerError extends Error {}`):

```ts
class FileMutationServerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
```

3b. In `requestFileMutation`, pass the status:

```ts
      throw new FileMutationServerError(data.error, response.status);
```

3c. Require `destinationPath` for copy in the response validation (update the condition):

```ts
    || ((type === "rename" || type === "move" || type === "copy")
```

3d. Add state and the smart-destination memo (after the Task 2 state lines). `pasteDestinationDirectory` returns the last context directory (the entry itself when it is a directory, otherwise its parent), falling back to the first root:

```ts
  const [pasteConflict, setPasteConflict] = useState<{ type: "copy" | "move"; sourcePath: string; destinationDirectory: string; name: string } | null>(null);
```

```ts
  const pasteDestinationDirectory = useMemo(() => {
    if (lastContextEntry) {
      return lastContextEntry.isDir ? lastContextEntry.path : getFileDirectory(lastContextEntry.path);
    }
    return roots[0]?.fullPath ?? null;
  }, [lastContextEntry, roots]);
```

3e. Add `performPaste` after `executeMutation` (note: cut into the source's own directory is a no-op that drops the cut; 409 on the first attempt opens the dialog; a successful cut clears the clipboard, a successful copy keeps it):

```ts
  const performPaste = useCallback(async (mode: "copy" | "cut", sourcePath: string, destinationDirectory: string, conflict: "error" | "overwrite" | "keep-both") => {
    const type = mode === "copy" ? "copy" : "move";
    const requestId = mutationRequestRef.current += 1;
    setMutationBusy(true); setMutationError(null);
    try {
      if (mode === "cut" && sameFilePath(getFileDirectory(sourcePath), destinationDirectory)) {
        setClipboard(null);
        return;
      }
      const result = await requestFileMutation(sourcePath, type, { destinationDirectory, conflict });
      setTreeRefreshKey((key) => key + 1);
      if (result.destinationPath) setHighlightedPaths(new Set([result.destinationPath]));
      if (mode === "cut") setClipboard(null);
    }
    catch (cause) {
      if (requestId === mutationRequestRef.current) {
        if (cause instanceof FileMutationServerError && cause.status === 409 && conflict === "error") {
          setPasteConflict({ type, sourcePath, destinationDirectory, name: getFileName(sourcePath) });
        } else {
          setMutationError(cause instanceof FileMutationServerError ? cause.message : t("files.operationFailed"));
        }
      }
    }
    finally {
      if (requestId === mutationRequestRef.current) setMutationBusy(false);
    }
  }, [t]);
```

3f. Add the keyboard handler after `performPaste`:

```ts
  const handleExplorerKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x" && key !== "v") return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    event.preventDefault();
    if (key === "c") {
      if (lastContextEntry) setClipboard({ path: lastContextEntry.path, mode: "copy" });
      return;
    }
    if (key === "x") {
      if (lastContextEntry) setClipboard({ path: lastContextEntry.path, mode: "cut" });
      return;
    }
    if (!clipboard || mutationBusy) return;
    const destinationDirectory = pasteDestinationDirectory;
    if (!destinationDirectory) return;
    void performPaste(clipboard.mode, clipboard.path, destinationDirectory, "error");
  }, [clipboard, lastContextEntry, mutationBusy, pasteDestinationDirectory, performPaste]);
```

3g. Make the explorer container focusable and wire the handler. The outermost returned `<div style={{ minHeight: "100%", position: "relative" }} ...>` becomes:

```tsx
    <div
      tabIndex={0}
      onKeyDown={handleExplorerKeyDown}
      style={{ minHeight: "100%", position: "relative", outline: "none" }}
```

3h. Add the Paste context-menu item after the delete button's closing `</>` (shown only for directories and roots; disabled without a clipboard entry):

```tsx
          {contextMenu.target.isDir && (
            <button type="button" role="menuitem" disabled={mutationBusy || !clipboard} onClick={() => { const entry = clipboard; setContextMenu(null); if (entry) void performPaste(entry.mode, entry.path, contextMenu.target.fullPath, "error"); }} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t("files.paste")}</button>
          )}
```

3i. Add the conflict dialog right after the `{pendingMutation && (...)}` block, before the component's closing `</div>`:

```tsx
      {pasteConflict && (
        <div role="dialog" aria-modal="true" aria-label={t("files.conflictTitle")} style={{ position: "fixed", inset: 0, zIndex: 31, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)" }}>
          <div onKeyDown={(event) => { if (event.key === "Escape") setPasteConflict(null); }} style={{ width: 320, padding: 16, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)" }}>
            <div style={{ marginBottom: 6, color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("files.conflictTitle")}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" }}>{t("files.conflictMessage", { name: pasteConflict.name })}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button type="button" disabled={mutationBusy} onClick={() => setPasteConflict(null)}>{t("i18n.cancel")}</button>
              <button type="button" disabled={mutationBusy} onClick={() => { const conflict = pasteConflict; setPasteConflict(null); void performPaste(conflict.type === "copy" ? "copy" : "cut", conflict.sourcePath, conflict.destinationDirectory, "keep-both"); }}>{t("files.conflictKeepBoth")}</button>
              <button type="button" disabled={mutationBusy} onClick={() => { const conflict = pasteConflict; setPasteConflict(null); void performPaste(conflict.type === "copy" ? "copy" : "cut", conflict.sourcePath, conflict.destinationDirectory, "overwrite"); }}>{t("files.conflictOverwrite")}</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Add the i18n keys**

After the Task 2 keys in each locale:

`en.ts`:
```ts
    "files.paste": "Paste",
    "files.conflictTitle": "Name already exists",
    "files.conflictMessage": "\"{name}\" already exists in the destination folder.",
    "files.conflictOverwrite": "Overwrite",
    "files.conflictKeepBoth": "Keep both",
```
`zh-CN.ts`:
```ts
    "files.paste": "粘贴",
    "files.conflictTitle": "同名文件已存在",
    "files.conflictMessage": "目标文件夹中已存在“{name}”。",
    "files.conflictOverwrite": "覆盖",
    "files.conflictKeepBoth": "保留两者",
```
`zh-TW.ts`:
```ts
    "files.paste": "貼上",
    "files.conflictTitle": "同名檔案已存在",
    "files.conflictMessage": "目標資料夾中已存在「{name}」。",
    "files.conflictOverwrite": "覆蓋",
    "files.conflictKeepBoth": "保留兩者",
```

- [ ] **Step 5: Run to verify pass, then full verification and commit**

Run: `node --experimental-strip-types --test components/FileExplorer.mutations.test.mjs` — expect PASS.
Run the whole suite: `npm test` — expect PASS.
Run: `node_modules/.bin/tsc --noEmit` — expect no errors.
Run: `npm run lint` — expect no new errors.

```bash
git add components/FileExplorer.tsx components/FileExplorer.mutations.test.mjs lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat(explorer): paste with keyboard shortcuts and name-conflict dialog"
```

- [ ] **Step 6: Manual smoke check (dev server)**

Start/inspect the dev server per AGENTS.md (`lsof -nP -iTCP:30141 -sTCP:LISTEN` first; reuse a healthy process). In the browser:
1. Right-click a file → Copy → right-click a folder → Paste — file appears highlighted.
2. Paste again into the same folder → dialog appears → Keep both creates `a copy 2.txt`.
3. Right-click → Cut (row dims) → Paste into another folder → row undims, file moved.
4. Focus the chat input and press ⌘V — text paste works, no explorer paste fires.
