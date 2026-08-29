"use client";

import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import { buildSearchTree, type SearchTreeNode } from "@/lib/search-tree";
import { useI18n } from "@/hooks/useI18n";
import { collectDroppedUploadEntries, type DroppedUploadEntry } from "@/lib/drop-collect";
import type { FileTabMutation } from "./file-tab-state";
type Translate = ReturnType<typeof useI18n>["t"];

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  fileSearchOpen?: boolean;
  onFileSearchOpenChange?: (open: boolean) => void;
  onFileMutation?: (mutation: FileTabMutation) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  entries: DroppedUploadEntry[];
  conflicts: string[];
  nonReplaceable: string[];
  targetDir: string;
}

const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const INTERNAL_FILE_DRAG_TYPE = "application/x-pi-web-file-path";
const INTERNAL_DIRECTORY_DRAG_TYPE = "application/x-pi-web-file-is-directory";

type ExplorerMutation = {
  type: "create-file" | "create-directory" | "rename" | "move" | "delete";
  target: FileNode;
};
type ExplorerMutationType = ExplorerMutation["type"];
type MutationResponse = { error?: string; sourcePath: string; destinationPath?: string; deleted: boolean };

function sameFilePath(left: string, right: string): boolean {
  return normalizeFilePathSlashes(left).replace(/\/+$/, "") === normalizeFilePathSlashes(right).replace(/\/+$/, "");
}

function isPathWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeFilePathSlashes(candidate).replace(/\/+$/, "");
  const normalizedParent = normalizeFilePathSlashes(parent).replace(/\/+$/, "");
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

