# Open Native File Browser (File Explorer)

**Date:** 2026-09-04
**Status:** Approved (design)

## Goal

Let the user jump from Pi Web's left-side file explorer to the operating system's
native file browser (Finder / Explorer / file manager) at the exact location they
are looking at:

1. A new icon button in the file-explorer header opens the native file browser at
   the explorer's current root (the session/workspace cwd).
2. A hover action on every file and folder row opens the native file browser at
   that specific item: a folder opens in place, a file is revealed (opened with
   its containing folder shown and the file selected).

This is a convenience/shortcut feature: it complements, never replaces, the
in-app file tabs.

## Non-Goals

- No remote-machine UX in v1 (no copy-confirmation dialogs like terminal's
  clipboard fallback, no client/server machine detection). If the server runs on
  machine A and the browser on machine B, a window opens on machine A. The API
  response surfaces failures; the UI surfaces errors non-destructively.
- No electron/desktop-shell bridge for reveal in v1 (unlike terminal's
  `window.piDesktop` preference). Finder/Explorer/xdg-open launch reliably from
  a local background server process.
- No settings, no tool presets, no session-file changes.

## Backend: `POST /api/file-browser/open`

New route: `app/api/file-browser/open/route.ts` (mirrors `app/api/terminal/open/`).

Request body:

```json
{ "path": "/abs/path/to/file-or-dir" }
```

Validation pipeline (order matters; all 4xx/5xx responses are JSON `{ error: string }`):

