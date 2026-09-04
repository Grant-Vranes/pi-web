import { dirname } from "path";

/** Argv for opening a path in the OS file browser. */
export interface FileBrowserCommand {
  command: string;
  args: string[];
}

/**
 * Build the argv that opens `nativePath` in the OS file browser. Files are
 * revealed with the parent folder shown and the file selected (darwin
 * `open -R`, win32 `explorer /select,`); on Linux, where no reveal
 * convention exists, the containing directory is opened instead.
 * Directories are opened in place on every platform.
 */
export function buildFileBrowserCommand(
  platform: NodeJS.Platform,
  nativePath: string,
  isDirectory: boolean,
): FileBrowserCommand {
  if (platform === "darwin") {
    // `open -R` reveals the file selected in Finder; directories open in place.
    return { command: "open", args: isDirectory ? [nativePath] : ["-R", nativePath] };
  }
  if (platform === "win32") {
    // No space after "/select,"; backslash separators are required.
    return { command: "explorer", args: isDirectory ? [nativePath] : [`/select,${nativePath}`] };
  }
  // Linux: no reveal convention — xdg-open the containing directory
  // for files, the directory itself for directories.
  return { command: "xdg-open", args: [isDirectory ? nativePath : dirname(nativePath)] };
}
