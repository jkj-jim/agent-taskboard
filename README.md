# Codex Taskboard

一个本地优先的议题看板，可在浏览器中运行，也可以通过独立 CDP 启动器或注入脚本嵌入 Codex。React UI 与捆绑的 Skill 所使用的 `taskctl` CLI 共用同一套 HTTP API。

看板同时支持 **Codex** 和 **Claude Code** 两个 Agent：议题的负责人可以选 Codex Agent 或 Claude Agent，选谁就由谁承接后续开发。两者的差异集中在 [`shared/agents.mjs`](shared/agents.mjs)（唯一事实源）与 [`server/agents/`](server/agents/)（每个 Agent 一个适配器）两处，其余代码一律查表，不判断 Agent 名字。

## 环境要求

- Node.js 22.5 或更高版本
- 使用 Codex Agent 时：`codex` CLI
- 使用 Claude Agent 时：`claude` CLI（Claude Code）

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

## 安装 Skill

`skills/manage-taskboard` 是一份两端共用的 Skill，把它软链到各自的 skills 目录即可：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard

ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.claude/skills/manage-taskboard
```

该 Skill 会指导 Agent 检查议题、将其移至 `in_progress`、使用乐观版本控制、验证工作，然后移至 `in_review`；只有在用户明确确认验收或要求标记完成后，才会将议题移至 `done`。Skill 内的 `agents/openai.yaml` 只对 Codex 生效，Claude Code 会忽略它、只读 `SKILL.md` 的 frontmatter。

## 配合 Claude Code 使用

### 一次性准备

1. **单独登录 CLI。** Claude 桌面端和 `claude` CLI 是两套登录态，桌面端已登录**不代表** CLI 可用。看板调用的是 CLI：

   ```bash
   claude auth login
   claude auth status   # loggedIn 必须为 true
   ```

   看板会在 `GET /api/local/agents` 里如实上报每个 Agent 的可用性与登录状态，未登录时界面会提示，而不是等到发消息才失败。

2. **确认项目能解析到本机目录。** 工作区解析与 Agent 无关，按顺序取三个来源：Codex 应用维护的本机项目路径表、项目自身的 `workspacePath`、以及 `taskctl project map` 写下的设备映射。多数项目会自动命中；若报 `PROJECT_WORKSPACE_UNAVAILABLE`，显式映射一次即可：

   ```bash
   npm run taskctl -- project map <project-id> --workspace-path /absolute/path/to/repo
   ```

3. **按上一节把 Skill 软链到 `~/.claude/skills/`。**

`taskctl` 不需要 `npm link`：服务会在 `.data/bin/` 下生成一个 shim 并拼进 Agent 子进程的 `PATH`，同时注入 `CODEX_TASKBOARD_URL` 指向自己，Agent 直接 `taskctl issue get ABC-1 --json` 即可。

### 三种用法

**自动启动 Agent。** 本机通过 `localhost` / `127.0.0.1` 打开的看板中，用户把 Codex Agent 负责的议题移入“进行中”，或在“进行中”改派给 Codex Agent 时，本地服务会在已经运行且挂载兼容注入器的 Codex 客户端中后台创建并提交原生任务。它不会启动或激活 Codex 应用，不会改变浏览器焦点，也不会降级为 `codex exec`；客户端或注入器未就绪时只保留议题状态并提示。Claude Agent 仍由看板现有的 CLI 适配器自动启动。

**在对话中打开。** Codex Agent 会通过同一个本机桥创建原生 Codex 任务并写回真实任务 ID：嵌入看板会停留在新任务，同机普通浏览器会在创建成功后通过 `codex://` 将客户端路由到它。是否把已经运行的 Codex 窗口提到最前由客户端当前版本决定；Taskboard 不调用系统窗口激活接口。Claude Agent 继续走 `claude://code/new`，并把工作目录和预填指令一起带过去。远程 Cloud 页面不能直接控制桌面客户端，需要回到运行 Codex 的电脑操作。

**在看板内直接跑。** AI 面板新建会话时选 Claude，服务会以 `claude -p --output-format stream-json` 驱动，工具调用、文件改动、token 用量都会实时显示在面板里。会话 id 在第一轮执行前就已生成（`--session-id`），因此议题一开始就能关联和跳转。