async function requestFileMutation(
  targetPath: string,
  type: ExplorerMutationType,
  body: Record<string, string> = {},
): Promise<MutationResponse> {
  const response = await fetch(`/api/files/${encodeFilePathForApi(targetPath)}?type=${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as Partial<MutationResponse>;
  if (!response.ok || !data.sourcePath) {
    throw new Error(data.error ?? `File operation failed (HTTP ${response.status})`);
  }
  return data as MutationResponse;
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function uploadEntries(
  targetDirectory: string,
  entries: DroppedUploadEntry[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const entry of entries) {
      formData.append("files", entry.file, entry.relativePath);
    }

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  t,
  onFolderDrop,
  onContextMenu,
  onInternalFolderDrop,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken?: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  t: Translate;
  onFolderDrop?: (dirPath: string, event: React.DragEvent) => void;
  onContextMenu?: (node: FileNode, event: React.MouseEvent) => void;
  onInternalFolderDrop?: (target: FileNode, sourcePath: string, sourceIsDir: boolean) => void;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isDropOver, setIsDropOver] = useState(false);
  const folderDropCounterRef = useRef(0);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (refreshToken !== undefined && open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        draggable
        onClick={handleClick}
        onContextMenu={(event) => onContextMenu?.(node, event)}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-pi-web-file-path", node.fullPath);
          event.dataTransfer.setData(INTERNAL_DIRECTORY_DRAG_TYPE, String(node.isDir));
          event.dataTransfer.effectAllowed = "move";
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragEnter={node.isDir && (onFolderDrop || onInternalFolderDrop) ? (event) => {
          const isInternal = event.dataTransfer.types.includes(INTERNAL_FILE_DRAG_TYPE);
          const isUpload = !isInternal && Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === "file");
          if (!isInternal && !isUpload) return;
          event.preventDefault(); event.stopPropagation();
          folderDropCounterRef.current += 1; setIsDropOver(true);
        } : undefined}
        onDragOver={node.isDir && (onFolderDrop || onInternalFolderDrop) ? (event) => {
          const isInternal = event.dataTransfer.types.includes(INTERNAL_FILE_DRAG_TYPE);
          const isUpload = !isInternal && Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === "file");
          if (!isInternal && !isUpload) return;
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = isInternal ? "move" : "copy";
        } : undefined}
        onDragLeave={node.isDir && (onFolderDrop || onInternalFolderDrop) ? () => {
          folderDropCounterRef.current -= 1;
          if (folderDropCounterRef.current <= 0) { folderDropCounterRef.current = 0; setIsDropOver(false); }
        } : undefined}
        onDrop={node.isDir && (onFolderDrop || onInternalFolderDrop) ? (event) => {
          const sourcePath = event.dataTransfer.getData(INTERNAL_FILE_DRAG_TYPE);
          if (sourcePath) { event.preventDefault(); event.stopPropagation(); setIsDropOver(false); folderDropCounterRef.current = 0; onInternalFolderDrop?.(node, sourcePath, event.dataTransfer.getData(INTERNAL_DIRECTORY_DRAG_TYPE) === "true"); return; }
          if (!Array.from(event.dataTransfer.items ?? []).some((item) => item.kind === "file")) return;
          setIsDropOver(false); folderDropCounterRef.current = 0; onFolderDrop?.(node.fullPath, event);
        } : undefined}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: isDropOver ? "color-mix(in srgb, var(--accent) 14%, var(--bg-hover))" : hovered ? "var(--bg-hover)" : "transparent",
          outline: isDropOver ? "1px solid var(--accent)" : "none",
          outlineOffset: -1,
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title={t("files.insertPath")}
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            {t("files.mention")}
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title={t("files.download")}
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              t={t}
              onFolderDrop={onFolderDrop}
              onContextMenu={onContextMenu}
              onInternalFolderDrop={onInternalFolderDrop}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        height: 24,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {rel}
      </span>
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed,
  onChangesCountChange,
  fileSearchOpen = false,
  onFileSearchOpenChange,
  onFileMutation,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ target: FileNode; x: number; y: number; isRoot: boolean } | null>(null);
  const [pendingMutation, setPendingMutation] = useState<ExplorerMutation | null>(null);
  const [mutationName, setMutationName] = useState("");
  const [moveSource, setMoveSource] = useState<FileNode | null>(null);
  const [moveDirectory, setMoveDirectory] = useState(cwd);
  const [moveDirectories, setMoveDirectories] = useState<FileNode[]>([]);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const dropCounterRef = useRef(0);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";
  const hasSearchQuery = searchQuery.trim().length > 0;

  // Reuse the cached, bounded file index used by @ mentions.
  useEffect(() => {
    if (!fileSearchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchPaths([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(false);
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ matches?: FileIndexEntry[] }> : Promise.reject(new Error("Search failed")))
        .then((data) => setSearchPaths((data.matches ?? []).filter((entry) => !entry.isDir).map((entry) => entry.path)))
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchPaths([]);
            setSearchError(true);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, fileSearchOpen, searchQuery]);

  // Focus the search input whenever the search panel opens.
  useEffect(() => {
    if (fileSearchOpen) searchInputRef.current?.focus();
  }, [fileSearchOpen]);

  // Results render as a tree; keep every directory that contains a match
  // expanded, while preserving the user's manual collapses as they type.
  useEffect(() => {
    if (searchPaths.length === 0) return;
    const dirs = new Set<string>();
    for (const relative of searchPaths) {
      const parts = relative.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        dirs.add(joinFilePath(cwd, path));
      }
    }
    setSearchExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of dirs) {
        if (!next.has(dir)) { next.add(dir); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [cwd, searchPaths]);

  const searchRoots = useMemo(() => {
    const toFileNode = (node: SearchTreeNode): FileNode => ({
      name: node.name,
      fullPath: joinFilePath(cwd, node.path),
      isDir: node.isDir,
      size: 0,
      children: node.children.map(toFileNode),
      loaded: true,
    });
    return buildSearchTree(searchPaths).map(toFileNode);
  }, [cwd, searchPaths]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const openContextMenu = useCallback((target: FileNode, event: React.MouseEvent, isRoot = false) => {
    event.preventDefault();
    event.stopPropagation();
    setMutationError(null);
    setContextMenu({ target, x: event.clientX, y: event.clientY, isRoot });
  }, []);

  const finishMutation = useCallback((type: ExplorerMutationType, sourcePath: string, result: MutationResponse) => {
    if ((type === "rename" || type === "move") && result.destinationPath) onFileMutation?.({ kind: type === "rename" ? "rename" : "move", sourcePath, destinationPath: result.destinationPath });
    setTreeRefreshKey((key) => key + 1);
    setContextMenu(null); setPendingMutation(null); setMoveSource(null); setMutationError(null);
  }, [onFileMutation]);

  const executeMutation = useCallback(async (type: ExplorerMutationType, target: FileNode, body: Record<string, string> = {}) => {
    setMutationBusy(true); setMutationError(null);
    try {
      const result = await requestFileMutation(target.fullPath, type, body);
      if (type === "delete") onFileMutation?.({ kind: "delete", sourcePath: target.fullPath });
      finishMutation(type, target.fullPath, result);
    }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : t("files.operationFailed")); }
    finally { setMutationBusy(false); }
  }, [finishMutation, onFileMutation, t]);

  const openMovePicker = useCallback(async (source: FileNode) => {
    setContextMenu(null); setMutationError(null); setMoveSource(source); setMoveDirectory(cwd);
    try { setMoveDirectories((await fetchEntries(cwd)).filter((entry) => entry.isDir)); }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : t("files.operationFailed")); }
  }, [cwd, t]);

  const handleInternalFolderDrop = useCallback((target: FileNode, sourcePath: string, sourceIsDir: boolean) => {
    if (sameFilePath(target.fullPath, sourcePath) || (sourceIsDir && isPathWithin(target.fullPath, sourcePath))) return;
    const source: FileNode = { name: getFileName(sourcePath), fullPath: sourcePath, isDir: sourceIsDir, size: 0 };
    void executeMutation("move", source, { destinationDirectory: target.fullPath });
  }, [executeMutation]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => { if (!(event.target as Element).closest("[data-file-explorer-menu]")) setContextMenu(null); };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") setContextMenu(null); };
    document.addEventListener("pointerdown", close, true); document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", keydown, true); };
  }, [contextMenu]);

  const applyUploadResult = useCallback((data: UploadResponse, targetDir: string = cwd) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(targetDir, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUploadEntries = useCallback(async (
    entries: DroppedUploadEntry[],
    strategy: UploadConflictStrategy,
    targetDir: string = cwd,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadEntries(targetDir, entries, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          entries,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
          targetDir,
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data, targetDir);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUploadEntries = useCallback(async (entries: DroppedUploadEntry[], targetDir: string = cwd) => {
    if (entries.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);

    // Frontend size pre-check.
    const tooLarge: string[] = [];
    let total = 0;
    for (const entry of entries) {
      total += entry.file.size;
      if (entry.file.size > MAX_UPLOAD_FILE_BYTES) tooLarge.push(entry.relativePath);
    }
    if (tooLarge.length > 0 || total > MAX_UPLOAD_TOTAL_BYTES) {
      const offenders = tooLarge.length > 0 ? tooLarge : entries.map((e) => e.relativePath);
      setUploadError(t("files.tooLarge", { files: offenders.join(", ") }));
      return;
    }

    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(targetDir)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: entries.map((entry) => entry.relativePath) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          entries,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
          targetDir,
        });
        return;
      }

      await performUploadEntries(entries, "error", targetDir);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUploadEntries, uploadBusy, t]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    const entries: DroppedUploadEntry[] = files.map((file) => ({ file, relativePath: file.name }));
    void prepareUploadEntries(entries);
  }, [prepareUploadEntries]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  const acceptsUploadDrop = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer || dataTransfer.types.includes(INTERNAL_FILE_DRAG_TYPE)) return false;
    const items = Array.from(dataTransfer.items ?? []);
    return items.some((item) => item.kind === "file");
  }, []);

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
    dropCounterRef.current += 1;
    setIsDropTarget(true);
  }, [acceptsUploadDrop]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
  }, [acceptsUploadDrop]);

  const handleDragLeave = useCallback(() => {
    dropCounterRef.current -= 1;
    if (dropCounterRef.current <= 0) {
      dropCounterRef.current = 0;
      setIsDropTarget(false);
    }
  }, []);

  const handleDrop = useCallback(async (event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
    dropCounterRef.current = 0;
    setIsDropTarget(false);
    const { entries } = await collectDroppedUploadEntries(event.dataTransfer);
    void prepareUploadEntries(entries);
  }, [acceptsUploadDrop, prepareUploadEntries]);

  // Drop onto a specific folder node: upload into that folder instead of cwd.
  const handleFolderDrop = useCallback(async (dirPath: string, event: React.DragEvent) => {
    if (!acceptsUploadDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dropCounterRef.current = 0;
    setIsDropTarget(false);
    const { entries } = await collectDroppedUploadEntries(event.dataTransfer);
    void prepareUploadEntries(entries, dirPath);
  }, [acceptsUploadDrop, prepareUploadEntries]);

  const cwdName = useMemo(() => {
    const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
    return parts.filter(Boolean).pop() ?? cwd;
  }, [cwd]);

  return (
    <div
      style={{ minHeight: "100%", position: "relative" }}
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget) return;
        openContextMenu({ name: cwdName, fullPath: cwd, isDir: true, size: 0, loaded: true }, event, true);
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDropTarget && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            background: "color-mix(in srgb, var(--accent) 8%, transparent)",
            border: "2px dashed var(--border)",
            borderRadius: 6,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>
            {t("files.dropToUpload", { name: cwdName })}
          </span>
        </div>
      )}
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, zIndex: 5, background: "var(--bg-panel)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUploadEntries(pendingConflict.entries, "overwrite", pendingConflict.targetDir)} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUploadEntries(pendingConflict.entries, "skip", pendingConflict.targetDir)} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  {t("files.mention")}
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {fileSearchOpen && (
      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ position: "relative" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") onFileSearchOpenChange?.(false); }}
            placeholder={t("sidebar.searchFilesPlaceholder")}
            aria-label={t("sidebar.searchFiles")}
            style={{ width: "100%", boxSizing: "border-box", padding: "6px 24px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              title={t("sidebar.clearSearch")}
              aria-label={t("sidebar.clearSearch")}
              style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
        {hasSearchQuery && (
          <div style={{ paddingTop: 3 }}>
            {searchLoading && <div role="status" style={{ padding: "6px 2px", fontSize: 10, color: "var(--text-dim)" }}>{t("sidebar.searchingFiles")}</div>}
            {!searchLoading && searchError && <div role="alert" style={{ padding: "6px 2px", fontSize: 10, color: "#f87171" }}>{t("i18n.networkError")}</div>}
            {!searchLoading && !searchError && searchPaths.length === 0 && <div style={{ padding: "6px 2px", fontSize: 10, color: "var(--text-dim)" }}>{t("sidebar.noMatchingFiles")}</div>}
            {!searchLoading && !searchError && searchPaths.length > 0 && (
              <div>
                {searchRoots.map((node) => (
                  <TreeNode
                    key={`${searchQuery}:${node.fullPath}`}
                    node={node}
                    depth={0}
                    cwd={cwd}
                    onOpenFile={onOpenFile}
                    onAtMention={onAtMention}
                    expandedPaths={searchExpanded}
                    onToggleExpanded={(fullPath, open) => {
                      setSearchExpanded((prev) => {
                        const next = new Set(prev);
                        if (open) next.add(fullPath); else next.delete(fullPath);
                        return next;
                      });
                    }}
                    highlightedPaths={highlightedPaths}
                    gitStatusByPath={gitStatusByPath}
                    changedDirectoryPaths={changedDirectoryPaths}
                    t={t}
                    onFolderDrop={handleFolderDrop}
                    onContextMenu={openContextMenu}
                    onInternalFolderDrop={handleInternalFolderDrop}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {!changesCollapsed && gitFiles.length > 0 && (
        <div style={{ padding: "0 4px 2px" }}>
          <div
            aria-label={t("files.changeStats", {
              count: gitFiles.length,
              additions: gitLineStats.additions,
              deletions: gitLineStats.deletions,
            })}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 12 }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              {t("files.changedCount", { count: gitFiles.length })}
            </span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{gitLineStats.deletions}</span>
          </div>
          {gitFiles.map((status) => (
            <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
          ))}
        </div>
      )}

      {(changesCollapsed || gitFiles.length === 0) && (!fileSearchOpen || !hasSearchQuery) && (
        <div
          style={{ padding: "2px 4px" }}
          onContextMenu={(event) => openContextMenu({ name: cwdName, fullPath: cwd, isDir: true, size: 0, loaded: true }, event, true)}
        >
          {loading ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>Loading files...</div>
          ) : error ? (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>
          ) : (
            roots.map((node) => (
              <TreeNode
                key={node.fullPath}
                node={node}
                depth={0}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onAtMention={onAtMention}
                expandedPaths={expandedPaths}
                onToggleExpanded={handleToggleExpanded}
                refreshToken={refreshToken}
                highlightedPaths={highlightedPaths}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                t={t}
                onFolderDrop={handleFolderDrop}
                onContextMenu={openContextMenu}
                onInternalFolderDrop={handleInternalFolderDrop}
              />
            ))
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}
      {mutationError && (
        <div role="alert" style={{ padding: "6px 8px", color: "#f87171", fontSize: 11 }}>
          {mutationError}
          <DismissButton onClick={() => setMutationError(null)} title={t("files.dismissOperationError")} />
        </div>
      )}
      {contextMenu && (
        <div data-file-explorer-menu role="menu" style={{ position: "fixed", zIndex: 30, top: contextMenu.y, left: contextMenu.x, minWidth: 150, padding: 4, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", boxShadow: "0 8px 20px rgba(0,0,0,.2)" }}>
          {(["create-file", "create-directory"] as const).map((type) => (contextMenu.target.isDir && (
            <button key={type} type="button" role="menuitem" onClick={() => { setPendingMutation({ type, target: contextMenu.target }); setMutationName(""); setContextMenu(null); }} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t(type === "create-file" ? "files.newFile" : "files.newFolder")}</button>
          )))}
          {!contextMenu.isRoot && <>
            <button type="button" role="menuitem" onClick={() => { setPendingMutation({ type: "rename", target: contextMenu.target }); setMutationName(contextMenu.target.name); setContextMenu(null); }} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t("files.rename")}</button>
            <button type="button" role="menuitem" onClick={() => void openMovePicker(contextMenu.target)} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t("files.moveTo")}</button>
            <button type="button" role="menuitem" onClick={() => { const target = contextMenu.target; if (window.confirm(t("files.confirmDelete", { name: target.name }))) void executeMutation("delete", target); }} style={{ display: "block", width: "100%", padding: "6px 8px", border: 0, background: "none", color: "#f87171", textAlign: "left", cursor: "pointer", fontSize: 12 }}>{t("files.delete")}</button>
          </>}
        </div>
      )}
      {pendingMutation && (
        <div role="dialog" aria-modal="true" aria-label={pendingMutation.type === "rename" ? t("files.rename") : t("files.create")} style={{ position: "fixed", inset: 0, zIndex: 31, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)" }}>
          <form onSubmit={(event) => { event.preventDefault(); const type = pendingMutation.type; const target = type === "rename" ? pendingMutation.target : { ...pendingMutation.target, fullPath: pendingMutation.target.fullPath }; void executeMutation(type, target, { name: mutationName }); }} style={{ width: 320, padding: 16, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)" }}>
            <label style={{ display: "block", marginBottom: 8, color: "var(--text)", fontSize: 13 }}>{t("files.fileName")}</label>
            <input autoFocus value={mutationName} onChange={(event) => setMutationName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setPendingMutation(null); }} style={{ width: "100%", boxSizing: "border-box", padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}><button type="button" onClick={() => setPendingMutation(null)} disabled={mutationBusy}>{t("i18n.cancel")}</button><button type="submit" disabled={mutationBusy || !mutationName.trim()}>{pendingMutation.type === "rename" ? t("files.rename") : t("files.create")}</button></div>
          </form>
        </div>
      )}
      {moveSource && (
        <div role="dialog" aria-modal="true" aria-label={t("files.selectDestination")} style={{ position: "fixed", inset: 0, zIndex: 31, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)" }}>
          <div style={{ width: 360, maxHeight: "70dvh", overflow: "auto", padding: 16, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)" }}>
            <div style={{ marginBottom: 8, color: "var(--text)", fontSize: 13 }}>{t("files.selectDestination")}</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <button type="button" onClick={() => { setMoveDirectory(cwd); void fetchEntries(cwd).then((entries) => setMoveDirectories(entries.filter((entry) => entry.isDir))); }} style={{ flex: 1, padding: 6, border: 0, background: moveDirectory === cwd ? "var(--bg-hover)" : "none", color: "var(--text)", textAlign: "left" }}>{cwdName}</button>
              <button type="button" disabled={sameFilePath(moveDirectory, cwd)} onClick={() => { const parent = getFileDirectory(moveDirectory); if (!isPathWithin(parent, cwd)) return; setMoveDirectory(parent); void fetchEntries(parent).then((entries) => setMoveDirectories(entries.filter((entry) => entry.isDir))); }} aria-label={t("directoryPicker.goToParent")} style={{ padding: "6px 8px" }}>↑</button>
            </div>
            {moveDirectories.map((directory) => <button key={directory.fullPath} type="button" disabled={moveSource.isDir && isPathWithin(directory.fullPath, moveSource.fullPath)} onClick={() => { setMoveDirectory(directory.fullPath); void fetchEntries(directory.fullPath).then((entries) => setMoveDirectories(entries.filter((entry) => entry.isDir))); }} style={{ display: "block", width: "100%", padding: 6, border: 0, background: "none", color: "var(--text)", textAlign: "left" }}>{directory.name}</button>)}
            {moveSource.isDir && isPathWithin(moveDirectory, moveSource.fullPath) && <div style={{ color: "#f87171", fontSize: 11 }}>{t("files.invalidMoveTarget")}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}><button type="button" onClick={() => setMoveSource(null)} disabled={mutationBusy}>{t("i18n.cancel")}</button><button type="button" disabled={mutationBusy || sameFilePath(moveDirectory, getFileDirectory(moveSource.fullPath)) || (moveSource.isDir && isPathWithin(moveDirectory, moveSource.fullPath))} onClick={() => { const source = moveSource; const destinationDirectory = moveDirectory; if (source.isDir && isPathWithin(destinationDirectory, source.fullPath)) return; void executeMutation("move", source, { destinationDirectory }); }}>{t("files.moveHere")}</button></div>
          </div>
        </div>
      )}
    </div>
  );
});
