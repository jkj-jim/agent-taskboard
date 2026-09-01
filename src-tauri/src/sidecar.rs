// 随包 Node sidecar 的启动、健康检查、异常重启与优雅退出
// （document/design/desktop-app-packaging.md §4 生命周期）。

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::app_identity;
use crate::app_version;

/// 异常退出后最多再拉起两次，之后进入启动故障页。
const MAX_RESTARTS: u32 = 2;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Launch {
    pub profile: &'static str,
    pub app_version: &'static str,
    pub port: u16,
    pub profile_directory: PathBuf,
    pub skill_path: PathBuf,
}

impl Launch {
    pub fn log_path(&self) -> PathBuf {
        self.profile_directory.join("logs").join("sidecar.log")
    }
}

pub struct Health {
    pub status: Option<String>,
    pub app_id: Option<String>,
    pub profile: Option<String>,
    pub version: Option<String>,
}

pub struct Supervisor {
    launch: Launch,
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
}

fn text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn append_log(path: &PathBuf, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

impl Supervisor {
    pub fn new(launch: Launch) -> Self {
        Self {
            launch,
            child: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        }
    }

    // 十一个启动参数（§4）。安装版不用环境变量，也不允许 sidecar 回退到仓库路径。
    fn spawn(&self, app: &AppHandle) -> Result<Receiver<()>, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| format!("resource directory unavailable: {error}"))?;
        let log_path = self.launch.log_path();

        let (mut events, child) = app
            .shell()
            .sidecar("node")
            .map_err(|error| format!("bundled Node sidecar missing: {error}"))?
            .args([
                text(resources.join("server").join("index.mjs")),
                "--profile".into(),
                self.launch.profile.into(),
                "--app-version".into(),
                self.launch.app_version.into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                self.launch.port.to_string(),
                "--data-directory".into(),
                text(self.launch.profile_directory.clone()),
                "--attachments-directory".into(),
                text(self.launch.profile_directory.join("attachments")),
                "--runtime-directory".into(),
                text(self.launch.profile_directory.join("runtime")),
                "--static-directory".into(),
                text(resources.join("dist").join("web")),
                "--skill-path".into(),
                text(self.launch.skill_path.clone()),
                "--taskctl-cli-path".into(),
                text(resources.join("cli").join("taskctl.mjs")),
                "--codex-injector-path".into(),
                text(resources.join("scripts").join("codex-injector.mjs")),
            ])
            .spawn()
            .map_err(|error| format!("failed to start Node sidecar: {error}"))?;

        *self.child.lock().unwrap() = Some(child);

        let (exited, exit_signal): (Sender<()>, Receiver<()>) = channel();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        append_log(&log_path, String::from_utf8_lossy(&line).trim_end());
                    }
                    CommandEvent::Stderr(line) => {
                        append_log(&log_path, String::from_utf8_lossy(&line).trim_end());
                    }
                    CommandEvent::Terminated(payload) => {
                        append_log(&log_path, &format!("[shell] sidecar exited with {:?}", payload.code));
                        let _ = exited.send(());
                    }
                    _ => {}
                }
            }
        });

        Ok(exit_signal)
    }

    /// 启动、等待健康、校验身份，然后一直阻塞到 sidecar 退出。
    fn run_once(&self, app: &AppHandle) -> Result<(), String> {
        wait_for_free_port(self.launch.port, self.launch.profile, Duration::from_secs(5))?;
        let exit_signal = self.spawn(app)?;
        let health = wait_for_health(self.launch.port, HEALTH_TIMEOUT)?;
        assert_identity(&health, self.launch.profile)?;

        emit_status(app, "ready", None, &self.launch);
        if let Some(window) = app.get_webview_window("main") {
            let url = format!("http://127.0.0.1:{}", self.launch.port);
            window
                .navigate(url.parse().map_err(|_| "invalid board url".to_string())?)
                .map_err(|error| format!("failed to load the board: {error}"))?;
        }

        let _ = exit_signal.recv();
        Err("sidecar exited unexpectedly".into())
    }

    pub fn supervise(self: &Arc<Self>, app: AppHandle) {
        let supervisor = Arc::clone(self);
        std::thread::spawn(move || {
            for attempt in 0..=MAX_RESTARTS {
                if supervisor.shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                if attempt > 0 {
                    append_log(
                        &supervisor.launch.log_path(),
                        &format!("[shell] restarting the sidecar (attempt {attempt}/{MAX_RESTARTS})"),
                    );
                    emit_status(&app, "restarting", None, &supervisor.launch);
                }

                let failure = supervisor.run_once(&app).unwrap_err();
                supervisor.terminate();
                if supervisor.shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                append_log(&supervisor.launch.log_path(), &format!("[shell] {failure}"));
                if attempt == MAX_RESTARTS {
                    emit_status(&app, "failed", Some(&failure), &supervisor.launch);
                }
            }
        });
    }

    /// 重新开始一轮启动，供启动故障页的重试按钮调用。
    pub fn retry(self: &Arc<Self>, app: AppHandle) {
        self.terminate();
        self.shutting_down.store(false, Ordering::SeqCst);
        emit_status(&app, "starting", None, &self.launch);
        self.supervise(app);
    }

    // SIGTERM 让 server/index.mjs 走自己的 close()，SQLite 才有机会正常收尾；超时才强杀。
    fn terminate(&self) {
        let Some(child) = self.child.lock().unwrap().take() else {
            return;
        };
        let pid = child.pid() as i32;
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.terminate();
    }
}

