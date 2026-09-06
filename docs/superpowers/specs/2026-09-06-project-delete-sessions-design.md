# 项目 rail hover tip 增加「删除项目」功能 — Design

## Motivation
On the left-most project rail, hovering a project shows a floating card
(summary of that project's running + waiting-to-check sessions). There was no
way to delete a whole project. This adds a destructive "delete project"
action accessible from that hover card.

Scope (chosen by user during brainstorming):
- Action deletes **all** of the project's sessions, including the on-disk
  `.jsonl` files (option 3).
- Deletion is **blocked while any session in the project is running** and the
  user is told to stop them first (option B).
- Control is a bottom red **「删除项目…」** button inside the card (Q1 = A).
- Idle (nothing running) confirmation is a lightweight two-step inline confirm
  inside the card (Q1 + Q2 = A).
- After a successful delete the project tile is also removed from the rail.

## Definitions & scope of a "project"
A project is the set of sessions aggregated by `workspaceKeyOf(session)`
(`lib/workspace-memory.ts`), i.e. `session.projectKey` (resolved project root)
falling back to `projectRoot`/`cwd`. All worktrees of one repo resolve to the
same main-repo `projectKey`, so deleting "a project" clears that repo's
sessions across every worktree. The count shown in the confirm UI makes this
transparent.

## Server
1. Extend the sessions collection route `app/api/sessions/route.ts` with a
   `DELETE` handler: `DELETE /api/sessions?projectRoot=<absolute path>`.
2. Factor a unit-testable helper `lib/project-session-delete.ts`
   `deleteSessionsForProject(projectRoot)`:
   - Enumerate via `listAllSessions()`.
   - Resolve the project root **server-side** to its canonical key with
     `projectIdentityKey(projectRoot)` so a client cannot fabricate an
     arbitrary key; also normalize each session's cwd with `resolveProject`.
   - Collect every session whose project key equal the target key.
   - Running check: if any collected session `getRpcSession(id)?.isRunning()`
     then return `{ ok: false, blockedRunning: true }` — nothing is deleted.
   - Otherwise for each session reuse the single-delete semantics:
     rpc `shutdown()` (when a wrapper is alive), `unlinkSync(file)`,
     `forgetArchivedSession(id)`, and invalidate path/list caches.
   - Return `{ ok: true, deleted: N }`.
3. Response shapes
   - `{ ok: false, blockedRunning: true, runningCount }`
   - `{ ok: true, deleted: number }`
   - `404` when no project file / nothing found? — the helper returns
     `deleted: 0` on empty; treat as ok.

## Client
### ProjectRailTooltip (components/SessionSidebar.tsx)
- New prop `onDeleteProject?: (project) => Promise<void>` and reuse the
  `allSessions` the parent already passes.
- Compute `projectSessions = allSessions.filter(ws === project.key)`,
  `count`, and whether any is in `runningSessionIds`.
- UI states local to the component:
  - `armed` (whether the two-step confirm is showing),
  - `deleting` (in-flight), `busyMessage`.
- Footer area of the card:
  - Default: red-outlined `删除项目…` button.
    - Running sessions present → disabled; hovering shows
      `请先停止运行中的会话` (title attr / small caption).
  - After first click (and not running): button replaced by two flat inline
    actions, red `确认删除（N 个会话，不可恢复）` + `取消`.
  - While deleting → spinner / disabled `删除中…`.
- On successful delete: call nothing else here; the parent handles rail removal
  + refresh + close. Show transient error caption on failure / when the server
  reports `blockedRunning` (race window).

### SessionSidebar orchestration
- New internal handler passed to `ProjectRail`/tooltip:
  - `fetch('/api/sessions?projectRoot=…', { method:'DELETE' })`.
  - `blockedRunning` → surface message, do not close.
  - ok → close tooltip, remove project from `projectRailHistory` (persists to
    localStorage via existing effect), force-refresh the session list, and if
    the currently selected session belongs to this project notify AppShell to
    clear the active tab (mirror `SessionItem`'s delete flow upstream).

## i18n
Add keys (en / zh-CN / zh-TW) in `lib/i18n/messages/`:
- `sidebar.deleteProjectTitle` — 删除本项目中所有会话…(与单个删除不同,不可单删)
- confirm / running-block / in-progress / cancel strings, plus count text.

## Error handling
- File-system failures per session are caught individually so one bad file does
  not abort the rest; total count reflects successes.
- If the whole project resolves nothing, treat as ok with `deleted: 0`.

## Testing (project uses TDD + node .test.mjs)
- Unit-test `deleteSessionsForProject`: filtering by key, running-block path,
  deletion + cache invalidation, per-file failure tolerance.
- Route handler test mirrors existing `app/api/sessions` tests.
- Component tests match existing `SessionSidebar.*.test.mjs` patterns.

## Out of scope
- Deleting the underlying directory / project files (only sessions).
- Trash/undo.
- Archive-then-purge batches.
- "Delete" on individual session cards inside the tooltip.
