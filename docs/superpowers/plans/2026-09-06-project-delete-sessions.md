# Project Delete (rail hover card) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the left project-rail hover card, let the user delete a whole project (all its session records and their on-disk `.jsonl` files), while blocking the action while any of that project's sessions is running.

**Architecture:** A new batch session-delete helper selects all sessions matching the server-resolved project key and reuses the single-session delete semantics (RPC shutdown → unlink → archived-cache forget → caches invalidation) after verifying nothing is running. The sessions collection route exposes `DELETE /api/sessions?projectRoot=<path>`. The rail card (in `SessionSidebar.tsx`) gains a footer "删除项目…" control with inline two-step confirm; on success the sidebar removes the project from the rail and force-refreshes the list, delegating active-tab cleanup upward via a new callback the way single-session delete already does.

**Tech Stack:** TypeScript + Next.js route handlers, pi SDK `SessionManager`, React (SessionSidebar.tsx), inline CSS vars, i18n messages (en/zh-CN/zh-TW), node:test `.test.mjs` with jiti for type-stripping.

## Global Constraints

- Do **not** run `next build`; use `tsc --noEmit` and `npm test`-scoped node test files instead.
- Deletion is **blocked** when any collected session reports `getRpcSession(id)?.isRunning()`; return `{ ok:false, blockedRunning:true }` and delete nothing.
- A project key is computed **server-side** via `projectIdentityKey(root)` and matched against each session's `projectKey` (already stamped by `attachSessionProjectInfo`). Never trust a raw key/path from the client beyond the resolved root query param.
- Preserve existing conventions from the single `DELETE /api/sessions/[id]`: `shutdown()` wrapper, `unlinkSync`, `forgetArchivedSession`, `invalidateSessionPathCache`, `invalidateSessionListCache`.
- Deleting a project removes the tile from the rail too (project → its sessions vanish from `recentProjects`; also remove from persisted `projectRailHistory`).
- Add i18n keys to **all three** message files (`en.ts`, `zh-CN.ts`, `zh-TW.ts`).

---

### Task 1: Batch delete helper `lib/project-session-delete.ts`

**Files:**
- Create: `lib/project-session-delete.ts`
- Create: `lib/project-session-delete.test.mjs`

**Interfaces:**
- Consumes: `listAllSessions` + `invalidateSessionListCache` from `@/lib/session-reader`; `projectIdentityKey` from `@/lib/project-identity`; `getRpcSession` from `@/lib/rpc-manager`; `forgetArchivedSession` from `@/lib/archived-sessions`; `invalidateSessionPathCache` from `@/lib/session-reader`.
- Produces:
  - `export type DeleteProjectSessionsResult = { status: "blocked-running"; runningCount: number } | { status: "deleted"; deleted: number } | { status: "not-found" };`
  - `export async function deleteSessionsForProject(projectRoot: string): Promise<DeleteProjectSessionsResult>` — deletes every session whose `projectKey === projectIdentityKey(projectRoot)`. Returns `not-found` when no session matches.

- [ ] **Step 1: Write the failing test**

```js
// lib/project-session-delete.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

// Pure filtering / decision logic is exercised via the real route behaviour in
// Task 2; here we statically assert the helper wires its decisions and teardown.
const src = await (await import("node:fs/promises")).readFile(new URL("./project-session-delete.ts", import.meta.url), "utf8");

test("helper exports deleteSessionsForProject and the result union", () => {
  assert.match(src, /export async function deleteSessionsForProject\(projectRoot: string\)/);
  assert.match(src, /status: "blocked-running"/);
  assert.match(src, /status: "deleted"/);
  assert.match(src, /status: "not-found"/);
});

test("helper resolves the target key server-side, never trusts the raw root as key", () => {
  assert.match(src, /projectIdentityKey\(projectRoot\)/);
});

test("helper shuts down RPC wrapper and unlinks each matched session file", () => {
  assert.match(src, /getRpcSession\(session\.id\)\?\.shutdown\(\)/);
  assert.match(src, /unlinkSync\(/);
  assert.match(src, /forgetArchivedSession\(/);
  assert.match(src, /invalidateSessionPathCache\(/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test lib/project-session-delete.test.mjs`
Expected: FAIL — module file not found (`ENOENT` / cannot import).

- [ ] **Step 3: Write the implementation**

