# Chat Drag-and-Drop Path Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop local files and directories into chat and insert their absolute paths as quoted `@` mentions, without uploading their contents.

**Architecture:** A new pure `lib/dropped-paths.ts` module classifies a drag payload, extracts Electron or browser-provided local paths, deduplicates them, and formats closed mentions. `useDragDrop` exposes the classified payload and accepts path-capable drags; `ChatWindow` sends image files and formatted mentions to distinct imperative ChatInput methods. Electron safely exposes `webUtils.getPathForFile` through the preload bridge.

**Tech Stack:** Next.js 16, React 19, TypeScript, Electron, Node `node:test`, `jiti`.

## Global Constraints

- Never upload, read, recursively enumerate, or index dropped non-image files or directories.
- Preserve the current image attachment flow and image-only behavior.
- Insert closed, quoted absolute mentions: `@"/absolute/path" ` and `@"/absolute/directory/" `.
- Preserve source order, deduplicate path mentions, and add only the dropped directory itself.
- Use Electron native path metadata when available; in browsers only accept explicit `file:` URLs from `text/uri-list`.
- Do not modify file viewer APIs or their allowed-root security boundary.
- If non-image items are dropped but no local path is exposed, leave the draft unchanged and show one non-blocking notice.
- Keep Chat-only and other tool preset permissions unchanged.
- Existing baseline: `npm test` has 9 pre-existing failures (871 passing of 880), which must remain the only failures after this feature.

---

## File structure

- **Create `lib/dropped-paths.ts`**: Pure drag payload classification, Electron/browser path extraction, normalization, and `@` mention formatting.
- **Create `lib/dropped-paths.test.mjs`**: Unit tests for every platform and formatting boundary.
- **Modify `desktop/preload.cjs`**: Safely expose Electron's `webUtils.getPathForFile` to the isolated web renderer.
- **Create `desktop/preload.test.mjs`**: Static bridge contract test that prevents context-isolation regressions.
- **Modify `hooks/useDragDrop.ts`**: Recognize supported local-path drops and return classified drop data instead of only images.
- **Modify `hooks/useAgentSession.ts`**: Expose its existing notice enqueue action for local UI events.
- **Create `hooks/useDragDrop.test.mjs`**: Test the hook source contract for path-capable acceptance and reset behavior.
- **Modify `components/ChatInput.tsx`**: Expose a caret-preserving imperative insertion method for formatted path mention text.
- **Modify `components/ChatInput.test.mjs`**: Test and lock the insertion method's source contract.
- **Modify `components/ChatWindow.tsx`**: Partition dropped images and paths, route them to ChatInput, update drop affordance, and enqueue the existing notice mechanism on unavailable paths.
- **Create `components/ChatWindow.drop-paths.test.mjs`**: Source-level integration contract test for payload partitioning and notice behavior.

## Interfaces

```ts
// lib/dropped-paths.ts
export interface DroppedPath {
  path: string;
  isDirectory: boolean;
}

export interface DropPayload {
  imageFiles: File[];
  pathMentions: string;
  hasNonImageFiles: boolean;
}

export function buildDropPayload(dataTransfer: DataTransfer): DropPayload;

// hooks/useDragDrop.ts
export function useDragDrop(onDrop: (payload: DropPayload) => void): {
  isDragOver: boolean;
  handleDragEnter: (event: React.DragEvent) => void;
  handleDragOver: (event: React.DragEvent) => void;
  handleDragLeave: () => void;
  handleDrop: (event: React.DragEvent) => void;
};

// ChatInput.tsx and hooks/useAgentSession.ts
export interface ChatInputHandle {
  // existing methods...
  addImages: (files: File[]) => void;
  insertPathMentions: (mentions: string) => void;
}

// hooks/useAgentSession.ts return value
addNotice: (notice: { message: string; type?: NoticeType }) => void;
```

### Task 1: Implement and test pure dropped-path payload helpers

**Files:**
- Create: `lib/dropped-paths.ts`
- Test: `lib/dropped-paths.test.mjs`

