# File Explorer Mutations Design

## Goal

Add native file-management actions to Pi Web's left file explorer: create files and folders, rename, move, and delete files or directories. All actions are available through a contextual right-click menu; moves also work by dragging entries onto directories.

## Scope

The feature operates only within the existing allowed file roots used by `/api/files`. It changes files on disk immediately. Deletion is permanent, not a recycle-bin action.

## User Experience

### Context menu

Right-clicking a file or folder prevents the browser menu and opens an accessible, pointer-positioned explorer menu. Clicking unused tree space targets the explorer's current working directory.

Available actions:

| Target | Actions |
| --- | --- |
| Empty tree area | New file, New folder |
| Folder | New file, New folder, Rename, Move to…, Delete |
| File | Rename, Move to…, Delete |

Existing file affordances, including open, mention, download, Git status, and upload behavior, remain available.

### Naming and conflicts

Create and rename collect a single name in an inline explorer control or lightweight purpose-built dialog. Names cannot be empty, `.` or `..`, contain a path separator, or be absolute paths. Existing target names are never overwritten. The UI retains the submitted name and presents the server error so the user can correct it.

### Move

`Move to…` opens a folder-only tree chooser rooted at the explorer cwd. The confirm action is disabled for the current parent directory, the source directory itself, and descendants of a directory source. Existing targets are rejected without overwriting.

Entries are also draggable. A file or directory dropped onto a directory performs the same move request. The candidate target directory is visibly highlighted. Drops onto files and moving a directory into itself or a descendant are rejected before the request.

### Delete

Every delete action shows a confirmation prompt naming the affected entry. It warns when a directory is non-empty. Confirming permanently deletes files or recursively deletes directories; cancellation makes no request.

### Result synchronization

A successful operation refreshes the explorer tree and Git status. Renamed or moved files that are open in tabs update their path and label. Deleting an open file closes its tab. Failed actions do not optimistically mutate tree state.

## Architecture

### Server mutation API

Extend `app/api/files/[...path]/route.ts` with mutation request types for `create-file`, `create-directory`, `rename`, `move`, and `delete`. Each request validates `isApiRequestAllowed()` before parsing its JSON body.

The path in the route selects the source item or parent directory as appropriate. Request bodies carry only operation-specific names or destination directories. A focused server helper validates names, resolves paths, detects conflicts, and returns clear 4xx responses.

The server must authorize the lexical candidate path with `isFilePathAllowed()` and authorize existing source/parent/destination paths after canonical resolution with `isExistingFilePathAllowed()`. For writes, it must resolve and re-check existing parents so symlinks cannot redirect a mutation outside the allowed roots. Rename and move stay within allowed roots. Deletion uses `lstat` semantics so deleting a symlink removes the link rather than recursively operating on its target.

### Client state and components

`components/FileExplorer.tsx` owns menu visibility, selected target, dialog/chooser state, operation-pending state, and refresh sequencing. Tree nodes receive narrow callbacks for context menus and internal drag moves instead of independently owning mutation state.

A focused helper module holds pure mutation request construction and client-safe path/source validation where useful. This keeps the explorer component centered on interaction state and enables isolated tests. The API remains the authority for every validation and authorization decision.

The file-tab owner (currently `components/AppShell.tsx` and its file-tab state helpers) receives an explorer mutation notification with `{ kind, sourcePath, destinationPath? }` and updates or removes matching tabs using normalized paths.

## Error Handling

The API uses these response classes:

- `400`: malformed request, invalid name, invalid mutation type, or impossible source/destination relation;
- `403`: untrusted request or access outside permitted roots;
- `404`: missing source, parent, or destination directory;
- `409`: a same-name destination already exists;
- `500`: unexpected filesystem error without leaking sensitive filesystem details.

The UI maps failures to a persistent local operation error, preserves the current tree, restores interaction controls, and announces the message accessibly. Network failures use a generic retryable message.

## Tests

1. Add route-level tests for every operation's successful behavior, invalid-name rejection, root-escape rejection, canonical/symlink escape rejection, conflict rejection, and recursive directory deletion.
2. Add unit tests for mutation path/name helpers and tab synchronization for rename, move, and delete.
3. Add component-focused tests covering target-specific context-menu actions, delete confirmation/cancellation, folder-only move validation, and drag-to-directory dispatch.
4. Run the focused test files, then the repository TypeScript and lint checks.

## Non-goals

- Undo/recycle-bin support.
- Copy, multi-select, batch operations, or OS clipboard integration.
- Editing file content from the explorer.
- Moving entries across disallowed roots or overwriting destination entries.
