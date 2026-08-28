# File Explorer drag-and-drop upload (files and folders)

## Goal

Allow users to drag local files **and folders** onto the left file-explorer panel and upload them into the session working directory, preserving folder structure. Single files drag in flat (relative path = file name); folders drag in recursively, recreating subdirectories under the cwd.

## Scope

- Add a drag-and-drop upload channel to `FileExplorer`, distinct from the existing ChatWindow path-mention channel (which is text-only and untouched).
- Support both files and directories. Directories are read recursively via `webkitGetAsEntry()`; their contents are written under the cwd at their relative paths, recreating subdirectories.
- Reuse the existing upload state machine (checking → conflict → uploading → summary) and its UI.
- Extend the upload API to accept relative paths (path-separated file names) so folder structure can be recreated server-side.
- Keep all existing size limits and security boundaries: 25 MB per file, 100 MB total, allowed-roots + realpath checks on the upload directory.

## Non-goals

- No changes to ChatWindow / `useDragDrop` / `buildDropPayload`. That channel inserts `@"path"` mentions and never uploads content; it stays as-is.
- No changes to the `<input type="file">` upload button. It still selects flat files (browsers cannot select folders from a plain input), but those files now flow through the same generalized checking/upload path with `relativePath = file.name`.
- No resumable uploads, no chunking, no compression. The 100 MB hard cap remains.
- No drag reordering of tree nodes. Drag/drop on the explorer is upload-only.

## User interaction

1. User drags one or more files and/or folders from the OS onto the file-explorer panel.
2. While dragging over the panel, a translucent overlay appears: "Drop to upload into `<cwd basename>`".
3. On drop:
   - Files are collected with `relativePath = file.name`.
   - Folders are read recursively; every leaf file is collected with `relativePath = <dropped folder name>/<...>/<file name>`.
   - If the browser does not expose `webkitGetAsEntry` (unsupported), fall back to `dataTransfer.files` flat — behavior matches the old `<input>` upload; folder structure cannot be recovered and is not promised.
4. Frontend pre-check: if any single file exceeds 25 MB or the total exceeds 100 MB, the upload is aborted in the `checking` phase with an error listing the offending file names. No request is sent.
5. Otherwise the existing `upload-check` POST runs with the relative paths. Conflicts (existing files **or directories** at any target path) are reported back.
6. If conflicts exist, the existing conflict UI shows them by relative path and offers Replace / Skip existing / Cancel:
   - **Replace**: directories that already exist are left in place (merged, not deleted); files at conflict paths are unlinked and overwritten. New files in existing directories are written normally.
   - **Skip existing**: paths that already exist are skipped — an existing directory is not recreated, but files inside it that do **not** conflict are still uploaded. Only items reported as conflicts are skipped; non-conflicting siblings upload normally.
   - **Cancel**: aborts the whole drop.
7. On success the existing summary (uploaded / skipped / failed counts) and the "newly uploaded" highlight dot appear; the tree refreshes to show the new structure.

## Platform behavior

### Electron / Chromium-based

`webkitGetAsEntry()` is available on `DataTransferItem`. Directories are enumerable. This is the primary supported path and the only one that can preserve folder structure.

### Other browsers / unsupported

When `webkitGetAsEntry` is missing or throws, collect `dataTransfer.files` flat with `relativePath = file.name`. A folder dropped in such a browser is either ignored (its `File` entries may be empty) or flattened; the feature degrades to single-file upload. No content is read as a fallback for path inference.

## Architecture

### New helper: `lib/drop-collect.ts`

Pure client-side module exporting:

```ts
export interface DroppedUploadEntry {
  file: File;
  relativePath: string; // POSIX-style, "/"-separated, no leading slash
}

export interface CollectedDrop {
  entries: DroppedUploadEntry[];
  unsupported: boolean; // true when webkitGetAsEntry was unavailable
}

export async function collectDroppedUploadEntries(
  dataTransfer: DataTransfer,
): Promise<CollectedDrop>;
```

- Iterates `dataTransfer.items`; for each item calls `webkitGetAsEntry()`.
- For a file entry: `const file = await fileEntry.file();` → `{ file, relativePath: prefix ? `${prefix}/${entry.name}` : entry.name }`.
- For a directory entry: loops `reader.readEntries()` until it returns an empty array (a single call may not return all children), recursing with the accumulated prefix.
- `unsupported` is `true` when no item exposes `webkitGetAsEntry` (or the method is absent). In that case the function falls back to `Array.from(dataTransfer.files)` with flat `relativePath = file.name`.
- Returns entries in drop order. Does not deduplicate (server validates).
- Keeps the logic independent of React so it can be unit-tested in Node with fake entry objects.

