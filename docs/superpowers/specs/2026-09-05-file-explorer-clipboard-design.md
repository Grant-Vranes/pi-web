# File Explorer Clipboard (Copy / Cut / Paste) — Design

Date: 2026-09-05
Status: Approved

## Goal

Add copy / cut / paste support to the sidebar file explorer (`components/FileExplorer.tsx`)
via keyboard shortcuts (⌘C / ⌘X / ⌘V on macOS, Ctrl+C / Ctrl+X / Ctrl+V elsewhere) and
matching context-menu entries, with a conflict dialog when a paste destination already
contains an entry with the same name.

## Decisions (agreed with user)

1. **Operations**: Copy + Cut + Paste (option A). Cut executes the existing `move`
   mutation at paste time.
2. **Paste target**: Smart target (option A). The most recently right-clicked directory
   receives the paste; right-clicking a file targets its parent directory;
   right-clicking a root targets that root. ⌘V without any prior context menu falls back
   to the first project root.
3. **Name conflicts**: Confirmation dialog (option B) with Overwrite / Keep both / Cancel.
4. **Context menu** also gains Copy / Cut / Paste entries sharing the same logic as the
   shortcuts.
5. Out of scope: multi-select, full keyboard navigation (arrow keys), Finder-style
   automatic "copy" renaming on conflict (user chose the dialog).

## Approaches considered

- **Client-side copy via read + write**: rejected — only works for text files, cannot
  copy binaries or directories.
- **Full selection model with arrow-key navigation**: rejected for now — largest change;
  can be a later enhancement.
- **Server-side `copy` mutation + client clipboard state (chosen)**: reuses the existing
  mutation authorization pipeline and the existing `move` mutation for cut.

## Server design

Files: `lib/file-mutations.ts`, `app/api/files/[...path]/route.ts`.

### New mutation type

```ts
{ type: "copy"; sourcePath: string; destinationDirectory: string }
```

`copy` sits beside `move` in `FileMutation` and in `FILE_MUTATION_TYPES`, and reuses all
existing safety checks: `assertExistingAllowed` on the source, `assertDirectory` +
`assertParentAllowed` on the destination, and the same-or-descendant rejection so a
directory cannot be copied into itself or one of its descendants.

### `conflict` parameter on `copy` and `move`

Both mutations accept an optional `conflict` mode parsed from the request body:

- `"error"` (default): destination exists → `FileMutationError(409)`. This is the
  current behavior of both mutations.
- `"overwrite"`: remove the existing destination entry, then copy/move. Before removal,
  the existing entry must still resolve inside an allowed root (`isExistingFilePathAllowed`);
  an existing entry whose real path escapes the allowed roots returns 403, consistent with
  the file-access boundary. In-root symlinks are removed as links (never followed).
- `"keep-both"`: the server deterministically picks a free name before writing:
  `a.txt` → `a copy.txt` → `a copy 2.txt` …; entries without an extension use
  `name copy`, `name copy 2`, … This avoids client-side guess-and-retry races.
  The chosen name still passes `assertName` and `assertVacant` before the operation.

The result includes `destinationPath` (the actual final path) so the client can reveal
and highlight the pasted entry.

### Copy semantics

- Directories are copied recursively with `fs.cpSync(src, dest, { recursive: true, dereference: false, verbatimSymlinks: true })` so symlinks are copied as links and never
  pull in content from outside the allowed roots.
- Files are copied with `fs.copyFile` after the recursive/leaf dispatch.

## Client design

File: `components/FileExplorer.tsx`.

### Clipboard state

```ts
const [clipboard, setClipboard] = useState<{ path: string; mode: "copy" | "cut" } | null>(null);
```

Single entry only, matching the existing single-target operation model. The clipboard
lives in component state (per explorer instance); no cross-tab or cross-project
persistence.

### Smart paste target

```ts
const [lastContextDir, setLastContextDir] = useState<string | null>(null);
```

- Context menu on a directory → that directory's `fullPath`.
- Context menu on a file → its parent directory.
- Context menu on a root → the root path.
- `⌘V` with `lastContextDir === null` → first project root.
- Pasting into the entry's own parent with mode `cut` is a no-op (nothing to do).

### Keyboard shortcuts

- The tree container becomes focusable (`tabIndex={0}`) and handles `onKeyDown`.
- ⌘/Ctrl + `c` / `x` / `v` map to copy / cut / paste.
- Guard conditions (skip handling): the event target is inside an `input`, `textarea`,
  or `contentEditable` element; clipboard is null for paste; `mutationBusy` is true.
  This keeps chat input, search input, and rename dialogs unaffected.

### Context menu

- Non-root entries: Copy, Cut.
- Directories and roots: Paste (disabled/dimmed when clipboard is null or busy).
- Menu items call the same handlers as the shortcuts.

### Cut visual feedback

Entries currently held in the clipboard with mode `cut` render dimmed
(`opacity: 0.5`).

### Conflict dialog

Paste requests are always sent first with `conflict: "error"`. On a 409 response the
client opens a modal (styled after the existing `pendingMutation` dialog):

- Title: “已存在同名文件” / "Name already exists" (`files.conflictTitle`).
- Message includes the entry name and destination directory (`files.conflictMessage`).
- Buttons: Overwrite (`files.conflictOverwrite`), Keep both (`files.conflictKeepBoth`),
  Cancel (`i18n.cancel`).
- Overwrite / Keep both resend the same mutation with the matching `conflict` value;
  Cancel closes the dialog and clears busy state.

Paste success: refresh the tree and highlight `destinationPath` (existing
`highlightedPaths` mechanism). Copy paste dispatches no file-tab mutation — the source
continues to exist, so open tabs must stay on it; only cut paste goes through the
existing `move` kind of `FileTabMutation`, which already retargets open tabs.

### Cut + paste flow

Cut stores `{ mode: "cut" }`. Paste sends the existing `move` mutation with the chosen
destination directory (and `conflict` handling above). A successful cut paste clears the
clipboard (the entry no longer dims). A copy paste keeps the clipboard so the same entry
can be pasted again elsewhere.

## i18n

`lib/i18n/messages/en.ts`, `zh-CN.ts`, `zh-TW.ts` gain:

- `files.copy`, `files.cut`, `files.paste`
- `files.conflictTitle`, `files.conflictMessage`, `files.conflictOverwrite`,
  `files.conflictKeepBoth`

## Error handling

- While a mutation request is in flight, `mutationBusy` blocks duplicate submits.
- Failures surface through the existing error display (`files.operationFailed` or the
  server-provided message).
- If the clipboard source disappears before pasting (404), show the error and keep the
  clipboard so the user can retry or pick another target.

## Testing

- `app/api/files/mutation-route.test.mjs`:
  - copy file happy path; copy directory recursively; symlink preserved as link.
  - copy conflict → 409; `overwrite`; `keep-both` naming sequence.
  - copy outside allowed roots → 403; directory into itself → 400.
  - `move` with `conflict: overwrite` / `keep-both`.
- `components/FileExplorer.mutations.test.mjs` (existing source-assertion style):
  - shortcut bindings and editable-element guard,
  - clipboard state transitions: copy paste keeps the clipboard for repeat pastes;
    cut paste clears it on success
  - context menu entries and disabled paste,
  - conflict dialog resend flow,
  - cut dimming.

## Consequences / risks

- TOCTOU window between authorization and fs operations is an accepted, pre-existing
  limitation (documented in `file-mutations.ts`).
- `verbatimSymlinks: true` can produce broken links when a symlink uses a relative path
  and the copy lands elsewhere; accepted for this iteration (same as drag-upload
  semantics which never follow links either).
