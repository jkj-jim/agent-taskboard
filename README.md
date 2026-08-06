# Codex Taskboard

一个本地优先的议题看板，可在浏览器中运行，也可以通过独立 CDP 启动器或注入脚本嵌入 Codex。React UI 与捆绑的 Codex Skill 所使用的 `taskctl` CLI 共用同一套 HTTP API。

## 环境要求

- Node.js 22.5 或更高版本

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库存储在 `.data/taskboard.sqlite`。

如需在前端开发时启用实时重载：

```bash
npm run dev
```

Vite UI 运行在 <http://127.0.0.1:5173>，并将 API 请求代理到本地服务。

## 使用 CLI

在项目目录中运行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

如果希望直接在 shell 路径中使用 `taskctl`，请执行 `npm link`。通过 `CODEX_TASKBOARD_URL` 可让 CLI 指向其他本地或局域网服务。云部署通过回环地址上的配套服务和 `taskctl cloud login` 进行配置。

## 安装 Codex Skill

将 `skills/manage-taskboard` 复制或软链接到 Codex 的 skills 目录，然后新建一个 Codex 任务：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

该 Skill 会指导 Codex 检查议题、将其移至 `in_progress`、使用乐观版本控制、验证工作，然后移至 `in_review`；只有在用户明确确认验收或要求标记完成后，才会将议题移至 `done`。

## 嵌入 Codex

### 推荐方式：保留当前窗口，另开一个 Taskboard 窗口

保持现有 Codex 窗口打开。在 Taskboard 仓库中，以专用 CDP 端口启动第二个 Codex 实例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新 Codex 窗口出现后，在另一个终端运行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入面板期间请保持注入器终端运行。原 Codex 窗口不会受到影响，新窗口中会出现 Taskboard 侧边栏入口。如果端口 `9231` 已被占用，请在两条命令中改用同一个其他端口。

### 替代方式：使用独立启动器重启 Codex

退出所有正在运行的 Codex 窗口，然后运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

该命令会在需要时启动本地 Taskboard 服务，使用仅监听回环地址的 CDP 端口启动官方 macOS Codex 应用，在 Plugins 后注入一个原生风格的 Taskboard 入口，并持续监控服务和替换后的渲染器。打开 Taskboard 时，启动器会对固定的本地服务执行健康检查，在需要时重启服务，并重建加载失败的 iframe。使用嵌入面板期间请保持该命令运行。启动器不会修改 `ChatGPT.app` 或其中的 `app.asar`。

Codex 26.715.52143 自带的渲染器 CSP 会阻止任意 HTTP iframe。因此，启动器会启用 CDP CSP 绕过，重新加载该渲染器一次，安装 document-start 脚本，并等待 Taskboard OOPIF 真正加载完成。CDP 对同一台机器上的其他进程不设身份验证，因此启动器运行期间只应运行可信的本地代码。

如需向已通过其他方式启用 CDP 的 Codex 实例注入，请运行：

```bash
npm run codex:inject -- --port 9229 --open
```

该命令也会持续驻留，使注入后的标签页能在 Taskboard 服务退出后重启它。按 `Ctrl-C` 停止命令。

脚本会在 Codex 侧边栏中添加 Taskboard 入口，并让 iframe 覆盖 Codex 的完整主工作区，包括上下文标题栏区域，因此 Taskboard 自身的页头不会留下空白条带。完整的矩形页头位于 Electron 可拖拽层上方，并标记为 `no-drag`；由于激活 Taskboard 时会隐藏原生上下文操作，其自身操作可以使用正常的边缘内距，无需人为留出右侧空隙。原生侧边栏会保持挂载，之前选择的页面和上下文页头会暂时隐藏；选择其他 Codex 页面即可恢复。

“在对话中打开”会在存在对应原生 Codex 项目时选中该项目，并打开一个尚未发送的原生输入框，其中预填 `$manage-taskboard ISSUE-ID`。只有当对话真正处理该议题后，才会建立归属关系：`taskctl` 会读取 Codex 的 `CODEX_THREAD_ID`，并把该 ID 记录到议题或评论变更上。记录的 ID 可通过 Codex 原生路由桥点击打开。每个议题只能绑定一个 Git 分支或一个 worktree；可选项从所选 Codex 项目的仓库中扫描，而不是手动输入。该集成使用 Codex 现有的项目、输入框和路由标记；不会修改 React、替换 `fetch`、加载私有代码块，也不会编辑 Codex 数据文件。

如需使用其他 UI 源地址，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 绑定地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址 |

`npm start` 会输出本地 URL 和可用的局域网 URL。同一可信网络中的协作者可以打开其中一个局域网 URL，共用同一个 Taskboard 服务。任务、评论和附件变更会通过服务器发送事件广播到所有已打开的客户端；客户端重连时会执行完整刷新，因此不会遗漏断开期间发生的变更。协作者可以设置 `CODEX_TASKBOARD_URL=http://<host-ip>:47823`，让 `taskctl` 指向共享服务。

局域网模式没有账户身份验证：可信局域网中任何能访问该 URL 的人都可以读写 Taskboard。若部署到公网或云端，必须设置经过身份验证的部署边界。

## 通过 Cloudflare 共享

供两位互相信任的协作者使用时，Taskboard 可以部署在 Cloudflare 上：由 Worker Static Assets 和 API 路由提供服务，以 D1 作为权威业务数据库，并使用私有 R2 存储桶保存附件。该部署通过共享密码进行 HTTPS Basic Authentication，并会在全局修订版本发生变化后刷新已打开的看板。

每台设备各自维护项目检出路径映射，并继续使用本地配套服务提供 Codex、Git/worktree、Skill 和 MCP 能力。云模式绝不会回退到本地 SQLite 数据库，也不会同时写入两处。

有关所有者部署、配置现有 GitHub 安装、轮换密码、映射本地路径，以及一次性迁移本地数据的流程，请参阅[云协作](docs/cloud-collaboration.md)。

## 验证

```bash
npm run check
```

该命令会执行 TypeScript 检查、前端生产构建，以及服务器、CLI 和注入脚本测试套件。
