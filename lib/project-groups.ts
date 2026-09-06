import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export interface RecentProject {
  /** Stable server-provided identity used for comparison and Map keys. */
  key: string;
  /** Original project path used for display and filesystem operations. */
  root: string;
}

/** A project as rendered by the rail tiles and the workspace dropdown. */
export interface ProjectSelection {
  root: string;
  key: string;
}

/** Projects sorted by most recent activity and deduplicated by stable key. */
export function getRecentProjects(sessions: readonly SessionInfo[]): RecentProject[] {
  const latestByProject = new Map<string, { root: string; modified: string }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const key = workspaceKeyOf(session);
    const previous = latestByProject.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByProject.set(key, { root, modified: session.modified });
    }
  }
  return [...latestByProject.entries()]
    .sort((a, b) => b[1].modified.localeCompare(a[1].modified))
    .map(([key, { root }]) => ({ key, root }));
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const counts = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    let entry = counts.get(key);
    if (!entry) {
      entry = { running: 0, unread: 0 };
      counts.set(key, entry);
    }
    if (runningSessionIds.has(session.id)) entry.running++;
    if (unreadSessionIds.has(session.id)) entry.unread++;
  }
  return counts;
}

export function sessionsForProject(
  sessions: readonly SessionInfo[],
  projectKey: string,
): SessionInfo[] {
  return sessions.filter((session) => workspaceKeyOf(session) === projectKey);
}

/** Directory-level comparison without node:path (this module is client-side):
 * drop trailing separators, and for Windows-style paths also fold case and
 * separator direction, mirroring projectIdentityKey's win32 semantics. POSIX
 * paths stay case-sensitive. */
function normalizeRoot(root: string): string {
  const windowsLike = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith("\\\\");
  const trimmed = windowsLike
    ? root.replace(/[\\/]+$/, "")
    : root.replace(/\/+$/, "");
  return windowsLike ? trimmed.toLowerCase().replace(/\\/g, "/") : trimmed;
}

/** The single project list rendered by both the rail and the workspace
 *  dropdown, so the two can never drift apart.
 *
 *  Server-derived projects (`recent` plus `selected`) own identity: their keys
 *  come from workspaceKeyOf(session), so per-project activity resolves. The
 *  persisted rail history contributes ordering and keeps remembered
 *  directories that have no sessions yet visible (see loadProjectRailHistory).
 *
 *  Every directory appears at most once. A remembered entry whose directory
 *  has since gained server identity is upgraded in place to the server
 *  key/root — an outdated cwd-based key otherwise never matches activity
 *  counts. When the same key reports a moved root, the server-reported root
 *  wins. */
export function mergeProjectLists(
  history: readonly ProjectSelection[],
  recent: readonly ProjectSelection[],
  selected: ProjectSelection | null,
): ProjectSelection[] {
  const serverByKey = new Map<string, ProjectSelection>();
  for (const project of recent) serverByKey.set(project.key, project);
  if (selected) serverByKey.set(selected.key, selected);

  const result: ProjectSelection[] = [];
  const claimedKeys = new Set<string>();
  const rootOwner = new Map<string, string>();
  const serverSlots = new Set<string>();

  const place = (project: ProjectSelection, fromServer: boolean): void => {
    result.push(project);
    claimedKeys.add(project.key);
    rootOwner.set(normalizeRoot(project.root), project.key);
    if (fromServer) serverSlots.add(project.key);
  };

  // Pass 1 — persisted order first. Entries the server still knows render
  // with the server's identity; remembered session-less directories keep
  // their slot.
  for (const remembered of history) {
    if (claimedKeys.has(remembered.key)) continue;
    const server = serverByKey.get(remembered.key);
    if (server) {
      if (rootOwner.has(normalizeRoot(server.root))) continue;
      place(server, true);
      continue;
    }
    if (rootOwner.has(normalizeRoot(remembered.root))) continue;
    place(remembered, false);
  }

  // Pass 2 — server-discovered projects the history does not know yet, in
  // recency order. If the directory occupies a remembered slot under an
  // outdated key, upgrade that slot to the server identity.
  for (const project of serverByKey.values()) {
    if (claimedKeys.has(project.key)) continue;
    const owner = rootOwner.get(normalizeRoot(project.root));
    if (owner !== undefined && owner !== project.key) {
      const index = result.findIndex((entry) => entry.key === owner);
      if (index >= 0 && !serverSlots.has(owner)) {
        claimedKeys.delete(owner);
        result[index] = project;
        claimedKeys.add(project.key);
        rootOwner.set(normalizeRoot(project.root), project.key);
        serverSlots.add(project.key);
      }
      // An already-server-owned directory stays as-is: two server keys for
      // one root are ambiguous, so the most recent entry keeps the slot.
      continue;
    }
    place(project, true);
  }

  return result;
}
