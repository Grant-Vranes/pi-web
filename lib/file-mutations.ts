import fs from "fs";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { isWindowsAbsolutePath } from "./paths";

export class FileMutationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type FileMutation =
  | { type: "create-file" | "create-directory"; directory: string; name: string }
  | { type: "rename"; sourcePath: string; name: string }
  | { type: "move"; sourcePath: string; destinationDirectory: string }
  | { type: "delete"; sourcePath: string }
  | { type: "write"; sourcePath: string; content: string; baseMtimeMs: number | null };

export type FileMutationResult = {
  sourcePath: string;
  destinationPath?: string;
  deleted: boolean;
  mtimeMs?: number;
  size?: number;
};

function resolverFor(...paths: string[]): typeof path {
  return paths.some(isWindowsAbsolutePath) ? path.win32 : path;
}

function assertName(name: string): void {
  if (
    !name
    || name === "."
    || name === ".."
    || /[\\/]/.test(name)
    || path.isAbsolute(name)
    || path.win32.isAbsolute(name)
  ) {
    throw new FileMutationError(400, "Invalid file name");
  }
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function nearestExistingAncestor(target: string, allowedRoots: Set<string>): string | null {
  // Walk up from target to find the first existing ancestor that is still
  // lexically within an allowed root, probing each candidate with lstat
  // (which does not follow the final component). Used to canonically
  // authorize before probing a leaf whose path may traverse an allowed-root
  // symlink that escapes the root — lstat follows intermediate symlinks, so
  // we must authorize the nearest existing ancestor first. Stops at the
  // lexical root boundary so a root path's tmp-directory parent is never
  // evaluated.
  const resolver = resolverFor(target);
  let current = target;
  for (let depth = 0; depth < 64; depth++) {
    const parent = resolver.dirname(current);
    if (parent === current) return null; // filesystem root
    if (!isFilePathAllowed(parent, allowedRoots)) return null; // walked out of lexical root
    if (pathEntryExists(parent)) return parent;
    current = parent;
  }
  return null;
}

function assertLexicallyAllowed(target: string, allowedRoots: Set<string>): void {
  if (!isFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertExistingAllowed(target: string, allowedRoots: Set<string>): void {
  // Authorize before observing the leaf so outside-root paths cannot be used
  // as an existence oracle. Canonically authorize the nearest existing
  // ancestor first: an allowed-root symlink whose target escapes the root
  // must return 403 regardless of whether the leaf exists, so we never reveal
  // existence through such a symlink. lstat follows intermediate symlinks, so
  // authorizing the ancestor (which resolves through realpath) catches escapes
  // before any leaf probe.
  assertLexicallyAllowed(target, allowedRoots);
  const ancestor = nearestExistingAncestor(target, allowedRoots);
  if (ancestor !== null && !isExistingFilePathAllowed(ancestor, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
  if (!pathEntryExists(target)) {
    throw new FileMutationError(404, "File or directory not found");
  }
  // The leaf itself must also resolve within an allowed root (covers a direct
  // symlink whose target is outside the root, where the ancestor is legitimately
  // inside but the leaf escapes).
  if (!isExistingFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertParentAllowed(target: string, allowedRoots: Set<string>): void {
  const parent = resolverFor(target).dirname(target);
  assertLexicallyAllowed(target, allowedRoots);
  assertLexicallyAllowed(parent, allowedRoots);
  // Canonically authorize the nearest existing ancestor before probing the
  // parent, so an allowed-root symlink escaping the root cannot leak
  // outside-root existence via lstat following intermediate symlinks.
  const ancestor = nearestExistingAncestor(parent, allowedRoots);
  if (ancestor !== null && !isExistingFilePathAllowed(ancestor, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
  if (!pathEntryExists(parent)) {
    throw new FileMutationError(404, "Parent directory not found");
  }
  if (!isExistingFilePathAllowed(parent, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertVacant(target: string, allowedRoots: Set<string>): void {
  assertLexicallyAllowed(target, allowedRoots);
  if (pathEntryExists(target)) {
    throw new FileMutationError(409, "A file or directory with this name already exists");
  }
}

function assertDirectory(target: string, allowedRoots: Set<string>): void {
  assertExistingAllowed(target, allowedRoots);
  if (!fs.statSync(target).isDirectory()) {
    throw new FileMutationError(400, "Target is not a directory");
  }
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const resolver = resolverFor(candidate, ancestor);
  const relative = resolver.relative(ancestor, candidate);
  const traversesOutside = relative === ".." || relative.startsWith(`..${resolver.sep}`);
  return relative === "" || (!traversesOutside && !resolver.isAbsolute(relative));
}

// Authorization and mutation are separate path-based Node fs calls. Another
// local process can replace a checked path between them; this known TOCTOU
// window is an accepted limitation of the current Node API approach.
function executeMutation(
  mutation: FileMutation,
  allowedRoots: Set<string>,
): FileMutationResult {
  if ("directory" in mutation) {
    assertName(mutation.name);
    assertDirectory(mutation.directory, allowedRoots);
    const destinationPath = resolverFor(mutation.directory).join(
      mutation.directory,
      mutation.name,
    );
    assertParentAllowed(destinationPath, allowedRoots);
    assertVacant(destinationPath, allowedRoots);

    if (mutation.type === "create-file") {
      fs.writeFileSync(destinationPath, "", { flag: "wx" });
    } else {
      fs.mkdirSync(destinationPath);
    }
    return { sourcePath: destinationPath, destinationPath, deleted: false };
  }

  if (mutation.type === "write") {
    // 404 for normal missing files; 403 before any leaf probe when an
    // intermediate symlink escapes the allowed roots.
    assertExistingAllowed(mutation.sourcePath, allowedRoots);
    const stat = fs.statSync(mutation.sourcePath);
    if (!stat.isFile()) {
      throw new FileMutationError(400, "Target is not a file");
    }
    if (mutation.baseMtimeMs !== null && stat.mtimeMs !== mutation.baseMtimeMs) {
      throw new FileMutationError(409, "File changed on disk since it was read");
    }
    fs.writeFileSync(mutation.sourcePath, mutation.content, "utf-8");
    const nextStat = fs.statSync(mutation.sourcePath);
    return { sourcePath: mutation.sourcePath, deleted: false, mtimeMs: nextStat.mtimeMs, size: nextStat.size };
  }

  if (mutation.type === "delete") {
    assertLexicallyAllowed(mutation.sourcePath, allowedRoots);
    // Canonically authorize the existing parent before lstat of the leaf, so
    // an allowed-root symlink escaping the root cannot be used to probe
    // outside-root existence (lstat follows intermediate symlinks).
    const sourceParent = resolverFor(mutation.sourcePath).dirname(mutation.sourcePath);
    assertExistingAllowed(sourceParent, allowedRoots);
    const sourceStat = fs.lstatSync(mutation.sourcePath);
    if (sourceStat.isSymbolicLink()) {
      // Direct symlink: delete the link itself, not its target. The parent
      // was canonically authorized above; the leaf is removed non-recursively.
    } else if (!isExistingFilePathAllowed(mutation.sourcePath, allowedRoots)) {
      throw new FileMutationError(403, "Access denied");
    }
    fs.rmSync(mutation.sourcePath, {
      recursive: sourceStat.isDirectory(),
      force: false,
    });
    return { sourcePath: mutation.sourcePath, deleted: true };
  }

  assertExistingAllowed(mutation.sourcePath, allowedRoots);
  const sourceResolver = resolverFor(mutation.sourcePath);
  const destinationDirectory = mutation.type === "rename"
    ? sourceResolver.dirname(mutation.sourcePath)
    : mutation.destinationDirectory;
  const name = mutation.type === "rename"
    ? mutation.name
    : sourceResolver.basename(mutation.sourcePath);

  assertName(name);
  assertDirectory(destinationDirectory, allowedRoots);
  const destinationPath = resolverFor(destinationDirectory).join(destinationDirectory, name);
  assertParentAllowed(destinationPath, allowedRoots);

  assertVacant(destinationPath, allowedRoots);

  if (fs.lstatSync(mutation.sourcePath).isDirectory()) {
    const canonicalSourcePath = fs.realpathSync(mutation.sourcePath);
    const canonicalDestinationDirectory = fs.realpathSync(destinationDirectory);
    const canonicalDestinationPath = resolverFor(
      canonicalDestinationDirectory,
      canonicalSourcePath,
    ).join(canonicalDestinationDirectory, name);
    if (isSameOrDescendant(canonicalDestinationPath, canonicalSourcePath)) {
      throw new FileMutationError(
        400,
        "A folder cannot be moved into itself or one of its subfolders",
      );
    }
  }

  fs.renameSync(mutation.sourcePath, destinationPath);
  return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function mutateFile(
  mutation: FileMutation,
  allowedRoots: Set<string>,
): FileMutationResult {
  try {
    return executeMutation(mutation, allowedRoots);
  } catch (error) {
    if (error instanceof FileMutationError) throw error;
    if (isFileSystemError(error) && error.code === "ENOENT") {
      throw new FileMutationError(404, "File or directory not found");
    }
    if (isFileSystemError(error) && error.code === "EEXIST") {
      throw new FileMutationError(409, "A file or directory with this name already exists");
    }
    if (isFileSystemError(error) && error.code === "ENOTDIR") {
      throw new FileMutationError(400, "Target is not a directory");
    }
    if (isFileSystemError(error) && error.code === "ENOTEMPTY") {
      throw new FileMutationError(409, "Directory is not empty");
    }
    throw error;
  }
}
