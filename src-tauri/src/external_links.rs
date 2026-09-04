// 看板在 sidecar 就绪后 navigate 到 http://127.0.0.1:<port>，整个 UI 都跑在
// WKWebView 里。WebView 只会自己去加载导航目标，遇到 `codex://`、`claude://`
// 这类它不认识的 scheme 既打不开也不会转交系统，导航静默失败——表现就是任务详情
// 里点「在 Codex 中打开」「在 Claude Code 中打开」毫无反应（浏览器里同一份前端
// 正常，因为浏览器会把未知 scheme 交给系统）。
//
// 拦截点放在 Rust 侧的导航钩子上：前端三处深链（唤起已有会话、新建会话、运行时
// 引导动作）都走同一条导航，一处拦截全部覆盖，也不必按 Agent 硬编码 scheme。

use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_opener::OpenerExt;

/// 该由 WebView 自己加载的 scheme：`tauri` 是打包后的启动页，`http`/`https` 是
/// 本机看板和外链，其余是页面内部资源。此外的一律交给系统默认处理程序。
const IN_PAGE_SCHEMES: [&str; 7] = ["http", "https", "tauri", "file", "about", "data", "blob"];

pub fn handled_by_webview(scheme: &str) -> bool {
    IN_PAGE_SCHEMES.contains(&scheme)
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("external-links")
        .on_navigation(|webview, url| {
            if handled_by_webview(url.scheme()) {
                return true;
            }
            if let Err(error) = webview.opener().open_url(url.as_str(), None::<&str>) {
                eprintln!("[shell] failed to open {}: {error}", url.scheme());
            }
            // 已经交给系统，WebView 不再继续这次导航，否则它会以「不支持的 URL」
            // 失败，把当前页面停在错误状态上。
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_deep_links_go_to_the_system() {
        assert!(!handled_by_webview("codex"));
        assert!(!handled_by_webview("claude"));
    }

    #[test]
    fn the_board_itself_keeps_loading_in_the_webview() {
        assert!(handled_by_webview("http"));
        assert!(handled_by_webview("https"));
        assert!(handled_by_webview("tauri"));
    }
}