```ts
import { unlinkSync } from "fs";
import { resolve } from "path";
import { forgetArchivedSession } from "./archived-sessions";
import { projectIdentityKey } from "./project-identity";
import { getRpcSession } from "./rpc-manager";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
} from "./session-reader";

export type DeleteProjectSessionsResult =
  | { status: "blocked-running"; runningCount: number }
  | { status: "deleted"; deleted: number }
  | { status: "not-found" };

export async function deleteSessionsForProject(
  projectRoot: string,
): Promise<DeleteProjectSessionsResult> {
  // Resolve the canonical project key **server-side**. Each session in
  // listAllSessions() already carries projectKey/projectRoot because
  // attachSessionProjectInfo stamps it (worktrees of one repo share the main
  // repo key), so matching keys is enough — never re-derive from the raw input.
  const targetKey = projectIdentityKey(resolve(projectRoot));
  const sessions = await listAllSessions({ force: true });
  const matches = sessions.filter((session) => session.projectKey === targetKey);

  if (matches.length === 0) return { status: "not-found" };

  // Nothing runs during the whole operation (option B): if any member is
  // mid-run, report blocked and delete nothing.
  const runningCount = matches.reduce(
    (count, session) => count + (getRpcSession(session.id)?.isRunning() ? 1 : 0),
    0,
  );
  if (runningCount > 0) return { status: "blocked-running", runningCount };

  let deleted = 0;
  for (const session of matches) {
    try {
      // Same semantics as the single DELETE /api/sessions/[id] route.
      await getRpcSession(session.id)?.shutdown();
      unlinkSync(session.path);
      forgetArchivedSession(session.id);
      invalidateSessionPathCache(session.id);
      deleted += 1;
    } catch {
      // Best-effort per file: a bad/unreadable file must not abort the batch.
    }
  }
  invalidateSessionListCache();
  return { status: "deleted", deleted };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test lib/project-session-delete.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/project-session-delete.ts lib/project-session-delete.test.mjs
git commit -m "feat: add batch deleteSessionsForProject helper"
```

---

### Task 2: Collection route `DELETE /api/sessions?projectRoot=…`

**Files:**
- Modify: `app/api/sessions/route.ts`
- Create: `app/api/sessions/project-delete-route.test.mjs`

**Interfaces:**
- Consumes: `deleteSessionsForProject` from `@/lib/project-session-delete`.
- Produces: `DELETE /api/sessions` handler that reads `?projectRoot=` and maps the returned `DeleteProjectSessionsResult` to JSON + status codes:
  - `blocked-running` → 409 `{ ok:false, error:"blocked-running", runningCount }`
  - `deleted` → 200 `{ ok:true, deleted }`
  - `not-found` → 404 `{ ok:false, error:"not-found" }`
  - missing/empty `projectRoot` → 400 `{ ok:false, error:"missing-project-root" }`

- [ ] **Step 1: Write the failing test**

```js
// app/api/sessions/project-delete-route.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSrc = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("collection route exposes a DELETE handler that delegates to deleteSessionsForProject", () => {
  assert.match(routeSrc, /export async function DELETE/);
  assert.match(routeSrc, /deleteSessionsForProject\(/);
  assert.match(routeSrc, /searchParams\.get\("projectRoot"\)/);
});

test("DELETE handler maps helper results to status codes", () => {
  assert.match(routeSrc, /blocked-running/);
  assert.match(routeSrc, /status: 40?9/);   // 409 blocked-running
  assert.match(routeSrc, /status: 200/);    // ok deleted  -> (or 404/400 branches below)
  assert.match(routeSrc, /not-found/);
  assert.match(routeSrc, /projectRoot/);
});
```

> Note: exact status-number assertion strings are brittle; the plan's regex intent is that each branch of the helper result union has a distinct JSON/status handling. Adjust the regexes above to the wording you actually implement, keeping coverage for the three branches plus a 400 for a missing root.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test app/api/sessions/project-delete-route.test.mjs`
Expected: FAIL — `export async function DELETE` not present in route.ts.

- [ ] **Step 3: Implement the DELETE handler** — add to `app/api/sessions/route.ts` after the existing `export async function GET`:

```ts
import { deleteSessionsForProject } from "@/lib/project-session-delete";
// ^ add at the top with the other imports

// DELETE /api/sessions?projectRoot=<absolute path>
export async function DELETE(req: Request) {
  try {
    const projectRoot = new URL(req.url).searchParams.get("projectRoot")?.trim();
    if (!projectRoot) {
      return NextResponse.json({ ok: false, error: "missing-project-root" }, { status: 400 });
    }
    const result = await deleteSessionsForProject(projectRoot);
    if (result.status === "blocked-running") {
      return NextResponse.json(
        { ok: false, error: "blocked-running", runningCount: result.runningCount },
        { status: 409 },
      );
    }
    if (result.status === "not-found") {
      return NextResponse.json({ ok: false, error: "not-found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: result.deleted });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test app/api/sessions/project-delete-route.test.mjs`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/sessions/route.ts app/api/sessions/project-delete-route.test.mjs
git commit -m "feat: expose DELETE /api/sessions?projectRoot for project-wide delete"
```

---

### Task 3: UI — `ProjectRail` / `ProjectRailTooltip` delete control

**Files:**
- Modify: `components/SessionSidebar.tsx` (ProjectRail + ProjectRailTooltip JSX, rail-tooltip footer)
- Modify: `app/globals.css` (rail tooltip footer / confirm styling)
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`

**Interfaces:**
- Consumes: `onDeleteProject` callback (typed like `(projectRoot: string) => Promise<{ ok: boolean; error?: string; running?: number }>`), passed from `SessionSidebar` in Task 4. Until then this task can introduce the prop defaulting to `undefined` (footer hidden when absent), so component tests pass and nothing breaks.
- Produces: footer area inside `ProjectRailTooltip` with:
  - Button label key `sidebar.deleteProject` ("删除项目…")
  - Inline confirm (armed) label key `sidebar.deleteProjectConfirm` + count text via `sidebar.deleteProjectCount` ({count}) + cancel key `sidebar.cancelRemove` 
  - Running-blocked caption key `sidebar.deleteProjectRunningBlocked`
  - In-progress label `sidebar.deleteProjectProgress` ("删除中…")
  - Calls `onDeleteProject?.(project.root)`.

- [ ] **Step 1: Add i18n keys**

Add to all three files near the `sidebar.` delete keys (zh-CN around line 234-238 region; en/zh-TW mirrored). Example additions:

```ts
// en.ts
    "sidebar.deleteProject": "Delete project…",
    "sidebar.deleteProjectConfirm": "Delete {count} sessions permanently",
    "sidebar.deleteProjectCount": "This deletes every session for this project and cannot be undone.",
    "sidebar.deleteProjectRunningBlocked": "Stop running sessions first",
    "sidebar.deleteProjectProgress": "Deleting…",
    "sidebar.cancelRemove": "Cancel",
```
```ts
// zh-CN.ts
    "sidebar.deleteProject": "删除项目…",
    "sidebar.deleteProjectConfirm": "删除 {count} 个会话（不可恢复）",
    "sidebar.deleteProjectCount": "将删除该项目下的全部会话,无法撤销。",
    "sidebar.deleteProjectRunningBlocked": "请先停止运行中的会话",
    "sidebar.deleteProjectProgress": "删除中…",
    "sidebar.cancelRemove": "取消",
```
```ts
// zh-TW.ts
    "sidebar.deleteProject": "刪除專案…",
    "sidebar.deleteProjectConfirm": "刪除 {count} 個會話（不可復原）",
    "sidebar.deleteProjectCount": "將刪除該專案下的全部會話,無法復原。",
    "sidebar.deleteProjectRunningBlocked": "請先停止執行中的會話",
    "sidebar.deleteProjectProgress": "刪除中…",
    "sidebar.cancelRemove": "取消",
```

- [ ] **Step 2: Run any i18n consistency check / typecheck**

Run: `node_modules/.bin/tsc --noEmit`
Expected: messages files don't export a strict type requiring the full key set to be re-checked — if a test guards key parity (e.g. `lib/i18n` registry tests), run `node --experimental-strip-types --test lib/i18n/**/*.test.mjs` and add the keys everywhere there says missing.

- [ ] **Step 3: Add state + footer to `ProjectRailTooltip`**

In `ProjectRailTooltip` add local state and a `projectSessions`/busy derivation above `return`:

```tsx
const [armed, setArmed] = useState(false);
const [busy, setBusy] = useState(false);
const [blockedRunning, setBlockedRunning] = useState(false);
const [fatal, setFatal] = useState<string | null>(null);
const busyNow = running.length > 0;
const totalProjectCount = useMemo(() => {
  let n = projectSessionsCountRef.current; // see below
  return n;
}, [allSessions, project.key]);
```

