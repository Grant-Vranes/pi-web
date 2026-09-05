# Project Rail Tile Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click on a leftmost project-rail tile opens a context menu with "Open project folder" and "Remove icon"; removal persists (hidden-key set) and auto-switches the workspace when the active tile is removed.

**Architecture:** All UI work lives in `ProjectRail`/`SessionSidebar` in `components/SessionSidebar.tsx` (fixed-position menu rendered via `createPortal`, mirroring the existing `FileExplorer` menu and `ProjectRailTooltip` escape hatch). Removal persists workspace keys in a new localStorage set; re-selecting a project clears its hidden flag via the existing `selectedProject` sync effect. Switch-target selection is a pure helper in `lib/project-groups.ts`.

**Tech Stack:** Next.js client components (React 19), TypeScript, localStorage, `node:test` + jiti for lib tests, source-assertion tests for components.

**Spec:** `docs/superpowers/specs/2026-09-05-project-rail-context-menu-design.md`

## Global Constraints

- **Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev` (repo AGENTS.md).
- Typecheck command: `node_modules/.bin/tsc --noEmit` (must pass with zero errors).
- Lint command: `npm run lint` (must pass).
- Test script: `npm test` runs `node --experimental-strip-types --test "app/**/*.test.mjs" "components/**/*.test.mjs" "hooks/**/*.test.mjs" "lib/**/*.test.mjs" "public/**/*.test.mjs"`. Single file: `node --experimental-strip-types --test <file>`.
- localStorage access is always wrapped in try/catch, best-effort (repo pattern).
- No `/api` or backend changes in this feature.
- i18n: every new user-facing string needs entries in all three locales: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`.
- `tsconfig.json` has `"strict": true` (no `noUncheckedIndexedAccess`), but index reads must still be guarded against `undefined` where the value is optional.

---

### Task 1: `pickRailSwitchTarget` pure helper

**Files:**
- Modify: `lib/project-groups.ts` (append at end of file)
- Test: `lib/project-groups.test.mjs`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `export function pickRailSwitchTarget(keys: readonly string[], removedIndex: number): string | null` — the rail tile that becomes active after the tile at `removedIndex` is removed: right neighbor first, else left neighbor, else `null`. Task 3 imports this from `@/lib/project-groups`.

- [ ] **Step 1: Write the failing tests**

In `lib/project-groups.test.mjs`, extend the existing jiti destructuring import (currently `getProjectActivity, getRecentProjects, sessionsForProject`) to add `pickRailSwitchTarget`:

```js
const {
  getProjectActivity,
  getRecentProjects,
  pickRailSwitchTarget,
  sessionsForProject,
} = await jiti.import("./project-groups.ts");
```

Append at the end of the file:

```js
test("pickRailSwitchTarget prefers the right neighbor", () => {
  assert.equal(pickRailSwitchTarget(["a", "b", "c"], 0), "b");
  assert.equal(pickRailSwitchTarget(["a", "b", "c"], 1), "c");
});

test("pickRailSwitchTarget falls back to the left neighbor", () => {
  assert.equal(pickRailSwitchTarget(["a", "b", "c"], 2), "b");
  assert.equal(pickRailSwitchTarget(["a", "b"], 1), "a");
});

test("pickRailSwitchTarget returns null without any neighbor", () => {
  assert.equal(pickRailSwitchTarget(["a"], 0), null);
  assert.equal(pickRailSwitchTarget([], 0), null);
  assert.equal(pickRailSwitchTarget(["a", "b"], 7), null);
  assert.equal(pickRailSwitchTarget(["a", "b"], -1), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test lib/project-groups.test.mjs`
Expected: FAIL — `pickRailSwitchTarget` is `undefined` (destructure of missing export throws or the new tests error).

- [ ] **Step 3: Write the implementation**

Append at the end of `lib/project-groups.ts`:

