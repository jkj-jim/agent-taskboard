// 应用内更新（document/design/desktop-app-packaging.md §14）。
//
// 全部逻辑在 Rust 侧，用系统原生对话框。原因是主窗口在 sidecar 健康后会
// `navigate` 到 `http://127.0.0.1:<port>`，React UI 因此跑在 HTTP 源上，那个源
// 默认拿不到 Tauri IPC；把更新入口放前端就得给 HTTP 源开 remote capability。
// 放 Rust 侧还有一个好处：sidecar 起不来、界面停在启动故障页时，更新照样能用——
// 而「装了一个起不来的版本」恰恰是最需要更新的时候。

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::app_version;
use crate::sidecar;

pub const RELEASES_URL: &str = "https://github.com/jkj-jim/agent-taskboard/releases";

/// 启动后延迟这么久再查一次。让 sidecar 先起来、界面先可用；
/// 更新检查绝不能挡在启动路径上。
const STARTUP_DELAY: Duration = Duration::from_secs(12);

/// 对话框里最多展示这么多字符的发布说明。CHANGELOG 一节可能很长，
/// 原生对话框撑不住，截断后引导去 Release 页面看全文。
const NOTES_LIMIT: usize = 700;

/// 只有 production 装 updater。beta 必须完全不碰 stable 的 latest.json，
/// 「前端不去调」不算约束，插件根本不注册才算。
pub fn install(app: &AppHandle) -> bool {
    if app_version::profile() != app_version::PROFILE_PRODUCTION {
        println!("[update] profile={} 不启用应用内更新", app_version::profile());
        return false;
    }
    match app.plugin(tauri_plugin_updater::Builder::new().build()) {
        Ok(()) => true,
        Err(error) => {
            // 本地 `npx tauri build` 不带发布配置，没有 pubkey 与 endpoints。
            // 这不是故障，只是这份产物不具备更新能力。
            println!("[update] 未配置更新源，应用内更新不可用：{error}");
            false
        }
    }
}

pub fn schedule_startup_check(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 不引 tokio 只为了一个 sleep：延迟本身与异步无关，交给一个线程等就行。
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            std::thread::sleep(STARTUP_DELAY);
            let _ = sender.send(());
        });
        let _ = receiver.recv();
        run(handle, false).await;
    });
}

pub fn check_now(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { run(handle, true).await });
}

/// beta 不检查更新，只把 Release 列表打开让用户自己挑（§14）。
pub fn open_releases(app: &AppHandle) {
    if let Err(error) = app.opener().open_url(RELEASES_URL, None::<&str>) {
        eprintln!("[update] 打开 Release 页面失败：{error}");
    }
}

fn truncate_notes(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= NOTES_LIMIT {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(NOTES_LIMIT).collect();
    format!("{head}…\n\n（完整更新内容见 Release 页面）")
}

async fn run(app: AppHandle, interactive: bool) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            if interactive {
                notify(&app, "无法检查更新", &format!("这份产物没有配置更新源。\n\n{error}"));
            }
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            println!("[update] 发现新版本 {}", update.version);
            prompt(app, update);
        }
        Ok(None) => {
            println!("[update] 已是最新版本 {}", app_version::APP_VERSION_FULL);
            if interactive {
                notify(
                    &app,
                    "已经是最新版本",
                    &format!("当前版本 {}。", app_version::APP_VERSION_FULL),
                );
            }
        }
        // 离线或 GitHub 不可达不打扰用户，也绝不影响 App 继续运行（§14）。
        Err(error) => {
            if interactive {
                notify(&app, "暂时无法检查更新", &format!("{error}"));
            } else {
                println!("[update] 后台检查失败，忽略：{error}");
            }
        }
    }
}

fn prompt(app: AppHandle, update: tauri_plugin_updater::Update) {
    let mut message = format!(
        "当前版本 {}，可更新到 {}。",
        app_version::APP_VERSION_FULL, update.version,
    );
    if let Some(body) = update.body.as_deref() {
        let notes = truncate_notes(body);
        if !notes.is_empty() {
            message.push_str("\n\n");
            message.push_str(&notes);
        }
    }

    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("发现新版本")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "现在更新".to_string(),
            "稍后".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                tauri::async_runtime::spawn(async move { apply(handle, update).await });
            }
        });
}

async fn apply(app: AppHandle, update: tauri_plugin_updater::Update) {
    // 先停 sidecar 再替换 bundle。安装会把整个 .app 换掉，而 sidecar 跑的正是
    // 包内的 Contents/MacOS/node；让它先干净退出，WAL 才会被检查点写回主库。
    if let Some(supervisor) = app.try_state::<Arc<sidecar::Supervisor>>() {
        supervisor.shutdown();
    }

    // 签名由插件用编译进 App 的公钥校验，验不过这里就是 Err，不会落地。
    match update.download_and_install(|_downloaded, _total| {}, || {}).await {
        // restart 必须回主线程。这里是 tokio worker，直接调会走进 App 的退出清理，
        // 那条路径在 macOS 上要碰 AppKit；实测会以「panic in a function that cannot
        // unwind」abort，而且是时好时坏——同一份二进制两次演练一次成功一次崩。
        Ok(()) => {
            let restart_handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || restart_handle.restart()) {
                eprintln!("[update] 无法回到主线程重启：{error}");
            }
        }
        Err(error) => {
            // 安装失败保留当前版本继续运行（§14）。sidecar 已经停了，重新拉起来。
            if let Some(supervisor) = app.try_state::<Arc<sidecar::Supervisor>>() {
                supervisor.retry(app.clone());
            }
            notify(
                &app,
                "更新失败",
                &format!("已保留当前版本 {}。\n\n{error}", app_version::APP_VERSION_FULL),
            );
        }
    }
}

fn notify(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message.to_string())
        .title(title.to_string())
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}
