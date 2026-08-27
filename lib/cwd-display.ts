/**
 * Substitute the home dir prefix with `~` for display. No path truncation —
 * callers handle ellipsis/truncation themselves (e.g. PathLabel).
 *
 * Client-safe: no Node `path` import, so it can run in the browser where the
 * home dir is fetched from `/api/home`.
 */
export function displayCwd(cwd: string, homeDir?: string): string {
  return homeDir && cwd.startsWith(homeDir) ? "~" + cwd.slice(homeDir.length) : cwd;
}
