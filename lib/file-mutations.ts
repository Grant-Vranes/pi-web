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
  | { type: "delete"; sourcePath: string };

export type FileMutationResult = {
  sourcePath: string;
  destinationPath?: string;
  deleted: boolean;
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

function assertLexicallyAllowed(target: string, allowedRoots: Set<string>): void {
  if (!isFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertExistingAllowed(target: string, allowedRoots: Set<string>): void {
  // Authorize before observing the filesystem so outside-root paths cannot be
  // used as an existence oracle.
  assertLexicallyAllowed(target, allowedRoots);
  if (!pathEntryExists(target)) {
    throw new FileMutationError(404, "File or directory not found");
  }
  if (!isExistingFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertParentAllowed(target: string, allowedRoots: Set<string>): void {
  const parent = resolverFor(target).dirname(target);
  assertLexicallyAllowed(target, allowedRoots);
  assertLexicallyAllowed(parent, allowedRoots);
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

  if (mutation.type === "delete") {
    assertLexicallyAllowed(mutation.sourcePath, allowedRoots);
    const sourceStat = fs.lstatSync(mutation.sourcePath);
    if (sourceStat.isSymbolicLink()) {
      const sourceParent = resolverFor(mutation.sourcePath).dirname(mutation.sourcePath);
      assertExistingAllowed(sourceParent, allowedRoots);
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
