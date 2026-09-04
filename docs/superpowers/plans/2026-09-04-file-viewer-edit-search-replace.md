# File Viewer Edit / Search / Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the right-hand file preview pane edit text files (save back to disk with conflict detection) and search/replace within the opened file.

**Architecture:** New `write` file mutation flows through the existing security-hardened `file-mutations.ts`. `TextFileViewer` gains an edit mode (plain `textarea`, no new deps) whose draft persists through the existing per-tab `FileViewerState` mechanism. Search/replace is a compact bar driven by pure helpers in `lib/file-search.ts`; read mode highlights matching rendered lines, edit mode drives textarea selections.

**Tech Stack:** React (existing), Node `fs`, `node:test` + `jiti`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-file-viewer-edit-search-replace-design.md`

## Global Constraints

- No new npm dependencies.
- `write` never creates files; only existing regular files inside allowed roots.
- Read limit is `TEXT_PREVIEW_MAX_BYTES` (256KB) — every successfully read text file is editable; no extra size gating.
- Conflict check compares `stat.mtimeMs` against client `baseMtimeMs`; `baseMtimeMs: null` forces the write.
- Never run `next build`; verify with `node_modules/.bin/tsc --noEmit`, `npm run lint`, `npm test`.
- Test conventions: lib tests import TS via type-stripping or `jiti`; component tests are source-structure assertions (`functionBlock` pattern, see `components/FileViewer.state.test.mjs`).
- All user-facing strings are i18n keys added to all three files: `lib/i18n/messages/en.ts`, `zh-CN.ts`, `zh-TW.ts`.
- Commit style: `feat(file-viewer): ...`.

---

### Task 1: Pure search helpers (`lib/file-search.ts`)

**Files:**
- Create: `lib/file-search.ts`
- Test: `lib/file-search.test.mjs`

**Interfaces (used by Task 6):**
- `interface SearchMatch { line: number; start: number; end: number }` — `line` 1-based; `start`/`end` UTF-16 offsets.
- `findMatches(content: string, query: string, caseSensitive: boolean): SearchMatch[]` — sorted, non-overlapping, `[]` for empty query.
- `replaceOne(content: string, match: SearchMatch, replacement: string): string`
- `replaceAll(content: string, matches: SearchMatch[], replacement: string): { content: string; count: number }`

- [ ] **Step 1: Write the failing tests** — create `lib/file-search.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { findMatches, replaceAll, replaceOne } from "./file-search.ts";

test("findMatches locates plain-text matches with 1-based line numbers", () => {
  const content = "alpha\nbeta\ngamma beta";
  assert.deepEqual(findMatches(content, "beta", true), [
    { line: 2, start: 6, end: 10 },
    { line: 3, start: 17, end: 21 },
  ]);
});

test("empty query yields no matches", () => {
  assert.deepEqual(findMatches("anything", "", true), []);
  assert.deepEqual(findMatches("", "x", true), []);
});

test("case-insensitive matching folds ASCII case only", () => {
  const content = "Foo FOO fö";
  assert.deepEqual(
    findMatches(content, "foo", false).map((m) => [m.start, m.end]),
    [[0, 3], [4, 7]],
  );
  assert.deepEqual(findMatches(content, "foo", true), [{ line: 1, start: 4, end: 7 }]);
});

test("matches never overlap", () => {
  assert.deepEqual(findMatches("aaaa", "aa", true), [
    { line: 1, start: 0, end: 2 },
    { line: 1, start: 2, end: 4 },
  ]);
});

test("replaceOne splices a single match", () => {
  const content = "alpha beta gamma";
  const match = findMatches(content, "beta", true)[0];
  assert.equal(replaceOne(content, match, "B"), "alpha B gamma");
});

test("replaceAll replaces every match and reports the count", () => {
  const content = "aXbXc";
  const matches = findMatches(content, "X", true);
  assert.deepEqual(replaceAll(content, matches, "YY"), { content: "aYYbYYc", count: 2 });
  assert.deepEqual(replaceAll(content, [], "YY"), { content, count: 0 });
});

