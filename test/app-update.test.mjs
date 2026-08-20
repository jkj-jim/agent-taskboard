import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readSource(...segments) {
  return readFile(path.join(projectRoot, ...segments), "utf8");
}

test("the updater plugin is an actual dependency, not just config", async () => {
  // 0.1.0 与 0.1.1 就是这样发出去的：tauri.release.conf.json 里有 plugins.updater、
  // latest.json 也照常上传，但客户端根本没装插件，应用里既没有入口也不会有提示。
  const cargo = await readSource("src-tauri", "Cargo.toml");
  assert.match(cargo, /^tauri-plugin-updater = /m);
  assert.match(cargo, /^tauri-plugin-dialog = /m);

  const main = await readSource("src-tauri", "src", "main.rs");
  assert.match(main, /mod update;/);
  assert.match(main, /update::install\(&handle\)/);
  assert.match(main, /update::schedule_startup_check/);
});

test("only production registers the updater, and it registers at setup time", async () => {
  const update = await readSource("src-tauri", "src", "update.rs");

  // beta 绝不能碰 stable 的 latest.json。「前端不去调」不算约束，插件不注册才算。
  assert.match(update, /profile\(\) != app_version::PROFILE_PRODUCTION/);
  // 挂在 Builder 上会让本地 `npx tauri build`（不带发布配置、没有 pubkey）
  // 出来的产物一启动就失败，所以必须在 setup 里注册并容忍失败
  const main = await readSource("src-tauri", "src", "main.rs");
  assert.doesNotMatch(main, /\.plugin\(tauri_plugin_updater/);
  assert.match(update, /app\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
});

test("the install path stops the sidecar first and restarts on the main thread", async () => {
  const update = await readSource("src-tauri", "src", "update.rs");
  const apply = update.slice(update.indexOf("async fn apply"));

  // 安装会整包替换，而 sidecar 跑的正是包内的 Contents/MacOS/node；
  // 先让它干净退出，WAL 才会被检查点写回主库。
  assert.ok(
    apply.indexOf("supervisor.shutdown()") < apply.indexOf("download_and_install"),
    "sidecar must stop before the bundle is replaced",
  );
  // 在 tokio worker 上直接 restart 会走进 App 的退出清理，那条路径在 macOS 上
  // 要碰 AppKit，实测会以「panic in a function that cannot unwind」abort，
  // 而且时好时坏——同一份二进制两次演练一次成功一次崩。
  assert.match(apply, /run_on_main_thread\(move \|\| restart_handle\.restart\(\)\)/);
  // 安装失败必须保留当前版本继续运行，并把刚停掉的 sidecar 拉回来
  assert.match(apply, /supervisor\.retry\(app\.clone\(\)\)/);
});

test("the update entry point needs no IPC from the board's HTTP origin", async () => {
  // 主窗口在 sidecar 健康后会 navigate 到 http://127.0.0.1:<port>，React UI 因此
  // 跑在 HTTP 源上。把更新入口放前端就得给那个源开 remote capability；放 Rust 侧
  // 则一行 capability 都不用动，而且 sidecar 起不来时更新照样可用。
  const capabilities = JSON.parse(await readSource("src-tauri", "capabilities", "default.json"));
  assert.deepEqual(capabilities.permissions, ["core:default"]);
  assert.equal(capabilities.remote, undefined);

  const main = await readSource("src-tauri", "src", "main.rs");
  // 菜单项是唯一的手动入口，production 查更新、beta 打开 Release 列表
  assert.match(main, /CHECK_UPDATE_ITEM/);
  assert.match(main, /update::check_now\(&menu_handle\)/);
  assert.match(main, /update::open_releases\(&menu_handle\)/);
});

test("the CHANGELOG tells 0.1.0 and 0.1.1 users they must download once by hand", async () => {
  // 那两版没有更新能力，指望它们自己升级是升不上来的；说明里必须写清楚。
  const changelog = await readSource("CHANGELOG.md");
  const section = changelog.slice(changelog.indexOf("## 0.1.2"), changelog.indexOf("## 0.1.1"));
  assert.match(section, /手动下载/);
  assert.match(section, /0\.1\.0/);
});
