# Chat drag-and-drop path mentions

## Goal

Allow users to drag local files and directories onto the main chat area and add them to the draft as absolute `@` path mentions. This supports files from projects other than the current session working directory without uploading file contents.

## Scope

- Keep the existing image drag-and-drop flow unchanged.
- Add path mention insertion for non-image files and directories.
- Prefer Electron's native path metadata.
- In a normal browser, use `text/uri-list` when the browser supplies `file:` URLs.
- Do not upload, read, enumerate, or index dropped non-image files or directories.

## User interaction

1. A user drops one or more items over the chat area.
2. Images continue through the existing image attachment flow.
3. Every resolved non-image item is inserted at the current caret position as a closed `@` mention:
   - File: `@"/absolute/path/to/file.ts" `
   - Directory: `@"/absolute/path/to/directory/" `
4. Multiple mentions preserve drop order and are separated by one space.
5. The composer retains focus, puts the caret after the inserted mentions, and updates its height.
6. Dropping a directory adds only the directory path, never its children.

Paths are always quoted and escaped for the `@"..."` mention syntax. This makes spacing and other token-breaking characters unambiguous.

## Platform behavior

### Electron

Use the path metadata available on dropped `File` instances to create absolute mentions for files and directories.

### Browser

Try to parse `file:` entries from the drag payload's `text/uri-list`. Browsers that do not reveal a local absolute path cannot support this capability safely. In that case, leave the draft unchanged and show a concise, non-blocking notice. Never infer a path from a filename or read file content as a fallback.

Non-`file:` URIs, malformed URLs, empty paths, and duplicate paths are ignored.

## Architecture

### Drag payload helpers

Add a small pure client-side module responsible for:

- identifying image files versus path candidates;
- extracting Electron paths and browser `file:` URIs;
- normalizing directory suffixes;
- deduplicating paths while retaining input order; and
- formatting quoted absolute `@` mentions.

Keeping this logic independent of React enables direct Node tests for platform payload edge cases.

### ChatWindow

`ChatWindow` remains the chat-area drag owner. Its drop callback partitions images and path mentions:

- forward images to the existing `ChatInput.addImages()` API;
- forward formatted path text to a new `ChatInput` imperative insertion API; and
- request a notice only when non-image local items were dropped but none produced a usable absolute path.

The shared drag hook will recognize either supported images or path-capable drag data so its overlay and `preventDefault` behavior work for both cases. The overlay copy becomes generic: dropping will add attachments or path references.

### ChatInput

Add an imperative `insertPathMentions` method that reuses the existing caret-aware insertion behavior. It must not replace text already in the composer, must reset active `@` completion state, focus the textarea, reposition the selection after the insertion, resize the textarea, and naturally persist through the existing draft effect.

The new behavior remains text-only after insertion. When submitted, the mention travels in the user message exactly as typed. Agent tool permissions remain authoritative: chat-only sessions cannot read the referenced files, while sessions with filesystem tools may use the paths.

## Error handling

- Existing image-only drops stay visually and functionally unchanged.
- A mixed drop accepts images even when path extraction fails.
- A path-only drop with no exposed path does not alter the draft and produces one non-blocking notice.
- No server endpoint or file-access allow-list is changed because the feature only writes message text; it does not use pi-web's file viewer APIs.

## Testing

Use test-driven development:

1. Add failing tests for path extraction, URI parsing, mention formatting, directory suffixes, ordering, duplicate filtering, invalid entries, and image/path partitioning.
2. Add a failing test for composer insertion at a selection so existing input remains intact and the caret follows the inserted mentions.
3. Implement the smallest helpers and UI integration required to pass those tests.
4. Run focused tests, then the complete test suite, TypeScript checking, and lint.

The worktree baseline has nine existing `npm test` failures (871 passing of 880), primarily source-structure assertions for AppShell, ChatWindow, SessionSidebar, and rpc-manager. Verification will distinguish those from regressions introduced by this feature.