test("replacement containing the query does not loop or corrupt", () => {
  const content = "a b a";
  const matches = findMatches(content, "a", true);
  const result = replaceAll(content, matches, "a");
  assert.equal(result.content, "a b a");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test lib/file-search.test.mjs`
Expected: FAIL — Cannot find module `./file-search.ts`.

- [ ] **Step 3: Write the implementation** — create `lib/file-search.ts`:

```ts
/**
 * Pure in-file search helpers shared by the file viewer's search bar.
 * Case-insensitive matching folds ASCII letters only: it is length-preserving
 * (offsets always index the original string) and predictable for code.
 */

export interface SearchMatch {
  /** 1-based source line of the match. */
  line: number;
  /** Inclusive UTF-16 start offset into the original content. */
  start: number;
  /** Exclusive UTF-16 end offset into the original content. */
  end: number;
}

const ASCII_UPPER_A = 65;
const ASCII_UPPER_Z = 90;
const ASCII_CASE_DELTA = 32;

function foldCharCode(code: number): number {
  return code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z ? code + ASCII_CASE_DELTA : code;
}

function countNewlinesBetween(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  return count;
}

function foldMatchesAt(text: string, offset: number, query: string): boolean {
  for (let index = 0; index < query.length; index++) {
    const a = text.charCodeAt(offset + index);
    const b = query.charCodeAt(index);
    if (a !== b && foldCharCode(a) !== foldCharCode(b)) return false;
  }
  return true;
}

export function findMatches(content: string, query: string, caseSensitive: boolean): SearchMatch[] {
  if (query.length === 0 || query.length > content.length) return [];

  const matches: SearchMatch[] = [];
  const lastStart = content.length - query.length;
  let line = 1;
  let cursor = 0;

  scan: while (cursor <= lastStart) {
    if (caseSensitive) {
      const index = content.indexOf(query, cursor);
      if (index === -1) return matches;
      line += countNewlinesBetween(content, cursor, index);
      matches.push({ line, start: index, end: index + query.length });
      cursor = index + query.length;
      continue;
    }
    for (let index = cursor; index <= lastStart; index++) {
      if (foldMatchesAt(content, index, query)) {
        line += countNewlinesBetween(content, cursor, index);
        matches.push({ line, start: index, end: index + query.length });
        cursor = index + query.length;
        continue scan;
      }
    }
    return matches;
  }
  return matches;
}

export function replaceOne(content: string, match: SearchMatch, replacement: string): string {
  return content.slice(0, match.start) + replacement + content.slice(match.end);
}

export function replaceAll(
  content: string,
  matches: SearchMatch[],
  replacement: string,
): { content: string; count: number } {
  if (matches.length === 0) return { content, count: 0 };
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(content.slice(cursor, match.start), replacement);
    cursor = match.end;
  }
  parts.push(content.slice(cursor));
  return { content: parts.join(""), count: matches.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test lib/file-search.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/file-search.ts lib/file-search.test.mjs
git commit -m "feat(file-viewer): add pure in-file search helpers"
```

---

### Task 2: `write` mutation (`lib/file-mutations.ts`)

**Files:**
- Modify: `lib/file-mutations.ts`
- Test: `lib/file-mutations.test.mjs` (extend)

**Interfaces (used by Task 3):**
- `FileMutation` gains `{ type: "write"; sourcePath: string; content: string; baseMtimeMs: number | null }`.
- `FileMutationResult` gains optional `mtimeMs?: number; size?: number`.
- 409 = conflict (disk mtime ≠ `baseMtimeMs`); `baseMtimeMs: null` skips the check.

- [ ] **Step 1: Write the failing tests** — append to `lib/file-mutations.test.mjs` (same `fixture` helper and existing imports of `mutateFile`, `FileMutationError`, `fs`, `os`, `path`):

```js
test("writes existing files and returns the new mtime and size", (t) => {
  const { root, roots } = fixture(t);
  const target = path.join(root, "notes.md");
  fs.writeFileSync(target, "old");

  const result = mutateFile(
    { type: "write", sourcePath: target, content: "# new\n", baseMtimeMs: null },
    roots,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "# new\n");
  assert.equal(result.sourcePath, target);
  assert.equal(result.size, 6);
  assert.equal(typeof result.mtimeMs, "number");
});

test("write rejects a stale base mtime with 409", (t) => {
  const { root, roots } = fixture(t);
  const target = path.join(root, "conflict.txt");
  fs.writeFileSync(target, "one");
  const baseMtimeMs = fs.statSync(target).mtimeMs;
  // Simulate an external modification after the client read the file.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(target, later, later);

  assert.throws(
    () => mutateFile({ type: "write", sourcePath: target, content: "two", baseMtimeMs }, roots),
    (error) => error instanceof FileMutationError && error.status === 409,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "one");

  mutateFile({ type: "write", sourcePath: target, content: "two", baseMtimeMs: null }, roots);
  assert.equal(fs.readFileSync(target, "utf8"), "two");
});

test("write validates the target", (t) => {
  const { root, roots } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  assert.throws(
    () => mutateFile({ type: "write", sourcePath: path.join(root, "missing.txt"), content: "x", baseMtimeMs: null }, roots),
    (error) => error.status === 404,
  );
  const directory = path.join(root, "dir");
  fs.mkdirSync(directory);
  assert.throws(
    () => mutateFile({ type: "write", sourcePath: directory, content: "x", baseMtimeMs: null }, roots),
    (error) => error.status === 400,
  );
  assert.throws(
    () => mutateFile({ type: "write", sourcePath: path.join(outside, "nope.txt"), content: "x", baseMtimeMs: null }, roots),
    (error) => error.status === 403,
  );
});

test("write refuses to follow a symlink that escapes the allowed roots", (t) => {
  const { root, roots } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, "victim.txt");
  fs.writeFileSync(outsideFile, "victim");
  fs.symlinkSync(outsideFile, path.join(root, "link.txt"));

  assert.throws(
    () => mutateFile({ type: "write", sourcePath: path.join(root, "link.txt"), content: "hijack", baseMtimeMs: null }, roots),
    (error) => error.status === 403,
  );
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "victim");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test lib/file-mutations.test.mjs`
Expected: FAIL — `write` mutations are not handled.

- [ ] **Step 3: Implement**

In `lib/file-mutations.ts`:

3a. Extend the union at the top:

```ts
export type FileMutation =
  | { type: "create-file" | "create-directory"; directory: string; name: string }
  | { type: "rename"; sourcePath: string; name: string }
  | { type: "move"; sourcePath: string; destinationDirectory: string }
  | { type: "delete"; sourcePath: string }
  | { type: "write"; sourcePath: string; content: string; baseMtimeMs: number | null };
```

3b. Extend the result type:

```ts
export type FileMutationResult = {
  sourcePath: string;
  destinationPath?: string;
  deleted: boolean;
  mtimeMs?: number;
  size?: number;
};
```

3c. In `executeMutation`, add a `write` branch immediately after the `"directory" in mutation` block and before the `delete` branch:

```ts
  if (mutation.type === "write") {
    if (!isFilePathAllowed(mutation.sourcePath, allowedRoots)) {
      throw new FileMutationError(403, "Access denied");
    }
    // statSync before the canonical check so a missing file maps to 404
    // (via the ENOENT mapping in mutateFile) instead of a misleading 403.
    const stat = fs.statSync(mutation.sourcePath);
    // Resolves symlinks: an in-root link pointing outside the roots is 403,
    // so writes always land on a canonical in-root regular file.
    if (!isExistingFilePathAllowed(mutation.sourcePath, allowedRoots)) {
      throw new FileMutationError(403, "Access denied");
    }
    if (!stat.isFile()) {
      throw new FileMutationError(400, "Target is not a file");
    }
    if (mutation.baseMtimeMs !== null && stat.mtimeMs !== mutation.baseMtimeMs) {
      throw new FileMutationError(409, "File changed on disk since it was read");
    }
    fs.writeFileSync(mutation.sourcePath, mutation.content, "utf-8");
    const nextStat = fs.statSync(mutation.sourcePath);
    return { sourcePath: mutation.sourcePath, deleted: false, mtimeMs: nextStat.mtimeMs, size: nextStat.size };
  }
```

> Note: a broken symlink also surfaces as 404 here (statSync ENOENT) — an accepted, documented behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test lib/file-mutations.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/file-mutations.ts lib/file-mutations.test.mjs
git commit -m "feat(file-viewer): add conflict-checked write file mutation"
```

---

### Task 3: Route wiring — `read` mtime + `write` POST

**Files:**
- Modify: `app/api/files/[...path]/route.ts`
- Test: `app/api/files/files-write-route.test.mjs` (create)

**Interfaces (used by Task 5):**
- `GET …?type=read` response gains `mtimeMs: stat.mtimeMs`.
- `POST …?type=write` accepts JSON `{ content: string; baseMtimeMs: number | null }`; 200 → `FileMutationResult`; 409/413/400/403/404 → `{ error }`.

- [ ] **Step 1: Write the failing route test** — create `app/api/files/files-write-route.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, GET } = await jiti.import("./route.ts");
const { NextRequest } = await jiti.import("next/server");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-write-route-"));
  allowFileRoot(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function postWrite(filePath, body) {
  const segments = filePath.split("/").filter(Boolean).map(encodeURIComponent);
  const url = `http://localhost/api/files/${segments.join("/")}?type=write`;
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

function routeContext(filePath) {
  return { params: Promise.resolve({ path: filePath.split("/").filter(Boolean) }) };
}

test("write saves content and reports the new mtime", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "a.md");
  fs.writeFileSync(target, "old");

  const response = await POST(postWrite(target, { content: "fresh\n", baseMtimeMs: null }), routeContext(target));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(fs.readFileSync(target, "utf8"), "fresh\n");
  assert.equal(payload.size, 6);
  assert.equal(typeof payload.mtimeMs, "number");
});

test("write returns 409 when the disk mtime moved after the client read", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "conflict.txt");
  fs.writeFileSync(target, "one");
  const baseMtimeMs = fs.statSync(target).mtimeMs;
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(target, later, later);

  const response = await POST(postWrite(target, { content: "two", baseMtimeMs }), routeContext(target));
  assert.equal(response.status, 409);
  assert.equal(fs.readFileSync(target, "utf8"), "one");
});

