import { NextResponse } from "next/server";
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { resolveProject } from "@/lib/worktree";

/** Same access gate as /api/files and /api/worktrees: only session cwds /
 *  project roots / explicitly allowed dirs may be opened. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

/**
 * Build the shell command that cd's into `cwd`, checks out `branch` (when
 * the cwd is not already on that branch), and finally `exec`s an interactive
 * shell so the terminal window stays open. The command is a POSIX sh
 * fragment that works in bash/zsh/dash.
 *
 * On Windows we use a separate PowerShell-native builder.
 */
function buildShellCommand(cwd: string, branch: string | null): string {
  // `cd` then, if a branch is given, switch to it only when the current
  // branch differs. `git checkout` is used (not switch) for broad git version
  // compatibility; detached HEAD and uncommitted changes are left to git to
  // report. The branch name is quoted; branch names cannot contain single
  // quotes themselves, so single-quote wrapping is safe.
  const cdPart = `cd ${shellQuote(cwd)}`;
  const checkout = branch
    ? `git checkout ${shellQuote(branch)} 2>/dev/null || true`
    : null;
  // Without `exec` into an interactive shell, `sh -c "..."` exits as soon
  // as the commands finish and the terminal window closes instantly — the
  // user would see nothing. `$SHELL` honors the user's login shell; fall
  // back to bash, then sh.
  const interactive = `exec ${shellQuote(process.env.SHELL || "bash")}`;
  return [cdPart, checkout, interactive].filter(Boolean).join(" && ");
}

