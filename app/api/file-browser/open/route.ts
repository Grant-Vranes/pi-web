import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import { dirname } from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { toNativePath } from "@/lib/paths";
import { isApiRequestAllowed } from "@/lib/request-security";

/** Same access gate as /api/files and /api/terminal/open: only session cwds /
 *  project roots / explicitly allowed paths may be opened. */
async function checkPathAllowed(targetPath: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(targetPath, allowedRoots) || !isExistingFilePathAllowed(targetPath, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

interface SpawnResult {
  ok: boolean;
  error?: string;
}

/**
 * Spawn a detached process that opens `targetPath` in the OS file browser.
 * Files are revealed with the parent folder shown and the file selected
 * (darwin `open -R`, win32 `explorer /select,`); on Linux, where no reveal
 * convention exists, the containing directory is opened instead. Directories
 * are opened in place on every platform.
 */
function openInFileBrowser(targetPath: string, isDirectory: boolean): Promise<SpawnResult> {
  return new Promise((resolve) => {
    try {
      const nativePath = toNativePath(targetPath);
      let command: string;
      let args: string[];
      if (process.platform === "darwin") {
        // `open -R` reveals the file selected in Finder; directories open in place.
        command = "open";
        args = isDirectory ? [nativePath] : ["-R", nativePath];
      } else if (process.platform === "win32") {
        command = "explorer";
        // No space after "/select,"; backslash separators are required.
        args = isDirectory ? [nativePath] : [`/select,${nativePath}`];
      } else {
        // Linux: no reveal convention — xdg-open the containing directory
        // for files, the directory itself for directories.
        command = "xdg-open";
        args = [isDirectory ? nativePath : dirname(nativePath)];
      }

      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      // Detach so the file browser outlives the server process; unref so the
      // server can exit without waiting on it. The window itself is async —
      // a successful spawn with no early error is the best we can verify.
      child.unref();
      setTimeout(() => resolve({ ok: true }), 250);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// POST /api/file-browser/open  body: { path }  →  { ok }
//
// Opens the OS native file browser at `path`: directories open in place,
// files are revealed (containing folder shown, file selected). The path must
// exist and pass the same allowed-roots gate as /api/files and
// /api/terminal/open.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({})) as { path?: string };
    const targetPath = body.path;
    if (!targetPath || typeof targetPath !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    if (!existsSync(targetPath)) {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }
    const denied = await checkPathAllowed(targetPath);
    if (denied) return denied;

    let isDirectory: boolean;
    try {
      isDirectory = statSync(targetPath).isDirectory();
    } catch {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }

    const result = await openInFileBrowser(targetPath, isDirectory);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed to open file browser" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
