"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { getFileApiUrl } from "@/lib/file-api";
import {
  buildMergedScene,
  fetchSceneText,
  stripViewportState,
  type BinaryFiles,
  type ExcalidrawAppState,
  type ExcalidrawElement,
} from "@/lib/excalidraw-scene";
// Static side-effect import: Turbopack cannot dynamically import() CSS. This
// module itself is lazy-loaded via next/dynamic from FileViewer, so the
// stylesheet still only loads when an .excalidraw file is opened.
import "@excalidraw/excalidraw/index.css";

interface SceneData {
  elements: ExcalidrawElement[];
  appState: ExcalidrawAppState;
  files: BinaryFiles;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LoadingPlaceholder() {
  const { t } = useI18n();
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
      {t("i18n.loading")}
    </div>
  );
}

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => ({ default: mod.Excalidraw })),
  { ssr: false, loading: () => <LoadingPlaceholder /> },
);

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  watchEnabled?: boolean;
  /** Called when the file cannot be parsed as an Excalidraw scene. */
  onFallbackToText: () => void;
}

type MetaResponse = {
  size?: number;
  error?: string;
};

type WriteResponse = {
  mtimeMs?: number;
  size?: number;
  error?: string;
};

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "4px 16px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  color: "var(--text-dim)",
  background: "var(--bg)",
  flexShrink: 0,
};

const ICON_BUTTON_STYLE: CSSProperties = {
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
};