fn emit_status(app: &AppHandle, state: &str, reason: Option<&str>, launch: &Launch) {
    let _ = app.emit(
        "startup",
        serde_json::json!({
            "state": state,
            "reason": reason,
            "profile": launch.profile,
            "version": launch.app_version,
            "port": launch.port,
            "logPath": launch.log_path().to_string_lossy(),
        }),
    );
}

pub fn assert_identity(health: &Health, profile: &str) -> Result<(), String> {
    if health.status.as_deref() != Some("ok") {
        return Err(format!("/health reported status {:?}", health.status));
    }
    if health.app_id.as_deref() != Some(app_identity::APP_ID) {
        return Err(format!(
            "端口 上是另一个应用：/health 的 appId 为 {:?}",
            health.app_id
        ));
    }
    if health.profile.as_deref() != Some(profile) {
        return Err(format!(
            "端口被 {:?} profile 的实例占用，当前是 {profile}",
            health.profile
        ));
    }
    if health.version.as_deref() != Some(app_version::APP_VERSION_FULL) {
        return Err(format!(
            "版本不一致：壳是 {}，sidecar 是 {:?}",
            app_version::APP_VERSION_FULL,
            health.version
        ));
    }
    Ok(())
}

pub fn wait_for_health(port: u16, timeout: Duration) -> Result<Health, String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = String::from("sidecar was never reachable");
    while Instant::now() < deadline {
        match probe_health(port) {
            Ok(body) => {
                let parsed: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|error| format!("/health returned invalid JSON: {error}"))?;
                return Ok(Health {
                    status: parsed["status"].as_str().map(str::to_owned),
                    app_id: parsed["appId"].as_str().map(str::to_owned),
                    profile: parsed["profile"].as_str().map(str::to_owned),
                    version: parsed["version"].as_str().map(str::to_owned),
                });
            }
            Err(error) => last_error = error,
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(last_error)
}

/// 只查 loopback 上的一个固定端点，用最小的 HTTP/1.0 请求换取零额外依赖。
pub fn probe_health(port: u16) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().map_err(|_| "invalid port")?,
        Duration::from_millis(800),
    )
    .map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
    stream
        .write_all(
            format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or("malformed /health response")?;
    let status = head.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(format!("/health returned {status}"));
    }
    Ok(body.to_string())
}

/// 端口被占用时的判定：绝不改用随机端口。自己的孤儿 sidecar 会在父进程消失后
/// 几秒内自行退出，所以先给它一点时间；仍占着就交给启动故障页。
pub fn wait_for_free_port(port: u16, profile: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if !port_in_use(port) {
            return Ok(());
        }
        let conflict = describe_conflict(port, profile);
        if Instant::now() >= deadline {
            return Err(conflict);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn port_in_use(port: u16) -> bool {
    let Ok(address) = format!("127.0.0.1:{port}").parse() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

fn describe_conflict(port: u16, profile: &str) -> String {
    // 认不出身份就只报端口冲突，不猜占用者是谁。
    let Ok(body) = probe_health(port) else {
        return format!("端口 {port} 被另一个程序占用");
    };
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let health = Health {
        status: parsed["status"].as_str().map(str::to_owned),
        app_id: parsed["appId"].as_str().map(str::to_owned),
        profile: parsed["profile"].as_str().map(str::to_owned),
        version: parsed["version"].as_str().map(str::to_owned),
    };
    match assert_identity(&health, profile) {
        // 同 profile 的残留实例：等它按孤儿看门狗自行退出。
        Ok(()) => format!("端口 {port} 仍被上一次的 sidecar 占用"),
        Err(reason) => reason,
    }
}
