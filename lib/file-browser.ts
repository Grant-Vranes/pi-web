/** Result of asking the server to open a path in the OS file browser. */
export interface OpenInFileBrowserResult {
  ok: boolean;
  error?: string;
}

/**
 * Ask the Pi Web server to open `path` in the operating system's native file
 * browser (Finder / Explorer / xdg-open). Files are revealed with their
 * containing folder shown and the file selected; directories open in place.
 * Never throws — callers surface `error` themselves.
 */
export async function openInFileBrowser(path: string): Promise<OpenInFileBrowserResult> {
  try {
    const response = await fetch("/api/file-browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error ?? `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
