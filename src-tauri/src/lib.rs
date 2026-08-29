// Pi Web Desktop — Tauri 2 shell.
//
// Replaces desktop/main.cjs (Electron). Responsibilities (matching the
// Electron main process 1:1):
//   1. spawn the embedded Next.js server (release) or reuse the dev server (dev)
//   2. wait for the port to be reachable
//   3. load http://127.0.0.1:PORT in the webview
//   4. kill the server on app exit
//   5. single-instance enforcement
// Tray, IPC handlers, and window lifecycle are added in later phases.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 30141;
const PORT_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const PORT_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Holds the spawned server child so we can kill it on exit. None in dev mode
/// (the dev server is owned by `beforeDevCommand`) or when reusing an existing
/// server on the port.
struct ServerChild(Mutex<Option<CommandChild>>);

/// Allows a deliberate Quit action to bypass close-to-tray interception.
struct IsQuitting(AtomicBool);

/// Resolve the desktop server port using the same precedence as the Node
/// launcher: an inherited `PORT`, then this checkout's `.env.local`, then the
/// normal Pi Web default. Tauri does not load `.env.local` into its Rust
/// process, so relying on `std::env::var("PORT")` alone leaves the desktop
/// shell pinned to a stale, compiled-in port.
fn server_port() -> u16 {
    fn parse_port(value: &str) -> Option<u16> {
        value.trim().parse::<u16>().ok()
    }

    if let Ok(port) = std::env::var("PORT") {
        if let Some(port) = parse_port(&port) {
            return port;
        }
        log::warn!("[pi-web-desktop] ignoring invalid PORT={port:?}");
    }

    // `.env.local` is intentionally a development convenience. A packaged
    // application has no project checkout, so it falls back to DEFAULT_PORT
    // unless its launcher explicitly provides PORT.
    if cfg!(debug_assertions) {
        if let Ok(contents) = std::fs::read_to_string(".env.local") {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let line = line.strip_prefix("export ").unwrap_or(line);
                if let Some(value) = line.strip_prefix("PORT=") {
                    let value = value.trim().trim_matches(['\"', '\'']);
                    if let Some(port) = parse_port(value) {
                        return port;
                    }
                    log::warn!("[pi-web-desktop] ignoring invalid PORT in .env.local");
                    break;
                }
            }
        }
    }

    DEFAULT_PORT
}

fn port_reachable(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    match addr.parse() {
        Ok(socket_addr) => TcpStream::connect_timeout(&socket_addr, Duration::from_millis(800)).is_ok(),
        Err(_) => false,
    }
}

/// Mirror desktop/runtime-helpers.cjs waitForPort: poll connect every 300ms,
/// bail after 45s.
fn wait_for_port(host: &str, port: u16) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if port_reachable(host, port) {
            return Ok(());
        }
        if start.elapsed() >= PORT_WAIT_TIMEOUT {
            return Err(format!("Timed out waiting for {host}:{port}"));
        }
        std::thread::sleep(PORT_POLL_INTERVAL);
    }
}

/// Resolve the path to the bundled node binary.
/// - Release: <resource_dir>/node/<platform-node>
/// - Dev: the system `node` on PATH (dev runs from the project checkout)
fn node_binary_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        which_node()
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?;
        let name = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        let p = resource_dir.join("desktop-runtime").join("node").join(name);
        if p.exists() {
            Ok(p)
        } else {
            // Fallback to system node if the bundled one is missing (e.g. dev
            // build mislabeled as release).
            which_node()
        }
    }
}

fn which_node() -> Result<PathBuf, String> {
    let name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(sep) {
        let candidate = PathBuf::from(dir).join(name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("`node` not found on PATH".to_string())
}

/// Resolve the server entry path.
/// - Release: <resource_dir>/desktop-server.mjs
/// - Dev: <project_root>/desktop-server.mjs
fn server_entry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        // In dev the CWD is the project root (tauri dev runs from there).
        let p = PathBuf::from("desktop-server.mjs");
        if p.exists() {
            return Ok(p);
        }
        // Fallback: try alongside the executable / manifest dir.
        Ok(app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?
            .join("desktop-server.mjs"))
    } else {
        Ok(app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {e}"))?
            .join("desktop-runtime")
            .join("desktop-server.mjs"))
    }
}

/// Mirror desktop/runtime-helpers.cjs shouldLaunchEmbeddedServer:
/// in dev we never spawn (beforeDevCommand owns the server); in release we
/// spawn only when the port is free (reuse an existing server otherwise).
fn should_spawn_server(port_in_use: bool) -> bool {
    if cfg!(debug_assertions) {
        false
    } else {
        !port_in_use
    }
}

