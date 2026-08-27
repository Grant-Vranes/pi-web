/** A single git worktree checkout entry returned by /api/worktrees. */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

/** Full worktree state for a project, as loaded from /api/worktrees. */
export interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}
