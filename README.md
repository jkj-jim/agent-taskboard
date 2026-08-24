# Agent Taskboard

一个本地优先的任务看板，可在浏览器中运行，也可以通过独立 CDP 启动器或注入脚本嵌入 Codex。React UI 与捆绑的 Skill 所使用的 `taskctl` CLI 共用同一套 HTTP API。

看板同时支持 **Codex** 和 **Claude Code** 两个 Agent：任务的负责人可以选 Codex Agent 或 Claude Agent，选谁就由谁承接后续开发。两者的差异集中在 [`shared/agents.mjs`](shared/agents.mjs)（唯一事实源）与 [`server/agents/`](server/agents/)（每个 Agent 一个适配器）两处，其余代码一律查表，不判断 Agent 名字。

想快速理解“用户派发任务 → Agent 读取与执行 → 评论交付 → 用户验收”的完整逻辑，请看[《Agent 任务运行机制》](document/agent-task-interaction-mechanism.md)。

## 环境要求

- Node.js 22.16 或更高版本（`.nvmrc` 固定了随包分发所用的版本）
- 使用 Codex Agent 时：`codex` CLI
- 使用 Claude Agent 时：`claude` CLI（Claude Code）

## 桌面应用（macOS 14+ Apple Silicon）

从 [Releases](https://github.com/jkj-jim/agent-taskboard/releases) 下载最新版本的 DMG。安装包自带 Node 运行时，本机装没装 Node 都不影响。

**用访达把 `Agent Taskboard.app` 拖进「应用程序」再打开**，不要在磁盘映像里直接双击——带隔离属性的应用会被 macOS 挪到临时目录下启动（App Translocation），内置服务起不来。首次打开的放行步骤见每个 Release 里的《首次打开》一节。

数据落在 `~/Library/Application Support/io.github.jkj-jim.agenttaskboard/profiles/production/`，卸载（删除 `.app`）不会触碰它。正式版与预发布版各用一份独立数据目录和端口，互不读写。

应用内的更新走 GitHub Releases：稳定版会自动提示，预发布版只提供手动下载。

## 三套实例共存

同一台机器上可以同时跑三份看板，各有独立数据库、端口和 App Data：

| | 端口 | 数据 | 用途 |
| --- | --- | --- | --- |
| 安装版（正式） | 47824 | `~/Library/Application Support/io.github.jkj-jim.agenttaskboard/profiles/production/` | 日常使用，真实任务放这里 |
| 安装版（预发布） | 47825 | 同上但 `profiles/beta/` | 验发布产物，不碰正式数据也不写共享 skill |
| `npm start` / `npm run dev` | 47823 | 仓库下的 `.data/` | 开发与调试，数据可以随便删 |

**已经隔离好、不用操心的**：数据库、附件、日志、`taskctl` shim、WorkBuddy 的 MCP 条目（`agent-taskboard` / `agent-taskboard-beta` / `taskboard` 三个名字）。一个看板派发出去的 Agent，它的 `PATH` 里排在最前的是那个看板自己的 shim，shim 又钉住了 `AGENT_TASKBOARD_URL`，所以 Agent 写回的一定是派它出来的那块板子。

**真正共用、需要约定的三件事**：

### 1. Skill 目录

`~/.agents/skills/manage-taskboard`（Codex 与 WorkBuddy 扫描）和 `~/.claude/skills/manage-taskboard`（Claude 扫描）三套实例共用一份。开发机上它们通常是软链，指向仓库的 `skills/manage-taskboard`。

约定：**Skill 的唯一事实源就是仓库工作树，改它走正常的改代码流程。**

看板里有一个「应用模板」的动作，但入口是条件性的：只有当 Claude 发现不了 skill（`~/.claude/skills/manage-taskboard` 不存在或没指向已安装的 skill）时，顶部状态区的 Claude 那一格才会出现「查看 skill 状态」，点开的弹层里才有它。软链正常时根本看不到这个按钮。

一旦走到那一步，在开发机上点它等于把模板逐文件写进被 git 跟踪的文件，表现成一堆没人做过的本地改动。这条路现在被挡住了：`applySkillTemplate` 解析 realpath 后向上找 `.git`，命中就返回 `SKILL_POINTS_AT_WORKTREE`，让你回仓库改。

代价是：改了 skill，三套实例的 Agent 立刻都用新的。这在开发期通常正是你想要的；要验「新用户装上后拿到的 skill 长什么样」，用预发布版看差异（它只读），不要在正式版里应用。

### 2. 手敲 `taskctl` 默认打到哪

`taskctl` 不带环境变量时用 `http://127.0.0.1:47823`，也就是**开发实例**。在终端里手敲命令查任务，查的是 dev 的库，不是安装版的。要指向安装版：

```bash
AGENT_TASKBOARD_URL=http://127.0.0.1:47824 npm run taskctl -- issue list --project <id>
```

Agent 自己不需要设这个变量，shim 已经钉好了。

### 3. Codex 客户端只有一个

`npm run codex` 起的是带隔离 user-data-dir 的独立 Codex 实例（CDP `9231`）；安装版不自己启动 Codex，而是连接已经在跑且挂了注入器的客户端。所以两个看板会去驱动同一个 Codex 实例——同一时刻只让一个看板派发 Codex 任务。Claude 与 WorkBuddy 没这个限制。

`CODEX_HOME` 三套实例共用且**故意不隔离**：按 profile 覆盖它会让 Codex 回到未登录状态。

### 日常怎么走

- 真实任务放安装版（47824）。开发时的脏数据留在 dev（47823），删掉重来没有代价。
- 改完代码先在 dev 里跑通，再打包装一次，验安装版的行为。
- 验发布产物（签名、更新、首次打开）用预发布版，它读不到也写不了正式数据。
- 发版前 `npm run check`；产物相关的改动另外看 `.github/workflows/macos-verify.yml` 跑出来的结果。

## 本地运行（开发）

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库存储在 `.data/taskboard.sqlite`。这条路径与桌面应用各用一份数据，互不影响。

## 项目

**一个项目就是一个本地文件夹。** 侧边栏「项目」旁的 `+` 和项目首页右上角的「新建项目」都会弹出系统的文件夹选择框，选中即建好项目：项目名取文件夹名，路径即工作区。选到一个已经属于某个项目的文件夹时，直接打开那个项目，不会建出第二个。

选择框由本地服务弹出，所以浏览器、Codex 和 WorkBuddy 三种打开方式的行为完全一致——网页自身拿不到文件夹的绝对路径，宿主的选择器又只在注入时可用。

Codex 侧边栏里已有的项目会一并列在项目首页，点开即接管，两边共用同一个项目 id。反过来，当任务在一个 Codex 还不认识的文件夹里启动会话时，看板会让 Codex 为该文件夹补建项目；文件夹相同即同一个项目，Claude 与 WorkBuddy 同理，前者以该目录为工作目录，后者以它为工作空间。

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

如果希望直接在 shell 路径中使用 `taskctl`，请执行 `npm link`。通过 `AGENT_TASKBOARD_URL` 可让 CLI 指向其他本地或局域网服务。云部署通过回环地址上的配套服务和 `taskctl cloud login` 进行配置。

## 安装 Skill

`skills/manage-taskboard` 是一份两端共用的 Skill，把它软链到各自的 skills 目录即可：

```bash
ln -s /absolute/path/to/agent-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard

ln -s /absolute/path/to/agent-taskboard/skills/manage-taskboard \
  ~/.claude/skills/manage-taskboard
```

该 Skill 会指导 Agent 检查任务、将其移至 `in_progress`、使用乐观版本控制、验证工作，然后移至 `in_review`；只有在用户明确确认验收或要求标记完成后，才会将任务移至 `done`。Skill 内的 `agents/openai.yaml` 只对 Codex 生效，Claude Code 会忽略它、只读 `SKILL.md` 的 frontmatter。

## 配合 Claude Code 使用

### 一次性准备

1. **单独登录 CLI。** Claude 桌面端和 `claude` CLI 是两套登录态，桌面端已登录**不代表** CLI 可用。看板调用的是 CLI：

   ```bash
   claude auth login
   claude auth status   # loggedIn 必须为 true
   ```

   看板顶部的状态区会展示三个 Agent 的实时可用状态，数据来自 `GET /api/local/agents`。未登录时那里会直接给出对应动作（Claude 是复制 `claude auth login`，看板不会代跑终端命令）。新任务只能分配给状态为「可用」的 Agent；已有任务的负责人不受状态变化影响。

2. **确认项目能解析到本机目录。** 工作区解析与 Agent 无关，按顺序取三个来源：Codex 应用维护的本机项目路径表、项目自身的 `workspacePath`（从文件夹新建的项目自带）、以及 `taskctl project map` 写下的设备映射。多数项目会自动命中；若报 `PROJECT_WORKSPACE_UNAVAILABLE`，显式映射一次即可：

   ```bash
   npm run taskctl -- project map <project-id> --workspace-path /absolute/path/to/repo
   ```

3. **按上一节把 Skill 软链到 `~/.claude/skills/`。**

`taskctl` 不需要 `npm link`：服务会在 `.data/bin/` 下生成一个带当前服务地址的 shim，并拼进 Agent 子进程的 `PATH`。Agent 开工时可直接用 `taskctl issue brief ABC-1 --json` 一次读取任务、全部评论与附件；原生 Codex 唤起指令会使用这个 shim 的绝对路径，非默认端口也不会连错服务。

`taskctl issue list --project <id> --json` 默认是供 Agent 选候选任务的精简索引：只列活动状态，描述最多返回 50 个字符。明确查看历史时用 `--status done`；统计、导出或诊断才使用 `--all-statuses --full`。选中任务后用 `issue brief` 读取完整执行上下文。

### 三种用法

**自动启动 Agent。** 本机通过 `localhost` / `127.0.0.1` 打开的看板中，用户把 Codex Agent 负责的任务移入“进行中”，或在“进行中”改派给 Codex Agent 时，本地服务会在已经运行且挂载兼容注入器的 Codex 客户端中后台创建并提交原生任务。它不会启动或激活 Codex 应用，不会改变浏览器焦点，也不会降级为 `codex exec`；客户端或注入器未就绪时只保留任务状态并提示。Claude Agent 仍由看板现有的 CLI 适配器自动启动。

**在对话中打开。** 这是用户主动编辑入口：Codex Agent 会通过本机桥打开新的原生输入框，插入真实的 `$manage-taskboard` Skill mention 和任务指令，但不会自动发送。你可以修改或补充提示词，再自己点击发送。首次发送前 Codex 尚未生成正式会话 ID，因此看板不会提前绑定会话；Agent 后续通过 `taskctl` 写评论或任务时会自动记录当前会话。Claude Agent 继续走 `claude://code/new`，并把工作目录和预填指令一起带过去。远程 Cloud 页面不能直接控制桌面客户端，需要回到运行 Codex 的电脑操作。

**在看板内直接跑。** 把 Claude Agent 负责的任务移入「进行中」时，服务会以 `claude -p --output-format stream-json` 起一轮。会话 id 在第一轮执行前就已生成（`--session-id`），因此任务一开始就能关联和跳转。这类会话和你自己开的会话一样落在项目工作区下，在该目录里敲 `claude` 后 `/resume` 就能接着聊。

看板跑出来的会话会在任务详情的会话入口旁多一个按钮，点开是这一轮的对话记录：工具调用、文件改动、报错都在里面，运行中可以中断，也可以直接追问让它接着改。在别的客户端里唤起的会话（Codex 原生、WorkBuddy）没有这个按钮，因为看板手里没有它们的过程。

**关联并唤起已有会话。** 任务详情下方列出该任务每个 Agent 的当前会话，点击即可在对应客户端中打开（Claude 走 `claude://resume?session=<id>`，会把该 CLI 会话导入桌面端）。旁边的「关联已有会话…」下拉列出该项目目录下的所有 Claude Code 会话（活跃的带 ●），可以把你自己开的会话挂到任务上。

会话归属是自动的：Agent 通过 `taskctl` 写任务或评论时，`taskctl` 读取 `CODEX_THREAD_ID` 或 `CLAUDE_CODE_SESSION_ID` 判断自己是谁，看板据此为每个任务保留**每个 Agent 各一条**当前会话。

### 注意事项

- **Claude Code 没有 OS 级沙箱，而且看板跑的就是全放行的一档。** Codex 的 `workspace-write` 由操作系统限制写入范围，Claude Code 没有等价机制；无头模式下若只放行编辑（`acceptEdits`），所有命令都会被拒绝而让 Agent 空转。所以看板一律用 `workspace-write` 这一档跑：Codex 侧它是真沙箱加自动审阅，Claude 侧它等同 `bypassPermissions`，**命令不逐条审批**。这一档不可选——三档命名照搬自 Codex 的审批模型，两家实现并不对应，交给用户选只会误导。
- **模型目录是写死的。** Claude 没有 `codex debug models` 的等价接口，可选模型维护在 `server/agents/claude.mjs` 的 `CLAUDE_MODELS` 里，新模型发布后需要手动补一行。
- **深链需要 Claude 桌面端。** `claude://resume` / `claude://code/new` 由桌面端注册处理；首次在一个新目录里打开会话时，Claude Code 会弹出「是否信任该文件夹」，确认一次即可。
- **桌面端打开 CLI 会话是「导入副本」，不是接管。** 终端里的 `claude` 和桌面端各自维护会话列表：桌面端起的会话直接写进 `~/.claude/projects/`，CLI 能看到；反过来 CLI 会话要点一次「在 Claude Code 中打开」，桌面端才会把它导入自己的列表（同一会话只导入一次，重复点击会回到同一个窗口）。**若该会话此刻正开在某个终端里**（选项里标了「运行中」），导入后两边会各写各的，看起来就像多了一个内容相同的会话；这类会话建议在原终端里继续，或等它结束再从看板打开。
- **定时自动任务和配额感知只有 Codex 有。** 这两项依赖 Codex 的原生接口，Claude 侧没有等价能力。
- **不要在 Claude Code 会话内启动看板服务。** 子进程会继承宿主的 `CLAUDE_CODE_*` 环境变量，容易出现认证异常；请在普通终端里 `npm start`。

## 配合 WorkBuddy 使用

WorkBuddy 没有命令行，看板只能在它自己的客户端里唤起会话，任务读写走 MCP。

### 一次性准备

```bash
npm run workbuddy
```

它会退出正在运行的 WorkBuddy，再带调试端口重新启动（默认 `9240`，可用 `--port` 改）。看板需要这个端口才能驱动它新建会话、预填任务指令并提交。**每次要用 WorkBuddy 跑任务前都用这条命令启动它**，从「应用程序」直接打开的实例没有该端口。

首次派发任务时，看板会自动把自己的 MCP 地址写进 `~/.workbuddy/mcp.json`，并把 `manage-taskboard` 技能同步到 `~/.workbuddy/skills/`。然后需要你在 WorkBuddy 里做一次授权：**专家·技能·连接器 → 连接器 → MCP 服务管理 → 启用 `taskboard` → 重启 WorkBuddy**。之后不再需要重复。

已经存在且仍能响应的 `taskboard` 注册条目不会被覆盖，所以你自己配好的地址不会被改掉。

### 派发任务

- **自动**：把负责人设为 WorkBuddy Agent，再把任务拖到「进行中」。看板会新建会话、填入指令并直接提交，然后把会话 id 绑定到任务。
- **手动**：在任务详情里点「在对话中打开」。看板同样新建会话并预填指令，但不提交，由你确认后回车。
- **回到已有会话**：任务上的会话入口会让看板把对应会话重新置前（WorkBuddy 没有 URL scheme，只能这样打开）。

Agent 通过 `taskboard_get_task` / `taskboard_add_comment` / `taskboard_move_task` 读写看板，写入记在 WorkBuddy Agent 名下。

### 注意事项

- **WorkBuddy 的会话没有对话记录可看。** 它没有无头模式，会话跑在它自己的客户端里，所以任务详情上只有「在 WorkBuddy 中打开」，没有查看记录的入口。
- **任务描述里不要写看板地址。** WorkBuddy 的网关会拒绝内容中含 `http://127.0.0.1:<端口>` 的请求（错误码 11133）。地址只存在于 MCP 配置里，指令里不出现。
- **工作目录是它自己的沙箱。** 每个会话跑在 `~/WorkBuddy/<时间戳>` 下，看板无法指定项目 checkout。需要它在仓库里干活时，要在 WorkBuddy 侧用「选择工作空间」指定。
- **停止 WorkBuddy 要走它自己的退出流程。** 直接发信号会让它卡在退出确认里，界面停在启动画面且无法关闭。

## 嵌入 Codex

### 推荐方式：一条命令打开独立的 Taskboard 窗口

保持现有 Codex 窗口打开，在 Taskboard 仓库中运行：

```bash
npm run codex
```

该命令会在需要时把本地 Taskboard 服务启动在回环地址，通过专用 CDP 端口 `9231` 新开一个官方 macOS Codex 实例，完成注入并直接显示 Taskboard。无需退出已经打开的普通 Codex：启动器使用 `.data/codex-user-data` 隔离 Electron 的单实例锁，同时继续读取同一份 Codex 账号、项目和任务数据；原窗口及其中的会话不会关闭或改变。若 `9231` 上已经有这个可调试实例，启动器会直接复用。冷启动时会在统一时间窗内等待同一组主 renderer 持续稳定；如果注入期间发生 frame swap 或 WebSocket 替换，则重新等待新 renderer 后继续，不需要再次运行命令。之后还会持续监控服务和替换后的渲染器，在需要时重启服务并重建加载失败的 iframe。使用嵌入面板期间请保持该命令运行；按 `Ctrl-C` 会停止监控并关闭本次启动的独立 Codex，原 Codex 不受影响。启动器不会修改 `ChatGPT.app` 或其中的 `app.asar`。

Codex 26.715.52143 自带的渲染器 CSP 会阻止任意 HTTP iframe。因此，启动器会启用 CDP CSP 绕过，重新加载该渲染器一次，安装 document-start 脚本，并等待 Taskboard OOPIF 真正加载完成。CDP 对同一台机器上的其他进程不设身份验证，因此启动器运行期间只应运行可信的本地代码。

### 高级方式：连接手动启用 CDP 的 Codex

如需使用其他端口，先自行用相同端口启动 Codex，再运行：

```bash
npm run codex:inject -- --port <端口> --open
```

该命令也会持续驻留，使注入后的标签页能在 Taskboard 服务退出后重启它。按 `Ctrl-C` 停止命令。

驻留注入器会定期检查注入脚本的内容哈希；源码变化时在同一进程内重新挂载，不需要重启 watcher。`npm run build` 只刷新已经打开的 Taskboard iframe，不会再终止前台的 `codex:inject` 命令或把它替换成无日志后台进程。watcher 只连接 Codex 主窗口，不处理头像浮层、语音输入等辅助窗口；单次 CDP 心跳超时时会丢弃旧连接并自动重连，不让存活但失响的连接卡住整个循环。如果面板仍提示“注入器心跳已停止”，应回到终端确认 watcher 是否退出或持续报连接错误，再重新执行上面的命令。

脚本会在 Codex 侧边栏中添加 Taskboard 入口，并让 iframe 覆盖 Codex 的完整主工作区，包括上下文标题栏区域，因此 Taskboard 自身的页头不会留下空白条带。完整的矩形页头位于 Electron 可拖拽层上方，并标记为 `no-drag`；由于激活 Taskboard 时会隐藏原生上下文操作，其自身操作可以使用正常的边缘内距，无需人为留出右侧空隙。原生侧边栏会保持挂载，之前选择的页面和上下文页头会暂时隐藏；选择其他 Codex 页面即可恢复。

Codex 原生启动由本地 Taskboard 服务串行执行：服务连接已经运行且保有注入器心跳的客户端，切换任务对应的项目或 worktree，退出意外激活的 Plan mode，并插入真实的 `$manage-taskboard` Skill mention 和任务指令。启动前只检查注入器、心跳、本机桥和侧栏；新对话输入框在导航后单独等待，避免把页面切换中的临时 DOM 缺失误报成不兼容。状态变更触发的后台派发会在校验后自动提交，把新生成的原生任务 ID 以 compare-and-set 方式写回任务，再恢复此前的 Codex 任务和 Taskboard；用户主动点击“在对话中打开”时只保留可编辑的预填内容，不提交也不提前绑定会话。浏览器只访问 loopback Taskboard API，不接触 CDP 端口；整个流程不会调用系统窗口激活接口，也不会启动第二个 app-server 或 `codex exec`。每个任务仍只能绑定一个 Git 分支或一个 worktree，可选项从所选 Codex 项目的仓库中扫描。

如需使用其他 UI 源地址，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENT_TASKBOARD_HOST` | `0.0.0.0` | HTTP 绑定地址；使用 `127.0.0.1` 可禁用局域网访问 |
| `AGENT_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `AGENT_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `AGENT_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址；服务会自动注入给它启动的 Agent |
| `CODEX_EXECUTABLE` | `codex` | Codex CLI 可执行文件 |
| `CODEX_HOME` | `~/.codex` | Codex 状态目录 |
| `CLAUDE_EXECUTABLE` | `claude` | Claude Code CLI 可执行文件 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code 状态目录（Skill、会话记录） |

以上 `AGENT_TASKBOARD_*` 的旧名 `CODEX_TASKBOARD_*` 仍然识别，规范名优先。留着旧名是因为它会写在磁盘上的两处：服务为 Agent 生成的 `taskctl` shim 脚本，以及协作者按旧文档配过的 shell profile。

`taskctl` 通过 `CODEX_THREAD_ID` 或 `CLAUDE_CODE_SESSION_ID` 判断自己运行在哪个 Agent 里；两者都没有时用 `--thread-id` 指定会话，用 `--agent codex|claude` 覆盖自动判断。

`npm start` 会输出本地 URL 和可用的局域网 URL。同一可信网络中的协作者可以打开其中一个局域网 URL，共用同一个 Taskboard 服务。任务、评论和附件变更会通过服务器发送事件广播到所有已打开的客户端；客户端重连时会执行完整刷新，因此不会遗漏断开期间发生的变更。协作者可以设置 `AGENT_TASKBOARD_URL=http://<host-ip>:47823`，让 `taskctl` 指向共享服务。

局域网模式没有账户身份验证：可信局域网中任何能访问该 URL 的人都可以读写 Taskboard。若部署到公网或云端，必须设置经过身份验证的部署边界。

## 通过 Cloudflare 共享

供两位互相信任的协作者使用时，Taskboard 可以部署在 Cloudflare 上：由 Worker Static Assets 和 API 路由提供服务，以 D1 作为权威业务数据库，并使用私有 R2 存储桶保存附件。该部署通过共享密码进行 HTTPS Basic Authentication，并会在全局修订版本发生变化后刷新已打开的看板。

每台设备各自维护项目检出路径映射，并继续使用本地配套服务提供 Codex、Git/worktree、Skill 和 MCP 能力。云模式绝不会回退到本地 SQLite 数据库，也不会同时写入两处。

有关所有者部署、配置现有 GitHub 安装、轮换密码、映射本地路径，以及一次性迁移本地数据的流程，请参阅[云协作](document/cloud-collaboration.md)。

## 验证

```bash
npm run check
```

该命令会执行 TypeScript 检查、前端生产构建，以及服务器、CLI 和注入脚本测试套件。