**Consumes:** Browser `DataTransfer`, Electron's optional `window.piDesktop.getPathForFile(file)`, and the existing `File` interface.

**Produces:** `buildDropPayload(dataTransfer)` returning images separately from a single formatted absolute-path mention string plus a non-image signal for unavailable-path notices.

- [ ] **Step 1: Write failing unit tests for payload extraction and formatting**

Create `lib/dropped-paths.test.mjs` with Jiti loading and fake `File`/`DataTransfer` values. Cover these exact assertions:

```js
import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./dropped-paths.ts");
}

test("buildDropPayload keeps images separate and formats Electron file and directory paths", async () => {
  const { buildDropPayload } = await loadSubject();
  globalThis.window = {
    piDesktop: { getPathForFile: (file) => file.nativePath ?? "" },
  };
  const payload = buildDropPayload({
    files: [
      { type: "image/png", name: "screen.png", nativePath: "/tmp/screen.png" },
      { type: "text/plain", name: "a file.ts", nativePath: "/work/a file.ts" },
      { type: "", name: "src", nativePath: "/work/src" },
    ],
    items: [
      { webkitGetAsEntry: () => ({ isDirectory: false }) },
      { webkitGetAsEntry: () => ({ isDirectory: false }) },
      { webkitGetAsEntry: () => ({ isDirectory: true }) },
    ],
    getData: () => "",
  });

  assert.equal(payload.imageFiles.length, 1);
  assert.equal(payload.hasNonImageFiles, true);
  assert.equal(payload.pathMentions, '@"/work/a file.ts" @"/work/src/" ');
});

test("buildDropPayload uses file URLs only when Electron paths are unavailable", async () => {
  const { buildDropPayload } = await loadSubject();
  globalThis.window = {};
  const payload = buildDropPayload({
    files: [{ type: "text/plain", name: "ignored.txt" }],
    getData: (type) => type === "text/uri-list"
      ? "# Finder\nfile:///Users/a%20b/project/readme.md\nhttps://example.test/nope"
      : "",
  });

  assert.equal(payload.pathMentions, '@"/Users/a b/project/readme.md" ');
});

test("buildDropPayload removes duplicate and malformed paths without claiming an unavailable drop", async () => {
  const { buildDropPayload } = await loadSubject();
  globalThis.window = {};
  const payload = buildDropPayload({
    files: [{ type: "text/plain", name: "unknown.txt" }],
    getData: () => "file:///tmp/a.ts\nfile:///tmp/a.ts\nfile://%zz",
  });

  assert.equal(payload.pathMentions, '@"/tmp/a.ts" ');
  assert.equal(payload.hasNonImageFiles, true);
});

test("buildDropPayload identifies an unresolvable non-image drop without touching images", async () => {
  const { buildDropPayload } = await loadSubject();
  globalThis.window = {};
  const payload = buildDropPayload({
    files: [{ type: "application/pdf", name: "outside.pdf" }],
    getData: () => "",
  });

  assert.equal(payload.imageFiles.length, 0);
  assert.equal(payload.hasNonImageFiles, true);
  assert.equal(payload.pathMentions, "");
});
```

Restore the previous global `window` in `try/finally` in each test so test ordering cannot leak platform state.

- [ ] **Step 2: Run the new unit test and verify it fails**

Run: `node --experimental-strip-types --test lib/dropped-paths.test.mjs`

Expected: failure because `lib/dropped-paths.ts` does not exist.

- [ ] **Step 3: Implement the minimal payload helper**

Create `lib/dropped-paths.ts`. Define `DroppedPath`, `DropPayload`, an `ElectronDesktopBridge` declaration, and these focused helpers:

```ts
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function formatPathMention({ path, isDirectory }: DroppedPath): string {
  const normalized = isDirectory && !path.endsWith("/") ? `${path}/` : path;
  return `@"${normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" `;
}

function fileUrls(uriList: string): string[] {
  return uriList.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}
```

