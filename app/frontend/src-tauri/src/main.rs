// USB LLM Studio desktop shell.
//
// A thin window around the existing app: it finds the studio folder (the USB root that
// holds scripts/server/serve.cjs), starts the Node server with the portable Node runtime
// the launchers install, opens the UI from that server, and stops the server on exit.
// The UI keeps talking to the server over HTTP exactly as it does in a browser.

// Hide the console window on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Same defaults as mac.sh / linux.sh: 1420, then the first free port in 1421-1499.
const PREFERRED_PORT: u16 = 1420;
const FALLBACK_PORTS: std::ops::RangeInclusive<u16> = 1421..=1499;
// serve.cjs reads its port from this variable (see PORT_FRONTEND in serve.cjs).
const PORT_ENV: &str = "FRONTEND_PORT";
// Optional override for where the studio folder is.
const ROOT_ENV: &str = "USBLLM_ROOT";
// Set by the AppImage runtime to the real path of the .AppImage file.
const APPIMAGE_ENV: &str = "APPIMAGE";
const PATH_ENV: &str = "PATH";
const SYSTEM_NODE: &str = "node";

const SERVER_SCRIPT: &[&str] = &["scripts", "server", "serve.cjs"];
const DIST_INDEX: &[&str] = &["app", "dist", "index.html"];
const LOG_DIR: &[&str] = &["app", "cache"];
const LOG_FILE: &str = "desktop-server.log";
// Portable Node runtimes installed by scripts/setup (NODE_DIR in mac.sh, linux.sh, windows.bat).
#[cfg(target_os = "macos")]
const BUNDLED_NODE: &[&str] = &["app", "tools", "node-mac", "bin", "node"];
#[cfg(target_os = "linux")]
const BUNDLED_NODE: &[&str] = &["app", "tools", "node-linux", "bin", "node"];
#[cfg(windows)]
const BUNDLED_NODE: &[&str] = &["app", "tools", "node-win", "node.exe"];

const HEALTH_PATH: &str = "/api/health";
const HTTP_OK: &str = "200";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
// How far up from the app binary to look for the studio folder (covers Foo.app/Contents/MacOS).
const MAX_PARENT_LEVELS: usize = 6;

const MAIN_WINDOW: &str = "main";
const SHELL_PAGE: &str = "index.html";
// Defined in shell/index.html.
const SHELL_ERROR_FN: &str = "window.showError";
const WINDOW_SIZE: (f64, f64) = (1280.0, 860.0);
const MIN_WINDOW_SIZE: (f64, f64) = (900.0, 600.0);
const SETUP_HINT: &str = "Run the launcher for your system (mac.sh, linux.sh or windows.bat) once to finish setup, then open the desktop app again.";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The server this shell started (None when it reuses one that was already running).
struct ServerProcess(Mutex<Option<Child>>);

fn join(root: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(root.to_path_buf(), |path, part| path.join(part))
}

fn is_studio_root(dir: &Path) -> bool {
    join(dir, SERVER_SCRIPT).is_file()
}

fn find_studio_root() -> Option<PathBuf> {
    if let Some(dir) = env::var_os(ROOT_ENV).map(PathBuf::from) {
        if is_studio_root(&dir) {
            return Some(dir);
        }
    }
    let starts = [
        env::var_os(APPIMAGE_ENV).map(PathBuf::from),
        env::current_exe().ok(),
        env::current_dir().ok(),
    ];
    starts.into_iter().flatten().find_map(|start| {
        start
            .ancestors()
            .take(MAX_PARENT_LEVELS + 1)
            .find(|dir| is_studio_root(dir))
            .map(Path::to_path_buf)
    })
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn server_is_healthy(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, HEALTH_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {}:{port}\r\nConnection: close\r\n\r\n",
        Ipv4Addr::LOCALHOST
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0u8; 64];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let status_line = String::from_utf8_lossy(&buffer[..read]);
    status_line.split_whitespace().nth(1) == Some(HTTP_OK)
}

enum ServerTarget {
    /// A studio server is already answering on this port (for example one started by mac.sh).
    Running(u16),
    /// Nothing is listening here; start our own server on it.
    Start(u16),
}

fn choose_port() -> Result<ServerTarget, String> {
    for port in std::iter::once(PREFERRED_PORT).chain(FALLBACK_PORTS) {
        if port_is_free(port) {
            return Ok(ServerTarget::Start(port));
        }
        if server_is_healthy(port) {
            return Ok(ServerTarget::Running(port));
        }
    }
    Err(format!(
        "No free port found. Tried {PREFERRED_PORT} and {}-{}.",
        FALLBACK_PORTS.start(),
        FALLBACK_PORTS.end()
    ))
}

