// App 身份常量（document/design/desktop-app-packaging.md §1、§4）。
// APP_ID 必须与 src-tauri/tauri.conf.json 的 identifier 完全一致，由测试保证。

export const APP_ID = "io.github.jkj-jim.agenttaskboard";

// 开发实例没有 --profile，但 /health 仍要能把它和 production / beta 区分开。
export const PROFILE_DEVELOPMENT = "development";

// 单实例键：同一 profile 只允许一个 App 实例，production、beta 与开发服务互不干扰。
export function singleInstanceKey(profile) {
  return `${APP_ID}:${profile}`;
}
