import type { FileViewerState } from "@/lib/file-viewer-state";
import { getFileName, sameFilePath } from "../lib/file-paths";
import type { Tab } from "./TabBar";

export type FileTabMutation =
  | { kind: "rename" | "move"; sourcePath: string; destinationPath: string }
  | { kind: "delete"; sourcePath: string };

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

export function applyFileTabMutation(tabs: Tab[], mutation: FileTabMutation): Tab[] {
  const index = tabs.findIndex((tab) => sameFilePath(tab.filePath, mutation.sourcePath));
  if (index === -1) return tabs;

  if (mutation.kind === "delete") {
    return tabs.filter((_, tabIndex) => tabIndex !== index);
  }

  const next = [...tabs];
  next[index] = {
    ...next[index],
    id: `file:${mutation.destinationPath}`,
    filePath: mutation.destinationPath,
    label: getFileName(mutation.destinationPath),
  };
  return next;
}

export function getNextActiveFileTabId(
  tabsBefore: Tab[],
  activeTabId: string | null,
  mutation: FileTabMutation,
): string | null {
  const nextTabs = applyFileTabMutation(tabsBefore, mutation);
  if (activeTabId === null) return null;

  const activeTab = tabsBefore.find((tab) => tab.id === activeTabId);
  if (activeTab && sameFilePath(activeTab.filePath, mutation.sourcePath)) {
    if (mutation.kind !== "delete") return `file:${mutation.destinationPath}`;
    return nextTabs.at(-1)?.id ?? null;
  }

  return nextTabs.some((tab) => tab.id === activeTabId) ? activeTabId : nextTabs.at(-1)?.id ?? null;
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}
