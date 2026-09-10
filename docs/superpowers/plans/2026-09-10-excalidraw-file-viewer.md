# .excalidraw File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open `.excalidraw` files in the file browser with a read-only Excalidraw canvas by default and a full interactive editor behind an "Edit" button, saving back to disk with the existing mtime-conflict write API.

**Architecture:** A new `ExcalidrawViewer` client component (lazy-loaded, `ssr: false`) renders the official `@excalidraw/excalidraw` React component in view or edit mode. It reuses the `/api/files` read/meta/watch/write endpoints and mirrors the existing `ImageViewer` header/watch patterns. `FileViewer` dispatches to it before the text viewer via a new `isExcalidrawPath()` predicate.

**Tech Stack:** Next.js 16 (App Router), React 19, `@excalidraw/excalidraw` (dynamic import), node:test regex-style component tests (repo convention — tests read source files and assert patterns; no React DOM testing).

**Spec:** `docs/superpowers/specs/2026-09-10-excalidraw-file-viewer-design.md`

## Global Constraints

- Reuse the existing `/api/files` `read` / `meta` / `watch` / `write` endpoints. **No new API routes.**
- Excalidraw code must be lazy-loaded and never evaluated server-side (`next/dynamic` with `ssr: false`).
- Write-back must preserve unknown top-level JSON keys of the original scene file; only `elements`, `appState`, `files` are replaced.
- `appState` write-back is limited to `["viewBackgroundColor", "gridSize", "gridModeEnabled"]`.
- Save sends `{ content, baseMtimeMs }`; HTTP 409 means conflict and must surface an "Overwrite" path (`baseMtimeMs: null`).
- No auto-save. Exiting edit with unsaved changes asks `window.confirm` (reuse `i18n.confirmDiscard`).
- Do NOT add `.excalidraw` draft persistence to `FileViewerState`.
- Tests use `node:test` + `node:assert/strict`, run with `npm test` (files match `components/**/*.test.mjs`, `lib/**/*.test.mjs`).
- Commit after every task; use Conventional Commits style (`feat:`, `test:`, `refactor:`).
- UI copy comes from `useI18n()` keys; add to all three locales (`en`, `zh-CN`, `zh-TW`).

---

### Task 1: Add the `@excalidraw/excalidraw` dependency

**Files:**
- Modify: `package.json` (via npm), `package-lock.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `@excalidraw/excalidraw` installed; `mod.Excalidraw` component available for dynamic import in Task 5.

- [ ] **Step 1: Install the package**

```bash
npm install @excalidraw/excalidraw
```

Expected: install succeeds (adds the package as a runtime dependency; React 19 is a supported peer).

- [ ] **Step 2: Verify the CSS entry path for later tasks**

```bash
node -e "const p=require('@excalidraw/excalidraw/package.json'); console.log(p.version)"; ls node_modules/@excalidraw/excalidraw | grep -i '\.css$'; ls node_modules/@excalidraw/excalidraw/dist 2>/dev/null | grep -i '\.css$'
```

Expected: prints a `0.18.x` (or newer) version, and lists a stylesheet entry (typically `index.css` at the package root, or a css file under `dist/`). **Record the exact css path found** — Task 5 imports it. If both exist, prefer the package-root `index.css`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @excalidraw/excalidraw dependency"
```

---

### Task 2: `isExcalidrawPath()` in `lib/file-types.ts`

**Files:**
- Modify: `lib/file-types.ts` (append near the bottom, after `isDocumentPreviewPath`)
- Test: `lib/file-types.test.mjs` (append a new test)

**Interfaces:**
- Consumes: `getFileExt(filePath: string): string` (already in `lib/file-types.ts`).
- Produces: `isExcalidrawPath(filePath: string): boolean` — Task 5 uses it in `FileViewer`.

- [ ] **Step 1: Write the failing test**

Append to `lib/file-types.test.mjs` (bottom of file):