test("write validates the payload and target", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "b.txt");
  fs.writeFileSync(target, "");

  const invalidContent = await POST(postWrite(target, { content: 5, baseMtimeMs: null }), routeContext(target));
  assert.equal(invalidContent.status, 400);

  const invalidMtime = await POST(postWrite(target, { content: "x", baseMtimeMs: "yesterday" }), routeContext(target));
  assert.equal(invalidMtime.status, 400);

  const missingPath = path.join(root, "missing.txt");
  const missing = await POST(postWrite(missingPath, { content: "x", baseMtimeMs: null }), routeContext(missingPath));
  assert.equal(missing.status, 404);
});

test("write rejects oversized bodies with 413", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "big.txt");
  fs.writeFileSync(target, "");
  const big = "x".repeat(2 * 1024 * 1024);

  const response = await POST(postWrite(target, { content: big, baseMtimeMs: null }), routeContext(target));
  assert.equal(response.status, 413);
});

test("read responses include mtimeMs for conflict detection", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "c.txt");
  fs.writeFileSync(target, "hello");

  const segments = target.split("/").filter(Boolean).map(encodeURIComponent);
  const request = new NextRequest(`http://localhost/api/files/${segments.join("/")}?type=read`, {
    headers: { Host: "localhost" },
  });
  const response = await GET(request, routeContext(target));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.content, "hello");
  assert.equal(typeof payload.mtimeMs, "number");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test app/api/files/files-write-route.test.mjs`
Expected: FAIL — write returns 400 "Invalid file request type"; read payload lacks `mtimeMs`.

- [ ] **Step 3: Wire the route** — in `app/api/files/[...path]/route.ts`:

3a. Add `"write"` to the mutation type list:

```ts
const FILE_MUTATION_TYPES = ["create-file", "create-directory", "rename", "move", "delete", "write"] as const;
```

(`FILE_POST_REQUEST_TYPE_SET` spreads `FILE_MUTATION_TYPES` — no change needed there.)

3b. Add a body bound next to the other MAX_* constants:

```ts
// Text writes are bounded by the 256KB read limit; 2MB of JSON body leaves
// generous room for JSON escaping and multibyte characters.
const MAX_WRITE_BODY_CHARS = 2 * 1024 * 1024;
```

3c. Extend `parseMutation` — insert before the final `return { type, sourcePath: filePath };`:

```ts
  if (type === "write") {
    if (typeof input.content !== "string") {
      throw new FileMutationError(400, "content must be a string");
    }
    if (input.baseMtimeMs !== null && typeof input.baseMtimeMs !== "number") {
      throw new FileMutationError(400, "baseMtimeMs must be a number or null");
    }
    return { type, sourcePath: filePath, content: input.content, baseMtimeMs: input.baseMtimeMs };
  }
```

3d. In `POST`, replace the mutation branch with a bounded read for writes:

```ts
    const mutationType = parseFileMutationType(type);
    if (mutationType) {
      let body: unknown = null;
      if (mutationType === "write") {
        const raw = await request.text();
        if (raw.length > MAX_WRITE_BODY_CHARS) {
          return NextResponse.json({ error: "File content must be 2MB or less" }, { status: 413 });
        }
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      } else {
        body = await request.json().catch(() => null);
      }
      const mutation = parseMutation(mutationType, filePathFromSegments(segments), body);
      const allowedRoots = await getAllowedFileRoots();
      const result = mutateFile(mutation, allowedRoots);
      return NextResponse.json(result);
    }
```

3e. In the `read` handler, return the mtime:

```ts
      const content = fs.readFileSync(filePath, "utf-8");
      const language = getLanguage(filePath);
      return NextResponse.json({ content, language, size: stat.size, mtimeMs: stat.mtimeMs });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test app/api/files/files-write-route.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/api/files/[...path]/route.ts" app/api/files/files-write-route.test.mjs
