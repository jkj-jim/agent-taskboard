#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_identity;
mod app_version;
mod sidecar;
mod single_instance;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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
        .invoke_handler(tauri::generate_handler![retry_startup])
        .setup(move |app| {
            let handle = app.handle().clone();
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
            supervisor.supervise(handle);

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