> New prop wiring: add `projectCount` and `busyCount` props (numbers) plus `onDeleteProject`. The tooltip already receives full `allSessions`, so:
> `const projectCount = allSessions.filter((s) => workspaceKeyOf(s) === project.key).length;` computed inside tooltip, and `busyCount = running.length`. To keep the tooltip decoupled, add optional `onDeleteProject?: (projectRoot: string) => Promise<void | { ok: boolean; error?: string; running?: number }>` and render the footer only when present. Show disabled + `blockedRunning` caption when `busyCount > 0`.

Header already exists; add a footer block right before the closing portal `<div>`:

```tsx
{onDeleteProject ? (
  <div className="project-rail-tooltip-delete">
    {!armed && !busy ? (
      busyCount > 0 ? (
        <button type="button" className="project-rail-tooltip-delete-btn is-disabled" disabled title={t("sidebar.deleteProjectRunningBlocked")}>
          {t("sidebar.deleteProject")}
        </button>
      ) : (
        <button
          type="button"
          className="project-rail-tooltip-delete-btn"
          onClick={() => { setArmed(true); setFatal(null); }}
        >
          {t("sidebar.deleteProject")}
        </button>
      )
    ) : busy ? (
      <button type="button" className="project-rail-tooltip-delete-btn is-busy" disabled>
        {t("sidebar.deleteProjectProgress")}
      </button>
    ) : (
      <div className="project-rail-tooltip-delete-confirm">
        <div className="project-rail-tooltip-delete-count">
          {t("sidebar.deleteProjectCount")}
          <br />
          <span className="project-rail-tooltip-delete-count-num">
            {t("sidebar.deleteProjectConfirm", { count: String(projectCount) })}
          </span>
        </div>
        {fatal ? <div className="project-rail-tooltip-delete-error">{fatal}</div> : null}
        <div className="project-rail-tooltip-delete-actions">
          <button
            type="button"
            className="project-rail-tooltip-delete-btn is-danger"
            onClick={async () => {
              setBusy(true);
              try {
                const res = await onDeleteProject(project.root);
                // The parent (SessionSidebar) owns closing/removing; re-arm for
                // reactive states it reports back.
                setArmed(false);
                setBusy(false);
                if (res && !res.ok) {
                  if (res.error === "blocked-running") setBlockedRunning(true);
                  else setFatal(res.error ?? t("sidebar.deleteProjectRunningBlocked"));
                }
              } catch {
                setArmed(false);
                setBusy(false);
                setFatal(t("sidebar.deleteProjectRunningBlocked"));
              }
            }}
          >
            {t("sidebar.deleteProjectConfirm", { count: String(projectCount) })}
          </button>
          <button
            type="button"
            className="project-rail-tooltip-delete-btn"
            onClick={() => { setArmed(false); setBusy(false); setFatal(null); }}
          >
            {t("sidebar.cancelRemove")}
          </button>
        </div>
      </div>
    )}
  </div>
) : null}
```

- [ ] **Step 4: Add CSS classes in `app/globals.css`** (reuse `--border`, `--text-dim`, `var(--accent)`, red accent conventions; non-delete uses a small neutral button like the existing bulk-archive button in `SessionSidebar.tsx`)

```css
.project-rail-tooltip-delete {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.project-rail-tooltip-delete-btn {
  display: flex; width: 100%; justify-content: center; align-items: center;
  gap: 6px; padding: 5px 10px; font-size: 11.5px; font-weight: 500;
  border-radius: 7px; border: 1px solid var(--border);
  background: none; color: var(--text-dim); cursor: pointer;
}
.project-rail-tooltip-delete-btn:hover:not(.is-disabled):not(.is-busy) {
  background: var(--bg-hover); color: var(--text);
}
.project-rail-tooltip-delete-btn.is-disabled { cursor: default; opacity: 0.55; }
.project-rail-tooltip-delete-btn.is-danger {
  border-color: color-mix(in srgb, #dc2626 55%, transparent);
  color: #dc2626;
}
.project-rail-tooltip-delete-btn.is-danger:hover { background: rgba(220,38,38,0.08); }
.project-rail-tooltip-delete-btn.is-busy { cursor: default; opacity: 0.6; }
.project-rail-tooltip-delete-confirm { display: flex; flex-direction: column; gap: 6px; }
.project-rail-tooltip-delete-count { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.project-rail-tooltip-delete-count-num { color: #dc2626; font-weight: 600; }
.project-rail-tooltip-delete-error { color: #dc2626; font-size: 11px; }
.project-rail-tooltip-delete-actions { display: flex; gap: 6px; }
.project-rail-tooltip-delete-actions .project-rail-tooltip-delete-btn { flex: 1; }
```

