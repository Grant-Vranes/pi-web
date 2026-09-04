# Open Native File Browser — Design

**Date:** 2026-09-04
**Status:** Approved by user (pending spec review)

## Problem

Pi Web's left file explorer (workspace tree) is the only way to see project
files, but users who want to interact with a file or folder in their OS's
native file browser (Finder, Windows Explorer, GNOME Files, …) must manually
navigate there. This adds two entry points that jump straight to the right
location:

1. A **header icon button** in the file explorer heading that opens the native
   file browser at the explorer's current root (`cwd`).
2. A **hover action on every file/folder row** that opens the native file
   browser at that specific item:
   - Directory → open that directory in the file browser.
   - File → reveal (open containing folder with the file selected). On Linux
     where no "reveal" convention exists, open the file's containing directory.

## Non-Goals

- No Electron/desktop-shell bridge (unlike `window.piDesktop.openTerminal`):
  `open`/`explorer`/`xdg-open` launched from the local Next.js server process
  reliably appear on macOS/Windows/Linux desktops.
- No changes to the in-app file tabs, file viewer, or upload flows.
- No client/server machine detection for remote-browsing scenarios.

## Backend

### New route: `app/api/file-browser/open/route.ts`

`POST /api/file-browser/open` with JSON body `{ "path": "/abs/path" }`.

Validation order (all failures return JSON `{ error: string }`):

1. `isApiRequestAllowed(request)` → 403 "Untrusted API request"
2. `path` is a non-empty string → 400 "path is required"
3. Allowed-roots gate, lexical pass (BEFORE any filesystem access so the
   400 below cannot probe paths outside the boundary):
   `getAllowedFileRoots()` then `isFilePathAllowed(path, roots)`
   → 403 "Access denied"
4. Path exists (checked with `fs.existsSync`) → 400 "Path does not exist: <path>"
5. Allowed-roots gate, realpath pass: `isExistingFilePathAllowed(path, roots)`
   → 403 "Access denied" (rejects symlink escapes; runs after the existence
   check because realpath requires an existing path)
6. `fs.statSync(path).isDirectory()` decides file vs directory behaviour.

Platform-specific open (child_process.spawn, `{ detached: true, stdio: "ignore" }`,
`child.unref()`, resolve after ~250 ms unless an early `error` event fires — the
same best-effort pattern as `openTerminal()`):

| Platform | File                              | Directory         |
| -------- | --------------------------------- | ----------------- |
| darwin   | `open -R <file>`                  | `open <dir>`      |
| win32    | `explorer /select,<file>`         | `explorer <dir>`  |
| linux    | `xdg-open <parent of file>`       | `xdg-open <dir>`  |

Windows: `explorer /select,` needs no space after the comma and requires native
backslash separators; incoming paths are normalised with `toNativePath()` from
`lib/paths.ts` before spawning on win32.

Response: `{ ok: true }` on accepted spawn; `{ error }` with 400/403/500
otherwise.

## Frontend

### Header button — `components/SessionSidebar.tsx`

In the `.sidebar-explorer-heading` row (currently: changes toggle, search,
upload, refresh) add a new `ToolbarIconButton` between the upload button and
the refresh button:

- Rendered only when `explorerOpen` (same guard as the other explorer actions).
- Icon: folder-plus-arrow/external style SVG consistent with the other 13×13
  stroke icons; `title`/`aria-label` = `t("sidebar.openNativeFileBrowser")`.
- Clicking calls `openInFileBrowser(selectedCwd ?? selectedCwdProp)`; disabled
  (via a local `fileBrowserOpening` state cleared after 600 ms) so repeated
  clicks can't stack dialogs.

### Row hover button — `components/FileExplorer.tsx`

`TreeNode` currently renders two independent absolutely-positioned hover
controls: the mention pill button and the (files-only) download link. Refactor
them into a single right-anchored flex container
(`position: absolute; right: 4; display: flex; gap: 4; align-items: center`)
so buttons flow leftwards from the right edge:

- Mention pill button (unchanged behaviour, still conditional on
  `onAtMention`).
- New file-browser button — 20×20 icon button styled like the existing
  download link (`background: var(--bg-panel)`, `border: 1px solid
  var(--border)`, `color: var(--text-muted)`, 11–12 px stroke icon,
  `title`/`aria-label` = `t("files.openInFileBrowser")`), with
  `event.stopPropagation()` so the row's open/toggle handler doesn't fire.
- Download link (files only, unchanged).

The button calls `openInFileBrowser(node.fullPath)`; the server decides
reveal-vs-open from the path's own type.

### Shared helper — `lib/file-browser.ts`

```ts
export async function openInFileBrowser(path: string): Promise<{ ok: boolean; error?: string }>
```

POSTs to `/api/file-browser/open`, parses `{ error }` on non-2xx, resolves
`{ ok: false, error }` instead of throwing on network failures. Consumed by
both the sidebar header button and `TreeNode`.

## i18n

Add to all three locale plugins (`lib/i18n/messages/{en,zh-CN,zh-TW}.ts`):

- `sidebar.openNativeFileBrowser`
- `files.openInFileBrowser`
- `files.openInFileBrowserFailed`

## Testing

- New `app/api/file-browser/open/route.test.mjs` in the repo's `node:test`
  source-assertion style (like `app/api/files/mutation-route.test.mjs`),
  asserting the request-security guard, allowed-roots guard, existence check,
  per-platform command branches, and detached spawn usage.
- `node_modules/.bin/tsc --noEmit` and `npm run lint` must pass.
- Manual checks: header button opens Finder at the project root; hovering a
  folder shows the new button and opens that folder; hovering a file reveals
  it selected in Finder; row click still opens/toggles as before.

## Files Touched

- Create: `app/api/file-browser/open/route.ts`
- Create: `app/api/file-browser/open/route.test.mjs`
- Create: `lib/file-browser.ts`
- Modify: `components/SessionSidebar.tsx` (header button + i18n usage)
- Modify: `components/FileExplorer.tsx` (TreeNode hover action container)
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`