```js
test("detects excalidraw scene paths", async () => {
  const { isExcalidrawPath } = await loadSubject();

  assert.equal(isExcalidrawPath("/tmp/diagram.excalidraw"), true);
  assert.equal(isExcalidrawPath("C:\\docs\\diagram.EXCALIDRAW"), true);
  assert.equal(isExcalidrawPath("/tmp/diagram.json"), false);
  assert.equal(isExcalidrawPath("/tmp/diagram.txt"), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- 2>/dev/null | grep -A3 "excalidraw"; node --experimental-strip-types --test lib/file-types.test.mjs
```

Expected: FAIL — `isExcalidrawPath is not a function` (or equivalent undefined-export error).

- [ ] **Step 3: Implement**

In `lib/file-types.ts`, after `isDocumentPreviewPath`, add:

```ts
export function isExcalidrawPath(filePath: string): boolean {
  return getFileExt(filePath) === "excalidraw";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --experimental-strip-types --test lib/file-types.test.mjs
```

Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/file-types.ts lib/file-types.test.mjs
git commit -m "feat: add isExcalidrawPath file-type predicate"
```

---

### Task 3: Extract `getFileApiUrl()` into `lib/file-api.ts`

`getFileApiUrl` is currently a private function in `components/FileViewer.tsx`. `ExcalidrawViewer` needs it too, but importing from `FileViewer.tsx` would create a circular import (FileViewer will import ExcalidrawViewer). Extract it into a tiny shared module.

**Files:**
- Create: `lib/file-api.ts`
- Modify: `components/FileViewer.tsx` (delete the local `getFileApiUrl` definition, import from the new module)
- Test: `lib/file-api.test.mjs` (new)

**Interfaces:**
- Consumes: `encodeFilePathForApi` from `@/lib/file-paths`.
- Produces: `getFileApiUrl(filePath: string, type: "read" | "download" | "meta" | "preview" | "watch" | "write", sourceSessionId?: string | null, params?: Record<string, string | number | undefined>): string` — used by `FileViewer.tsx` and `ExcalidrawViewer.tsx` with identical behavior to the current private helper.

- [ ] **Step 1: Write the failing test**

Create `lib/file-api.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-api.ts");
}

test("builds file api urls with type, session and extra params", async () => {
  const { getFileApiUrl } = await loadSubject();

  const url = getFileApiUrl("/tmp/a.json", "read", "session-1", { offset: 10, v: 0 });
  assert.ok(url.startsWith("/api/files/"), `unexpected prefix: ${url}`);
  assert.ok(url.includes("type=read"), url);
  assert.ok(url.includes("sessionId=session-1"), url);
  assert.ok(url.includes("offset=10"), url);
  // Falsy param values are omitted.
  assert.ok(!url.includes("v="), url);
});

