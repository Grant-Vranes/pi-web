import type { WorktreeState } from "./worktree-types";
import { samePath } from "./paths";

export interface WorktreeTopologySnapshot {
  projectKey: string;
  activeWorktreePath: string | null;
  worktreePaths: string[];
}

export type WorktreeHandoffTarget =
  | { kind: "created"; cwd: string }
  | { kind: "removed"; cwd: string }
  | null;

export function snapshotWorktreeTopology(
  state: Pick<WorktreeState, "projectKey" | "currentWorktreePath" | "worktrees">,
): WorktreeTopologySnapshot {
  return {
    projectKey: state.projectKey,
    activeWorktreePath: state.currentWorktreePath ?? null,
    worktreePaths: state.worktrees.map((worktree) => worktree.path).filter(Boolean),
  };
}

export function decideWorktreeHandoff(
  before: WorktreeTopologySnapshot,
  after: Pick<WorktreeState, "projectKey" | "projectRoot" | "currentWorktreePath" | "worktrees">,
): WorktreeHandoffTarget {
  if (before.projectKey !== after.projectKey) return null;

  const activeWasRemoved = Boolean(
    before.activeWorktreePath
    && !after.worktrees.some((worktree) => samePath(worktree.path, before.activeWorktreePath!)),
  );
  if (activeWasRemoved) return { kind: "removed", cwd: after.projectRoot };

  const added = after.worktrees
    .map((worktree) => worktree.path)
    .filter((path) => path && !before.worktreePaths.some((previous) => samePath(previous, path)));
  return added.length === 1 ? { kind: "created", cwd: added[0] } : null;
}
