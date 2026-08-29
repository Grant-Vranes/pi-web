export interface DroppedPath {
  path: string;
  isDirectory: boolean;
}

export interface DropPayload {
  imageFiles: File[];
  pathMentions: string;
  hasNonImageFiles: boolean;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function formatPathMention({ path, isDirectory }: DroppedPath): string {
  const normalized = isDirectory && !path.endsWith("/") ? `${path}/` : path;
  const escaped = normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `@"${escaped}" `;
}

function fileUrls(uriList: string): string[] {
  return uriList.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}

function pathFromFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    if (!path) return null;
    return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

function uniquePaths(paths: DroppedPath[]): DroppedPath[] {
  const seen = new Set<string>();
  return paths.filter((entry) => {
    const normalized = entry.isDirectory && !entry.path.endsWith("/")
      ? `${entry.path}/`
      : entry.path;
    const key = `${entry.isDirectory ? "directory" : "file"}:${normalized}`;
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Build a non-image payload from Tauri's native drag-drop absolute paths. */
export function buildNativePathDropPayload(paths: string[]): DropPayload {
  return {
    imageFiles: [],
    hasNonImageFiles: paths.length > 0,
    pathMentions: uniquePaths(paths.map((path) => ({ path, isDirectory: false }))).map(formatPathMention).join(""),
  };
}

export function buildDropPayload(dataTransfer: DataTransfer): DropPayload {
  const files = Array.from(dataTransfer.files);
  const imageFiles = files.filter(isImageFile);
  const nonImageFiles = files.filter((file) => !isImageFile(file));
  const hasNonImageFiles = nonImageFiles.length > 0;
  const paths: DroppedPath[] = [];

  // Browser File objects deliberately do not expose local filesystem paths.
  // Tauri native drops are handled in useDragDrop via WebviewWindow events;
  // browser drops can still provide a file:// URI list below.

  if (paths.length === 0 && hasNonImageFiles) {
    for (const value of fileUrls(dataTransfer.getData("text/uri-list"))) {
      const path = pathFromFileUrl(value);
      if (path) paths.push({ path, isDirectory: false });
    }
  }

  return {
    imageFiles,
    hasNonImageFiles,
    pathMentions: uniquePaths(paths).map(formatPathMention).join(""),
  };
}