test("omits sessionId when absent", async () => {
  const { getFileApiUrl } = await loadSubject();

  const url = getFileApiUrl("/tmp/a.json", "write", null);
  assert.ok(url.startsWith("/api/files/"));
  assert.ok(url.includes("type=write"));
  assert.ok(!url.includes("sessionId="), url);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --experimental-strip-types --test lib/file-api.test.mjs
```

Expected: FAIL — module `./file-api.ts` does not exist.

- [ ] **Step 3: Create `lib/file-api.ts`**

Copy the helper body verbatim from `components/FileViewer.tsx` (the function named `getFileApiUrl`):

```ts
import { encodeFilePathForApi } from "./file-paths";

export type FileApiRequestType = "read" | "download" | "meta" | "preview" | "watch" | "write";

export function getFileApiUrl(
  filePath: string,
  type: FileApiRequestType,
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --experimental-strip-types --test lib/file-api.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Switch `FileViewer.tsx` to the shared helper**

In `components/FileViewer.tsx`:

Delete the entire local definition (it sits directly above `DownloadLink`):

```ts
function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch" | "write",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}
```

Add to the existing import block (anywhere among the `@/lib/...` imports):

```ts
import { getFileApiUrl } from "@/lib/file-api";
```

- [ ] **Step 6: Run existing FileViewer tests to confirm no regression**

```bash
node --experimental-strip-types --test components/FileViewer.test.mjs components/FileViewer.edit.test.mjs components/FileViewer.state.test.mjs components/FileViewer.search.test.mjs components/FileViewer.changemarker.test.mjs
```

Expected: PASS. (These are source-regex tests; they must be unaffected.)

- [ ] **Step 7: Commit**

```bash
git add lib/file-api.ts lib/file-api.test.mjs components/FileViewer.tsx
git commit -m "refactor: extract shared getFileApiUrl into lib/file-api"
```

---

### Task 4: File-explorer icon and i18n copy

**Files:**
- Modify: `components/FileIcons.tsx`
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts` (each in the block around line 514–527 where the other `i18n.*` file-viewer keys live)
- Test: `components/FileIcons.test.mjs` (new)

**Interfaces:**
- Consumes: existing keys `i18n.save`, `i18n.saving`, `i18n.editFile`, `i18n.doneEditing`, `i18n.confirmDiscard`, `i18n.fileChangedOnDisk`, `i18n.overwrite`, `i18n.saveFailed`, `i18n.downloadFile`, `i18n.liveSync`, `i18n.notWatching` (all already present in the three locale files).
- Produces: new keys `i18n.openAsText`, `i18n.invalidExcalidrawScene`; `getFileIcon()` returns an Excalidraw icon for `.excalidraw` files.

- [ ] **Step 1: Write the failing test**

Create `components/FileIcons.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileIcons.tsx", import.meta.url), "utf8");

test("maps .excalidraw files to a dedicated icon", () => {
  assert.match(source, /function ExcalidrawIcon\(/);
  assert.match(source, /excalidraw.*ExcalidrawIcon|ExcalidrawIcon.*excalidraw/s);
});

test("excalidraw keys exist in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"i18n\.openAsText"/, locale);
    assert.match(messages, /"i18n\.invalidExcalidrawScene"/, locale);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --experimental-strip-types --test components/FileIcons.test.mjs
```

Expected: FAIL — `ExcalidrawIcon` not found / keys missing.

- [ ] **Step 3: Add the icon**

In `components/FileIcons.tsx`, add an inline SVG (hand-drawn style matches the existing stroke-based icons; the Excalidraw brand logo itself is not in the Catppuccin icon set). Place it above `EXTENSION_ICONS`:

```tsx
function ExcalidrawIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Hand-drawn canvas frame */}
      <path d="M5.2 4.1c4.4-.9 9.2-.7 13.6 1" />
      <path d="M20.2 6.3c.8 4.3.6 8.7-.6 12.9" />
      <path d="M17.5 20.3c-4.2.8-8.5.6-12.4-.9" />
      <path d="M3.6 17.2c-.7-4.2-.4-8.5 1-12.4" />
      {/* Pen stroke */}
      <path d="M8.6 14.9c1.9.4 3.8.2 5.6-.6l4.3-2c.5-.3.3-.9-.3-.9-3.2.3-6.4 1-9.5 2.4-1 .5-.9 1.2-.1 1.1z" fill="currentColor" stroke="none" />
    </svg>
  );
}
```

Then extend `getFileIcon` so the extension resolves to it (insert before the `EXTENSION_ICONS` lookup):

```tsx
export function getFileIcon(name: string, size = 14): React.ReactNode {
  const lower = name.toLowerCase();
  const specialIcon = getSpecialFileIcon(lower);
  if (specialIcon) return <CatppuccinIcon name={specialIcon} size={size} />;

  const ext = lower.split(".").pop() ?? "";
  if (ext === "excalidraw") return <ExcalidrawIcon size={size} />;
  const icon = EXTENSION_ICONS[ext];
  return icon ? <CatppuccinIcon name={icon} size={size} /> : <GenericFileIcon size={size} />;
}
```

- [ ] **Step 4: Add the i18n keys**

In `lib/i18n/messages/en.ts`, immediately after `"i18n.saveFailed": "Save failed",` add:

```ts
    "i18n.openAsText": "Open as text",
    "i18n.invalidExcalidrawScene": "This file is not a valid Excalidraw scene.",
```

In `lib/i18n/messages/zh-CN.ts`, after its `"i18n.saveFailed"` line add:

```ts
    "i18n.openAsText": "以文本方式打开",
    "i18n.invalidExcalidrawScene": "该文件不是有效的 Excalidraw 场景。",
```

In `lib/i18n/messages/zh-TW.ts`, after its `"i18n.saveFailed"` line add:

```ts
    "i18n.openAsText": "以文字方式開啟",
    "i18n.invalidExcalidrawScene": "該檔案不是有效的 Excalidraw 場景。",
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node --experimental-strip-types --test components/FileIcons.test.mjs lib/i18n/registry.test.mjs
```

Expected: PASS (the registry test validates key parity across locales).

- [ ] **Step 6: Commit**

```bash
git add components/FileIcons.tsx components/FileIcons.test.mjs lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat: excalidraw file icon and viewer i18n copy"
```

---

### Task 5: `ExcalidrawViewer` component + `FileViewer` dispatch

**Files:**
- Create: `components/ExcalidrawViewer.tsx`
- Modify: `components/FileViewer.tsx` (dispatch + text fallback state)
- Test: `components/ExcalidrawViewer.test.mjs` (new)

**Interfaces:**
- Consumes:
  - `isExcalidrawPath(filePath: string): boolean` (Task 2)
  - `getFileApiUrl(...)` (Task 3)
  - i18n keys from Task 4 and the pre-existing ones listed there
  - `useTheme()` → `{ isDark: boolean }`; `useI18n()` → `{ t: (key, vars?) => string }`
  - `getFileName`, `getRelativeFilePath` from `@/lib/file-paths`
- Produces:
  - `components/ExcalidrawViewer.tsx` default export `ExcalidrawViewer` with props `{ filePath: string; cwd?: string; sourceSessionId?: string | null; watchEnabled?: boolean; onFallbackToText: () => void }`.
  - `FileViewer` renders it for `.excalidraw` paths (unless the user fell back to text).

- [ ] **Step 1: Write the failing tests**

Create `components/ExcalidrawViewer.test.mjs` (repo convention: read source, assert patterns):

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ExcalidrawViewer.tsx", import.meta.url), "utf8");
const fileViewerSource = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("loads the Excalidraw canvas lazily, client-only", () => {
  assert.match(source, /dynamic\(\s*\(\)\s*=>\s*[\s\S]*?import\("@excalidraw\/excalidraw"\)/s);
  assert.match(source, /\{\s*ssr:\s*false/);
});

test("renders view-only canvas in view mode", () => {
  assert.match(source, /viewModeEnabled=\{mode === "view"\}/);
});

test("persists only scene fields and preserves unknown top-level keys", () => {
  assert.match(source, /\.\.\.original/);
  assert.match(source, /SAVED_APP_STATE_KEYS\s*=\s*\[["'`]?viewBackgroundColor/);
});