For each non-image `File`, attempt `window.piDesktop?.getPathForFile(file)` first. Determine whether it is a directory from the corresponding `dataTransfer.items[index]?.webkitGetAsEntry()?.isDirectory`; only use `webkitRelativePath.endsWith("/")` as a fallback. Do not recurse into an entry. When Electron returns no path, parse `file:` URLs from `dataTransfer.getData("text/uri-list")` with `new URL()`, require `protocol === "file:"`, use `decodeURIComponent(url.pathname)`, remove the leading slash from Windows drive paths (`/C:/…`), and ignore malformed values. URI-derived paths default to files because browser URI lists do not reliably preserve directory type. Deduplicate normalized `(path, isDirectory)` records using a `Set`, preserving first-seen order. Return image files unchanged and concatenate formatted mentions.

Declare the window bridge locally:

```ts
declare global {
  interface Window {
    piDesktop?: { getPathForFile(file: File): string };
  }
}
```

- [ ] **Step 4: Run the helper test and verify it passes**

Run: `node --experimental-strip-types --test lib/dropped-paths.test.mjs`

Expected: all four tests pass.

- [ ] **Step 5: Commit the helper deliverable**

```bash
git add lib/dropped-paths.ts lib/dropped-paths.test.mjs
git commit -m "feat: classify dropped path mentions"
```

### Task 2: Expose Electron file paths through the isolated preload bridge

**Files:**
- Modify: `desktop/preload.cjs:1-8`
- Create: `desktop/preload.test.mjs`

**Consumes:** Electron's `contextBridge` and `webUtils.getPathForFile` APIs, plus the `Window.piDesktop` interface produced in Task 1.

**Produces:** A narrow, synchronous `window.piDesktop.getPathForFile(file)` bridge available only in Electron.

- [ ] **Step 1: Write a failing preload bridge contract test**

Create `desktop/preload.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");

test("exposes only Electron webUtils file-path lookup to the page", () => {
  assert.match(source, /const \{ contextBridge, ipcRenderer, webUtils \} = require\("electron"\)/);
  assert.match(source, /contextBridge\.exposeInMainWorld\("piDesktop", \{\s*getPathForFile\(file\) \{\s*return webUtils\.getPathForFile\(file\);\s*\},\s*}\)/);
});
```

- [ ] **Step 2: Run the preload test and verify it fails**

Run: `node --test desktop/preload.test.mjs`

Expected: failure because `contextBridge` and `webUtils` are not exposed.

- [ ] **Step 3: Add the narrow preload bridge**

Change the Electron import and add the bridge before existing event listeners:

```js
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("piDesktop", {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
});
```

Do not expose `ipcRenderer`, Node APIs, arbitrary filesystem APIs, or a generic invoke mechanism.

- [ ] **Step 4: Run the preload test and verify it passes**

Run: `node --test desktop/preload.test.mjs`

Expected: one passing test.

- [ ] **Step 5: Commit the Electron bridge deliverable**

```bash
git add desktop/preload.cjs desktop/preload.test.mjs
git commit -m "feat(desktop): expose dropped file paths"
```

### Task 3: Extend the shared drag hook and composer insertion interface

**Files:**
- Modify: `hooks/useDragDrop.ts:1-40`
- Modify: `hooks/useAgentSession.ts:2005-2026`
- Create: `hooks/useDragDrop.test.mjs`
- Modify: `components/ChatInput.tsx:94-106, 669-687`
- Modify: `components/ChatInput.test.mjs`

**Consumes:** `buildDropPayload(dataTransfer)` from Task 1 and the new `ChatInputHandle.insertPathMentions(mentions)` contract.

**Produces:** A drag hook that prevents default for path-capable payloads, an exposed `addNotice({ message, type })` action for component-owned UI failures, and a ChatInput method that inserts formatted mentions at the selection without replacing existing draft text.

- [ ] **Step 1: Write failing hook and composer contract tests**

