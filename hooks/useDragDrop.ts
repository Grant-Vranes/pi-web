"use client";

import { useState, useCallback, useRef } from "react";
import { buildDropPayload, type DropPayload } from "@/lib/dropped-paths";

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

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}