```ts
/** Pick the rail tile that becomes active after the tile at `removedIndex`
 *  is removed: the right neighbor first, else the left neighbor, else null. */
export function pickRailSwitchTarget(keys: readonly string[], removedIndex: number): string | null {
  if (removedIndex < 0 || removedIndex >= keys.length) return null;
  const right = keys[removedIndex + 1];
  if (right !== undefined) return right;
  const left = keys[removedIndex - 1];
  if (left !== undefined) return left;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test lib/project-groups.test.mjs`
Expected: PASS — all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add lib/project-groups.ts lib/project-groups.test.mjs
git commit -m "feat: add pickRailSwitchTarget rail helper"
```

---

### Task 2: Hidden rail keys persistence + rail filtering + unhide-on-select

**Files:**
- Modify: `components/SessionSidebar.tsx` (constants block ~line 134, helpers after `loadProjectRailHistory` ~line 200, state ~line 516, persist effect ~line 594, `selectedProject` effect ~line 1028, `railProjects` memo ~line 1042)
- Test: `components/SessionSidebar.rail-menu.test.mjs` (create)

**Interfaces:**
- Consumes: existing `ProjectSelection` interface, `PROJECT_RAIL_STORAGE_KEY` neighbors.
- Produces: constant `PROJECT_RAIL_HIDDEN_STORAGE_KEY = "pi-web:project-rail-hidden"`; helpers `loadHiddenRailKeys(): Set<string>` / `saveHiddenRailKeys(keys: Set<string>): void`; state `hiddenRailKeys: Set<string>` + `setHiddenRailKeys` in `SessionSidebar`. Task 3 uses `hiddenRailKeys`, `setHiddenRailKeys`, and `setProjectRailHistory`.

Note: this task has no user-visible behavior yet (nothing calls removal); it is verified by source-assertion tests, typecheck, and the full suite.

- [ ] **Step 1: Write the failing source test**

Create `components/SessionSidebar.rail-menu.test.mjs` (source-assertion style, matching `SessionSidebar.worktree.test.mjs`):

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("removing a project icon hides it persistently", () => {
  assert.match(source, /pi-web:project-rail-hidden/);
  // railProjects filters hidden keys out of every source.
  assert.match(source, /hiddenRailKeys\.has\(project\.key\)/);
  // Re-selecting a project clears its hidden flag so the icon returns.
  assert.match(source, /next\.delete\(selectedProject\.key\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test components/SessionSidebar.rail-menu.test.mjs`
Expected: FAIL — no `pi-web:project-rail-hidden` in source.

- [ ] **Step 3: Implement**

All edits in `components/SessionSidebar.tsx`.

**3a. Constant** — after the existing rail storage key:

```tsx
const PROJECT_RAIL_STORAGE_KEY = "pi-web:project-rail-history";
const PROJECT_RAIL_HIDDEN_STORAGE_KEY = "pi-web:project-rail-hidden";
```

**3b. Helpers** — directly after the closing brace of `loadProjectRailHistory()`:

```tsx
/** Keys of rail tiles the user explicitly removed. Session-derived projects
 *  would otherwise reappear immediately, so removal needs this persistent
 *  hidden set; re-selecting the project clears its entry again. */
function loadHiddenRailKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PROJECT_RAIL_HIDDEN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function saveHiddenRailKeys(keys: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (keys.size === 0) window.localStorage.removeItem(PROJECT_RAIL_HIDDEN_STORAGE_KEY);
    else window.localStorage.setItem(PROJECT_RAIL_HIDDEN_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Persistence is best-effort.
  }
}
```

**3c. State** — directly after the `projectRailHistory` state line:

```tsx
const [projectRailHistory, setProjectRailHistory] = useState<ProjectSelection[]>(() => loadProjectRailHistory());
const [hiddenRailKeys, setHiddenRailKeys] = useState<Set<string>>(() => loadHiddenRailKeys());
```

**3d. Persist effect** — directly after the existing `projectRailHistory` persist effect (the one writing `PROJECT_RAIL_STORAGE_KEY`):