/** Single-quote a path/branch for POSIX shells, escaping any embedded quotes. */
function shellQuote(value: string): string {
  // POSIX: wrap in single quotes, escape embedded single quotes as '\''.
  // This is also accepted by PowerShell (which treats ' as a literal string).
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a path for PowerShell using double quotes, escaping embedded quotes. */
function powershellDqQuote(value: string): string {
  return `"${value.replace(/"/g, '`"')}"`;
}

/** Build a PowerShell-native command string (used for Windows Terminal). */
function buildPowerShellCommand(cwd: string, branch: string | null): string {
  const cdPart = `Set-Location -LiteralPath ${powershellDqQuote(cwd)}`;
  if (!branch) return cdPart;
  // Silently no-op when already on the branch or checkout fails (e.g. dirty
  // tree) — the user can see the git error in the terminal themselves.
  const checkout = `try { git checkout ${powershellDqQuote(branch)} } catch {}`;
  return `${cdPart}; ${checkout}`;
}

interface SpawnResult {
  ok: boolean;
  error?: string;
}

/** Spawn a detached process that opens a new terminal window at `cwd`. */
function openTerminal(cwd: string, branch: string | null): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const platform = process.platform;
    let command: string;
    let args: string[];
    let options: { cwd: string; detached: boolean; stdio: "ignore" };

    try {
      if (platform === "win32") {
        // Open a new PowerShell window at cwd. We use `start` (via cmd.exe)
        // so the window is independent of the server process. Prefer pwsh
        // (PowerShell 7+) when present, else fall back to built-in
        // powershell.exe. Windows Terminal is not required.
        const psCmd = buildPowerShellCommand(cwd, branch);
        const psLine = `pwsh.exe -NoExit -Command ${psCmd} 2>nul || powershell.exe -NoExit -Command ${psCmd}`;
        const cmdLine = `start "" /B ${psLine}`;
        command = process.env.COMSPEC || "cmd.exe";
        args = ["/c", cmdLine];
        options = { cwd, detached: true, stdio: "ignore" };
      } else if (platform === "darwin") {
        // `osascript` is the reliable way to open a fresh Terminal.app
        // window AND run a command in it in one shot.
        const shCmd = buildShellCommand(cwd, branch);
        const escaped = shCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal" to do script "${escaped}"`;
        command = "osascript";
        args = ["-e", script];
        options = { cwd, detached: true, stdio: "ignore" };
      } else {
        // Linux: gnome-terminal on some Wayland GNOME setups silently exits
        // 0 without opening a window (D-Bus factory mismatch), so we try
        // several emulators and verify a window actually appeared via
        // wmctrl, falling through to the next candidate if not.
        openLinuxTerminalWithVerification(cwd, branch).then(resolve);
        return;
      }

      const child = spawn(command, args, options);
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      // Detach so the terminal outlives the server process; unref so the
      // server can exit without waiting on it.
      child.unref();
      // Give the spawn a brief moment to confirm it didn't immediately fail
      // with an error event. A successful spawn with no early error is the
      // best we can do — the terminal window itself is async.
      setTimeout(() => resolve({ ok: true }), 250);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** All available terminal emulators on PATH, honoring $TERMINAL first. */
function listLinuxTerminals(): Array<[string, string]> {
  const preferred = process.env.TERMINAL;
  const order: Array<[string, string]> = [];
  if (preferred) {
    order.push([preferred.split(/\s+/)[0], "-e"]);
  }
  // gnome-terminal/xfce4-terminal use `--`; the rest use `-e`.
  const known: Array<[string, string]> = [
    ["xterm", "-e"],
    ["gnome-terminal", "--"],
    ["konsole", "-e"],
    ["xfce4-terminal", "-e"],
    ["alacritty", "-e"],
    ["kitty", "-e"],
    ["lxterminal", "-e"],
    ["mate-terminal", "-e"],
    ["tilix", "-e"],
    ["qterminal", "-e"],
    ["terminology", "-e"],
  ];
  for (const [name, flag] of known) {
    if (!order.some(([n]) => n === name)) order.push([name, flag]);
  }
  const available: Array<[string, string]> = [];
  for (const [name, flag] of order) {
    const probe = spawnSync("sh", ["-c", `command -v ${shellQuote(name)} >/dev/null 2>&1 && echo found`], {
      timeout: 2000,
    });
    if (probe.status === 0 && /found/.test(probe.stdout.toString())) {
      available.push([name, flag]);
    }
  }
  return available;
}

/** Try each terminal emulator, verifying via wmctrl that a window appeared. */
async function openLinuxTerminalWithVerification(cwd: string, branch: string | null): Promise<SpawnResult> {
  const shCmd = buildShellCommand(cwd, branch);
  const available = listLinuxTerminals();
  if (available.length === 0) {
    return {
      ok: false,
      error: "No supported terminal emulator found. Set the TERMINAL env var (e.g. TERMINAL=xterm).",
    };
  }
  const wmctrlProbe = spawnSync("sh", ["-c", "command -v wmctrl >/dev/null 2>&1 && echo ok"], { timeout: 2000 });
  const canVerify = /ok/.test(wmctrlProbe.stdout.toString());
  const before = canVerify ? spawnSync("wmctrl", ["-l"], { timeout: 2000 }).stdout.toString() : "";
  for (const [name, flag] of available) {
    await new Promise<void>((resolve) => {
      const child = spawn(name, [flag, "sh", "-c", shCmd], {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      child.on("error", () => resolve());
      // Give the emulator up to 2.5s to create its window.
      setTimeout(resolve, 2500);
    });
    if (canVerify) {
      const after = spawnSync("wmctrl", ["-l"], { timeout: 2000 }).stdout.toString();
      if (after !== before) {
        return { ok: true };
      }
      // No new window — gnome-terminal may have silently failed. Try next.
      continue;
    }
    // Cannot verify — assume the first available worked.
    return { ok: true };
  }
  return {
    ok: false,
    error: "Terminal launched but no window appeared (known issue with gnome-terminal on some Wayland GNOME setups). Install xterm or set the TERMINAL env var.",
  };
}


// POST /api/terminal/open  body: { cwd }  →  { ok }
//
// Opens a new native terminal window at the session's cwd. When the cwd is a
// git worktree (or any git checkout) with a known branch, the terminal also
// checks out that branch so the user lands on the same branch the session is
// operating on. The cwd is the worktree directory itself for worktree
// sessions — resolveProject confirms the branch from git.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { cwd?: string; branch?: string | null };
    const cwd = body.cwd;
    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    // Use the caller-provided branch when present (the session already knows
    // it); otherwise resolve it from git. Handles worktrees, where the cwd is
    // the worktree dir but the branch is the worktree's checked-out branch.
    let branch: string | null = null;
    if (typeof body.branch === "string" && body.branch.trim()) {
      branch = body.branch.trim();
    } else {
      try {
        const project = await resolveProject(cwd);
        branch = project.branch;
      } catch {
        branch = null;
      }
    }

    const result = await openTerminal(cwd, branch);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed to open terminal" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