fn spawn_server(app: &tauri::AppHandle, port: u16) -> Result<CommandChild, String> {
    let node = node_binary_path(app)?;
    let entry = server_entry_path(app)?;
    if !entry.exists() {
        return Err(format!("server entry not found: {}", entry.display()));
    }
    let sidecar = app
        .shell()
        .command(node.to_string_lossy().to_string())
        .arg(entry.to_string_lossy().to_string())
        .current_dir(
            entry
                .parent()
                .ok_or_else(|| format!("server entry has no parent: {}", entry.display()))?,
        )
        .env("PORT", port.to_string())
        .env("PI_WEB_HOSTNAME", HOST)
        .env("PI_WEB_NO_OPEN", "1");
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn server: {e}"))?;

    // Log server stdout/stderr; watch for unexpected exit.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let s = String::from_utf8_lossy(&bytes);
                    for line in s.lines() {
                        log::info!("[pi-web-server] {line}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let s = String::from_utf8_lossy(&bytes);
                    for line in s.lines() {
                        log::warn!("[pi-web-server] {line}");
                    }
                }
                CommandEvent::Terminated(status) => {
                    log::warn!("[pi-web-server] terminated: {status:?}");
                }
                CommandEvent::Error(err) => {
                    log::error!("[pi-web-server] {err}");
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

#[tauri::command]
fn confirm_delete(name: Option<String>, id: Option<String>, app: tauri::AppHandle) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let message = name
        .map(|name| format!("删除会话“{name}”？"))
        .unwrap_or_else(|| "删除该会话？".to_string());
    let detail = id
        .map(|id| format!("会话 ID: {id}\n删除后无法恢复。"))
        .unwrap_or_else(|| "删除后无法恢复。".to_string());
    app.dialog()
        .message(format!("{message}\n\n{detail}"))
        .title("确认删除")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("删除".into(), "取消".into()))
        .blocking_show()
}

#[derive(serde::Serialize)]
struct TerminalResult {
    ok: bool,
    error: Option<String>,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[tauri::command]
fn open_terminal(cwd: String, branch: Option<String>) -> TerminalResult {
    use std::process::{Command, Stdio};
    if cwd.trim().is_empty() {
        return TerminalResult { ok: false, error: Some("cwd is required".into()) };
    }

    #[cfg(target_os = "linux")]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
        let checkout = branch
            .filter(|b| !b.is_empty())
            .map(|b| format!(" && git checkout {} 2>/dev/null || true", shell_quote(&b)))
            .unwrap_or_default();
        let command = format!("cd {}{} && exec {}", shell_quote(&cwd), checkout, shell_quote(&shell));
        let mut candidates: Vec<(String, Vec<String>)> = vec![
            ("gnome-terminal".into(), vec!["--".into()]),
            ("xterm".into(), vec!["-e".into()]),
            ("konsole".into(), vec!["-e".into()]),
            ("xfce4-terminal".into(), vec!["-e".into()]),
            ("alacritty".into(), vec!["-e".into()]),
            ("kitty".into(), vec!["-e".into()]),
        ];
        if let Some(preferred) = std::env::var("TERMINAL").ok().and_then(|v| v.split_whitespace().next().map(str::to_owned)) {
            candidates.insert(0, (preferred, vec!["-e".into()]));
        }
        // gnome-terminal can exit 0 without showing a window on Wayland GNOME.
        // When wmctrl is available, compare window lists after each launch and
        // fall through to the next emulator if no new window materialized.
        let wmctrl_available = Command::new("sh")
            .args(["-c", "command -v wmctrl >/dev/null 2>&1"])
            .status().map(|s| s.success()).unwrap_or(false);
        let windows_before = if wmctrl_available {
            Command::new("wmctrl").arg("-l").output().ok().map(|o| o.stdout).unwrap_or_default()
        } else { Vec::new() };

        for (program, args) in candidates {
            if !Command::new("sh").args(["-c", &format!("command -v {} >/dev/null 2>&1", shell_quote(&program))]).status().map(|s| s.success()).unwrap_or(false) {
                continue;
            }
            match Command::new(&program)
                .args(&args).args(["sh", "-c", &command])
                .current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn() {
                Err(_) => continue,
                Ok(_) if !wmctrl_available => return TerminalResult { ok: true, error: None },
                Ok(_) => {
                    std::thread::sleep(Duration::from_millis(2500));
                    let windows_after = Command::new("wmctrl").arg("-l").output().ok().map(|o| o.stdout).unwrap_or_default();
                    if windows_after != windows_before {
                        return TerminalResult { ok: true, error: None };
                    }
                }
            }
        }
        return TerminalResult { ok: false, error: Some("No terminal emulator opened. Set TERMINAL or install xterm.".into()) };
    }

    #[cfg(target_os = "macos")]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
        let checkout = branch.map(|b| format!(" && git checkout {} 2>/dev/null || true", shell_quote(&b))).unwrap_or_default();
        let command = format!("cd {}{} && exec {}", shell_quote(&cwd), checkout, shell_quote(&shell));
        let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
        return match Command::new("osascript").args(["-e", &format!("tell application \"Terminal\" to do script \"{escaped}\"")]).spawn() {
            Ok(_) => TerminalResult { ok: true, error: None },
            Err(e) => TerminalResult { ok: false, error: Some(e.to_string()) },
        };
    }

    #[cfg(target_os = "windows")]
    {
        let quoted = format!("\"{}\"", cwd.replace('"', "`\""));
        let checkout = branch.map(|b| format!("; try {{ git checkout \"{}\" }} catch {{}}", b.replace('"', "`\""))).unwrap_or_default();
        let line = format!("Set-Location -LiteralPath {quoted}{checkout}");
        return match Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()))
            .args(["/c", "start", "", "/B", "pwsh.exe", "-NoExit", "-Command", &line]).spawn() {
                Ok(_) => TerminalResult { ok: true, error: None },
                Err(e) => TerminalResult { ok: false, error: Some(e.to_string()) },
            };
    }

    #[allow(unreachable_code)]
    TerminalResult { ok: false, error: Some("Unsupported platform".into()) }
}