### `FileExplorer` drag handlers

The explorer's root `<div>` gets `onDragEnter` / `onDragOver` / `onDragLeave` / `onDrop`. A local enter/leave counter (mirroring `useDragDrop`'s pattern but **not** reusing that hook, whose `buildDropPayload` is mention-oriented and triggers `piDesktop.getPathForFile`) controls an overlay state `isDropTarget`.

- `acceptsUploadDrop(dataTransfer)`: returns true only if there is at least one `DataTransferItem` whose kind is `file` (so plain text/url drags are ignored and not `preventDefault`ed).
- On drop: `await collectDroppedUploadEntries(e.dataTransfer)`, then call `prepareUploadEntries(entries)`.
- Overlay: absolutely-positioned div over the explorer body, dashed `var(--border)`, translucent `var(--bg-hover)`, centered copy from i18n `files.dropToUpload` ("Drop to upload into {name}").

### `prepareUploadEntries`

A new method on `FileExplorer` that reuses the existing `uploadPhase` / `pendingConflict` / `uploadSummary` / `highlightedPaths` state and the existing `uploadFiles` XHR helper, but sources entries from a drop instead of an `<input>`:

1. If `entries.length === 0` or `uploadBusy`, return.
2. **Frontend size pre-check**: accumulate `file.size`; collect any file > 25 MB into `tooLarge`, and flag if total > 100 MB. If either triggers, `setUploadError` with a localized message listing the offending names (i18n key `files.tooLarge`, e.g. "These files exceed the size limit: {files}") and abort — no request.
3. `setUploadPhase("checking")`, POST `upload-check` with `{ fileNames: entries.map(e => e.relativePath) }` (field name kept for backward compat; values now may contain `/`).
4. On conflicts → `setPendingConflict({ entries, conflicts, nonReplaceable })`. `pendingConflict` is changed to carry `entries: DroppedUploadEntry[]` (replacing the old `files: File[]`) so a retry can re-POST with the correct relative paths.
5. Otherwise → `performUploadEntries(entries, "error")`.

### `performUploadEntries`

Like `performUpload` but builds FormData with `formData.append("files", entry.file, entry.relativePath)` so `file.name` becomes the relative path. Everything else (XHR, progress, 409 → conflict, `applyUploadResult`) is identical. The existing `performUpload(files, strategy)` is kept for the `<input>` path, or refactored to delegate to `performUploadEntries` with `relativePath = file.name` — the latter is preferred to keep one code path.

### `pendingConflict` retry

The conflict UI's Replace / Skip buttons currently call `performUpload(pendingConflict.files, strategy)`. They now call `performUploadEntries(pendingConflict.entries, strategy)`. The `PendingConflict` type's `files: File[]` field is replaced by `entries: DroppedUploadEntry[]`. The conflict summary text already interpolates `conflicts.join(", ")`, which now contains relative paths — correct as-is.

### Backend: `lib/file-upload.ts`

`validateUploadFileNames`:

- Allow `/` as the only path separator.
- Reject: empty string, `.` or `..` as any segment, a leading `/` (absolute), a leading `[A-Za-z]:` (Windows absolute), any `\`, any `\0`, empty segments (`//`), and `path.basename(fileName) !== fileName` no longer holds — instead split on `/` and validate each segment with the existing per-name rules (non-empty, not `.`/`..`, no `\0`). Duplicate check stays on the full relative path.
- `inspectUploadTargets` is unchanged: `path.join(directory, fileName)` already handles `/` in `fileName`, and `!stat.isFile() || stat.isSymbolicLink()` already classifies an existing directory as non-replaceable.

### Backend: `app/api/files/[...path]/route.ts` POST

