// 安装版加载的唯一注入入口（document/design/desktop-app-packaging.md §3、§9）。
// 它只启用 automation bridge：Codex 里不会出现任何 Taskboard 入口按钮或 iframe。
window.__CODEX_TASKBOARD_PANEL_ENABLED__ = false;