fn spawn_server(root: &Path, port: u16) -> Result<Child, String> {
    let bundled = join(root, BUNDLED_NODE);
    let node = if bundled.is_file() { bundled } else { PathBuf::from(SYSTEM_NODE) };

    let log_dir = join(root, LOG_DIR);
    fs::create_dir_all(&log_dir).map_err(|err| format!("Could not create {}: {err}", log_dir.display()))?;
    let log_path = log_dir.join(LOG_FILE);
    let log = fs::File::create(&log_path).map_err(|err| format!("Could not write {}: {err}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|err| err.to_string())?;

    let mut command = Command::new(&node);
    command
        .arg(join(root, SERVER_SCRIPT))
        .current_dir(root)
        .env(PORT_ENV, port.to_string())
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    // Like the launchers, put the portable Node first on PATH for anything the server spawns
    if let Some(node_dir) = node.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        let current = env::var_os(PATH_ENV).unwrap_or_default();
        let paths = std::iter::once(node_dir.to_path_buf()).chain(env::split_paths(&current));
        if let Ok(joined) = env::join_paths(paths) {
            command.env(PATH_ENV, joined);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| format!("Could not start Node.js ({}): {err}\n\n{SETUP_HINT}", node.display()))
}

/// Ends the server the way Ctrl+C in the launcher does, so serve.cjs can stop the
/// llama.cpp, whisper and TTS processes it started, then force-kills it if it hangs.
fn stop_server(mut child: Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
    #[cfg(windows)]
    {
        // Windows has no SIGTERM; end the whole process tree so backends do not linger
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Starts (or finds) the server and returns the port the UI is served on.
fn start_studio(app: &AppHandle) -> Result<u16, String> {
    let root = find_studio_root().ok_or_else(|| {
        format!("Could not find the USB LLM Studio folder. Keep this app in the same folder as mac.sh, linux.sh and windows.bat, or set {ROOT_ENV}.")
    })?;
    if !join(&root, DIST_INDEX).is_file() {
        return Err(format!("The app has not been built yet.\n\n{SETUP_HINT}"));
    }

    let port = match choose_port()? {
        ServerTarget::Running(port) => return Ok(port),
        ServerTarget::Start(port) => port,
    };
    let child = spawn_server(&root, port)?;
    let state = app.state::<ServerProcess>();
    *state.0.lock().map_err(|err| err.to_string())? = Some(child);

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if server_is_healthy(port) {
            return Ok(port);
        }
        let exited = state
            .0
            .lock()
            .ok()
            .and_then(|mut guard| guard.as_mut().and_then(|child| child.try_wait().ok().flatten()));
        if let Some(status) = exited {
            return Err(format!(
                "The local server stopped ({status}). Details are in {}.\n\n{SETUP_HINT}",
                join(&root, LOG_DIR).join(LOG_FILE).display()
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "The local server did not start within {} seconds. Details are in {}.",
        STARTUP_TIMEOUT.as_secs(),
        join(&root, LOG_DIR).join(LOG_FILE).display()
    ))
}

fn show_error(window: &WebviewWindow, message: &str) {
    let argument = serde_json::to_string(message).unwrap_or_default();
    let _ = window.eval(&format!("{SHELL_ERROR_FN}({argument})"));
}

fn main() {
    let app = tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
            let loaded_tx = Mutex::new(Some(loaded_tx));
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App(SHELL_PAGE.into()))
                .title(app.package_info().name.clone())
                .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
                .min_inner_size(MIN_WINDOW_SIZE.0, MIN_WINDOW_SIZE.1)
                .on_page_load(move |_window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        if let Some(tx) = loaded_tx.lock().ok().and_then(|mut guard| guard.take()) {
                            let _ = tx.send(());
                        }
                    }
                })
                .build()?;

            let handle = app.handle().clone();
            thread::spawn(move || {
                // Let the "Starting" page render first so errors have somewhere to show
                let _ = loaded_rx.recv_timeout(PAGE_LOAD_TIMEOUT);
                let result = start_studio(&handle).and_then(|port| {
                    format!("http://{}:{port}/", Ipv4Addr::LOCALHOST)
                        .parse::<tauri::Url>()
                        .map_err(|err| err.to_string())
                });
                match result {
                    Ok(url) => {
                        if let Err(err) = window.navigate(url) {
                            show_error(&window, &err.to_string());
                        }
                    }
                    Err(message) => show_error(&window, &message),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the USB LLM Studio window");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let child = handle
                .state::<ServerProcess>()
                .0
                .lock()
                .ok()
                .and_then(|mut guard| guard.take());
            if let Some(child) = child {
                stop_server(child);
            }
        }
    });
}
