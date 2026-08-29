import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "path";

/**
 * Persisted archive state. A session id appearing in this file is rendered in
 * the sidebar's "Archive" tab instead of the active "Conversations" tab.
 *
 * Stored as a plain JSON array under ~/.pi/agent/archived-sessions.json so it
 * is independent of pi's own session file format and survives pi upgrades.
 */

const ARCHIVED_FILE_NAME = "archived-sessions.json";

declare global {
  // Coalesced cache + in-flight promise so concurrent callers never race on a
  // partial write. Survives Next.js hot-reload via globalThis.
  var __piArchivedSessionsCache: Set<string> | undefined;
  var __piArchivedSessionsReadPromise: Promise<Set<string>> | undefined;
}

function archivedFilePath(): string {
  return join(getAgentDir(), ARCHIVED_FILE_NAME);
}

/** Load the archived session-id set. Returns an empty set when the file is
 *  missing or malformed (treated as "nothing archived yet"). */
export function readArchivedSessionIds(): Set<string> {
  if (globalThis.__piArchivedSessionsCache) return globalThis.__piArchivedSessionsCache;
  const filePath = archivedFilePath();
  try {
    if (!existsSync(filePath)) {
      globalThis.__piArchivedSessionsCache = new Set();
      return globalThis.__piArchivedSessionsCache;
    }
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const ids = new Set<string>();
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === "string" && id.length > 0) ids.add(id);
      }
    }
    globalThis.__piArchivedSessionsCache = ids;
    return ids;
  } catch {
    globalThis.__piArchivedSessionsCache = new Set();
    return globalThis.__piArchivedSessionsCache;
  }
}

function persist(ids: Set<string>): void {
  const dir = getAgentDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(archivedFilePath(), JSON.stringify([...ids], null, 2), "utf8");
  } catch {
    // Best-effort: a failed write only loses archive persistence across restarts.
  }
  globalThis.__piArchivedSessionsCache = new Set(ids);
}

/** Mark a session as archived. Returns the updated set. */
export function archiveSession(sessionId: string): Set<string> {
  const ids = new Set(readArchivedSessionIds());
  ids.add(sessionId);
  persist(ids);
  return ids;
}

/** Remove a session from the archive (restore to active list). Returns the
 *  updated set. */
export function unarchiveSession(sessionId: string): Set<string> {
  const ids = new Set(readArchivedSessionIds());
  ids.delete(sessionId);
  persist(ids);
  return ids;
}

/** Drop a session id from the archive when the session file itself is deleted,
 *  so the archive tab never shows a phantom row. */
export function forgetArchivedSession(sessionId: string): void {
  const ids = readArchivedSessionIds();
  if (!ids.has(sessionId)) return;
  unarchiveSession(sessionId);
}

/** Invalidate the in-memory cache so the next read reloads from disk. */
export function invalidateArchivedSessionsCache(): void {
  globalThis.__piArchivedSessionsCache = undefined;
}