- The write loop computes `destination = path.join(directory, file.name)`. When `file.name` contains `/`, ensure the parent exists: `fs.mkdirSync(path.dirname(destination), { recursive: true })` before writing.
- Conflict handling for directories: a directory target is in `nonReplaceable`, so under `overwrite` it is **not** unlinked (the existing `nonReplaceableSet` branch pushes an error for it). This is wrong for "merge" semantics — see correction below.
  - **Correction**: for `overwrite` strategy, skip the `unlinkSync` for non-replaceable (directory) targets and instead let the write proceed into the existing directory (the file is written at `destination`, which sits inside the already-present directory). For `skip`, directory conflicts are added to `skipped` only for the directory entry itself; files inside that are not in `conflictSet` still write. Concretely: in the loop, if `conflictSet.has(name) && nonReplaceableSet.has(name)` → under `skip`, `skipped.push(name)`; under `overwrite`, fall through to `mkdirSync(dirname) + writeFileSync({flag:"wx"})` only if the destination does not already exist as a file (it exists as a dir, so `wx` on the file path inside it succeeds). Add a clear comment.
- `upload-check` body parsing (`parseUploadFileNames`) is unchanged: it already accepts any string array; the strings now may contain `/`.
- 413 / per-file / total size checks unchanged.

### i18n

Add two keys to `en.ts`, `zh-CN.ts`, `zh-TW.ts`:

- `files.dropToUpload`: "Drop to upload into {name}" / "拖放以上传到 {name}" / "拖放以上傳到 {name}"
- `files.tooLarge`: "These files exceed the size limit (25 MB each, 100 MB total): {files}" / equivalent.

No other copy changes — conflict/summary copy already uses the file name, which is now the relative path.

## Error handling

- Size pre-check failures are non-blocking errors shown in the existing `uploadError` row with a Dismiss button; they never reach the network.
- `unsupported` drops (no `webkitGetAsEntry`) still work for flat files via the `dataTransfer.files` fallback; if that fallback yields zero entries (e.g. a folder dropped in a browser that exposes neither entries nor file contents), the server's existing `"No files selected"` validation (`validateUploadFileNames` returns that error on an empty array) surfaces as `uploadError`. No new i18n key is needed for this case.
- 413 from the server (front-end pre-check missed something, e.g. concurrent changes) is shown via the existing `uploadError` path.
- 409 conflict flow is unchanged.
- Partial failures (207) still populate `uploadSummary.errors` per file.

## Testing

TDD where practical; the pure helpers are the highest-value tests.

1. `lib/file-upload.test.mjs` (new or extend):
   - `validateUploadFileNames` accepts `a.txt`, `a/b/c.txt`, `dir/sub/file.ts`.
   - Rejects `../x`, `a/../b`, `/abs`, `C:\\x`, `a\\b`, `a//b`, ``, `.`, `..`, duplicates.
2. `lib/drop-collect.test.mjs` (new): fake `FileSystemEntry` / `FileSystemDirectoryEntry` objects with an async `readEntries` that returns batches then `[]`; assert collected `relativePath` values and order, mixed file/dir tree, empty directory yields nothing.
3. `app/api/files/[...path]/` route test (extend existing `*.test.mjs` or add): POST with FormData whose `file.name = "sub/dir/f.txt"`; assert file written to `<uploadDir>/sub/dir/f.txt` and subdirectories created; assert an existing directory at `sub` is merged under `overwrite` (file inside written, directory not deleted); assert `skip` writes non-conflicting sibling.
4. Source-structure regression: if any `*.test.mjs` asserts `FileExplorer` source text, update it to include the new drag handlers / `collectDroppedUploadEntries` import. Run the full suite and separate pre-existing failures from new ones.

## Open questions resolved

- Folder-structure upload: yes (approach A).
- Directory conflict: per-path conflict detection with Replace = merge+overwrite files, Skip = skip conflict items only (approach A).
- Single file vs folder: one unified channel, relative path = file name for flat files (approach A).
- Size limits: frontend pre-check + backend hard limit, fail fast with named files (approach A).
- Skip semantics for existing directories: the directory is not recreated, but non-conflicting files inside it still upload; only items in `conflictSet` are skipped.

## Risks

- `webkitGetAsEntry` recursion is async and `readEntries` must be looped; an off-by-one could drop files. Mitigated by the unit test with batched `readEntries`.
- Very wide/deep folders could produce thousands of entries before hitting the size cap (many tiny files). The 100 MB cap bounds bytes, not count; thousands of tiny files would still be one FormData. Accepted — the cap and the per-file `writeFileSync` loop are the existing contract.
- `path.join` on Windows with POSIX-style `file.name` (`a/b/c.txt`) produces the correct native path; `validateUploadFileNames` forbids `\` so no ambiguity.
- `mkdirSync({recursive:true})` is idempotent and safe under concurrent uploads to the same dir; the existing `flag:"wx"` still prevents overwriting an existing file without going through the conflict path.
