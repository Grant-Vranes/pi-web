# Open Native File Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an icon button to the file-explorer header and a hover action on every file/folder row that opens the OS native file browser at that location (files are revealed/selected, folders opened).

**Architecture:** A new `POST /api/file-browser/open` route spawns `open -R` / `explorer /select,` / `xdg-open` detached from the Next.js server, guarded by the same `isApiRequestAllowed` + allowed-roots gate as `/api/files` and `/api/terminal/open`. A shared `openInFileBrowser()` fetch helper is consumed by both the `SessionSidebar` header button and the `FileExplorer` `TreeNode` hover buttons (which get consolidated into one right-anchored flex container).

**Tech Stack:** Next.js App Router route handlers, `child_process.spawn`, React (inline-style components, no CSS modules), `node:test` (source-assertion tests for routes, jiti-loaded behavior tests for libs).

**Spec:** `docs/superpowers/specs/2026-09-04-open-native-file-browser-design.md`

## Global Constraints

- NEVER run `next build` during dev — it pollutes `.next/` and breaks `npm run dev` (AGENTS.md).
- Typecheck: `node_modules/.bin/tsc --noEmit`. Lint: `npm run lint`.
- Full test suite: `npm test` (runs `node --experimental-strip-types --test "app/**/*.test.mjs" "components/**/*.test.mjs" "hooks/**/*.test.mjs" "lib/**/*.test.mjs" "public/**/*.test.mjs"`).
- i18n key parity across locales is enforced by `lib/i18n/registry.test.mjs` — every new key must be added to all three of `en.ts`, `zh-CN.ts`, `zh-TW.ts`.
- Route security gate must exactly mirror `app/api/terminal/open/route.ts`: `isApiRequestAllowed(request)` → allowed-roots `isFilePathAllowed` + `isExistingFilePathAllowed`.
- Spawn pattern: `spawn(cmd, args, { detached: true, stdio: "ignore" })` + `child.unref()`; resolve `{ ok: true }` after 250 ms unless an early `error` event fires.
- One commit per task; commit messages use repo style (`feat(...)`/`test(...)`).

---

### Task 1: i18n keys

**Files:**
- Modify: `lib/i18n/messages/en.ts` (line ~219 after `"sidebar.uploadFiles"`, line ~278 after `"files.noFiles"`)
- Modify: `lib/i18n/messages/zh-CN.ts` (same anchors)
- Modify: `lib/i18n/messages/zh-TW.ts` (same anchors)

**Interfaces:**
- Consumes: nothing.
- Produces: message keys `sidebar.openNativeFileBrowser`, `files.openInFileBrowser`, `files.openInFileBrowserFailed` — consumed by Tasks 4 and 5 via `t(...)`.

- [ ] **Step 1: Add the keys to all three locale files**

In `lib/i18n/messages/en.ts`, make these two edits (the `"sidebar.uploadFiles"` / `"files.noFiles"` lines appear exactly once each):

```ts
    "sidebar.uploadFiles": "Upload files",
    "sidebar.openNativeFileBrowser": "Open in file browser",
```

```ts
    "files.noFiles": "No files found",
    "files.openInFileBrowser": "Open in file browser",
    "files.openInFileBrowserFailed": "Failed to open file browser",
```

In `lib/i18n/messages/zh-CN.ts`:

```ts
    "sidebar.uploadFiles": "上传文件",
    "sidebar.openNativeFileBrowser": "打开本机文件浏览器",
```

```ts
    "files.noFiles": "未找到文件",
    "files.openInFileBrowser": "打开本机文件浏览器",
    "files.openInFileBrowserFailed": "打开本机文件浏览器失败",
```

In `lib/i18n/messages/zh-TW.ts`:

```ts
    "sidebar.uploadFiles": "上傳檔案",
    "sidebar.openNativeFileBrowser": "開啟本機檔案瀏覽器",
```

