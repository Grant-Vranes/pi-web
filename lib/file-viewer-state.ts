export type FileViewerDisplayMode = "source" | "preview" | "diff";

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
  /**
   * In-progress editor text; null/absent when the viewer is not editing.
   * Persisted per file tab so switching tabs never loses unsaved edits.
   */
  draft?: string | null;
  /**
   * Disk mtime the draft was last known to be based on. Used for save
   * conflict detection (the server compares it against the current mtime).
   */
  baseMtimeMs?: number | null;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}

export function resolveInitialDraft(initialState?: FileViewerState): string | null {
  return typeof initialState?.draft === "string" ? initialState.draft : null;
}

export function resolveInitialBaseMtimeMs(initialState?: FileViewerState): number | null {
  return typeof initialState?.baseMtimeMs === "number" ? initialState.baseMtimeMs : null;
}