#[tauri::command]
fn reveal_path(path: String) -> TerminalResult {
    use std::process::Command;
    if path.trim().is_empty() {
        return TerminalResult { ok: false, error: Some("path is required".into()) };
    }
    #[cfg(target_os = "linux")]
    let result = std::path::Path::new(&path).parent()
        .map(|dir| Command::new("xdg-open").arg(dir).spawn())
        .unwrap_or_else(|| Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")));
    #[cfg(target_os = "macos")]
    let result = Command::new("open").args(["-R", &path]).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").args(["/select,", &path]).spawn();
    match result {
        Ok(_) => TerminalResult { ok: true, error: None },
        Err(e) => TerminalResult { ok: false, error: Some(e.to_string()) },
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn build_tray(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示 Pi Web", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("pi-web-tray")
        .menu(&menu)
        .tooltip("Pi Web Desktop")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                app.state::<IsQuitting>().0.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Linux status notifier implementations do not emit click events;
            // its tray menu remains available. Windows emits DoubleClick and
            // macOS emits Click, matching Electron's show-on-click behavior.
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => show_main_window(tray.app_handle()),
                _ => {}
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    // The manager resource table retains the icon after this local is dropped.
    let _tray = builder.build(app)?;
    Ok(())
}

fn load_main_window(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let url = format!("http://{HOST}:{port}");
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let url: tauri::Url = url.parse().map_err(|e| format!("parse url: {e}"))?;
    win.navigate(url).map_err(|e| format!("navigate: {e}"))?;
    win.show().map_err(|e| format!("show: {e}"))?;
    win.set_focus().ok();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![confirm_delete, open_terminal, reveal_path])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus the existing window.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .manage(ServerChild(Mutex::new(None)))
        .manage(IsQuitting(AtomicBool::new(false)))
        .setup(|app| {
            build_tray(app.handle())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_handle = app.handle().clone();
            let port = server_port();
            let port_in_use = port_reachable(HOST, port);
            log::info!(
                "[pi-web-desktop] dev={}, port {} in use: {}",
                cfg!(debug_assertions),
                port,
                port_in_use
            );

            if should_spawn_server(port_in_use) {
                match spawn_server(&app_handle, port) {
                    Ok(child) => {
                        let state = app_handle.state::<ServerChild>();
                        *state.0.lock().unwrap() = Some(child);
                    }
                    Err(e) => {
                        log::error!("[pi-web-desktop] spawn failed: {e}");
                        return Err(e.into());
                    }
                }
            } else if port_in_use {
                log::info!("[pi-web-desktop] reusing existing server on {HOST}:{port}");
            }

            // Block setup until the port is reachable (mirror waitForPort).
            // Run on a blocking thread so we don't stall the async runtime.
            let app_handle2 = app_handle.clone();
            std::thread::spawn(move || {
                if let Err(e) = wait_for_port(HOST, port) {
                    log::error!("[pi-web-desktop] {e}");
                    return;
                }
                if let Err(e) = load_main_window(&app_handle2, port) {
                    log::error!("[pi-web-desktop] load window: {e}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .app_handle()
                    .state::<IsQuitting>()
                    .0
                    .load(Ordering::SeqCst);
                if !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the server child on exit (mirror Electron before-quit).
            if let tauri::RunEvent::Exit = event {
                let child = app_handle
                    .try_state::<ServerChild>()
                    .and_then(|s| s.0.lock().ok()?.take());
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        });
}
