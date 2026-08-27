import fs from "fs";
import path from "path";
import { isPathWithinRoots } from "./path-security";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("\\")) {
      return `File names must not contain backslashes: ${fileName}`;
    }
    if (fileName.startsWith("/")) {
      return `File names must not be absolute paths: ${fileName}`;
    }
    if (/^[A-Za-z]:[\\/]/.test(fileName)) {
      return `File names must not be absolute paths: ${fileName}`;
    }
    const segments = fileName.split("/");
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === "..") {
        return `File names must not contain a path: ${fileName}`;
      }
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

export interface UploadFileInput {
  name: string;
  bytes: Buffer;
}

export interface UploadWriteResult {
  uploaded: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

function ensureUploadParentIsContained(
  destination: string,
  realRoots: Set<string>,
): string | null {
  try {
    const realDestination = fs.realpathSync(destination);
    if (!isPathWithinRoots(realDestination, realRoots)) return "path escapes upload directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const parentDir = path.dirname(destination);
  let existingAncestor = parentDir;
  while (true) {
    try {
      const realAncestor = fs.realpathSync(existingAncestor);
      if (!isPathWithinRoots(realAncestor, realRoots)) return "path escapes upload directory";
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return error instanceof Error ? error.message : String(error);
      }
      const nextAncestor = path.dirname(existingAncestor);
      if (nextAncestor === existingAncestor) return "path escapes upload directory";
      existingAncestor = nextAncestor;
    }
  }

  try {
    fs.mkdirSync(parentDir, { recursive: true });
    const realParent = fs.realpathSync(parentDir);
    if (!isPathWithinRoots(realParent, realRoots)) return "path escapes upload directory";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return null;
}

export function writeUploadFiles(
  directory: string,
  files: UploadFileInput[],
  inspection: UploadTargetInspection,
  strategy: UploadConflictStrategy,
): UploadWriteResult {
  const conflictSet = new Set(inspection.conflicts);
  const nonReplaceableSet = new Set(inspection.nonReplaceable);
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  const realRoot = fs.realpathSync(directory);
  const realRoots = new Set([realRoot]);

  for (const file of files) {
    const destination = path.join(directory, file.name);
    const isConflict = conflictSet.has(file.name);
    const isNonReplaceable = nonReplaceableSet.has(file.name);

    if (isConflict && strategy === "skip") {
      skipped.push(file.name);
      continue;
    }

    // The route returns conflict-strategy "error" requests as 409 before
    // writing. Keep the helper safe if a conflicting target appears anyway.
    if (isConflict && strategy === "error") {
      errors.push({ name: file.name, error: "Cannot replace an existing file, directory, or symbolic link" });
      continue;
    }

    const containmentError = ensureUploadParentIsContained(destination, realRoots);
    if (containmentError) {
      errors.push({ name: file.name, error: containmentError });
      continue;
    }

    // Replaceable file conflict: unlink before write (overwrite only).
    // Directories and symbolic links are never unlinked; an in-place write
    // will fail safely without deleting the existing target.
    if (isConflict && !isNonReplaceable) {
      try {
        fs.unlinkSync(destination);
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    try {
      fs.writeFileSync(destination, file.bytes, { flag: "wx" });
      uploaded.push(file.name);
    } catch (error) {
      errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { uploaded, skipped, errors };
}