```ts
    "files.noFiles": "找不到檔案",
    "files.openInFileBrowser": "開啟本機檔案瀏覽器",
    "files.openInFileBrowserFailed": "開啟本機檔案瀏覽器失敗",
```

- [ ] **Step 2: Verify key parity passes**

Run: `node --experimental-strip-types --test lib/i18n/registry.test.mjs`
Expected: PASS (`built-in locale packages have the complete English key and required placeholder sets` passes — it fails if any locale is missing a key).

- [ ] **Step 3: Commit**

```bash
git add lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat(i18n): add open-in-file-browser strings"
```

---

### Task 2: Shared helper `lib/file-browser.ts`

**Files:**
- Create: `lib/file-browser.ts`
- Test: `lib/file-browser.test.mjs`

**Interfaces:**
- Consumes: nothing (plain `fetch`).
- Produces: `openInFileBrowser(path: string): Promise<{ ok: boolean; error?: string }>` — consumed by Task 4 (`SessionSidebar`) and Task 5 (`FileExplorer`). Never throws; non-2xx and network failures resolve `{ ok: false, error }`.

- [ ] **Step 1: Write the failing behavior test**

Create `lib/file-browser.test.mjs` (follows the jiti pattern of `lib/agent-client.test.mjs`):

```mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { openInFileBrowser } = await jiti.import("./file-browser.ts");

test("posts the path to /api/file-browser/open and resolves ok on 2xx", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 200 });
  };

  const result = await openInFileBrowser("/tmp/project");
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(captured.url, "/api/file-browser/open");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.init.body), { path: "/tmp/project" });
});

test("surfaces the server error message on non-2xx responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "Access denied" }),
    { status: 403 },
  );

  const result = await openInFileBrowser("/etc");
  assert.deepEqual(result, { ok: false, error: "Access denied" });
});

test("falls back to the HTTP status when the error body is not JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response("nope", { status: 500 });

  const result = await openInFileBrowser("/tmp/project");
  assert.deepEqual(result, { ok: false, error: "HTTP 500" });
});

test("resolves a failure instead of throwing on network errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("connection reset");
  };

  const result = await openInFileBrowser("/tmp/project");
  assert.equal(result.ok, false);
  assert.equal(result.error, "connection reset");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/file-browser.test.mjs`
Expected: FAIL — jiti import of `./file-browser.ts` throws `ENOENT` (module not found).

- [ ] **Step 3: Write the implementation**

Create `lib/file-browser.ts`:

```ts
/** Result of asking the server to open a path in the OS file browser. */
export interface OpenInFileBrowserResult {
  ok: boolean;
  error?: string;
}

/**
 * Ask the Pi Web server to open `path` in the operating system's native file
 * browser (Finder / Explorer / xdg-open). Files are revealed with their
 * containing folder shown and the file selected; directories open in place.
 * Never throws — callers surface `error` themselves.
 */
export async function openInFileBrowser(path: string): Promise<OpenInFileBrowserResult> {
  try {
    const response = await fetch("/api/file-browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error ?? `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/file-browser.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output (success).

```bash
git add lib/file-browser.ts lib/file-browser.test.mjs
git commit -m "feat(files): shared openInFileBrowser helper"
```

---

### Task 3: API route `POST /api/file-browser/open`

**Files:**
- Create: `app/api/file-browser/open/route.ts`
- Test: `app/api/file-browser/open/route.test.mjs`

**Interfaces:**
- Consumes: `isApiRequestAllowed` (`@/lib/request-security`), `getAllowedFileRoots`/`isFilePathAllowed`/`isExistingFilePathAllowed` (`@/lib/file-access`), `toNativePath` (`@/lib/paths`) — all existing.
- Produces: `POST /api/file-browser/open` body `{ path: string }` → `{ ok: true }` | `{ error: string }` (400/403/500). Consumed by the Task 2 helper.

- [ ] **Step 1: Write the failing source-assertion test**

Create `app/api/file-browser/open/route.test.mjs` (follows the source-assertion pattern of `app/api/files/mutation-route.test.mjs`):

```mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("reveal requests are guarded like /api/files and /api/terminal/open", () => {
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(source, /isFilePathAllowed\(targetPath, allowedRoots\)/);
  assert.match(source, /isExistingFilePathAllowed\(targetPath, allowedRoots\)/);
  assert.match(source, /existsSync\(targetPath\)/);
});

test("file vs directory behaviour is implemented per platform", () => {
  // macOS: reveal files with `open -R`, open directories with `open`.
  assert.match(source, /command = "open";\s*\n\s*args = isDirectory \? \[nativePath\] : \["-R", nativePath\];/);
  // Windows: explorer /select,<file> — no space after the comma.
  assert.match(source, /command = "explorer";/);
  assert.match(source, /`\/select,\$\{nativePath\}`/);
  // Linux: xdg-open (directory itself, or the parent for files).
  assert.match(source, /command = "xdg-open";/);
  assert.match(source, /dirname\(nativePath\)/);
});

test("spawn is detached, ignores stdio, and unrefs the child", () => {
  assert.match(source, /spawn\(command, args, \{ detached: true, stdio: "ignore" \}\)/);
  assert.match(source, /child\.unref\(\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test "app/api/file-browser/open/route.test.mjs"`
Expected: FAIL — `readFile` throws `ENOENT` because `route.ts` does not exist yet.

- [ ] **Step 3: Write the route**

Create `app/api/file-browser/open/route.ts`:

```ts
import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import { dirname } from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { toNativePath } from "@/lib/paths";
import { isApiRequestAllowed } from "@/lib/request-security";

/** Same access gate as /api/files and /api/terminal/open: only session cwds /
 *  project roots / explicitly allowed paths may be opened. */
async function checkPathAllowed(targetPath: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(targetPath, allowedRoots) || !isExistingFilePathAllowed(targetPath, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

interface SpawnResult {
  ok: boolean;
  error?: string;
}

/**
 * Spawn a detached process that opens `targetPath` in the OS file browser.
 * Files are revealed with the parent folder shown and the file selected
 * (darwin `open -R`, win32 `explorer /select,`); on Linux, where no reveal
 * convention exists, the containing directory is opened instead. Directories
 * are opened in place on every platform.
 */
function openInFileBrowser(targetPath: string, isDirectory: boolean): Promise<SpawnResult> {
  return new Promise((resolve) => {
    try {
      const nativePath = toNativePath(targetPath);
      let command: string;
      let args: string[];
      if (process.platform === "darwin") {
        // `open -R` reveals the file selected in Finder; directories open in place.
        command = "open";
        args = isDirectory ? [nativePath] : ["-R", nativePath];
      } else if (process.platform === "win32") {
        command = "explorer";
        // No space after "/select,"; backslash separators are required.
        args = isDirectory ? [nativePath] : [`/select,${nativePath}`];
      } else {
        // Linux: no reveal convention — xdg-open the containing directory
        // for files, the directory itself for directories.
        command = "xdg-open";
        args = [isDirectory ? nativePath : dirname(nativePath)];
      }

      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      // Detach so the file browser outlives the server process; unref so the
      // server can exit without waiting on it. The window itself is async —
      // a successful spawn with no early error is the best we can verify.
      child.unref();
      setTimeout(() => resolve({ ok: true }), 250);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// POST /api/file-browser/open  body: { path }  →  { ok }
//
// Opens the OS native file browser at `path`: directories open in place,
// files are revealed (containing folder shown, file selected). The path must
// exist and pass the same allowed-roots gate as /api/files and
// /api/terminal/open.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({})) as { path?: string };
    const targetPath = body.path;
    if (!targetPath || typeof targetPath !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    if (!existsSync(targetPath)) {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }
    const denied = await checkPathAllowed(targetPath);
    if (denied) return denied;

    let isDirectory: boolean;
    try {
      isDirectory = statSync(targetPath).isDirectory();
    } catch {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }

    const result = await openInFileBrowser(targetPath, isDirectory);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed to open file browser" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test "app/api/file-browser/open/route.test.mjs"`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no output (success).