export default function ExcalidrawViewer({
  filePath,
  cwd,
  sourceSessionId,
  watchEnabled = true,
  onFallbackToText,
}: Props) {
  const { t } = useI18n();
  const { isDark } = useTheme();

  const [scene, setScene] = useState<SceneData | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [watching, setWatching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const originalJsonRef = useRef<Record<string, unknown> | null>(null);
  const baseMtimeMsRef = useRef(0);
  const elementsRef = useRef<ExcalidrawElement[] | null>(null);
  const appStateRef = useRef<ExcalidrawAppState | null>(null);
  const filesRef = useRef<BinaryFiles | null>(null);
  const sceneRequestRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // The excalidrawAPI callback fires from the internal App class constructor,
  // i.e. during render — before React commits the mount. Calling
  // scrollToContent there (even a frame later) can hit "setState on a
  // component that is not yet mounted", so stash the api in state and fit the
  // viewport from the effect below, which only runs after commit. Saved scenes
  // can carry stale scroll/zoom state that leaves the content off-screen.
  const handleExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawApi(api);
  }, []);

  useEffect(() => {
    if (!excalidrawApi) return;
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (!cancelled) {
        excalidrawApi.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.8 });
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [excalidrawApi]);

  const loadScene = useCallback(async () => {
    const requestId = ++sceneRequestRef.current;
    try {
      const { text, mtimeMs, size: readSize } = await fetchSceneText(fetch, (offset) => (
        getFileApiUrl(filePath, "read", sourceSessionId, { offset })
      ));
      if (requestId !== sceneRequestRef.current) return;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(t("i18n.invalidExcalidrawScene"));
      }
      if (!Array.isArray(parsed.elements)) throw new Error(t("i18n.invalidExcalidrawScene"));

      originalJsonRef.current = parsed;
      baseMtimeMsRef.current = mtimeMs;
      setSize(readSize);
      setScene({
        elements: parsed.elements as ExcalidrawElement[],
        appState: (parsed.appState ?? {}) as ExcalidrawAppState,
        files: (parsed.files ?? {}) as BinaryFiles,
      });
      elementsRef.current = null;
      appStateRef.current = null;
      filesRef.current = null;
      setDirty(false);
      setError(null);
      setSaveConflict(false);
      setSaveError(null);
      setReloadKey((k) => k + 1);
    } catch (loadError) {
      if (requestId === sceneRequestRef.current) {
        setScene(null);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
  }, [filePath, sourceSessionId, t]);

  useEffect(() => {
    setScene(null);
    setSize(null);
    baseMtimeMsRef.current = 0;
    setMode("view");
    setError(null);
    void loadScene();
  }, [filePath, sourceSessionId, loadScene]);

  // Live watch: identical pattern to ImageViewer. While editing, an external
  // change must not clobber the canvas; only the size display refreshes.
  useEffect(() => {
    setWatching(false);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (!watchEnabled) return;

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", () => {
      if (modeRef.current === "view") {
        void loadScene();
      } else {
        fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
          .then((r) => r.json())
          .then((d: MetaResponse) => {
            if (typeof d.size === "number") setSize(d.size);
          })
          .catch(() => { /* ignore */ });
      }
    });
    const markDisconnected = () => setWatching(false);
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled, loadScene]);

  const enterEdit = useCallback(() => {
    if (!scene) return;
    sceneRequestRef.current += 1;
    setSaveConflict(false);
    setSaveError(null);
    setMode("edit");
  }, [scene]);

  const exitEdit = useCallback(() => {
    if (dirty && !window.confirm(t("i18n.confirmDiscard"))) return;
    setSaveConflict(false);
    setSaveError(null);
    setMode("view");
    setDirty(false);
    void loadScene();
  }, [dirty, loadScene, t]);

  const saveScene = useCallback(async (options: { force?: boolean } = {}) => {
    if (saving || !scene) return;
    setSaving(true);
    setSaveError(null);
    try {
      const original = originalJsonRef.current ?? {};
      const merged = buildMergedScene(
        original,
        elementsRef.current ?? scene.elements,
        appStateRef.current ?? scene.appState,
        filesRef.current ?? scene.files,
      );
      const response = await fetch(getFileApiUrl(filePath, "write", sourceSessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: JSON.stringify(merged, null, 2),
          baseMtimeMs: options.force ? null : baseMtimeMsRef.current,
        }),
      });
      if (response.status === 409) {
        setSaveConflict(true);
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as WriteResponse | null;
        setSaveConflict(false);
        setSaveError(payload?.error ?? t("i18n.saveFailed"));
        return;
      }
      const result = await response.json() as WriteResponse;
      baseMtimeMsRef.current = result.mtimeMs ?? baseMtimeMsRef.current;
      if (typeof result.size === "number") setSize(result.size);
      originalJsonRef.current = merged;
      setScene({
        elements: merged.elements as ExcalidrawElement[],
        appState: merged.appState as ExcalidrawAppState,
        files: merged.files as BinaryFiles,
      });
      setSaveConflict(false);
      setDirty(false);
    } catch (e) {
      setSaveConflict(false);
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [filePath, saving, scene, sourceSessionId, t]);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={HEADER_STYLE}>
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "excalidraw"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        {mode === "view" ? (
          <button type="button" style={ICON_BUTTON_STYLE} disabled={!scene} onClick={enterEdit}>
            {t("i18n.editFile")}
          </button>
        ) : (
          <>
            {dirty && <span style={{ color: "#fbbf24" }}>{t("i18n.unsavedChanges")}</span>}
            <button
              type="button"
              style={ICON_BUTTON_STYLE}
              disabled={saving || (!dirty && !saveConflict)}
              onClick={() => void saveScene()}
            >
              {saving ? t("i18n.saving") : t("i18n.save")}
            </button>
            <button type="button" style={ICON_BUTTON_STYLE} onClick={exitEdit}>
              {t("i18n.doneEditing")}
            </button>
          </>
        )}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {error ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              color: "#f87171",
              fontSize: 13,
            }}
          >
            <span>{error}</span>
            <button type="button" style={ICON_BUTTON_STYLE} onClick={() => onFallbackToText()}>
              {t("i18n.openAsText")}
            </button>
          </div>
        ) : saveConflict ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              fontSize: 13,
            }}
          >
            <span>{t("i18n.fileChangedOnDisk")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={ICON_BUTTON_STYLE} onClick={() => void saveScene({ force: true })}>
                {t("i18n.overwrite")}
              </button>
              <button
                type="button"
                style={ICON_BUTTON_STYLE}
                onClick={() => {
                  setSaveConflict(false);
                  setMode("view");
                  void loadScene();
                }}
              >
                {t("i18n.cancel")}
              </button>
            </div>
          </div>
        ) : null}
        {!scene && !error && !saveConflict && <LoadingPlaceholder />}
        {saveError && !error && !saveConflict && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 16,
              right: 16,
              zIndex: 2,
              padding: "8px 12px",
              border: "1px solid rgba(248,113,113,0.45)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              color: "#f87171",
              fontSize: 12,
              boxShadow: "0 2px 8px rgba(0,0,0,0.16)",
            }}
          >
            {saveError}
          </div>
        )}
        {scene && !error && !saveConflict && (
          <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
            <Excalidraw
              key={`${filePath}-${reloadKey}`}
              initialData={{
                elements: scene.elements,
                appState: stripViewportState(scene.appState),
                files: scene.files,
              } as unknown as NonNullable<ComponentProps<typeof Excalidraw>["initialData"]>}
              excalidrawAPI={handleExcalidrawApi}
              viewModeEnabled={mode === "view"}
              theme={isDark ? "dark" : "light"}
              onChange={(elements, appState, files) => {
                elementsRef.current = elements as unknown as ExcalidrawElement[];
                appStateRef.current = appState as unknown as ExcalidrawAppState;
                filesRef.current = files as unknown as BinaryFiles;
                if (mode === "edit") setDirty(true);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
