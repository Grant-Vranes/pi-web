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

/** All available terminal launchers/emulators on PATH, honoring $TERMINAL first.
 *
 *  Returns a list of [launcher, argStyle] pairs where argStyle is one of:
 *  - "xdg"    : xdg-terminal-exec style — pass the command and args directly
 *               (it figures out the emulator itself; freedesktop standard).
 *  - "--"     : emulator uses `--` to separate its options from the command
 *               (gnome-terminal, xfce4-terminal).
 *  - "-e"     : emulator uses `-e` to run a command (xterm, konsole, kitty…).
 *  - "-e sh"  : emulator's `-e` only takes a single token, so we wrap with
 *               `sh -c` (some quirky emulators).
 *
 *  On Wayland GNOME, gnome-terminal's D-Bus factory can silently exit 0
 *  without opening a window when launched from a non-interactive/background
 *  process context. xdg-terminal-exec and standalone emulators (xterm,
 *  kitty, alacritty, foot, wezterm) are not affected, so we prefer them.
 */
function listLinuxTerminals(): Array<[string, string]> {
  const preferred = process.env.TERMINAL;
  const order: Array<[string, string]> = [];
  if (preferred) {
    // $TERMINAL may be a bare emulator name; treat it as `-e` style by
    // default (most emulators accept -e). gnome-terminal/xfce4-terminal
    // users should set TERMINAL explicitly if they want `--` semantics —
    // but we also auto-detect those two names below.
    const prefName = preferred.split(/\s+/)[0];
    order.push([prefName, prefName === "gnome-terminal" || prefName === "xfce4-terminal" ? "--" : "-e"]);
  }
  // xdg-terminal-exec first (freedesktop standard, respects mimeapps list
  // and works around gnome-terminal's factory issues on some setups), then
  // standalone emulators that are immune to the D-Bus factory problem, then
  // the D-Bus-based ones as a last resort.
  const known: Array<[string, string]> = [
    ["xdg-terminal-exec", "xdg"],
    ["xterm", "-e"],
    ["kitty", "-e"],
    ["alacritty", "-e"],
    ["wezterm", "-e"],
    ["foot", "-e"],
    ["konsole", "-e"],
    ["xfce4-terminal", "-e"],
    ["lxterminal", "-e"],
    ["mate-terminal", "-e"],
    ["tilix", "-e"],
    ["qterminal", "-e"],
    ["terminology", "-e"],
    ["ptyxis", "-e"],
    ["kgx", "-e"],
    // gnome-terminal last: on Wayland GNOME it may silently fail to open a
    // window when spawned from a background process (D-Bus factory mismatch).
    ["gnome-terminal", "--"],
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

/** Build the argv (excluding the leading command) for a given launcher style. */
function buildLauncherArgs(flag: string, shCmd: string): string[] {
  switch (flag) {
    case "xdg":
      // xdg-terminal-exec takes the command and args directly; pass sh -c.
      return ["sh", "-c", shCmd];
    case "--":
      // gnome-terminal / xfce4-terminal: `--` separates options from command.
      return ["--", "sh", "-c", shCmd];
    case "-e":
    default:
      // xterm / konsole / kitty / alacritty / foot / wezterm …: `-e cmd args…`.
      return ["-e", "sh", "-c", shCmd];
  }
}

/** Try each terminal emulator, verifying via wmctrl that a window appeared. */
async function openLinuxTerminalWithVerification(cwd: string, branch: string | null): Promise<SpawnResult> {
  const shCmd = buildShellCommand(cwd, branch);
  const available = listLinuxTerminals();
  if (available.length === 0) {
    return {
      ok: false,
      error: "No supported terminal emulator found. Set the TERMINAL env var (e.g. TERMINAL=xterm) or install xterm (apt install xterm / dnf install xterm).",
    };
  }
  const wmctrlProbe = spawnSync("sh", ["-c", "command -v wmctrl >/dev/null 2>&1 && echo ok"], { timeout: 2000 });
  const canVerify = /ok/.test(wmctrlProbe.stdout.toString());
  const before = canVerify ? spawnSync("wmctrl", ["-l"], { timeout: 2000 }).stdout.toString() : "";
  const attempted: string[] = [];
  for (const [name, flag] of available) {
    attempted.push(name);
    const args = buildLauncherArgs(flag, shCmd);
    await new Promise<void>((resolve) => {
      const child = spawn(name, args, {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      child.on("error", () => resolve());
      // Give the emulator up to 2.5s to create its window. xdg-terminal-exec
      // and some D-Bus-based emulators fork-and-exit immediately, so the
      // window may appear slightly after spawn returns.
      setTimeout(resolve, 2500);
    });
    if (canVerify) {
      const after = spawnSync("wmctrl", ["-l"], { timeout: 2000 }).stdout.toString();
      if (after !== before) {
        return { ok: true };
      }
      // No new window — this emulator silently failed (common with
      // gnome-terminal on Wayland GNOME). Try the next candidate.
      continue;
    }
    // Cannot verify (no wmctrl) — assume the first available worked. This
    // matches the historical behavior and avoids false negatives on minimal
    // window managers where wmctrl can't enumerate windows.
    return { ok: true };
  }
  // All candidates failed to open a window. Give the user an actionable
  // message: which emulators we tried, how to install a reliable one, and
  // how to force a specific one via $TERMINAL.
  const isWayland = /wayland/i.test(process.env.XDG_SESSION_TYPE || "") || !!process.env.WAYLAND_DISPLAY;
  const hint = isWayland
    ? "gnome-terminal is known to silently fail on some Wayland GNOME setups. " +
      "Install a standalone emulator (apt install xterm, or kitty/alacritty/wezterm) " +
      "and/or set TERMINAL=xterm before launching pi-web."
    : "Set the TERMINAL env var to your preferred emulator (e.g. TERMINAL=xterm).";
  return {
    ok: false,
    error: `Terminal launched but no window appeared (tried: ${attempted.join(", ")}). ${hint}`,
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