git commit -m "feat(file-viewer): expose conflict-checked write endpoint and read mtime"
```

---

### Task 4: Viewer state draft fields (`lib/file-viewer-state.ts`)

**Files:**
- Modify: `lib/file-viewer-state.ts`
- Test: `lib/file-viewer-state.test.mjs` (extend)

**Interfaces (used by Task 5):**
- `FileViewerState.draft?: string | null`, `FileViewerState.baseMtimeMs?: number | null`.
- `resolveInitialDraft(state?: FileViewerState): string | null`
- `resolveInitialBaseMtimeMs(state?: FileViewerState): number | null`

- [ ] **Step 1: Write the failing tests** — replace the import line and append to `lib/file-viewer-state.test.mjs`:

```js
import {
  resolveInitialBaseMtimeMs,
  resolveInitialDraft,
  resolveInitialFileDisplayMode,
} from "./file-viewer-state.ts";

test("initial draft and base mtime restore only well-formed values", () => {
  const state = { displayMode: "source", wrapLines: false, scrollTop: 0, scrollLeft: 0, draft: "partial edit", baseMtimeMs: 1234.5 };
  assert.equal(resolveInitialDraft(state), "partial edit");
  assert.equal(resolveInitialBaseMtimeMs(state), 1234.5);

  const withoutDraft = { displayMode: "source", wrapLines: false, scrollTop: 0, scrollLeft: 0, draft: null, baseMtimeMs: "x" };
  assert.equal(resolveInitialDraft(withoutDraft), null);
  assert.equal(resolveInitialBaseMtimeMs(withoutDraft), null);
  assert.equal(resolveInitialDraft(undefined), null);
  assert.equal(resolveInitialBaseMtimeMs(undefined), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test lib/file-viewer-state.test.mjs`
Expected: FAIL — `resolveInitialDraft` is not exported.

- [ ] **Step 3: Implement** — replace the contents of `lib/file-viewer-state.ts` with:

```ts
export type FileViewerDisplayMode = "source" | "preview" | "diff";

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
  /**
   * In-progress editor text; null/absent when the viewer is not editing.
   * Persisted per file tab so switching tabs never loses unsaved edits.
   */
  draft?: string | null;
  /**
   * Disk mtime the draft was last known to be based on. Used for save
   * conflict detection (the server compares it against the current mtime).
   */
  baseMtimeMs?: number | null;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}

export function resolveInitialDraft(initialState?: FileViewerState): string | null {
  return typeof initialState?.draft === "string" ? initialState.draft : null;
}

export function resolveInitialBaseMtimeMs(initialState?: FileViewerState): number | null {
  return typeof initialState?.baseMtimeMs === "number" ? initialState.baseMtimeMs : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test lib/file-viewer-state.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/file-viewer-state.ts lib/file-viewer-state.test.mjs
git commit -m "feat(file-viewer): persist editor draft and base mtime in viewer state"
```

---

### Task 5: Edit mode in `TextFileViewer`

**Files:**
- Modify: `components/FileViewer.tsx`, `app/globals.css`, `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`
- Test: `components/FileViewer.edit.test.mjs` (create)

**Interfaces:**
- Consumes: Task 2/3 (write endpoint; read `mtimeMs`), Task 4 (draft resolvers).
- Produces (used by Task 6): inside `TextFileViewer` — `isEditing`, `dirty`, `editorText`, `editorRef`, `updateEditorText(next: string)`, `dirtyRef`; i18n keys below.

- [ ] **Step 1: Add i18n keys** — run `grep -n '"i18n.saved"' lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts` and insert these keys immediately after the `"i18n.saved"` line in each file:

en.ts:

```ts
    "i18n.editFile": "Edit",
    "i18n.doneEditing": "Done",
    "i18n.unsavedChanges": "Unsaved changes",
    "i18n.confirmDiscard": "Discard unsaved changes?",
    "i18n.fileChangedOnDisk": "File changed on disk since it was opened.",
    "i18n.overwrite": "Overwrite",
    "i18n.reloadFile": "Reload",
    "i18n.saveFailed": "Save failed",
```

zh-CN.ts:

```ts
    "i18n.editFile": "编辑",
    "i18n.doneEditing": "完成",
    "i18n.unsavedChanges": "未保存的修改",
    "i18n.confirmDiscard": "放弃未保存的修改？",
    "i18n.fileChangedOnDisk": "文件在打开后被外部修改。",
    "i18n.overwrite": "覆盖写入",
    "i18n.reloadFile": "重新加载",
    "i18n.saveFailed": "保存失败",
```

zh-TW.ts:

```ts
    "i18n.editFile": "編輯",
    "i18n.doneEditing": "完成",
    "i18n.unsavedChanges": "未儲存的修改",
    "i18n.confirmDiscard": "放棄未儲存的修改？",
    "i18n.fileChangedOnDisk": "檔案在開啟後被外部修改。",
    "i18n.overwrite": "覆蓋寫入",
    "i18n.reloadFile": "重新載入",
    "i18n.saveFailed": "儲存失敗",
```

- [ ] **Step 2: Add CSS** — append to `app/globals.css`:

```css
/* File viewer: edit mode + save state */
.file-viewer-dirty-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
}

.file-viewer-conflict-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  background: #450a0a;
  color: #fecaca;
  border-bottom: 1px solid #7f1d1d;
  flex-shrink: 0;
}

.file-viewer-conflict-banner button {
  border: 1px solid #7f1d1d;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  background: transparent;
  color: #fecaca;
  cursor: pointer;
}

.file-viewer-conflict-banner button:hover {
  background: #7f1d1d;
}
```

- [ ] **Step 3: Extend types and helpers in `components/FileViewer.tsx`**

3a. `FileData` gains the read mtime:

```ts
interface FileData {
  content: string;
  language: string;
  size: number;
  mtimeMs: number;
}
```

3b. `getFileApiUrl` type union gains `"write"`:

```ts
function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch" | "write",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
```

3c. Update the `@/lib/file-viewer-state` import:

```ts
import {
  resolveInitialBaseMtimeMs,
  resolveInitialDraft,
  resolveInitialFileDisplayMode,
  type FileViewerDisplayMode as DisplayMode,
  type FileViewerState,
} from "@/lib/file-viewer-state";
```

- [ ] **Step 4: Add edit state to `TextFileViewer`**

4a. Next to the other initial-value consts (before `viewerStateRef`):

```ts
  const initialDraft = resolveInitialDraft(initialState);
  const initialBaseMtimeMs = resolveInitialBaseMtimeMs(initialState);
```

4b. Extend `viewerStateRef` initialization:

```ts
  const viewerStateRef = useRef<FileViewerState>({
    displayMode: requestedInitialDisplayMode,
    wrapLines: initialWrapLines,
    scrollTop: initialScrollTop,
    scrollLeft: initialScrollLeft,
    draft: initialDraft,
    baseMtimeMs: initialBaseMtimeMs,
  });
```

4c. After `const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);` add:

```ts
  const [editorText, setEditorText] = useState<string | null>(initialDraft);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const editorGutterRef = useRef<HTMLDivElement | null>(null);
  const isEditing = editorText !== null;