**关联并唤起已有会话。** 议题详情下方列出该议题每个 Agent 的当前会话，点击即可在对应客户端中打开（Claude 走 `claude://resume?session=<id>`，会把该 CLI 会话导入桌面端）。旁边的「关联已有会话…」下拉列出该项目目录下的所有 Claude Code 会话（活跃的带 ●），可以把你自己开的会话挂到议题上。

会话归属是自动的：Agent 通过 `taskctl` 写议题或评论时，`taskctl` 读取 `CODEX_THREAD_ID` 或 `CLAUDE_CODE_SESSION_ID` 判断自己是谁，看板据此为每个议题保留**每个 Agent 各一条**当前会话。

### 注意事项

- **Claude Code 没有 OS 级沙箱。** Codex 的 `workspace-write` 由操作系统限制写入范围，Claude Code 没有等价机制；无头模式下若只放行编辑（`acceptEdits`），所有命令都会被拒绝而让 Agent 空转。因此看板把 `workspace-write` 和 `danger-full-access` 都映射为 `bypassPermissions`，**该档位等同全放行、命令不会逐条审批**，界面上有对应提示。需要逐条审批时应使用 `read-only`（对应 plan 模式），或等待后续接入审批直通。
- **模型目录是写死的。** Claude 没有 `codex debug models` 的等价接口，可选模型维护在 `server/agents/claude.mjs` 的 `CLAUDE_MODELS` 里，新模型发布后需要手动补一行。
- **深链需要 Claude 桌面端。** `claude://resume` / `claude://code/new` 由桌面端注册处理；首次在一个新目录里打开会话时，Claude Code 会弹出「是否信任该文件夹」，确认一次即可。
- **桌面端打开 CLI 会话是「导入副本」，不是接管。** 终端里的 `claude` 和桌面端各自维护会话列表：桌面端起的会话直接写进 `~/.claude/projects/`，CLI 能看到；反过来 CLI 会话要点一次「在 Claude Code 中打开」，桌面端才会把它导入自己的列表（同一会话只导入一次，重复点击会回到同一个窗口）。**若该会话此刻正开在某个终端里**（选项里标了「运行中」），导入后两边会各写各的，看起来就像多了一个内容相同的会话；这类会话建议在原终端里继续，或等它结束再从看板打开。
- **定时自动任务和配额感知只有 Codex 有。** 这两项依赖 Codex 的原生接口，Claude 侧没有等价能力。
- **不要在 Claude Code 会话内启动看板服务。** 子进程会继承宿主的 `CLAUDE_CODE_*` 环境变量，容易出现认证异常；请在普通终端里 `npm start`。

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

Codex 原生启动由本地 Taskboard 服务串行执行：服务连接已经运行且保有注入器心跳的客户端，切换议题对应的项目或 worktree，退出意外激活的 Plan mode，插入真实的 `$manage-taskboard` Skill mention 和议题指令，校验后提交，并把新生成的原生任务 ID 以 compare-and-set 方式写回议题。后台启动会恢复此前的 Codex 任务和 Taskboard；用户主动点击“在对话中打开”时才停留或跳转到新任务。浏览器只访问 loopback Taskboard API，不接触 CDP 端口；整个流程不会调用系统窗口激活接口，也不会启动第二个 app-server 或 `codex exec`。每个议题仍只能绑定一个 Git 分支或一个 worktree，可选项从所选 Codex 项目的仓库中扫描。

如需使用其他 UI 源地址，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | HTTP 绑定地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址；服务会自动注入给它启动的 Agent |
| `CODEX_EXECUTABLE` | `codex` | Codex CLI 可执行文件 |
| `CODEX_HOME` | `~/.codex` | Codex 状态目录 |
| `CLAUDE_EXECUTABLE` | `claude` | Claude Code CLI 可执行文件 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 状态目录（Skill、会话记录） |

`taskctl` 通过 `CODEX_THREAD_ID` 或 `CLAUDE_CODE_SESSION_ID` 判断自己运行在哪个 Agent 里；两者都没有时用 `--thread-id` 指定会话，用 `--agent codex|claude` 覆盖自动判断。

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