Create `hooks/useDragDrop.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useDragDrop.ts", import.meta.url), "utf8");

test("routes classified image and local-path payloads through one drop callback", () => {
  assert.match(source, /import \{ buildDropPayload, type DropPayload \} from "@\/lib\/dropped-paths"/);
  assert.match(source, /useDragDrop\(onDrop: \(payload: DropPayload\) => void\)/);
  assert.match(source, /const payload = buildDropPayload\(e\.dataTransfer\)/);
  assert.match(source, /if \(payload\.imageFiles\.length === 0 && !payload\.hasNonImageFiles\) return/);
  assert.match(source, /counterRef\.current = 0;\s*setIsDragOver\(false\);\s*onDrop\(payload\)/);
});
```

Append this test to `hooks/useAgentSession.test.mjs`:

```js
test("exposes the existing notice enqueue action for component UI failures", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  assert.match(source, /setNoticePaused: setPausedNoticeId,\s*addNotice,/);
});
```

Append this test to `components/ChatInput.test.mjs`:

```js
test("exposes a caret-preserving path mention insertion handle", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

  assert.match(source, /insertPathMentions: \(mentions: string\) => void;/);
  assert.match(source, /insertPathMentions\(mentions: string\) \{/);
  assert.match(source, /const newVal = before \+ sep \+ mentions \+ after;/);
  assert.match(source, /ta\.setSelectionRange\(pos, pos\);/);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --experimental-strip-types --test hooks/useDragDrop.test.mjs hooks/useAgentSession.test.mjs components/ChatInput.test.mjs`

Expected: new assertions fail because the path payload hook integration, public notice action, and `insertPathMentions` do not exist.

- [ ] **Step 3: Implement the hook and insertion method**

In `hooks/useDragDrop.ts`, import `buildDropPayload` and `DropPayload`. Change the callback argument from `File[]` to `DropPayload`. In enter/over/drop, build the payload once for that event and recognize it if `payload.imageFiles.length > 0 || payload.hasNonImageFiles`; only then call `preventDefault`. On drop, reset the counter and overlay state before calling `onDrop(payload)`.

In `hooks/useAgentSession.ts`, add the existing `addNotice` callback to the actions returned from `useAgentSession` directly after `setNoticePaused`. Do not expose `dispatchNotice`, `createNoticeId`, or reducer internals.

In `components/ChatInput.tsx`, add this handle signature:

```ts
insertPathMentions: (mentions: string) => void;
```

Inside `useImperativeHandle`, directly after `insertText`, add this minimal selection-aware implementation:

```ts
insertPathMentions(mentions: string) {
  if (!mentions) return;
  const ta = textareaRef.current;
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const sep = before && !/\s$/.test(before) ? " " : "";
  const newVal = before + sep + mentions + after;
  const pos = start + sep.length + mentions.length;
  valueRef.current = newVal;
  setValue(newVal);
  setAtQuery(null);
  requestAnimationFrame(() => {
    const current = textareaRef.current;
    if (!current) return;
    current.focus();
    current.setSelectionRange(pos, pos);
    current.style.height = "auto";
    current.style.height = `${Math.min(current.scrollHeight, 200)}px`;
  });
},
```

Do not clear images, drafts, or the typed message. The established draft effect persists `value` after React updates.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `node --experimental-strip-types --test hooks/useDragDrop.test.mjs hooks/useAgentSession.test.mjs components/ChatInput.test.mjs`

Expected: all focused tests pass.

- [ ] **Step 5: Commit the hook and composer deliverable**

```bash
git add hooks/useDragDrop.ts hooks/useDragDrop.test.mjs hooks/useAgentSession.ts hooks/useAgentSession.test.mjs components/ChatInput.tsx components/ChatInput.test.mjs
git commit -m "feat(chat): insert dropped path mentions"
```

### Task 4: Integrate classified drops into ChatWindow and show the existing notice UI

**Files:**
- Modify: `components/ChatWindow.tsx:15, 526-530, 742-780`
- Create: `components/ChatWindow.drop-paths.test.mjs`

**Consumes:** `DropPayload` from `useDragDrop`, `ChatInputHandle.addImages`, `ChatInputHandle.insertPathMentions`, and the `addNotice` action exposed by Task 3.

**Produces:** Main chat-area behavior that preserves images, inserts paths, and uses a non-blocking notice only for unresolvable path-only drops.