```tsx
useEffect(() => {
  saveHiddenRailKeys(hiddenRailKeys);
}, [hiddenRailKeys]);
```

**3e. Un-hide on select** — replace the existing `selectedProject` sync effect (comment: "Remember every project that has been selected…") by prepending the hidden-flag clear. The effect body becomes:

```tsx
useEffect(() => {
  if (!selectedProject) return;
  // Selecting a project through any path restores its removed rail icon.
  setHiddenRailKeys((previous) => {
    if (!previous.has(selectedProject.key)) return previous;
    const next = new Set(previous);
    next.delete(selectedProject.key);
    return next;
  });
  setProjectRailHistory((previous) => {
    const index = previous.findIndex((project) => project.key === selectedProject.key);
    if (index === -1) return [...previous, selectedProject].slice(-30);
    if (previous[index].root === selectedProject.root) return previous;
    const next = [...previous];
    next[index] = selectedProject;
    return next;
  });
}, [selectedProject]);
```

**3f. Filter `railProjects`** — the memo's filter callback and dependency array become:

```tsx
return [...projectRailHistory, ...recentProjects, selectedProject].filter((project): project is ProjectSelection => {
  if (!project || seen.has(project.key) || hiddenRailKeys.has(project.key)) return false;
  seen.add(project.key);
  return true;
});
}, [projectRailHistory, recentProjects, selectedProject, hiddenRailKeys]);
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --experimental-strip-types --test components/SessionSidebar.rail-menu.test.mjs`
Expected: PASS.

Run: `node_modules/.bin/tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add components/SessionSidebar.tsx components/SessionSidebar.rail-menu.test.mjs
git commit -m "feat: persist hidden project rail keys"
```

---

### Task 3: Rail tile context menu + remove wiring + auto-switch + i18n

**Files:**
- Modify: `components/SessionSidebar.tsx` (import line ~11, handler after the `railProjects` memo ~line 1053, `ProjectRail` props/state ~line 1788, tile button ~line 1866, menu JSX before `</nav>` ~line 1935, `ProjectRail` usage ~line 1155)
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts` (insert after each file's `"sidebar.selectProject"` line — all at line 180)
- Test: `components/SessionSidebar.rail-menu.test.mjs` (append)

**Interfaces:**
- Consumes: `pickRailSwitchTarget(keys, removedIndex)` from Task 1; `hiddenRailKeys`/`setHiddenRailKeys`/`setProjectRailHistory` from Task 2; `openInFileBrowser(path)` from `@/lib/file-browser` (already imported in this file); `createPortal` (already imported).
- Produces: `handleRailRemoveProject(project: ProjectSelection): void` in `SessionSidebar`; new required `ProjectRail` prop `onRemoveProject: (project: ProjectSelection) => void`.

- [ ] **Step 1: Write the failing source tests**

Append to `components/SessionSidebar.rail-menu.test.mjs` (add the `projectGroupsSource` read below the existing `source` read):

```js
const projectGroupsSource = await readFile(new URL("../lib/project-groups.ts", import.meta.url), "utf8");