1. `isApiRequestAllowed(request)` → 403 "Untrusted API request" (same wording as other routes).
2. `path` present, non-empty string → 400 "path is required".
3. `fs.existsSync(path)` → 400 with `Directory does not exist: <path>` wording family ("Path does not exist: …" acceptable; keep the terminal route's phrasing style).
4. Allowed-roots gate: `getAllowedFileRoots()` then `isFilePathAllowed(path, roots) && isExistingFilePathAllowed(path, roots)` → 403 "Access denied".
5. Determine `isDirectory` via `fs.statSync(path).isDirectory()`.
6. Platform spawn (`spawn(command, args, { detached: true, stdio: "ignore" })`, then `child.unref()`, resolve `{ ok: true }` after ~250 ms unless an early `error` event resolves `{ ok: false, error }` first — the same best-effort pattern as terminal opening):

| Platform | File | Directory |
|---|---|---|
| darwin | `osascript -e 'tell application "Finder" to reveal POSIX file "…"'` → `open -R` equivalent, explicit Finder selection | `open <dir>` |
| win32 | `explorer /select,<file>` | `explorer <dir>` |
| linux | `xdg-open <parent-of-file>` | `xdg-open <dir>` |

Notes:
- macOS reveal uses osascript's `reveal POSIX file …` + `activate` so an already-running Finder comes to front with the file selected (equivalent to `open -R`; both acceptable — implementation may simply call `open -R` via spawn).
- Windows `/select,` requires no space after the comma and a backslashed native path. The server normalizes incoming slashes to native separators before spawning (compare `toNativePath()` in `lib/paths.ts`; git-driven route rule "compare paths with samePath(), never ===" does not apply here because the value is passed to the OS, not compared — but native separators are still required for `explorer /select,`).
- spawn errors are captured via `child.on("error", …)`; the promise resolves `{ ok: true }` after a short delay if no early error arrives, exactly like `openTerminal()` in the terminal route (GUI window appearance is async and unverifiable).
- Response: `{ ok: true }` on accepted spawn; `{ error }` with 4xx/5xx otherwise.

## 2. Frontend: header button

`components/SessionSidebar.tsx` — explorer heading row (`.sidebar-explorer-heading`), which currently holds: changes toggle, file search, upload, refresh.

- New `ToolbarIconButton` placed between the upload button and the refresh button.
- Shown only when `explorerOpen` (same guard as the other explorer actions).
- `title` = `t("sidebar.openNativeFileBrowser")`; `aria-label` same; `aria-pressed` unset.
- Disabled while a reveal request is in flight (local `revealOpening` state, cleared after 600 ms so the button never looks dead — same trick as `terminalOpening`).
- onClick → shared helper `revealInFileBrowser(path)` (below) with the explorer cwd (`selectedCwd ?? selectedCwdProp`; the button only renders when a cwd exists, matching the surrounding `(selectedCwdProp || selectedCwd)` guard).

## 3. Frontend: per-row hover action

`components/FileExplorer.tsx` — `TreeNode` row (and the shared row-building path used by search results, since both render through `TreeNode`).

- Replace the two independent absolutely-positioned hover buttons with one `position:absolute; right:4; top:50%; translateY(-50%)` flex row (`display:flex; gap:3`): **mention pill → reveal button → download link** (right-to-left order on screen: download rightmost for files; for dirs, reveal rightmost, then mention).
- The reveal button renders for **both files and directories**; download stays files-only; mention keeps its current `onAtMention`-presence condition.
- Reveal button: square 20×20-ish, same visual language as the download link (`background: var(--bg-panel)`, `border: 1px solid var(--border)`, `color: var(--text-muted)`, 11–12 px stroke icon), `title`/`aria-label` = `t("files.openInFileBrowser")`.
- Icon: external-link / arrow-out-of-box SVG (stroke currentColor, consistent with existing 24-viewBox inline SVGs). Not the same glyph as search/upload/refresh.
- `onClick` → `event.stopPropagation()` (row's open/open-file handler must not fire) → shared helper `revealInFileBrowser(path)`; stopPropagation stays mandatory even though the reveal anchor itself does not navigate.
- Context menu (`data-file-explorer-menu`) stays unchanged in v1: right-click already exists; adding a reveal item is optional polish, not in scope.

## 4. Shared helper

New `lib/reveal-in-file-browser.ts`:

```ts
export function revealInFileBrowser(path: string): Promise<{ ok: boolean; error?: string }>
```

- POST `/api/file-browser/open` with `Content-Type: application/json`, body `{ path }`.
- Resolves `{ ok: true }` on 2xx; parses `{ error }` on non-2xx; resolves `{ ok: false, error }` on network/parse failure (no throw).
- Consumed by both the SessionSidebar header button and TreeNode hover button; each caller owns its own in-flight/disabled state.

## 5. i18n

Three locale plugins (`lib/i18n/messages/{en,zh-CN,zh-TW}.ts`) get the same new keys — flat keys in the existing plugin maps (registry enforces key parity across locales):

- `sidebar.openNativeFileBrowser`
- `files.openInFileBrowser`
- `files.openInFileBrowserFailed`

Wording: zh-CN 「打开本机文件浏览器」 (both button titles; hover and header may share wording), zh-TW traditional equivalents, en "Open in file browser" / "Failed to open file browser".

## 6. Error handling

- Non-2xx API responses surface `data.error` verbatim when present, else a generic message — same conventions as `requestFileMutation()` and the file-search error paths.
- Failures from the reveal call never mutate explorer/tree state (no refresh, no selection change).

## 7. Route test

- Node `node:test` source-assertion test next to the route (matching repo convention of colocated `*.test.mjs` files that regex-check the route source), asserting:
  - the `isApiRequestAllowed` guard is present;
  - `getAllowedFileRoots()` + `isFilePathAllowed` + `isExistingFilePathAllowed` guard the path;
  - `existsSync` existence check;
  - darwin/win32/linux command branches are all implemented (regex on key fragments);
  - spawn is `detached` with `stdio: "ignore"` and calls `unref()`.
- Existing suites must keep passing.

## 8. Testing

Frontend changes are covered by the two existing suites; no new component tests in v1 (none exist for the explorer today). Backend route gets a colocated source-assertion test.
