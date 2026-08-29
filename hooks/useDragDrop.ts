"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriDesktop } from "@/lib/desktop-bridge";
import { buildDropPayload, buildNativePathDropPayload, type DropPayload } from "@/lib/dropped-paths";

export function useDragDrop(onDrop: (payload: DropPayload) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  const acceptsDrop = useCallback((dataTransfer: DataTransfer) => {
    const payload = buildDropPayload(dataTransfer);
    return payload.imageFiles.length > 0 || payload.hasNonImageFiles;
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, [acceptsDrop]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!acceptsDrop(e.dataTransfer)) return;
    e.preventDefault();
  }, [acceptsDrop]);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    const payload = buildDropPayload(e.dataTransfer);
    if (payload.imageFiles.length === 0 && !payload.hasNonImageFiles) return;
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    onDrop(payload);
  }, [onDrop]);

  // WebView drag events carry absolute filesystem paths directly. Electron
  // previously exposed the same information through webUtils.getPathForFile.
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "enter") {
        setIsDragOver(true);
      } else if (event.payload.type === "leave") {
        setIsDragOver(false);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        const payload = buildNativePathDropPayload(event.payload.paths);
        if (payload.hasNonImageFiles) onDrop(payload);
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}