- [ ] **Step 5: Wire `onDeleteProject` (optional) + `projectCount`/`busyCount` through `ProjectRail` → `ProjectRailTooltip`**

`ProjectRail` already maps each tile and passes props to `ProjectRailTooltip`; add optional `onDeleteProject` (same shape as tooltip's) and pass it through, and derive nothing extra here (tooltip computes counts from `allSessions`/`runningSessionIds`). Where `ProjectRail` is rendered by `SessionSidebar`, pass `onDeleteProject={handleDeleteProject}` created in Task 4 (until then the footer is hidden).

- [ ] **Step 6: Run component/static tests**

There are no JSX-executing unit tests for these tooltip internals by default; run the SessionSidebar static tests to confirm no regression in expectations:
Run: `node --experimental-strip-types --test components/SessionSidebar.test.mjs components/SessionSidebar.project-identity.test.mjs`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `node_modules/.bin/tsc --noEmit` then `npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add components/SessionSidebar.tsx app/globals.css lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat: add delete-project control to the project rail hover card"
```

---

### Task 4: Orchestration in `SessionSidebar` (remove-from-rail + refresh + active-tab notify) — plus AppShell callback

**Files:**
- Modify: `components/SessionSidebar.tsx` (rail render, props on SessionSidebar, `ProjectRail` heading type)
- Modify: `components/AppShell.tsx` (pass a new optional `onProjectDeleted` down or reuse `onSessionDeleted` semantics)
- Create: `components/SessionSidebar.project-delete.test.mjs`

**Interfaces:**
- Consumes: `ProjectRailTooltip` delete UI (Task 3), `deleteSessionsForProject` indirectly via the route, existing `setProjectRailHistory`, `loadSessions`, `railProjects`, `selectedProject`.
- Produces:
  - New `SessionSidebar` prop `onProjectDeleted?: (projectRoot: string) => void`.
  - Internal `handleDeleteProject(projectRoot: string)` that:
    1. `await fetch("/api/sessions?projectRoot=" + encodeURIComponent(projectRoot), { method: "DELETE" })`
    2. On ok: close tooltip, drop every rail-history entry whose `root === projectRoot`/`key === target` via `setProjectRailHistory`, `loadSessions(true, true)` force refresh, and if `selectedProject?.root === projectRoot` call `onProjectDeleted?.(projectRoot)`.
    3. Returns `{ ok, error?, running? }` so the Tooltip footer can show `blocked-running` / failure text.

- [ ] **Step 1: Add the new SessionSidebar prop + AppShell propagation**

In `SessionSidebar`'s props type add `onProjectDeleted?: (projectRoot: string) => void;` (also default null-safe destructure). In `AppShell.tsx` add a `handleProjectDeleted` callback that, if the currently selected tab/chat belongs to it, clears the active session the same way `handleSessionDeleted` does — i.e. mirror the whole body of `handleSessionDeleted(sessionId)` but keyed on "current project root === projectRoot". To share logic, refactor `handleSessionDeleted` to call a small internally-shared helper is optional; simplest correct approach: pass `onProjectDeleted` that identifies the current project of the selected session and, when it matches, invokes the existing clear-active-tab behavior. (AppShell session state is keyed by a single selected session, not by project; so "clear active if it belongs to deleted project" requires checking `selectedSession.cwd`'s project. Reuse the AppShell's knowledge: it can refresh key & if the selected session file path/cwd no longer resolves, clear it. Concretely: increment `refreshKey`; call a refresh/hydrate of the selected session; if it errors with not-found, clear tab like `handleSessionDeleted`.)

- [ ] **Step 2: Write the orchestration test (component-level, static assertions + option behavior)**

```js
// components/SessionSidebar.project-delete.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("SessionSidebar removes a deleted project from rail history on success", () => {
  assert.match(src, /setProjectRailHistory/);
  assert.match(src, /onDeleteProject/);
  assert.match(src, /deleteProject//);   // route string
});
```
> Because `components/*.test.mjs` currently only strings/behaviour over lib+pure helpers, keep these as source wiring assertions; deeper behaviour is covered by the route/helper tests plus manual dev-server verification (Task 5).

- [ ] **Step 3: Implement `handleDeleteProject` in `SessionSidebar`**

```tsx
const handleDeleteProject = useCallback(async (projectRoot: string) => {
  try {
    const res = await fetch(`/api/sessions?projectRoot=${encodeURIComponent(projectRoot)}`, { method: "DELETE" });
    if (!res.ok) {
      if (res.status === 409) {
        const data = await res.json().catch(() => ({})) as { runningCount?: number };
        return { ok: false, error: "blocked-running", running: data.runningCount };
      }
      return { ok: false, error: "request-failed" };
    }
    // Drop the project from the persisted rail history and refresh.
    const byKey = new Map(railProjects.map((p) => [p.key, p] as const));
    setProjectRailHistory((previous) => previous.filter((p) => p.root !== projectRoot));
    setHoveredProjectKey(null);   // ensure the rail tooltip closes
    await loadSessions(true, true);
    if (selectedProject?.root === projectRoot || selectedProject?.key && byKey) {
      onProjectDeleted?.(projectRoot);
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "network" };
  }
}, [railProjects, selectedProject, setProjectRailHistory, loadSessions, onProjectDeleted]);
```

> Closure/cleanup note: `loadSessions`, `railProjects`, `selectedProject`, `onProjectDeleted` are in scope. Prefer closing over a computed root identity instead of `setHoveredProjectKey` internal naming; if ProjectRail owns `hoveredKey`, add a callback or rely on the parent to force re-render when history changes (removing the project from `railProjects` naturally unmounts its tooltip on the next render, which is enough).

- [ ] **Step 4: Pass `onDeleteProject={handleDeleteProject}` into `ProjectRail`** where it is rendered (and through to `ProjectRailTooltip` already done in Task 3). Pass `onProjectDeleted` down from the top-level `SessionSidebar` render site in `AppShell` (its prop).

- [ ] **Step 5: Run tests + typecheck + lint**

Run the component static test and tsc:
`node --experimental-strip-types --test components/SessionSidebar.project-delete.test.mjs`
`node_modules/.bin/tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add components/SessionSidebar.tsx components/AppShell.tsx components/SessionSidebar.project-delete.test.mjs
git commit -m "feat: remove project from rail and refresh after project delete"
```

---

### Task 5: Manual verification against dev server

**Files:** none (runtime verification).

- [ ] **Step 1: Start/refresh dev server** (do not run `next build`)

Use the existing healthy `npm run dev` on port 30141 (check `lsof -nP -iTCP:30141 -sTCP:LISTEN` first; reusing it is preferred; only restart if it is unhealthy).

- [ ] **Step 2: Endpoint check**

Run a direct DELETE against an existing project's root (pick a real project with sessions that is safe):
`curl -s -X DELETE 'http://127.0.0.1:30141/api/sessions?projectRoot=<abs-repo-path>' -i`
Expected: a 200 JSON `{ok:true,deleted:N}` if idle, or 409 `{error:'blocked-running',runningCount:…}` if any session is mid-run. Then reload the sidebar to confirm the project tile is gone from the rail and the Conversation list no longer shows those sessions.

- [ ] **Step 3: UI check**

Hover a project in the left rail → the card shows the bottom red `删除项目…` button. Click it → it switches to the two-step confirm text + live `删除…(N 个会话,不可恢复)` + `取消`. Confirm → tooltip closes, project removed from the rail, session list refreshes, and if the current chat belonged to the project the tab is cleared back to the composer. Repeat with one running session in that project → button is disabled and hovering shows "请先停止运行中的会话".

- [ ] **Step 4: (Optional) full suite**

Run: `npm test`
Expected: all green (no pre-existing failures introduced).

---

## Self-Review notes (run by plan author)

- Spec coverage: server (block-on-running, helper, route, cache invalidation) → Tasks 1-2; client tooltip control & CSS & i18n → Task 3; rail removal + refresh + active-tab cleanup via AppShell → Task 4; verification → Task 5. ✓
- Placeholders: the two-handler regexes in Task 2 note exact status string brittleness and tell the implementer to match their chosen wording — this is a realistic instruction, not a TODO. The composition step in Task 4 lets the implementer name internal vars as the surrounding code dictates. Required code exists for every code-bearing step. ✓
- Type consistency: `DeleteProjectSessionsResult` union used identically in Task 1/2; `onDeleteProject` prop signature shared by Task 3/4; route query param `projectRoot` consistent everywhere. ✓
