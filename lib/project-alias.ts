/**
 * Per-project display-name aliases ("rename project").
 *
 * A project's default name is derived from its root directory, which is often
 * generic (e.g. "build"). The rail tooltip lets the user rename a project;
 * the alias is keyed by the stable workspace key (same identity the rail and
 * workspace dropdown already use) so it survives reordering and worktree root
 * changes, and lives in localStorage as best-effort UI state — aliases are a
 * personal display preference, not shared project data.
 */

const STORAGE_KEY = "pi-web:project-aliases";

/** Same-tab change notification: `storage` events only fire cross-tab, so
 *  writers dispatch this custom event for same-page listeners (e.g. the
 *  chat window's new-session header) to re-read the map. */
const CHANGE_EVENT = "pi-web:project-aliases-changed";

export type ProjectAliasMap = Record<string, string>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readMap(storage: StorageLike | null): ProjectAliasMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const aliases: ProjectAliasMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) aliases[key] = trimmed;
    }
    return aliases;
  } catch {
    return {};
  }
}

/** A snapshot of every stored alias, keyed by workspace key. */
export function loadProjectAliases(storage: StorageLike | null = getBrowserStorage()): ProjectAliasMap {
  return readMap(storage);
}

/** Subscribe to alias changes (same-tab custom event + cross-tab storage
 *  event). Returns an unsubscribe function; safe to call during SSR. */
export function subscribeProjectAliases(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Set the alias for a workspace key. An empty/blank name removes it. */
export function setProjectAlias(
  workspaceKey: string,
  name: string,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    const aliases = readMap(storage);
    const trimmed = name.trim();
    if (trimmed) aliases[workspaceKey] = trimmed;
    else delete aliases[workspaceKey];
    const raw = JSON.stringify(aliases);
    if (Object.keys(aliases).length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, raw);
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
      } catch {
        // environments without CustomEvent — subscribers poll instead
      }
    }
  } catch {
    // storage unavailable — aliases are best-effort
  }
}

/** The trailing directory segment of a project root, the fallback name. */
export function projectFolderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() || root;
}

/** The alias when set, otherwise the folder name derived from the root. */
export function projectDisplayName(
  root: string,
  alias: string | undefined | null,
): string {
  const trimmed = alias?.trim();
  return trimmed ? trimmed : projectFolderName(root);
}
