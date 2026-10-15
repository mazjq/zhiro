//! The desktop shell (ADR-048): a tray icon that stays, a window that hides instead of closing, the daemon started here
//! when nothing is listening — and only then stopped here. Attached to a daemon someone else started (a terminal's
//! `pnpm dev`), quitting just disconnects. Autostart is a checkbox in the tray menu, off unless the person ticks it.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

fn vault_dir() -> PathBuf {
    if let Ok(v) = std::env::var("JOBOS_VAULT") {
        return PathBuf::from(v);
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
        return PathBuf::from(base).join("JobOS").join("vault");
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        return PathBuf::from(home).join("Library/Application Support/JobOS/vault");
    }
    #[allow(unreachable_code)]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share/jobos/vault")
    }
}

/// Loopback token written by the daemon on first start. The webview reads it through this command,
/// so the token never lives in JS bundles or query strings.
#[tauri::command]
fn daemon_token() -> Result<String, String> {
    let p = vault_dir().join("config").join(".daemon-token");
    std::fs::read_to_string(&p)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("token not found at {} ({}). Start the daemon first.", p.display(), e))
}

#[tauri::command]
fn daemon_url() -> String {
    std::env::var("JOBOS_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into())
}

fn port() -> u16 {
    daemon_url().rsplit(':').next().and_then(|p| p.trim_end_matches('/').parse().ok()).unwrap_or(8787)
}

fn alive() -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port())), Duration::from_millis(300)).is_ok()
}

/// GET /health as text (std only): enough to read a flag or two out of it.
fn health() -> String {
    let Ok(mut s) = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port())), Duration::from_millis(500)) else { return String::new() };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

/// The daemon this window started, if it did. None while attached to one started elsewhere.
struct Daemon(Mutex<Option<Child>>);

/// In development the repository is where this crate lives; the installer (G3) replaces the command with the bundled daemon.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn node_cmd(script: &str, args: &[&str]) -> Command {
    let mut c = Command::new("node");
    c.arg("--no-warnings=ExperimentalWarning").arg("--import").arg("tsx").arg(script).args(args).current_dir(repo_root().join("apps").join("daemon"));
    if let Ok(v) = std::env::var("JOBOS_VAULT") { c.env("JOBOS_VAULT", v); }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn start_daemon(d: &Daemon) {
    if alive() { return; }
    let mut cmd = if let Ok(custom) = std::env::var("JOBOS_DAEMON_CMD") {
        let mut parts = custom.split_whitespace();
        let mut c = Command::new(parts.next().unwrap_or("node"));
        c.args(parts);
        c
    } else { node_cmd("src/main.ts", &[]) };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    match cmd.spawn() {
        Ok(child) => {
            *d.0.lock().unwrap() = Some(child);
            let t0 = Instant::now();
            while !alive() && t0.elapsed() < Duration::from_secs(30) { std::thread::sleep(Duration::from_millis(300)); }
        }
        Err(e) => eprintln!("[zhiro] could not start the daemon: {e}"),
    }
}

fn stop_daemon(d: &Daemon) {
    if let Some(mut child) = d.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
fn daemon_owned(d: State<Daemon>) -> bool {
    d.0.lock().unwrap().is_some()
}

#[tauri::command]
fn open_dir(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let r = Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&path).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&path).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Import an export: only when this window owns the daemon (it stops it, runs the import, starts it again).
#[tauri::command]
fn import_vault(zip: String, d: State<Daemon>) -> Result<String, String> {
    if d.0.lock().unwrap().is_none() {
        return Err("Zhiro 的后台不是这个窗口起的（比如终端里的 pnpm dev）：先把它停掉，再在终端里跑 pnpm --filter @zhiro/daemon vault import <zip>".into());
    }
    stop_daemon(&d);
    let out = node_cmd("src/cli/vault.ts", &["import", &zip]).output();
    start_daemon(&d);
    match out {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => Err(format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => Err(e.to_string()),
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn quit(app: &AppHandle) {
    let d: State<Daemon> = app.state();
    // a daemon this window started goes with it — unless an application is being filled in right now
    if d.0.lock().unwrap().is_some() && !health().contains("\"applyRunning\":true") { stop_daemon(&d); }
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .manage(Daemon(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![daemon_token, daemon_url, daemon_owned, open_dir, import_vault])
        .setup(|app| {
            start_daemon(&app.state::<Daemon>());
            let open = MenuItem::with_id(app, "open", "打开 Zhiro", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", "开机自启", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let agent = MenuItem::with_id(app, "agent", "打开 agent 工作目录", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &auto, &PredefinedMenuItem::separator(app)?, &data, &agent, &PredefinedMenuItem::separator(app)?, &quit_item])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("window icon"))
                .tooltip("Zhiro")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => show(app),
                    "autostart" => {
                        let al = app.autolaunch();
                        if al.is_enabled().unwrap_or(false) { let _ = al.disable(); } else { let _ = al.enable(); }
                    }
                    "data" => { let _ = open_dir(vault_dir().to_string_lossy().to_string()); }
                    "agent" => { let _ = open_dir(vault_dir().join("agent").to_string_lossy().to_string()); }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev { show(tray.app_handle()); }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
