# File Viewer: In-File Edit, Search & Replace

Date: 2026-09-04
Status: Approved (design discussion)

## Goal

Clicking a file opens it in the right-hand preview pane (existing `FileViewer`).
This feature adds three capabilities to that pane for text files:

1. **Edit** — modify the file's text in place and save it back to disk.
2. **Search** — find text within the currently opened file (match count, prev/next navigation).
3. **Replace** — replace matches individually or all at once.

Out of scope: project-wide (multi-file) search/replace, vim keybindings, regex search,
editing of binary/image/document files, editing while in Markdown/HTML preview or Diff mode.

## Backend

### 1. New `write` file mutation (`lib/file-mutations.ts`)

Extend `FileMutation`:

```ts
| { type: "write"; sourcePath: string; content: string; baseMtimeMs: number | null }
```

Semantics:

- Authorizes with the existing `assertExistingAllowed` path checks (allowed roots,
  symlink hardening). Writes never create files — a missing path is a 404.
- Target must be a regular file (400 for directories).
- **Conflict detection**: if the file's current `mtimeMs` differs from the client's
  `baseMtimeMs` (the mtime the client received when it read the file), throw
  `FileMutationError(409, ...)`. The client decides whether to overwrite (`baseMtimeMs`
  omitted/`null` forces the write) or reload.
- Writes with `fs.writeFileSync(path, content, "utf-8")` and returns the new
  `mtimeMs` and `size`.
- `FileMutationResult` gains optional `mtimeMs?: number` and `size?: number`.

### 2. Route wiring (`app/api/files/[...path]/route.ts`)

- Add `"write"` to `FILE_MUTATION_TYPES` / `FILE_POST_REQUEST_TYPE_SET`.
- `parseMutation` handles `write`: `content` must be a string; `baseMtimeMs` must be a
  number or `null`.
- Bound the JSON body (~2 MB, well above the 256 KB read limit) before parsing.
- `read` response now also includes `mtimeMs: stat.mtimeMs` so the client has a base
  value for conflict detection.

## Frontend

### 3. Pure search helpers (`lib/file-search.ts`)

```ts
interface SearchMatch { line: number; start: number; end: number } // line is 1-based
findMatches(content: string, query: string, caseSensitive: boolean): SearchMatch[]
replaceAll(content: string, matches: SearchMatch[], replacement: string): { content, count }
replaceOne(content: string, match: SearchMatch[], index: number, replacement): string
```

Fully unit-testable; no React or DOM dependencies. Empty/whitespace query yields no matches.

### 4. `FileViewer` edit mode

- Toolbar gains **Edit / Done** toggle and (within edit mode) **Save**.
  - Visible only for text files that returned content via `read` (images/audio/docx/pdf
    never reach the text path, so they are excluded naturally).
  - Entering edit while in `preview`/`diff` switches to `source`.
- Editor = styled `<textarea>` (mono font, line numbers gutter kept and scroll-synced).
  No new editor dependency.
- Draft state:
  - `draft` state + `dirty = draft !== savedContent`.
  - Draft and `baseMtimeMs` are folded into `viewerStateRef` and therefore into the
    existing per-tab `FileViewerState` persistence (`onStateChange`), so switching tabs
    (which unmounts the viewer) does not lose edits.
  - While dirty, the live-watch auto reload is suppressed so an external change cannot
    clobber in-progress edits.
- Save:
  - `Cmd/Ctrl+S` or Save button → `POST …/api/files/<path>?type=write` with current
    content and `baseMtimeMs`.
  - On success: `savedContent = draft`, `baseMtimeMs` = returned mtime, banner cleared.
  - On 409: red banner "File changed on disk" with **Reload** (discard draft, refetch)
    and **Overwrite** (resend with `baseMtimeMs: null`) actions.
- Dirty indicator (dot) in the viewer toolbar; `beforeunload` guard while dirty.

### 5. Search/replace bar

- `Cmd/Ctrl+F` (or toolbar button) opens a compact bar under the toolbar:
  query input, case toggle (Aa), match counter ("3/17"), prev/next buttons.
- In **edit mode** the bar additionally shows: replace input, **Replace**, **Replace All**.
- Navigation behavior:
  - Read mode: matching lines get a highlight class on `.file-source-line` (works for
    both the highlighted and lightweight >1000-line render paths); next/prev scrolls the
    matching line into view.
  - Edit mode: next/prev selects the match inside the textarea via `setSelectionRange`
    (the browser scrolls the selection into view); Replace rewrites the draft at the
    match; Replace All rewrites via `replaceAll` and re-runs the search.
- `Esc` closes the bar.

### 6. i18n

New keys (`i18n.editFile`, `i18n.doneEditing`, `i18n.saveFile`, `i18n.searchFile`,
`i18n.matchOf`, `i18n.fileChangedOnDisk`, `i18n.overwrite`, `i18n.reload`, …) added to
`en`, `zh-CN`, and `zh-TW` message files.

## Testing

- `lib/file-search.test.mjs` — match finding (case sensitivity, multiline, empty query),
  replace-one/replace-all invariants.
- `lib/file-mutations.test.mjs` — `write` happy path, 404 missing, 403 outside roots /
  symlink escape, 409 conflict when mtime differs, 400 when target is a directory.
- Existing viewer state tests extended for the draft-in-state behavior.
- `tsc --noEmit` and `npm run lint` clean.

## Non-goals / future

- Project-wide search panel, regex search, `history`/undo beyond the textarea's native
  undo (native undo works per-keystroke), editor themes, vim mode.