```

4d. Replace the identity-reset effect (the one keyed on `filePath`) with:

```ts
  useEffect(() => {
    const nextState: FileViewerState = {
      displayMode: requestedInitialDisplayMode,
      wrapLines: initialWrapLines,
      scrollTop: initialScrollTop,
      scrollLeft: initialScrollLeft,
      draft: initialDraft,
      baseMtimeMs: initialBaseMtimeMs,
    };

    viewerStateRef.current = nextState;
    scrollRestorePendingRef.current = true;
    autoDiffAppliedRef.current = false;
    setDisplayMode(requestedInitialDisplayMode);
    setWrapLines(initialWrapLines);
    setEditorText(initialDraft);

    return () => {
      onStateChangeRef.current?.({ ...viewerStateRef.current });
    };
  }, [
    filePath,
    sourceSessionId,
    requestedInitialDisplayMode,
    initialWrapLines,
    initialScrollTop,
    initialScrollLeft,
    initialDraft,
    initialBaseMtimeMs,
  ]);
```

- [ ] **Step 5: Add edit callbacks** — after `toggleWrapLines` insert:

```ts
  const dirty = editorText !== null && editorText !== (data?.content ?? "");
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const persistViewerState = useCallback(() => {
    onStateChangeRef.current?.({ ...viewerStateRef.current });
  }, []);

  const updateEditorText = useCallback((next: string) => {
    setEditorText(next);
    viewerStateRef.current.draft = next;
    persistViewerState();
  }, [persistViewerState]);

  const enterEditMode = useCallback(() => {
    if (!data) return;
    updateDisplayMode("source");
    setSaveConflict(false);
    setSaveError(null);
    setEditorText(data.content);
    viewerStateRef.current.draft = data.content;
    persistViewerState();
  }, [data, persistViewerState, updateDisplayMode]);

  const exitEditMode = useCallback(() => {
    if (viewerStateRef.current.draft !== null && viewerStateRef.current.draft !== (data?.content ?? "")) {
      if (!window.confirm(t("i18n.confirmDiscard"))) return;
    }
    setEditorText(null);
    viewerStateRef.current.draft = null;
    setSaveConflict(false);
    setSaveError(null);
    persistViewerState();
  }, [data?.content, persistViewerState, t]);

  const reloadFromDisk = useCallback(() => {
    setEditorText(null);
    viewerStateRef.current.draft = null;
    setSaveConflict(false);
    setSaveError(null);
    void fetchContent(filePath);
  }, [fetchContent, filePath]);

  const saveDraft = useCallback(async (options: { force?: boolean } = {}) => {
    const currentDraft = editorText;
    if (currentDraft === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(getFileApiUrl(filePath, "write", sourceSessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: currentDraft,
          baseMtimeMs: options.force ? null : viewerStateRef.current.baseMtimeMs,
        }),
      });
      if (response.status === 409) {
        setSaveConflict(true);
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        setSaveError(payload?.error ?? t("i18n.saveFailed"));
        return;
      }
      const result = await response.json() as { mtimeMs?: number; size?: number };
      viewerStateRef.current.baseMtimeMs = result.mtimeMs ?? viewerStateRef.current.baseMtimeMs;
      setData((current) => (current
        ? { ...current, content: currentDraft, size: result.size ?? current.size }
        : current));
      setSaveConflict(false);
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  }, [editorText, filePath, saving, sourceSessionId, t]);
```

- [ ] **Step 6: Capture the read mtime and suppress live reload while dirty**

6a. In `fetchContent`'s success handler, replace `setError(null); setData(d); return d;` with:

```ts
        setError(null);
        setData(d);
        // Draft absent → adopt the fresh disk mtime. Draft present and equal
        // to disk → clean editor, refresh the base too. Draft present and
        // different → the draft's persisted base stays authoritative so a
        // stale save conflicts instead of silently overwriting.
        const currentDraft = viewerStateRef.current.draft;
        if (currentDraft === null || currentDraft === d.content) {
          viewerStateRef.current.baseMtimeMs = d.mtimeMs;
        }
        return d;
```

6b. In the watch effect's `synchronize`, add the dirty guard as the first line:

```ts
    const synchronize = () => {
      if (dirtyRef.current) return; // never clobber in-progress edits
      void fetchContent(filePath);
      void fetchGitDiff(filePath);
    };
```

6c. Add a `Cmd/Ctrl+S` effect after the existing Cmd+I mention effect:

```ts
  useEffect(() => {
    if (!isEditing) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveDraft();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, saveDraft]);
```

6d. Add a `beforeunload` guard effect:

```ts
  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);
```

- [ ] **Step 7: Toolbar buttons and dirty dot**

7a. Dirty dot — insert immediately after the metadata `<span className="file-viewer-meta" …>…</span>`:

```tsx
        {dirty && (
          <span
            className="file-viewer-dirty-dot"
            title={t("i18n.unsavedChanges")}
            aria-label={t("i18n.unsavedChanges")}
          />
        )}
