#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_identity;
mod app_version;
mod sidecar;
mod single_instance;
mod update;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// 菜单里「检查更新…」的 id。production 触发检查，beta 打开 Release 列表。
const CHECK_UPDATE_ITEM: &str = "check-update";

/// macOS 上更新入口的惯例位置是应用菜单，而不是应用内的设置页——后者在本项目里
/// 还得给 HTTP 源开 IPC 才能调到 Rust（见 update.rs 的说明）。
fn build_menu(app: &tauri::AppHandle, updates_enabled: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let check_update = MenuItem::with_id(
        app,
        CHECK_UPDATE_ITEM,
        if updates_enabled { "检查更新…" } else { "在 GitHub 上查看版本…" },
        true,
        None::<&str>,
    )?;
    let application = Submenu::with_items(
        app,
        "Agent Taskboard",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &check_update,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    // 没有编辑菜单的话，看板里的复制粘贴快捷键会失效。
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&application, &edit, &window])
}

#[tauri::command]
fn retry_startup(app: tauri::AppHandle, supervisor: tauri::State<Arc<sidecar::Supervisor>>) {
    supervisor.inner().retry(app);
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    let profile = app_version::profile();

    // 单实例键是 {bundleIdentifier}:{profile}：同一 profile 的第二个实例只把已有窗口
    // 前置然后退出；production、beta 和开发服务互不影响。
    let listener = match single_instance::acquire(profile) {
        Ok(single_instance::Acquired::Owner(listener)) => listener,
        Ok(single_instance::Acquired::AlreadyRunning) => return,
        Err(error) => {
            eprintln!("[shell] {error}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![retry_startup])
        .setup(move |app| {
            let handle = app.handle().clone();

            // updater 插件在 setup 里注册而不是挂 Builder：注册要读 plugins.updater
            // 配置，而本地构建不带发布配置；挂 Builder 上会让 `npx tauri build`
            // 出来的产物一启动就失败。
            let updates_enabled = update::install(&handle);
            app.set_menu(build_menu(&handle, updates_enabled)?)?;
            {
                let menu_handle = handle.clone();
                app.on_menu_event(move |_app, event| {
                    if event.id() == CHECK_UPDATE_ITEM {
                        if updates_enabled {
                            update::check_now(&menu_handle);
                        } else {
                            update::open_releases(&menu_handle);
                        }
                    }
                });
            }
            let port = app_version::port();
            println!("[shell] {} profile={profile} port={port}", app_version::APP_VERSION_FULL);

            let profile_directory = handle.path().app_data_dir()?.join("profiles").join(profile);
            for directory in ["logs", "runtime", "attachments"] {
                std::fs::create_dir_all(profile_directory.join(directory))?;
            }

            // skill 是三套实例共享的用户级目录，不按 profile 复制（§5）。
            let skill_path = handle
                .path()
                .home_dir()?
                .join(".agents")
                .join("skills")
                .join("manage-taskboard")
                .join("SKILL.md");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agent Taskboard")
                .inner_size(1280.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .build()?;

            {
                let focus_handle = handle.clone();
                single_instance::serve(listener, move || show_main_window(&focus_handle));
            }

            let supervisor = Arc::new(sidecar::Supervisor::new(sidecar::Launch {
                profile,
                app_version: app_version::APP_VERSION_FULL,
                port,
                profile_directory,
                skill_path,
            }));
            app.manage(Arc::clone(&supervisor));
            supervisor.supervise(handle.clone());

            if updates_enabled {
                update::schedule_startup_check(&handle);
            }

            Ok(())
        })
        // 关闭窗口只隐藏，App 留在程序坞；后台触发的 Agent 任务需要它常驻（§4）。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Agent Taskboard")
        .run(|handle, event| match event {
            // 点程序坞图标重新显示窗口。
            RunEvent::Reopen { .. } => show_main_window(handle),
            RunEvent::Exit => {
                if let Some(supervisor) = handle.try_state::<Arc<sidecar::Supervisor>>() {
                    supervisor.shutdown();
                }
                single_instance::release(app_version::profile());
            }
            _ => {}
        });
}