- [ ] **Step 1: Write a failing ChatWindow drop integration test**

Create `components/ChatWindow.drop-paths.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("partitions dropped images and path mentions without uploading path items", () => {
  assert.match(source, /const onDrop = useCallback\(\(\{ imageFiles, pathMentions, hasNonImageFiles \}: DropPayload\) => \{/);
  assert.match(source, /if \(imageFiles\.length > 0\) chatInputRef\?\.current\?\.addImages\(imageFiles\);/);
  assert.match(source, /if \(pathMentions\) \{\s*chatInputRef\?\.current\?\.insertPathMentions\(pathMentions\);\s*return;\s*}/);
  assert.match(source, /if \(hasNonImageFiles\) addNotice\(\{ type: "warning", message: "Could not access the dropped item's local path in this browser" \}\);/);
});

test("uses a generic path-or-image drop affordance", () => {
  assert.match(source, /Drop files, folders, or images to add them to your message/);
});
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `node --test components/ChatWindow.drop-paths.test.mjs`

Expected: failure because `ChatWindow` still accepts `File[]` and its overlay is image-specific.

- [ ] **Step 3: Implement ChatWindow drop partitioning and generic affordance**

Import `DropPayload` from `@/lib/dropped-paths` and destructure `addNotice` from the existing `useAgentSession` result. Replace the current callback with:

```ts
const onDrop = useCallback(({ imageFiles, pathMentions, hasNonImageFiles }: DropPayload) => {
  if (imageFiles.length > 0) chatInputRef?.current?.addImages(imageFiles);
  if (pathMentions) {
    chatInputRef?.current?.insertPathMentions(pathMentions);
    return;
  }
  if (hasNonImageFiles) {
    addNotice({ type: "warning", message: "Could not access the dropped item's local path in this browser" });
  }
}, [addNotice, chatInputRef]);
```

Keep the `useDragDrop(onDrop)` call and all existing root drag handlers. Update the active overlay from the image illustration to a generic file/folder/image indicator and include accessible visible copy exactly matching the test: `Drop files, folders, or images to add them to your message`. Keep it `pointer-events-none` so drops reach the root handler. Do not add a new modal, API route, or upload path.

- [ ] **Step 4: Run the integration test and verify it passes**

Run: `node --test components/ChatWindow.drop-paths.test.mjs`

Expected: both tests pass.

- [ ] **Step 5: Run feature-focused tests and typecheck**

Run:

```bash
node --experimental-strip-types --test \
  lib/dropped-paths.test.mjs \
  desktop/preload.test.mjs \
  hooks/useDragDrop.test.mjs \
  hooks/useAgentSession.test.mjs \
  components/ChatInput.test.mjs \
  components/ChatWindow.drop-paths.test.mjs
node_modules/.bin/tsc --noEmit
```

Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit the integration deliverable**

```bash
git add components/ChatWindow.tsx components/ChatWindow.drop-paths.test.mjs
git commit -m "feat(chat): handle dropped local paths"
```

### Task 5: Full verification and regression classification

**Files:**
- Modify: none expected

**Consumes:** All prior feature commits and the known baseline test failures.

**Produces:** Evidence that the new path-drop tests pass, lint/typecheck are clean, and no test failures were added beyond the recorded baseline.

- [ ] **Step 1: Run the complete project test suite**

Run: `npm test`

Expected: the same nine known baseline failures only. Confirm no failure includes `dropped-paths`, `useDragDrop.test.mjs`, `ChatInput.test.mjs`, `ChatWindow.drop-paths.test.mjs`, or `desktop/preload.test.mjs`.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: exit code 0 with no new errors or warnings.

- [ ] **Step 3: Inspect the final patch**

Run:

```bash
git status --short
git log --oneline develop..HEAD
git diff --check develop...HEAD
```

Expected: only feature and test files plus the already committed design/plan documentation; no whitespace errors.

- [ ] **Step 4: Commit any verification-only correction if needed**

If an error is found, first add a focused failing test that proves the regression, implement the smallest correction, rerun its focused test, then commit with a scoped message. If no correction is needed, do not make an empty commit.