```bash
git add app/api/file-browser/open/route.ts app/api/file-browser/open/route.test.mjs
git commit -m "feat(api): POST /api/file-browser/open reveals paths in the OS file browser"
```

---

### Task 4: Explorer header button (`SessionSidebar.tsx`)

**Files:**
- Modify: `components/SessionSidebar.tsx`

**Interfaces:**
- Consumes: `openInFileBrowser(path)` from Task 2; i18n keys `sidebar.openNativeFileBrowser`, `files.openInFileBrowserFailed` from Task 1; existing `ToolbarIconButton` component.
- Produces: header toolbar behavior only (no exports).

- [ ] **Step 1: Add the import**

After the existing import line `import { getFileName } from "@/lib/file-paths";` add:

```ts
import { openInFileBrowser } from "@/lib/file-browser";
```

- [ ] **Step 2: Add busy state**

Find (unique):

```ts
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
```

Replace with:

```ts
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [fileBrowserOpening, setFileBrowserOpening] = useState(false);
```

- [ ] **Step 3: Add the click handler**

Find the end of `handleNewSession` (unique block):

```ts
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);
```

Replace with (appending the new handler after it):

```ts
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  // Open the OS native file browser at the explorer's current root. Disabled
  // briefly while a request is in flight so the button never looks dead
  // (same pattern as terminalOpening).
  const handleOpenInFileBrowser = useCallback(async () => {
    const targetCwd = selectedCwd ?? selectedCwdProp;
    if (!targetCwd || fileBrowserOpening) return;
    setFileBrowserOpening(true);
    const result = await openInFileBrowser(targetCwd);
    if (!result.ok) {
      window.alert(`${t("files.openInFileBrowserFailed")}: ${result.error ?? ""}`);
    }
    setTimeout(() => setFileBrowserOpening(false), 600);
  }, [selectedCwd, selectedCwdProp, fileBrowserOpening, t]);
```

- [ ] **Step 4: Insert the toolbar button between upload and refresh**

Find the upload button block (unique — `openUploadPicker` appears once):

```tsx
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
```

Replace with the same block plus the new button after it:

```tsx
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => void handleOpenInFileBrowser()}
                disabled={fileBrowserOpening}
                title={t("sidebar.openNativeFileBrowser")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </ToolbarIconButton>
            )}
```

- [ ] **Step 5: Verify**

Run: `node_modules/.bin/tsc --noEmit && npm run lint`
Expected: both pass with no output/errors.

```bash
git add components/SessionSidebar.tsx
git commit -m "feat(sidebar): open native file browser from explorer header"
```

---

### Task 5: Row hover button (`FileExplorer.tsx`)

**Files:**
- Modify: `components/FileExplorer.tsx` (TreeNode hover controls, lines ~490-546)

**Interfaces:**
- Consumes: `openInFileBrowser(path)` from Task 2; i18n keys `files.openInFileBrowser`, `files.openInFileBrowserFailed` from Task 1; existing `MentionIcon`, `encodeFilePathForApi`, `getRelativeFilePath`.
- Produces: hover toolbar behavior only (no exports). Search-result rows reuse `TreeNode`, so they get the button for free.

- [ ] **Step 1: Add the import**

Find (unique):

```ts
import { collectDroppedUploadEntries, type DroppedUploadEntry } from "@/lib/drop-collect";
```

Replace with:

```ts
import { collectDroppedUploadEntries, type DroppedUploadEntry } from "@/lib/drop-collect";
import { openInFileBrowser } from "@/lib/file-browser";
```

- [ ] **Step 2: Replace the scattered hover buttons with one flex container**

Find the mention button + download link block — it starts at `{onAtMention && hovered && (` and ends just before the row's closing `</div>` followed by `{node.isDir && open && (`. The full oldText to replace (everything between the `loading` spinner `)}` and the row-closing `</div>`) is:

```tsx
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files.insertPath")}
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
```

Replace with (one right-anchored flex row: mention pill, new file-browser button for files AND directories, download link files-only):

```tsx
        {hovered && (
          <div
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            {onAtMention && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
                }}
                title={t("files.insertPath")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  padding: "0 8px",
                  height: 20,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--accent)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                <MentionIcon />
                {t("files.mention")}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openInFileBrowser(node.fullPath).then((result) => {
                  if (!result.ok) {
                    window.alert(`${t("files.openInFileBrowserFailed")}: ${result.error ?? ""}`);
                  }
                });
              }}
              title={t("files.openInFileBrowser")}
              aria-label={t("files.openInFileBrowser")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                width: 20,
                height: 20,
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
            {!node.isDir && (
              <a
                href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
                download
                onClick={(e) => e.stopPropagation()}
                title={t("files.download")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  padding: "0 5px",
                  height: 20,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  textDecoration: "none",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </a>
            )}
          </div>
        )}
```

- [ ] **Step 3: Verify**

Run: `node_modules/.bin/tsc --noEmit && npm run lint && npm test`
Expected: all pass (the full suite includes the new `route.test.mjs`, `file-browser.test.mjs`, and the i18n parity test).

```bash
git add components/FileExplorer.tsx
git commit -m "feat(explorer): reveal files and folders in the native file browser on hover"
```

---

### Task 6: Manual verification (dev server)

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Check for a healthy running dev server**

Run: `lsof -nP -iTCP:30141 -sTCP:LISTEN`
- If a healthy Pi Web process is listening, reuse it — do NOT start a second `next dev` (both contend for `.next/dev/lock`).
- Otherwise start one: `npm run dev` (background) and wait for the ready line.

- [ ] **Step 2: Exercise the API directly**

```bash
# Open a directory (Finder window appears at the repo root):
curl -s -X POST http://localhost:30141/api/file-browser/open \
  -H 'Content-Type: application/json' \
  -d '{"path":"'"$PWD"'"}'
# Expected: {"ok":true}

# Reveal a file (Finder opens the parent with the file selected):
curl -s -X POST http://localhost:30141/api/file-browser/open \
  -H 'Content-Type: application/json' \
  -d '{"path":"'"$PWD"'/package.json"}'
# Expected: {"ok":true}

# Outside the allowed roots → denied:
curl -s -X POST http://localhost:30141/api/file-browser/open \
  -H 'Content-Type: application/json' \
  -d '{"path":"/etc"}'
# Expected: {"error":"Access denied"}

# Missing path:
curl -s -X POST http://localhost:30141/api/file-browser/open \
  -H 'Content-Type: application/json' \
  -d '{"path":"/tmp/definitely-not-here-12345"}'
# Expected: {"error":"Path does not exist: /tmp/definitely-not-here-12345"}
```

- [ ] **Step 3: Exercise the UI in the browser**

1. Open `http://localhost:30141`, select a project with a file explorer visible.
2. Hover the explorer header: a new folder icon button sits between upload and refresh; its tooltip reads 打开本机文件浏览器 (zh) / Open in file browser (en). Click → Finder opens at the project root.
3. Hover a **folder** row: hover toolbar shows 提及 + new external-link button; click the external-link button → Finder opens that folder; the folder does NOT expand/collapse (stopPropagation works).
4. Hover a **file** row: hover toolbar shows 提及 + external-link + download; click external-link → Finder reveals the file selected; the file does NOT open in a tab.
5. Switch the UI language to English/繁體中文 and confirm the two tooltips translate.

- [ ] **Step 4: Final commit (if any fixups were needed) and report**

```bash
git status --short   # expect clean tree, no stray AGENTS.md changes
```

Report results; do not commit generated `BEGIN:nextjs-agent-rules` blocks in `AGENTS.md`.
