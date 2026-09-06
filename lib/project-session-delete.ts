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

/**
 * Delete every session that belongs to the given project, including their
 * on-disk .jsonl files. "Project" membership is decided by the stable,
 * server-computed `projectKey` that loadAllSessions stamps onto each record
 * (worktrees of one repo all share the main repo's key), so wiping "a project"
 * clears that repo's sessions across every worktree.
 *
 * Nothing is deleted while any matched session is running: return
 * blocked-running so the caller can tell the user to stop them first.
 */
export async function deleteSessionsForProject(
  projectRoot: string,
): Promise<DeleteProjectSessionsResult> {
  // Resolve the canonical project key server-side. A client-provided root must
  // never be treated as an opaque grouping key; normalize + case/separator-fold
  // it the way the session list does before comparing.
  const targetKey = projectIdentityKey(resolve(projectRoot));
  const sessions = await listAllSessions({ force: true });
  const matches = sessions.filter((session) => session.projectKey === targetKey);

  if (matches.length === 0) return { status: "not-found" };

  // Option B policy: refuse while any member is mid-run so active work is not
  // silently destroyed.
  let runningCount = 0;
  for (const session of matches) {
    if (getRpcSession(session.id)?.isRunning()) runningCount += 1;
  }
  if (runningCount > 0) return { status: "blocked-running", runningCount };

  let deleted = 0;
  for (const session of matches) {
    try {
      // Same teardown the single DELETE /api/sessions/[id] route performs.
      await getRpcSession(session.id)?.shutdown();
      unlinkSync(session.path);
      forgetArchivedSession(session.id);
      invalidateSessionPathCache(session.id);
      deleted += 1;
    } catch {
      // Best-effort per file: one unreadable/locked file must not abort the
      // rest of the batch.
    }
  }
  invalidateSessionListCache();
  return { status: "deleted", deleted };
}
