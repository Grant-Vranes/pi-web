import type { SessionInfo } from "./types";

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string | null>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = session.id;
    let rootId: string | null = null;

    while (true) {
      if (roots.has(currentId)) {
        rootId = roots.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;

      visited.add(currentId);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (current.relation?.kind !== "subagent") {
        rootId = current.id;
        break;
      }
      currentId = current.relation.parentSessionId;
    }

    for (const id of path) roots.set(id, rootId);
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const rootId = rootsBySessionId.get(session.id);
    const family = rootId ? families.get(rootId) : undefined;
    if (!family) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  return [...families.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}

export interface SessionDayGroup {
  /** 本地日历日的稳定 key（YYYY-MM-DD），用于折叠状态持久化。 */
  dateKey: string;
  /** 组内最新修改时间，用于生成标题文案。 */
  latestModified: string;
  families: SessionFamily[];
}

/**
 * 将已排序的会话分组按本地日历日聚合。listSessionFamilies() 已按
 * latestModified 降序返回，这里只需在保持顺序的前提下切分边界。
 * @param families 已排序的会话分组
 */
export function groupFamiliesByDay(
  families: readonly SessionFamily[],
): SessionDayGroup[] {
  const groups: SessionDayGroup[] = [];
  for (const family of families) {
    const date = new Date(family.latestModified);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const last = groups[groups.length - 1];
    if (last && last.dateKey === dateKey) {
      last.families.push(family);
      // families 已降序，组内首个即为最新，无需更新 latestModified
    } else {
      groups.push({ dateKey, latestModified: family.latestModified, families: [family] });
    }
  }
  return groups;
}