```

7b. Hide the mention button while editing — change its guard to:

```tsx
            {!isEditing && (onAtMention || onMentionLines) && (
```

7c. Hide the wrap toggle while editing — change its guard to:

```tsx
            {effectiveDisplayMode === "source" && !isEditing && (
```

7d. At the start of the `file-viewer-actions` div (before the mention button block), insert:

```tsx
            {!isDeletedDiff && (isEditing ? (
              <>
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={!dirty || saving}
                  className="file-viewer-mode-button"
                  style={{
                    background: dirty ? "var(--bg-selected)" : "transparent",
                    color: dirty ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  {saving ? t("i18n.saving") : t("i18n.save")}
                </button>
                <button
                  type="button"
                  onClick={exitEditMode}
                  disabled={saving}
                  className="file-viewer-mode-button"
                >
                  {t("i18n.doneEditing")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={enterEditMode}
                className="file-viewer-mode-button"
                title={t("i18n.editFile")}
                aria-label={t("i18n.editFile")}
              >
                {t("i18n.editFile")}
              </button>
            ))}
```

- [ ] **Step 8: Banners and editor pane**

8a. Insert between the toolbar's closing `</div>` and the `{/* Content area */}` comment:

```tsx
      {saveConflict && (
        <div className="file-viewer-conflict-banner" role="alert">
          <span style={{ flex: 1 }}>{t("i18n.fileChangedOnDisk")}</span>
          <button type="button" onClick={reloadFromDisk}>{t("i18n.reloadFile")}</button>
          <button type="button" onClick={() => void saveDraft({ force: true })}>{t("i18n.overwrite")}</button>
        </div>
      )}
      {saveError && !saveConflict && (
        <div className="file-viewer-conflict-banner" role="alert">
          <span style={{ flex: 1 }}>{saveError}</span>
          <button type="button" onClick={() => setSaveError(null)}>{t("i18n.cancel")}</button>
        </div>
      )}
```

8b. Make the editor the first branch of the content area — change the opening ternary `{effectiveDisplayMode === "diff" && hasGitDiff ? (` to:

```tsx
        {isEditing ? (
          <div className="file-editor" style={{ display: "flex", width: "100%", height: "100%", background: "var(--bg)" }}>
            <div
              aria-hidden="true"
              ref={editorGutterRef}
              className="file-editor-gutter"
              style={{
                flexShrink: 0,
                overflow: "hidden",
                padding: "12px 0",
                textAlign: "right",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontVariantNumeric: "tabular-nums",
                lineHeight: "20.8px",
                userSelect: "none",
                width: 48,
              }}
            >
              {(editorText ?? "").split("\n").map((_line, lineIndex) => (
                <div key={`editor-line-${lineIndex}`} style={{ paddingRight: 10 }}>{lineIndex + 1}</div>
              ))}
            </div>
            <textarea
              ref={editorRef}
              className="file-editor-textarea"
              value={editorText ?? ""}
              onChange={(event) => updateEditorText(event.target.value)}
              onScroll={(event) => {
                if (editorGutterRef.current) {
                  editorGutterRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              spellCheck={false}
              wrap="off"
              aria-label={getRelativeFilePath(filePath, cwd)}
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                outline: "none",
                resize: "none",
                padding: "12px 16px",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                lineHeight: "20.8px",
                whiteSpace: "pre",
                overflow: "auto",
                tabSize: 4,
              }}
            />
          </div>
        ) : effectiveDisplayMode === "diff" && hasGitDiff ? (
```

- [ ] **Step 9: Write the component structure test** — create `components/FileViewer.edit.test.mjs`:

```js
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

test("TextFileViewer saves drafts through the write endpoint with conflict base", () => {
  assert.match(textViewer, /getFileApiUrl\(filePath, "write", sourceSessionId\)/);
  assert.match(textViewer, /baseMtimeMs: options\.force \? null : viewerStateRef\.current\.baseMtimeMs/);
  assert.match(textViewer, /response\.status === 409/);
});

test("TextFileViewer keeps edits safe from live reload and navigation", () => {
  assert.match(textViewer, /if \(dirtyRef\.current\) return;/);
  assert.match(textViewer, /addEventListener\("beforeunload"/);
  assert.match(textViewer, /draft: initialDraft/);
  assert.match(textViewer, /baseMtimeMs: initialBaseMtimeMs/);
});

test("TextFileViewer renders edit controls, dirty dot, and conflict banner", () => {
  assert.match(textViewer, /onClick=\{enterEditMode\}/);
  assert.match(textViewer, /onClick=\{exitEditMode\}/);
  assert.match(textViewer, /className="file-viewer-dirty-dot"/);
  assert.match(textViewer, /file-viewer-conflict-banner/);
  assert.match(textViewer, /reloadFromDisk/);
  assert.match(textViewer, /saveDraft\(\{ force: true \}\)/);
  assert.match(textViewer, /event\.key\.toLowerCase\(\) === "s"/);
});

test("edit styles exist", () => {
  assert.match(cssSource, /\.file-viewer-dirty-dot \{/);
  assert.match(cssSource, /\.file-viewer-conflict-banner \{/);
});
```

- [ ] **Step 10: Verify**

```bash
node --experimental-strip-types --test components/FileViewer.edit.test.mjs components/FileViewer.state.test.mjs components/FileViewer.test.mjs
node_modules/.bin/tsc --noEmit
```
Expected: tests PASS, typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add components/FileViewer.tsx components/FileViewer.edit.test.mjs app/globals.css lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat(file-viewer): edit mode with conflict-checked save"
```

---

### Task 6: Search & replace bar

**Files:**
- Modify: `components/FileViewer.tsx`, `app/globals.css`, `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`
- Test: `components/FileViewer.search.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1 (`findMatches`, `replaceOne`, `replaceAll`), Task 5 (`isEditing`, `editorRef`, `editorText`, `updateEditorText`).
- Produces: search bar UI; read-mode highlight classes `.file-source-search-hit` / `.file-source-search-hit-active`.

> Hook placement rule: all new search state/effects/callbacks live in the hooks section of `TextFileViewer` (before the early `loading`/`error` returns). They must reference `data?.content`, never the render-body `content` const, to keep hook order unconditional.

- [ ] **Step 1: Add i18n keys** — insert after the `"i18n.saveFailed"` line from Task 5 in each of the three message files:

en.ts:

```ts
    "i18n.searchInFile": "Search in file",
    "i18n.matchCase": "Match case",
    "i18n.previousMatch": "Previous match",
    "i18n.nextMatch": "Next match",
    "i18n.noMatches": "No matches",
    "i18n.showReplace": "Toggle replace",
    "i18n.replaceWith": "Replace with",
    "i18n.replace": "Replace",
    "i18n.replaceAll": "Replace all",
    "i18n.closeSearch": "Close search",
```

zh-CN.ts:

```ts
    "i18n.searchInFile": "文件内搜索",
    "i18n.matchCase": "区分大小写",
    "i18n.previousMatch": "上一个匹配",
    "i18n.nextMatch": "下一个匹配",
    "i18n.noMatches": "没有匹配",
    "i18n.showReplace": "切换替换",
    "i18n.replaceWith": "替换为",
    "i18n.replace": "替换",
    "i18n.replaceAll": "全部替换",
    "i18n.closeSearch": "关闭搜索",
```

zh-TW.ts:

```ts
    "i18n.searchInFile": "檔案內搜尋",
    "i18n.matchCase": "區分大小寫",
    "i18n.previousMatch": "上一個符合",
    "i18n.nextMatch": "下一個符合",
    "i18n.noMatches": "沒有符合",
    "i18n.showReplace": "切換替換",
    "i18n.replaceWith": "替換為",
    "i18n.replace": "替換",
    "i18n.replaceAll": "全部替換",
    "i18n.closeSearch": "關閉搜尋",
```

- [ ] **Step 2: Add CSS** — append to `app/globals.css`:

```css
/* File viewer: search bar */
.file-search-input {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-family: var(--font-mono);
  outline: none;
  min-width: 0;
}

.file-search-input:focus {
  border-color: var(--accent);
}

.file-source-search-hit {
  background: rgba(245, 158, 11, 0.28);
}

.file-source-search-hit-active {
  background: rgba(245, 158, 11, 0.5);
  outline: 1px solid #f59e0b;
}
```

- [ ] **Step 3: Add the import** — in `components/FileViewer.tsx`:

```ts
import { findMatches, replaceAll, replaceOne } from "@/lib/file-search";
```

- [ ] **Step 4: Add search state and logic to `TextFileViewer`** (hooks section, after the Task 5 callbacks):

```ts
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [replaceVisible, setReplaceVisible] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const searchText = isEditing ? (editorText ?? "") : (data?.content ?? "");

  const searchMatches = useMemo(
    () => (searchOpen ? findMatches(searchText, searchQuery, searchCaseSensitive) : []),
    [searchCaseSensitive, searchOpen, searchQuery, searchText],
  );
  const clampedActiveIndex = searchMatches.length === 0
    ? 0
    : Math.min(activeMatchIndex, searchMatches.length - 1);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setActiveMatchIndex(0);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setReplaceVisible(false);
  }, []);

  const goToMatch = useCallback((index: number) => {
    if (searchMatches.length === 0) return;
    const nextIndex = ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
    setActiveMatchIndex(nextIndex);
    const match = searchMatches[nextIndex];
    if (isEditing) {
      const editor = editorRef.current;
      if (editor) {
        editor.focus();
        editor.setSelectionRange(match.start, match.end);
        // Center the match line; wrapped lines make this an approximation.
        const EDITOR_LINE_HEIGHT = 20.8;
        const targetTop = (match.line - 1) * EDITOR_LINE_HEIGHT - editor.clientHeight / 2;
        editor.scrollTop = Math.max(0, targetTop);
      }
    } else {
      const line = contentRef.current?.querySelector<HTMLElement>(
        `.file-source-line[data-line-number="${match.line}"]`,
      );
      line?.scrollIntoView({ block: "center" });
    }
  }, [isEditing, searchMatches]);

  const replaceCurrentMatch = useCallback(() => {
    const match = searchMatches[clampedActiveIndex];
    if (!match || editorText === null) return;
    updateEditorText(replaceOne(editorText, match, replacement));
  }, [clampedActiveIndex, editorText, replacement, searchMatches, updateEditorText]);

  const replaceAllMatches = useCallback(() => {
    if (editorText === null || searchMatches.length === 0) return;
    const result = replaceAll(editorText, searchMatches, replacement);
    updateEditorText(result.content);
  }, [editorText, replacement, searchMatches, updateEditorText]);
```

- [ ] **Step 5: Key handlers and highlight effect**

5a. `Cmd/Ctrl+F` opens the bar (chat input etc. keep native browser find):

```ts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat
        || event.key.toLowerCase() !== "f"
        || (!event.metaKey && !event.ctrlKey)
        || event.altKey
        || event.shiftKey
      ) return;
      const target = event.target;
      const insideTextField = target instanceof Element
        && target.closest("input, textarea, [contenteditable='true']");
      const insideOwnEditor = target instanceof Node
        && editorRef.current !== null
        && editorRef.current.contains(target);
      if (insideTextField && !insideOwnEditor) return;
      if (!isEditing && effectiveDisplayMode !== "source") return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveDisplayMode, isEditing, openSearch]);
```

5b. `Esc` exits edit mode when the search bar is closed (search input handles its own Esc via `stopPropagation`):

```ts
  useEffect(() => {
    if (!isEditing || searchOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      const insideTextField = target instanceof Element
        && target.closest("input, textarea, [contenteditable='true']");
      const insideOwnEditor = target instanceof Node
        && editorRef.current !== null
        && editorRef.current.contains(target);
      if (insideTextField && !insideOwnEditor) return;
      exitEditMode();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exitEditMode, isEditing, searchOpen]);
```

5c. Read-mode line highlight (edit mode uses textarea selections instead):

```ts
  useEffect(() => {
    if (isEditing) return;
    const root = contentRef.current;
    if (!root) return;
    const lines = root.querySelectorAll<HTMLElement>(".file-source-line");
    for (const line of lines) {
      line.classList.remove("file-source-search-hit", "file-source-search-hit-active");
    }
    if (!searchOpen || searchMatches.length === 0) return;
    for (const match of searchMatches) {
      root.querySelector<HTMLElement>(`.file-source-line[data-line-number="${match.line}"]`)
        ?.classList.add("file-source-search-hit");
    }
    root.querySelector<HTMLElement>(
      `.file-source-line[data-line-number="${searchMatches[clampedActiveIndex].line}"]`,
    )?.classList.add("file-source-search-hit-active");
  }, [clampedActiveIndex, data?.content, isEditing, searchMatches, searchOpen, wrapLines]);
```

5d. Reset the active index when query or case toggle changes:

```ts
  useEffect(() => {
    setActiveMatchIndex(0);
  }, [searchCaseSensitive, searchQuery]);
```

- [ ] **Step 6: Render the search UI**

6a. Toolbar toggle — inside the `file-viewer-actions` div, directly after the Edit/Done cluster from Task 5:

```tsx
            {!isDeletedDiff && (isEditing || effectiveDisplayMode === "source") && (
              <button
                type="button"
                onClick={() => (searchOpen ? closeSearch() : openSearch())}
                aria-pressed={searchOpen}
                className="file-viewer-icon-button"
                title={t("i18n.searchInFile")}
                aria-label={t("i18n.searchInFile")}
                style={{
                  background: searchOpen ? "var(--bg-selected)" : "transparent",
                  color: searchOpen ? "var(--text)" : "var(--text-muted)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.5" y2="16.5" />
                </svg>
              </button>
            )}
```

6b. The bar itself — render after the Task 5 banners and before the `{/* Content area */}` comment:

```tsx
      {searchOpen && (
        <div
          className="file-search-bar"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              ref={searchInputRef}
              className="file-search-input"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  goToMatch(clampedActiveIndex + (event.shiftKey ? -1 : 1));
                }
              }}
              placeholder={t("i18n.searchInFile")}
              aria-label={t("i18n.searchInFile")}
              style={{ flex: 1 }}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setSearchCaseSensitive((current) => !current)}
              aria-pressed={searchCaseSensitive}
              className="file-viewer-mode-button"
              title={t("i18n.matchCase")}
              aria-label={t("i18n.matchCase")}
              style={{
                fontSize: 11,
                background: searchCaseSensitive ? "var(--bg-selected)" : "transparent",
                color: searchCaseSensitive ? "var(--text)" : "var(--text-muted)",
              }}
            >
              Aa
            </button>
            <span
              className="file-search-count"
              style={{ minWidth: 64, textAlign: "center", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
            >
              {searchQuery === ""
                ? ""
                : searchMatches.length === 0
                  ? t("i18n.noMatches")
                  : `${clampedActiveIndex + 1}/${searchMatches.length}`}
            </span>
            <button
              type="button"
              onClick={() => goToMatch(clampedActiveIndex - 1)}
              disabled={searchMatches.length === 0}
              className="file-viewer-icon-button"
              title={t("i18n.previousMatch")}
              aria-label={t("i18n.previousMatch")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => goToMatch(clampedActiveIndex + 1)}
              disabled={searchMatches.length === 0}
              className="file-viewer-icon-button"
              title={t("i18n.nextMatch")}
              aria-label={t("i18n.nextMatch")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {isEditing && (
              <button
                type="button"
                onClick={() => setReplaceVisible((current) => !current)}
                aria-pressed={replaceVisible}
                className="file-viewer-mode-button"
                title={t("i18n.showReplace")}
                aria-label={t("i18n.showReplace")}
                style={{
                  background: replaceVisible ? "var(--bg-selected)" : "transparent",
                  color: replaceVisible ? "var(--text)" : "var(--text-muted)",
                }}
              >
                {t("i18n.replace")}
              </button>
            )}
            <button
              type="button"
              onClick={closeSearch}
              className="file-viewer-icon-button"
              title={t("i18n.closeSearch")}
              aria-label={t("i18n.closeSearch")}
            >
              <svg width="13" height="13" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
          {isEditing && replaceVisible && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                className="file-search-input"
                type="text"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                placeholder={t("i18n.replaceWith")}
                aria-label={t("i18n.replaceWith")}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={replaceCurrentMatch}
                disabled={searchMatches.length === 0}
                className="file-viewer-mode-button"
              >
                {t("i18n.replace")}
              </button>
              <button
                type="button"
                onClick={replaceAllMatches}
                disabled={searchMatches.length === 0}
                className="file-viewer-mode-button"
              >
                {t("i18n.replaceAll")}
              </button>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 7: Write the component structure test** — create `components/FileViewer.search.test.mjs`:

```js
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
  assert.match(textViewer, /closest\("input, textarea, \[contenteditable='true'\]'\)/);
});

test("search styles exist", () => {
  assert.match(cssSource, /\.file-search-input \{/);
  assert.match(cssSource, /\.file-source-search-hit \{/);
  assert.match(cssSource, /\.file-source-search-hit-active \{/);
});
```

- [ ] **Step 8: Verify**

```bash
node --experimental-strip-types --test components/FileViewer.search.test.mjs components/FileViewer.edit.test.mjs
node_modules/.bin/tsc --noEmit
```
Expected: tests PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add components/FileViewer.tsx components/FileViewer.search.test.mjs app/globals.css lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat(file-viewer): in-file search and replace bar"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

```bash
npm test
```
Expected: all PASS (includes the pre-existing suites that scan `FileViewer.tsx`).

- [ ] **Step 2: Typecheck and lint**

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```
Expected: both clean.

- [ ] **Step 3: Manual smoke check (dev server)**

1. `lsof -nP -iTCP:30141 -sTCP:LISTEN` — reuse an existing healthy server, else `npm run dev`.
2. Open a file tab: Edit → type → Cmd+S → dot clears; Done exits.
3. Edit a file, run an agent that touches the same file, then Cmd+S → conflict banner → Reload and Overwrite both behave.
4. Switch tabs mid-edit and return → draft intact.
5. Cmd+F in source and edit modes: count/prev/next/Aa; in edit mode also Replace / Replace All.

- [ ] **Step 4: Commit any stragglers**

```bash
git status --short
git add -A && git commit -m "chore(file-viewer): polish edit and search integration"  # only if needed
```