test("save sends baseMtimeMs and handles 409 conflicts", () => {
  assert.match(source, /baseMtimeMs:\s*options\.force\s*\?\s*null\s*:\s*baseMtimeMsRef\.current/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /setSaveConflict\(true\)/);
});

test("asks before discarding unsaved edits on exit", () => {
  assert.match(source, /window\.confirm\(t\("i18n\.confirmDiscard"\)\)/);
});

test("external file changes reload the scene only outside edit mode", () => {
  assert.match(source, /modeRef\.current === "view"[\s\S]*?loadScene\(\)/);
});

test("offers a text-viewer fallback when the scene cannot be parsed", () => {
  assert.match(source, /onFallbackToText\(\)/);
});

test("FileViewer dispatches .excalidraw files to ExcalidrawViewer before the text viewer", () => {
  assert.match(fileViewerSource, /isExcalidrawPath\(filePath\)/);
  assert.match(fileViewerSource, /<ExcalidrawViewer/);
  assert.match(fileViewerSource, /onFallbackToText=\{\(\) => setTextFallback\(true\)\}/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --experimental-strip-types --test components/ExcalidrawViewer.test.mjs
```

Expected: FAIL — `ExcalidrawViewer.tsx` does not exist (readFile throws).

- [ ] **Step 3: Create `components/ExcalidrawViewer.tsx`**

Use the CSS path discovered in Task 1 Step 2 in the dynamic loader below (shown here as `@excalidraw/excalidraw/index.css` — substitute the path found on the installed version if it differs):

```tsx
"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { getFileApiUrl } from "@/lib/file-api";

/** Element/file schemas are owned by Excalidraw; we only move them around. */
type ExcalidrawElement = Record<string, unknown>;
type BinaryFiles = Record<string, Record<string, unknown>>;

interface SceneData {
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: BinaryFiles;
}

/** appState fields persisted back into the scene file (no runtime UI state). */
const SAVED_APP_STATE_KEYS = ["viewBackgroundColor", "gridSize", "gridModeEnabled"] as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const Excalidraw = dynamic(
  () =>
    Promise.all([
      import("@excalidraw/excalidraw"),
      import("@excalidraw/excalidraw/index.css"),
    ]).then(([mod]) => ({ default: mod.Excalidraw })),
  { ssr: false, loading: () => null },
);

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  watchEnabled?: boolean;
  /** Called when the file cannot be parsed as an Excalidraw scene. */
  onFallbackToText: () => void;
}

type ReadResponse = {
  content?: string;
  mtimeMs?: number;
  size?: number;
  error?: string;
};

type WriteResponse = {
  mtimeMs?: number;
  size?: number;
  error?: string;
};

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "4px 16px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  color: "var(--text-dim)",
  background: "var(--bg)",
  flexShrink: 0,
};

const ICON_BUTTON_STYLE: CSSProperties = {
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
};

export default function ExcalidrawViewer({
  filePath,
  cwd,
  sourceSessionId,
  watchEnabled = true,
  onFallbackToText,
}: Props) {
  const { t } = useI18n();
  const { isDark } = useTheme();

  const [scene, setScene] = useState<SceneData | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [watching, setWatching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const originalJsonRef = useRef<Record<string, unknown> | null>(null);
  const baseMtimeMsRef = useRef(0);
  const elementsRef = useRef<ExcalidrawElement[] | null>(null);
  const appStateRef = useRef<Record<string, unknown> | null>(null);
  const filesRef = useRef<BinaryFiles | null>(null);
  const sceneRequestRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const loadScene = useCallback(() => {
    const requestId = ++sceneRequestRef.current;
    fetch(getFileApiUrl(filePath, "read", sourceSessionId))
      .then((r) => r.json())
      .then((d: ReadResponse) => {
        if (requestId !== sceneRequestRef.current) return;
        if (d.error) {
          setError(d.error);
          return;
        }
        try {
          const parsed = JSON.parse(d.content ?? "") as Record<string, unknown>;
          if (!Array.isArray(parsed.elements)) throw new Error(t("i18n.invalidExcalidrawScene"));
          originalJsonRef.current = parsed;
          baseMtimeMsRef.current = typeof d.mtimeMs === "number" ? d.mtimeMs : 0;
          if (typeof d.size === "number") setSize(d.size);
          setScene({
            elements: parsed.elements as ExcalidrawElement[],
            appState: (parsed.appState ?? {}) as Record<string, unknown>,
            files: (parsed.files ?? {}) as BinaryFiles,
          });
          elementsRef.current = null;
          appStateRef.current = null;
          filesRef.current = null;
          setDirty(false);
          setError(null);
          setSaveConflict(false);
          setSaveError(null);
          setReloadKey((k) => k + 1);
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message === t("i18n.invalidExcalidrawScene")) {
            setError(parseError.message);
          } else {
            setError(t("i18n.invalidExcalidrawScene"));
          }
        }
      })
      .catch((e) => {
        if (requestId === sceneRequestRef.current) setError(String(e));
      });
  }, [filePath, sourceSessionId, t]);

  useEffect(() => {
    setScene(null);
    setMode("view");
    setError(null);
    loadScene();
  }, [filePath, sourceSessionId, loadScene]);

  // Live watch: identical pattern to ImageViewer. While editing, an external
  // change must not clobber the canvas; only the size display refreshes.
  useEffect(() => {
    setWatching(false);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (!watchEnabled) return;

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", () => {
      if (modeRef.current === "view") {
        loadScene();
      } else {
        fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
          .then((r) => r.json())
          .then((d: { size?: number }) => {
            if (typeof d.size === "number") setSize(d.size);
          })
          .catch(() => { /* ignore */ });
      }
    });
    const markDisconnected = () => setWatching(false);
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled, loadScene]);

  const enterEdit = useCallback(() => {
    setSaveConflict(false);
    setSaveError(null);
    setMode("edit");
  }, []);

  const exitEdit = useCallback(() => {
    if (dirty && !window.confirm(t("i18n.confirmDiscard"))) return;
    setSaveConflict(false);
    setSaveError(null);
    setMode("view");
    setDirty(false);
  }, [dirty, t]);

  const saveScene = useCallback(async (options: { force?: boolean } = {}) => {
    if (saving || !scene) return;
    setSaving(true);
    setSaveError(null);
    try {
      const original = originalJsonRef.current ?? {};
      const savedAppState: Record<string, unknown> = {};
      const liveAppState = appStateRef.current;
      for (const key of SAVED_APP_STATE_KEYS) {
        if (liveAppState && key in liveAppState) savedAppState[key] = liveAppState[key];
      }
      const merged: Record<string, unknown> = {
        ...original,
        type: "excalidraw",
        version: typeof original.version === "number" ? original.version : 2,
        elements: elementsRef.current ?? scene.elements,
        appState: savedAppState,
        files: filesRef.current ?? scene.files,
      };
      const response = await fetch(getFileApiUrl(filePath, "write", sourceSessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: JSON.stringify(merged, null, 2),
          baseMtimeMs: options.force ? null : baseMtimeMsRef.current,
        }),
      });
      if (response.status === 409) {
        setSaveConflict(true);
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as WriteResponse | null;
        setSaveConflict(false);
        setSaveError(payload?.error ?? t("i18n.saveFailed"));
        return;
      }
      const result = await response.json() as WriteResponse;
      baseMtimeMsRef.current = result.mtimeMs ?? baseMtimeMsRef.current;
      if (typeof result.size === "number") setSize(result.size);
      originalJsonRef.current = merged;
      setScene({
        elements: merged.elements as ExcalidrawElement[],
        appState: merged.appState as Record<string, unknown>,
        files: merged.files as BinaryFiles,
      });
      setSaveConflict(false);
      setDirty(false);
    } catch (e) {
      setSaveConflict(false);
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [filePath, saving, scene, sourceSessionId, t]);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={HEADER_STYLE}>
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "excalidraw"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        {mode === "view" ? (
          <button type="button" style={ICON_BUTTON_STYLE} onClick={enterEdit}>
            {t("i18n.editFile")}
          </button>
        ) : (
          <>
            {dirty && <span style={{ color: "#fbbf24" }}>{t("i18n.unsavedChanges")}</span>}
            <button
              type="button"
              style={ICON_BUTTON_STYLE}
              disabled={saving || (!dirty && !saveConflict)}
              onClick={() => void saveScene()}
            >
              {saving ? t("i18n.saving") : t("i18n.save")}
            </button>
            <button type="button" style={ICON_BUTTON_STYLE} onClick={exitEdit}>
              {t("i18n.doneEditing")}
            </button>
          </>
        )}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {error ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              color: "#f87171",
              fontSize: 13,
            }}
          >
            <span>{error}</span>
            <button type="button" style={ICON_BUTTON_STYLE} onClick={onFallbackToText}>
              {t("i18n.openAsText")}
            </button>
          </div>
        ) : saveConflict ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              fontSize: 13,
            }}
          >
            <span>{t("i18n.fileChangedOnDisk")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={ICON_BUTTON_STYLE} onClick={() => void saveScene({ force: true })}>
                {t("i18n.overwrite")}
              </button>
              <button
                type="button"
                style={ICON_BUTTON_STYLE}
                onClick={() => {
                  setSaveConflict(false);
                  setMode("view");
                  loadScene();
                }}
              >
                {t("i18n.cancel")}
              </button>
            </div>
          </div>
        ) : saveError ? (
          <div style={{ padding: "8px 16px", color: "#f87171", fontSize: 12 }}>{saveError}</div>
        ) : null}
        {scene && !saveConflict && (
          <div style={{ position: "absolute", inset: 0 }}>
            <Excalidraw
              key={`${filePath}-${reloadKey}`}
              initialData={{
                elements: scene.elements,
                appState: scene.appState,
                files: scene.files,
              }}
              viewModeEnabled={mode === "view"}
              theme={isDark ? "dark" : "light"}
              onChange={(elements, appState, files) => {
                elementsRef.current = elements as ExcalidrawElement[];
                appStateRef.current = appState as Record<string, unknown>;
                filesRef.current = files as BinaryFiles;
                if (mode === "edit") setDirty(true);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the dispatch into `FileViewer.tsx`**

In `components/FileViewer.tsx`:

Add the lazy import near the top (after the existing imports):

```ts
const ExcalidrawViewer = dynamic(() => import("./ExcalidrawViewer"), { ssr: false });
```

(Also add `import dynamic from "next/dynamic";` if not already present, and `import { isExcalidrawPath } from "@/lib/file-types";` — extend the existing `@/lib/file-types` import list.)

In the `FileViewer` component, add fallback state at the top and a reset effect:

```ts
const [textFallback, setTextFallback] = useState(false);
useEffect(() => {
  setTextFallback(false);
}, [filePath]);
```

Then extend the dispatch chain so the excalidraw branch sits between `isDocumentPreviewPath` and the `TextFileViewer` return:

```ts
if (isExcalidrawPath(filePath) && !textFallback) {
  return (
    <ExcalidrawViewer
      filePath={filePath}
      cwd={cwd}
      sourceSessionId={sourceSessionId}
      watchEnabled={watchEnabled}
      onFallbackToText={() => setTextFallback(true)}
    />
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --experimental-strip-types --test components/ExcalidrawViewer.test.mjs components/FileViewer.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: no errors. If `@excalidraw/excalidraw` types complain about the loose `onChange` casts, cast through `as unknown as Record<string, unknown>` rather than weakening project types. If the CSS import path from Task 1 Step 2 fails to resolve, replace it with the exact css path found under `node_modules/@excalidraw/excalidraw/`.

- [ ] **Step 7: Manual smoke test against the dev server (if available)**

```bash
npm run dev &
sleep 8
printf '{"type":"excalidraw","version":2,"source":"pi-web","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}' > /tmp/smoke.excalidraw
```

Open the app, add a session cwd containing `/tmp`, open `smoke.excalidraw` in the file browser: canvas renders read-only; Edit → draw a rectangle → Save → file content contains the new element; external edit of the file while in view mode reloads the canvas. Stop the dev server afterwards.

- [ ] **Step 8: Commit**

```bash
git add components/ExcalidrawViewer.tsx components/ExcalidrawViewer.test.mjs components/FileViewer.tsx
git commit -m "feat: excalidraw scene viewer with view/edit modes"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit any stragglers (or clean tree)**

```bash
git status --short
```

Expected: clean tree (generated `BEGIN:nextjs-agent-rules` blocks in `AGENTS.md` must NOT be committed — discard them with `git checkout -- AGENTS.md` if present).
