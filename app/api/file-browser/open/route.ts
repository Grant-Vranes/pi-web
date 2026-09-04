import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { buildFileBrowserCommand } from "@/lib/file-browser-commands";
import { toNativePath } from "@/lib/paths";
import { isApiRequestAllowed } from "@/lib/request-security";

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
      const { command, args } = buildFileBrowserCommand(process.platform, nativePath, isDirectory);

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
// pass the allowed-roots gate (lexical check before any filesystem access,
// then a realpath check) before it is opened.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null) as { path?: string } | null;
    const targetPath = body?.path;
    if (!targetPath || typeof targetPath !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    // Lexical allowed-roots check BEFORE any filesystem access, so the
    // 400 "Path does not exist" answer cannot be used to probe which paths
    // exist outside the boundary.
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(targetPath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!existsSync(targetPath)) {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }
    // Realpath-aware containment: reject symlink escapes. Runs after the
    // existence check because realpath requires an existing path.
    if (!isExistingFilePathAllowed(targetPath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

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