test("rail tiles open a right-click menu with open-folder and remove actions", () => {
  // The tile button is the right-click target and blocks the native menu.
  assert.match(source, /onContextMenu=\{\(event\) => \{\n\s*event\.preventDefault\(\)/);
  // The menu renders through a portal so overflow:hidden rail ancestors
  // cannot clip it (same escape hatch as the hover tooltip).
  assert.match(source, /createPortal\(\n\s*<div\n\s*data-project-rail-menu/);
  // Open-folder reuses the shared file-browser helper and alerts on failure.
  assert.match(source, /openInFileBrowser\(project\.root\)/);
  assert.match(source, /files\.openInFileBrowserFailed/);
  // Remove routes through the parent handler so the cwd can switch.
  assert.match(source, /onRemoveProject=\{handleRailRemoveProject\}/);
});

test("removing the active tile switches to the nearest remaining neighbor", () => {
  assert.match(projectGroupsSource, /export function pickRailSwitchTarget/);
  assert.match(source, /pickRailSwitchTarget\(keys, removedIndex\)/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test components/SessionSidebar.rail-menu.test.mjs`
Expected: the two new tests FAIL (Task 2's test still passes).

- [ ] **Step 3: Implement i18n keys**

Insert immediately after the `"sidebar.selectProject"` line (line 180) in each locale file:

`lib/i18n/messages/en.ts`:
```ts
    "sidebar.railOpenFolder": "Open project folder",
    "sidebar.railRemoveIcon": "Remove from rail",
```

`lib/i18n/messages/zh-CN.ts`:
```ts
    "sidebar.railOpenFolder": "打开项目文件夹",
    "sidebar.railRemoveIcon": "移除项目图标",
```

`lib/i18n/messages/zh-TW.ts`:
```ts
    "sidebar.railOpenFolder": "開啟專案資料夾",
    "sidebar.railRemoveIcon": "移除專案圖示",
```

- [ ] **Step 4: Implement SessionSidebar changes**

All edits in `components/SessionSidebar.tsx`.

**4a. Import** — extend the existing project-groups import:

```tsx
import { getProjectActivity, getRecentProjects, pickRailSwitchTarget, sessionsForProject } from "@/lib/project-groups";
```

**4b. Parent remove handler** — insert **immediately after the `railProjects` useMemo block** (it must come after that memo because the deps array reads `railProjects` and `selectedProject` — defining it earlier would be a TDZ error):

```tsx
// Remove a rail tile: hide the project persistently and, when it is the
// active project, switch the workspace to the nearest remaining tile
// (right neighbor first, then left; no neighbor keeps the selection).
const handleRailRemoveProject = useCallback((project: ProjectSelection) => {
  setHiddenRailKeys((previous) => {
    if (previous.has(project.key)) return previous;
    const next = new Set(previous);
    next.add(project.key);
    return next;
  });
  setProjectRailHistory((previous) => previous.filter((item) => item.key !== project.key));
  if (selectedProject?.key !== project.key) return;
  const keys = railProjects.map((item) => item.key);
  const removedIndex = keys.indexOf(project.key);
  const targetKey = pickRailSwitchTarget(keys, removedIndex);
  if (!targetKey) return;
  const target = railProjects.find((item) => item.key === targetKey);
  if (!target) return;
  setSelectedCwd(target.root);
  setProjectFilter("");
  setCustomPathOpen(false);
  setCustomPathValue("");
  setCustomPathError(null);
  setDropdownOpen(false);
}, [selectedProject, railProjects]);
```

(`setSelectedCwd`, `setProjectFilter`, `setCustomPathOpen`, `setCustomPathValue`, `setCustomPathError`, `setDropdownOpen` are stable useState setters already used by the rail's `onSelect` — not repeated in deps.)

**4c. Wire the prop** — in the `<ProjectRail …>` JSX, after the existing `onReorder` prop:

```tsx
        onRemoveProject={handleRailRemoveProject}
```

**4d. `ProjectRail` props** — add `onRemoveProject` to the destructured params and the props type:

```tsx
function ProjectRail({
  projects,
  selectedProjectKey,
  activity,
  allSessions,
  runningSessionIds,
  runningSessionDetails,
  unreadSessionIds,
  onSelect,
  onAddProject,
  onReorder,
  onRemoveProject,
}: {
  projects: readonly ProjectSelection[];
  selectedProjectKey: string | null;
  activity: ReadonlyMap<string, { running: number; unread: number }>;
  allSessions: readonly SessionInfo[];
  runningSessionIds: ReadonlySet<string>;
  runningSessionDetails: readonly RunningRpcSessionDetail[];
  unreadSessionIds: ReadonlySet<string>;
  onSelect: (project: ProjectSelection) => void;
  onAddProject: () => void;
  onReorder: (keys: string[]) => void;
  onRemoveProject: (project: ProjectSelection) => void;
}) {
```

**4e. Menu state + actions** — inside `ProjectRail`, after the `hoveredKey` state line:

```tsx
  // Right-click menu target and viewport position. Rendered through a portal
  // with position:fixed (same as the tooltip) so the rail's overflow:hidden
  // ancestors cannot clip it.
  const [menu, setMenu] = useState<{ project: ProjectSelection; x: number; y: number } | null>(null);
```

After the `openTooltip` callback (or after `scheduleTooltipClose` — order within the component does not matter as long as it is before the return):

```tsx
  // Open the project folder in the OS file browser; failures surface in an
  // alert exactly like the explorer toolbar's open-in-file-browser button.
  const handleOpenFolder = useCallback(async (project: ProjectSelection) => {
    const result = await openInFileBrowser(project.root);
    if (!result.ok) {
      window.alert(`${t("files.openInFileBrowserFailed")}: ${result.error ?? ""}`);
    }
  }, [t]);

  // Dismiss the menu on outside pointerdown, Escape, or any scroll (capture
  // phase so scrolling inside the rail counts too).
  useEffect(() => {
    if (!menu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-project-rail-menu]")) setMenu(null);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const closeOnScroll = () => setMenu(null);
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [menu]);
```

**4f. Suppress tooltip while the menu is open** — the tile's `showTooltip` line becomes:

```tsx
const showTooltip = hoveredKey === project.key && !isDragging && !dropTarget && !menu;
```

**4g. Right-click on the tile button** — the `project-rail-item` button gains `onContextMenu` after its existing `onClick`:

```tsx
                onClick={() => onSelect(project)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  // Keep the fixed menu inside the viewport on edge tiles.
                  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 176));
                  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 84));
                  setMenu({ project, x, y });
                }}
```

**4h. Menu JSX** — inside `<nav className="project-rail">`, after the `project-rail-add` button, before `</nav>`:

```tsx
      {menu ? createPortal(
        <div
          data-project-rail-menu
          role="menu"
          style={{ position: "fixed", zIndex: 60, top: menu.y, left: menu.x, minWidth: 168, padding: 4, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", boxShadow: "0 8px 20px rgba(0,0,0,.2)" }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { const project = menu.project; setMenu(null); void handleOpenFolder(project); }}
            style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}
          >
            {t("sidebar.railOpenFolder")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { const project = menu.project; setMenu(null); onRemoveProject(project); }}
            style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "#f87171", textAlign: "left", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}
          >
            {t("sidebar.railRemoveIcon")}
          </button>
        </div>,
        document.body,
      ) : null}
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `node --experimental-strip-types --test components/SessionSidebar.rail-menu.test.mjs lib/project-groups.test.mjs`
Expected: PASS — all five tests in the two files.

Run: `node_modules/.bin/tsc --noEmit`
Expected: zero errors.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add components/SessionSidebar.tsx components/SessionSidebar.rail-menu.test.mjs lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat: add project rail tile context menu"
```

---

### Task 4: Full verification

**Files:**
- None (verification only; no commit expected).

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: verified working tree.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every file passes, including the three files touched by Tasks 1–3.

- [ ] **Step 2: Typecheck + lint**

Run: `node_modules/.bin/tsc --noEmit && npm run lint`
Expected: zero errors, clean lint.

- [ ] **Step 3: Manual smoke (optional, only if a dev server is already running)**

Per repo AGENTS.md: first `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse an already-running healthy Pi Web process; never start a second `next dev`. In the browser:
1. Right-click a rail tile → menu shows 打开项目文件夹 / 移除项目图标 (locale-dependent).
2. 打开项目文件夹 → OS file browser opens at the project root.
3. Right-click a non-active tile → 移除项目图标 → tile disappears; reload the page → still gone.
4. Select the removed project again from the workspace dropdown → its tile returns at its old position.
5. Right-click the active tile with ≥2 tiles → 移除项目图标 → workspace switches to the right neighbor (or left when removing the last tile).
