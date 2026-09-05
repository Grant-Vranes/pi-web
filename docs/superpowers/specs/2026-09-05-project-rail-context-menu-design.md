# Project Rail Tile Context Menu — Design

Date: 2026-09-05
Status: Approved

## Problem

The leftmost project rail (`ProjectRail` in `components/SessionSidebar.tsx`) supports
click-to-select, drag-to-reorder, and a hover status card, but has no right-click
actions. Users want to open the project folder in the OS file browser and remove a
project tile from the rail without touching localStorage by hand.

## Goals

1. Right-click on a rail tile opens a small context menu with two items:
   - **Open project folder** — open `project.root` in the OS file browser.
   - **Remove icon** — hide the tile from the rail.
2. Removing the currently active project icon auto-switches the workspace to the
   nearest remaining tile (user decision: option B).
3. A removed icon comes back automatically when the project is selected again
   through any path (dropdown, session click, initial restore).

## Non-Goals

- No new `/api` routes or backend changes.
- No additional menu items beyond the two above.

## Behavior

### Context menu

- Rendered by `ProjectRail` as a fixed-position menu at the cursor, mirroring the
  inline menu pattern in `FileExplorer` (same styling: `--bg-panel`, `--border`,
  12px font, role="menu"/"menuitem").
- State: `menu: { project, x, y } | null` inside `ProjectRail`.
- `onContextMenu` on the tile button: `preventDefault()`, capture cursor position,
  open menu. Suppress the hover tooltip while the menu is open.
- Close on outside `pointerdown`, `Escape`, scroll (capture phase), and after any
  menu action.
- Clamp `y` (and `x`) so the menu stays inside the viewport near screen edges.

### Open project folder

- Calls the existing `openInFileBrowser(project.root)` (`lib/file-browser.ts` →
  `POST /api/file-browser/open`).
- On failure: `window.alert` with the i18n failure message plus the error text,
  same as the explorer toolbar's open-in-file-browser handler.

### Remove icon semantics

Project tiles come from three sources: `projectRailHistory` (localStorage
`pi-web:project-rail-history`), `recentProjects` (derived from session files via
`getRecentProjects`), and the current `selectedProject`. Because session-derived
projects reappear on their own, removal requires a persistent hidden set.

- New localStorage key `pi-web:project-rail-hidden` — JSON array of workspace keys,
  with load/save helpers mirroring `loadProjectRailHistory` (best-effort, privacy
  mode safe).
- `railProjects` filters out hidden keys; removal also drops the project from
  `projectRailHistory`.
- Re-selecting a project clears its hidden flag. The existing `useEffect` that
  syncs `selectedProject` into `projectRailHistory` is extended to also delete the
  key from the hidden set. Order history survives hide/unhide cycles.
- **Auto-switch on removing the active project**: pick the switch target from the
  remaining rail tiles by nearest neighbor — the tile to the right of the removed
  one, else the tile to its left, else none. If a target exists, `setSelectedCwd`
  to its root and reuse the `onSelect` cleanup (clear dropdown filter, custom-path
  picker state, dropdown open flag). If no other project exists, keep the current
  selection unchanged.
- The switch-target choice is a pure function
  `pickRailSwitchTarget(keys: string[], removedIndex: number): string | null` in
  `lib/project-groups.ts`.

## Components

- `components/SessionSidebar.tsx`
  - Hidden-set load/save helpers + `hiddenRailKeys` state in `SessionSidebar`.
  - `handleRailRemoveProject(project)` in `SessionSidebar` (needs `setSelectedCwd`
    and dropdown state cleanup), passed to `ProjectRail` as `onRemoveProject`.
  - In `ProjectRail`: menu state, `onContextMenu` on the tile button, menu JSX,
    close-on-outside/Escape/scroll effect, open-folder action via
    `openInFileBrowser` + `t` for the failure alert.
- `lib/project-groups.ts`
  - `pickRailSwitchTarget(keys, removedIndex)` pure helper.
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`
  - `sidebar.railOpenFolder` — "Open project folder" / "打开项目文件夹" / "開啟專案資料夾"
  - `sidebar.railRemoveIcon` — "Remove from rail" / "移除项目图标" / "移除專案圖示"

## Error Handling

- `openInFileBrowser` never throws; failures surface via `window.alert`.
- localStorage access is wrapped in try/catch throughout (same as existing keys).
- Removing a project that is no longer in the rail (stale menu) is a no-op guard.

## Testing

- `lib/project-groups.test.mjs`: add cases for `pickRailSwitchTarget` —
  prefers the right neighbor, falls back to the left neighbor, returns `null`
  when no neighbor exists.
- `components/SessionSidebar.rail-menu.test.mjs` (source-assertion style, matching
  existing SessionSidebar tests): context menu is wired to the rail tile,
  removal hides via the hidden key set, and active-project removal switches cwd.

## Risks

- Hidden keys are workspace keys (`projectKey ?? projectRoot ?? cwd`); a project
  whose key form changes between sessions is treated as a different project. This
  matches how the rail already dedupes, so no extra handling.
