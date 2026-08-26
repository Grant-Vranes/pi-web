"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Chat message font scale.
 *
 * Drives a single CSS variable `--chat-font-scale` on :root that the message
 * area (markdown body + user bubble text) consumes via `calc(<px> * var(...))`.
 * The value persists in localStorage so it survives refresh and applies to
 * every session.
 *
 * Controls:
 *   - adjust(delta)  — step the scale by `delta` (e.g. +0.1 / -0.1)
 *   - reset()        — back to 1
 *   - setScale(v)    — absolute set, clamped
 *
 * Keyboard shortcuts (registered globally, ignored while typing in inputs):
 *   Mod + "+" / "="  — increase
 *   Mod + "-"        — decrease
 *   Mod + "0"        — reset
 * (`Mod` = Cmd on macOS, Ctrl elsewhere)
 */

const STORAGE_KEY = "pi-web:chat-font-scale";
const CSS_VAR = "--chat-font-scale";

export const CHAT_FONT_SCALE_MIN = 0.1;
export const CHAT_FONT_SCALE_MAX = 10;
export const CHAT_FONT_SCALE_STEP = 0.1;
// Round to this many decimals to avoid float drift like 1.0000000000000002.
const ROUND = 100;

export function clampChatFontScale(v: number): number {
  // No upper limit per user request. Lower bound is a small positive value so
  // text never disappears entirely (calc(14px * 0) would render nothing).
  if (!Number.isFinite(v) || v <= 0) return CHAT_FONT_SCALE_MIN;
  const clamped = Math.max(CHAT_FONT_SCALE_MIN, v);
  return Math.round(clamped * ROUND) / ROUND;
}

function readStored(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return 1;
    const v = Number(raw);
    if (!Number.isFinite(v)) return 1;
    return clampChatFontScale(v);
  } catch {
    return 1;
  }
}

function writeStored(v: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* ignore quota / privacy mode */
  }
}

function applyCssVar(v: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(CSS_VAR, String(v));
}

export interface UseChatFontScale {
  scale: number;
  adjust: (delta: number) => void;
  setScale: (v: number) => void;
  reset: () => void;
}

export function useChatFontScale(): UseChatFontScale {
  const [scale, setScaleState] = useState<number>(() => readStored());

  // Apply on mount + whenever it changes; also re-sync if another tab changed it.
  useEffect(() => {
    applyCssVar(scale);
    writeStored(scale);
  }, [scale]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setScaleState(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setScale = useCallback((v: number) => {
    setScaleState(clampChatFontScale(v));
  }, []);

  const adjust = useCallback((delta: number) => {
    setScaleState((prev) => clampChatFontScale(prev + delta));
  }, []);

  const reset = useCallback(() => setScaleState(1), []);

  // Global keyboard shortcuts: Mod + +/-/0
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Don't hijack browser zoom when the user is editing text.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key;
      if (k === "+" || k === "=") {
        e.preventDefault();
        adjust(CHAT_FONT_SCALE_STEP);
      } else if (k === "-" || k === "_") {
        e.preventDefault();
        adjust(-CHAT_FONT_SCALE_STEP);
      } else if (k === "0") {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [adjust, reset]);

  return { scale, adjust, setScale, reset };
}
