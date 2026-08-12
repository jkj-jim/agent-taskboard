# 多宿主注入可行性实测

面板要脱离 Codex 单一宿主，前提是能在别的 Agent 客户端里注入并渲染。本文记录 2026-08-11 在本机对 WorkBuddy 与 TraeWork CN 的实测结论，用于判断「独立应用 + 宿主投放」这条路能不能走通。

## 结论

两个宿主都能注入面板并程序化唤起会话，均有截图与判据数据。**唯一实质性阻塞在 Agent 回写看板这一环**：WorkBuddy 的 shell 工具可用，但只要一轮内容里出现 `http://127.0.0.1:<port>`，请求就被它的网关以 `11133 请求信息无效` 拒绝；而 `.mcp.json` 不是用户注册入口，加进去的 MCP server 不会传给 Agent 引擎。

| 宿主 | 运行时 | 开调试端口 | CSP 拦 iframe | 面板渲染 | 会话唤起 | 回写看板 |
| --- | --- | --- | --- | --- | --- | --- |
| WorkBuddy 5.3.11 | Electron 37.10.3 / Chrome 138 | 环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT` | 不拦 | 成功 | 端到端成功 | 阻塞 |
| TraeWork CN 0.1.48 | Electron 39.2.7 / Chrome 142 | 命令行 `--remote-debugging-port` | 不拦 | 成功 | 端到端成功 | 未验证 |

TraeWork CN 的应用包名仍是 `TRAE SOLO CN.app`，`product.json` 的 `appVersion` 已是 `0.1.48`，UI 显示名为 TraeWork CN。按包名定位会找错，宿主发现逻辑要同时认包名和 product 名。

## 环境

- macOS Darwin arm64 25.5.0
- 任务面板服务：`node server/index.mjs`，`http://127.0.0.1:47823`
- CDP 客户端复用仓库内的 `shared/codex-cdp.mjs`，未引入新依赖

## 各项验证

### 1. 运行时类型

两个宿主都是 Electron，`Contents/Frameworks/Electron Framework.framework` 均存在。

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
  "/Applications/WorkBuddy.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"
```

### 2. 远程调试端口

**WorkBuddy** 主进程自带官方开关，不需要命令行参数：

```js
var cdpPort = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
if (cdpPort && /^\d+$/.test(cdpPort)) {
  electron.app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
  require_logger.mainLog.info(`[WorkBuddy] CDP remote debugging enabled on port ${cdpPort}`);
```

开启后 `~/Library/Logs/WorkBuddy/main.log` 会记录该行，同时另一段代码检测到 CDP 模式后会打开性能分析菜单。实测：

```bash
WORKBUDDY_REMOTE_DEBUGGING_PORT=9240 /Applications/WorkBuddy.app/Contents/MacOS/Electron
curl -s --noproxy '*' http://127.0.0.1:9240/json/version
```

**TraeWork CN** 走 Chromium 标准参数，启动日志直接打印 `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`：

```bash
"/Applications/TRAE SOLO CN.app/Contents/MacOS/Electron" --remote-debugging-port=9242
```

### 3. 单实例锁的差异

这是两个宿主最重要的行为差异，直接决定启动器的设计。

- **WorkBuddy**：`--user-data-dir` 不能绕过单实例锁。带独立 profile 启动的第二个实例会写下「CDP enabled」日志后退出，端口不会真正监听。必须先让已有实例退出，由启动器自己拉起 WorkBuddy，才能拿到调试端口。
- **TraeWork CN**：`--user-data-dir` 可以起独立实例，与用户正在使用的实例并存，调试端口正常监听。代价是独立 profile 未登录，只能看到 setup 页。要拿到真实界面得用真实 profile，也就同样需要独占启动。

结论：两个宿主的启动器都要**拥有宿主进程的启动权**，这和上游 Codex 启动器的做法一致。若想不打断用户已开的会话，只有 TraeWork CN 可以走「独立 profile + 导入登录态」的路线（上游 `importCodexBrowserProfile` 就是这个思路）。

另外必须注意退出路径。实测中用 `SIGTERM`/`SIGKILL` 结束宿主会有副作用：TraeWork CN 会弹出「窗口意外终止（原因 killed，代码 15）」，该模态框还会挡住后续的 AppleScript 退出；WorkBuddy 则可能卡在退出确认循环里，日志反复打印 `promptDocumentPreviewQuitConfirmation: enter {isQuitting: true, userConfirmedDocumentPreviewQuit: false}`，界面停在启动画面且无法关闭，只能结束整个进程树再重新拉起。启动器停止宿主时必须走应用自己的退出流程，不能直接发信号。

### 4. CSP 是否拦截 localhost iframe

| 宿主 | 宿主页面 | CSP |
| --- | --- | --- |
| WorkBuddy | `file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html` | 无 CSP meta |
| TraeWork CN | `vscode-file://vscode-app/.../solo/solo-lite.html` | 无 CSP meta |

两个宿主的主渲染页都没有 CSP meta，注入 `http://127.0.0.1` 的 iframe 不受限制。

WorkBuddy 确实有删除 `content-security-policy` 响应头的代码，但作用域只限 `https://open.weixin.qq.com/*` 和 `https://localhost.weixin.qq.com:*/*`，与主界面无关。它主界面的 CSP 之所以不构成障碍，是因为宿主外壳是本地 `file://` 页面且没有 CSP meta。

### 5. 渲染实证

单看 iframe 的 `load` 事件会得出错误结论——服务未启动时 `ERR_CONNECTION_REFUSED` 的错误页同样会触发 `load`。本次实测踩过这个坑，最终用两种独立证据确认：

其一，宿主渲染进程能真正取到面板内容。在 WorkBuddy 渲染进程里 `fetch` 面板地址返回 `status 200`、`642` 字节、包含 `id="root"`。

其二，注入 iframe 后用 `Page.captureScreenshot` 截图，肉眼确认面板在宿主窗口内渲染：WorkBuddy 与 TraeWork CN 的截图中都能看到面板的「任务面板」侧栏、「首页 › Local」面包屑、「任务看板」视图标签和「隐藏列」。

跨源限制需要记住：宿主页面是 `file://` 或 `vscode-file://`，与 `http://127.0.0.1` 不同源，父页面拿不到 `iframe.contentDocument`。宿主与面板之间只能用 `postMessage` 通信，不能直接操作对方 DOM。上游为 Codex 做的 blob frame 和 host binding 就是为了绕开这一点。

### 6. 入口锚点

上游的 WorkBuddy 注入脚本靠克隆一个原生 tab 造入口，本次确认这些锚点在真实界面里存在。

WorkBuddy：`.conversation-sidebar` 命中 1 个，`[role="tab"]` 命中 10 个，标签为 `新建任务`、`助理`、`项目`、`专家·技能·连接器`、`自动化`、`资料库`、`更多应用·灵感`、`日常办公`、`代码开发`、`设计创意`。上游脚本查找的「自动化」标签确实在。

TraeWork CN：`[role="tab"]` 命中 3 个，标签为 `Work`、`Code`、`Design`；左侧还有 `新建任务`、`插件市场`、`自动化`、`办公助理`、`模板库` 一列入口。`.activitybar` 和 `.monaco-workbench` 都不命中——SOLO 界面不是标准 VS Code workbench，不能套用 VS Code 的选择器。

## 业务闭环所需能力

面板能渲染只是第一步。要把宿主当成 Agent 用，还需要「新建会话 → 预填任务 → 提交运行 → 会话与任务绑定 → Agent 回写看板」这条链。下表是对照现有 Codex 实现逐项实测的结果。

| 能力 | Codex（`server/codex-desktop-controller.mjs` 现有实现） | WorkBuddy | TraeWork CN |
| --- | --- | --- | --- |
| 新建会话入口 | 侧栏新建按钮 | `[data-track-id="agent_new_task_button_clicked"]` | 「新建任务」`⌘⌃N` |
| 可预填输入框 | `[data-codex-composer="true"][contenteditable="true"]` | Slate 编辑器 `[data-slate-editor]` | Lexical 编辑器 `.chat-input-v2-input-box-editable` |
| 程序化提交 | `window.electronBridge.sendMessageFromView` | CDP `Input.insertText` + 回车，实测成功 | 同路径，实测成功 |
| 稳定会话 id | `data-app-action-sidebar-thread-id` | `data-conversation-id`（UUID） | `data-session-id`（24 位 hex） |
| 按 id 重开会话 | `restoreRoute` 导航 `/local/<threadId>` | 点 `[data-conversation-id="<id>"]`，实测成功 | 未验证（JS click 点会话行无效） |
| 运行状态可观察 | — | 状态控件在运行期从 DOM 消失，实测可用 | 未验证 |
| Agent 回写看板 | `taskctl` 注入 PATH | shell 工具可用，但含本地 URL 的内容被网关拒绝 | 未验证 |
| 无头 CLI 执行 | `codex exec`（流式 JSON） | 无 | 无（CLI 是 VS Code 编辑器启动器） |

### WorkBuddy 细节

完全加载后的渲染进程里，`data-view-id` 为 `sidebar`、`main-content`、`detail-panel`、`sources-panel`，全部在同一个文档内，只有「空间」是远程 iframe（`https://www.workbuddy.cn/space/home?...&hostApp=workbuddy-d`）。输入框是单个 Slate 编辑器；会话列表的每项带 `data-conversation-id`，值为 UUID。

渲染进程暴露了 `window.workbuddyDesktop`，成员含 `invoke`、`events`、`window`、`app`、`opener`、`dialog`、`clipboard`、`notification`、`globalShortcut`，另有 `__wbEventBridge` 和 `__workbuddyDevtoolsTerminal`（`attach`/`poll`/`input`/`resize`/`detach`）。这是与 Codex 的 `electronBridge` 对应的位置，但唤起会话并不需要用到它——CDP 的 `Input` 域已经够了。

还有一层模式维度：顶部有 `日常办公` / `代码开发` / `设计创意` 三个 `[role="tab"]`。**命令能力只在「代码开发」模式下存在**，这个模式下才出现「选择工作空间」选择器。在默认的「日常办公」模式下，任何要求执行命令的请求都会被服务端以 `11133 请求信息无效` 拒绝。

### TraeWork CN 细节

输入框是单个 Lexical 编辑器，class `chat-input-v2-input-box-editable`，全页唯一，同时带 `data-lexical-editor` 和 `role="textbox"`。会话项带 `data-session-id`，值为 24 位 hex。整个界面没有 iframe，全在同一文档，注入比 WorkBuddy 更简单。

`bin/` 下有 `trae-solo-cn`，但打开是标准 VS Code 的 CLI 脚本（保留 Microsoft 版权头，处理 `VSCODE_IPC_HOOK_CLI` 转发），属于编辑器启动器，不是无头 Agent 运行器。`out/` 下 `mcpServers` 引用 218 处，MCP 配置目录为 `~/.trae-cn/mcps` 和 `~/.trae/mcps`。

它也有模式维度：顶部 `Work` / `Code` / `Design`（容器 `[role="tablist"].mode-switcher-btn`）。本次验证是在启动默认的 **Code** 模式下做的，模型 `Auto Mode`、位置「本地」、文件夹留空（UI 明写「选择文件夹（可选）」，确认非必填）。Work 和 Design 模式未验证。

### WorkBuddy 会话唤起端到端实测

已在 WorkBuddy 上跑通完整链路，两次独立验证均成功创建会话并拿到回复：

1. **新建会话**：`document.querySelector('[data-track-id="agent_new_task_button_clicked"]').click()`
2. **聚焦输入框**：对 `[data-slate-editor]` 的中心派发 `Input.dispatchMouseEvent` 的 `mouseMoved` / `mousePressed` / `mouseReleased`
3. **预填内容**：CDP `Input.insertText`
4. **提交**：CDP `Input.dispatchKeyEvent` 派发 `Enter`（`windowsVirtualKeyCode: 13`，`text: "\r"`）的 keyDown/keyUp

第一次用「注入验证：请只回复 OK」，WorkBuddy 自动把会话命名为「注入验证测试」并回复 OK，消耗 4.2，模型 Auto (GLM-5.2)。第二次用「回车提交验证：请只回复 DONE」且**只派发回车、不点任何发送控件**，同样成功，会话名「回车提交验证」，回复 DONE，侧栏任务计数从 6 变为 7。这说明回车即可提交，不需要定位发送按钮。

两个关键实现细节：

**预填必须用 CDP `Input.insertText`，不能用 `document.execCommand('insertText')`。** 后者只改了 DOM 文本，Slate 的内部模型仍是空的——可观察的判据是占位符「今天帮你做些什么？」依旧显示，此时发送控件是惰性的，点击和回车都不会提交。用 `Input.insertText` 后占位符消失，`[data-slate-string="true"]` 的文本等于输入内容，提交才生效。

**不要用发送控件的 DOM 位置做判据。** 输入框右下角那个圆形箭头是 `[data-track-id="agent_session_input_status"]`（32×32 的 `DIV`，不是 `<button>`），但直接点它在模型未更新时无效；模型更新后回车已经够用。验证提交是否成功也不要读输入框——提交后消息气泡本身也是一个 Slate 编辑器（`[data-slate-editor]` 会从 1 个变成 2 个），`querySelector` 取到的可能是气泡而非输入框。可靠判据是侧栏的任务计数或新出现的 `data-conversation-id`（注意任务列表折叠时这些 id 不在 DOM 里）。

### TraeWork CN 会话唤起端到端实测

同一条路径在 TraeWork CN 上也跑通了，只有选择器不同：

1. **新建会话**：`document.querySelector('.task-panel-entry-buttons > .task-list-new-task-item:not(.task-list-skills-item)').click()`。TraeWork **完全没有 `[data-track-id]` 属性**（全页 0 个），WorkBuddy 的选择器不适用。`.task-panel-entry-buttons` 下有 4 个 `.task-list-new-task-item`（新建任务/插件市场/自动化/模板库），后三个带 `.task-list-skills-item`，所以要用 `:not()` 排除。判据是 `.task-list-new-task-item.active` 的 class 切换。
2. **聚焦**：选择器 `[contenteditable="true"][data-lexical-editor]`。这一步在 TraeWork 上是冗余的——点完新建任务后 `document.activeElement` 已经是编辑器；保留无害。
3. **预填**：`Input.insertText`。三个判据都验到了：`#chat-input-v2-placeholder-MessageEditor` 的 `style.display` 从 `block` 变 `none`；编辑器内出现 `<p class="chat-input-v2__paragraph"><span data-lexical-text="true">…</span></p>`；`.chat-input-v2-send-button` 的 class 从 `chat-input-v2-send-button voice-call-mode` 变为 `chat-input-v2-send-button`。
4. **提交**：只派发回车，同样成功。T+3s 会话建出并收到回复，无需定位发送按钮。

判据数据：提交前 4 个 unique `data-session-id`、4 个 `.task-list-row-wrapper`；提交后 5 个，新增 `6a7b31a3855e4f48f5bd87ba`。会话自动命名「回车提交验证」，回复 `DONE`。

TraeWork 的 `data-session-id` **同一个 id 挂在 3 个元素上**，实现必须去重或指定元素：`.task-list-row-wrapper[data-session-id]` 是侧栏行（每会话一个，适合做列表）、`.ai-chat.chat-session[data-session-id]` 是当前打开的会话（**适合判断「刚建的是哪个」**）、`.virtualized-message-list-view[data-session-id]` 是消息列表。

与 WorkBuddy 的其他差异：TraeWork 提交后编辑器实例数不变（消息气泡不是编辑器），所以「querySelector 取到气泡」的坑在这里不存在；占位符是带 id 的独立元素、靠 inline `style.display` 切换，比 WorkBuddy 靠文案匹配好用得多，是现成的「Lexical 模型是否真更新」探针；发送控件是真 `<button>`（WorkBuddy 是 `DIV`），空输入时带 `voice-call-mode`，是可靠的 armed 信号。

一个反例值得记住：`document.querySelector('.task-list-row-wrapper').click()` 在 TraeWork 上**完全无效**（active 和面板都不动），但新建任务那个 div 的 JS click 有效。所以「JS click 在这个 UI 上通用」不成立，每个选择器都要单独实测。

### 会话与任务的持久绑定（WorkBuddy 实测成功）

拿着之前唤起时记下的会话 id 重新打开该会话：`document.querySelector('[data-conversation-id="71979bf2-3bd8-4580-90d1-9dd722fc7aa1"]')` 能命中，对其中心派发真实鼠标事件后，该会话正确打开（标题、历史消息、AI 回复都在）。先点「新建任务」离开、确认页面变成落地页，再按 id 重开，是一次真实的状态切换，不是没动过。

两个约束：

**没有 URL 路由。** `location.href` 始终是 `file:///.../renderer/index.html`，`hash` 为空。Codex 那种导航到 `/local/<threadId>` 的方式在 WorkBuddy 上不存在，重绑定只能依赖侧栏行的 DOM 存在。

**列表是虚拟滚动。** `[data-testid="virtuoso-scroller"]` 和 `virtuoso-item-list` 都在（react-virtuoso）。会话少时全部渲染，会话多时滚出视口的行不在 DOM 里。另外任务分组折叠时 id 也不在 DOM。所以按 id 重开前必须先展开分组、必要时滚动或用搜索把目标行渲染出来，不能假设 `querySelector` 一定命中。

### 运行状态可观察性（WorkBuddy 实测成功）

`[data-track-id="agent_session_input_status"]` 这个控件在一轮运行期间**从 DOM 中消失**，结束后重新出现。用「写一首关于秋天的短诗」采样：t=1s 起该控件为 `null`，持续到 t=13s，t=14s 重新出现，同时页面文本长度从 490 增长到 720。所以外部可以只靠这一个判据区分「运行中 / 已空闲」，不需要解析消息内容。

顺带一个负面观察：没有出现「停止」字样的文本按钮，别用文案匹配找停止控件。

### Agent 回写看板（WorkBuddy 部分打通，有明确阻塞）

先说结论：**shell 通道可用，但 MCP 通道走不通，而且网关会拒绝含本地 URL 的内容。**

**MCP 不通，且原因是结构性的。** 往 `~/.workbuddy/.mcp.json` 里加一条 `{"taskboard": {"type": "http", "url": "http://127.0.0.1:47900/mcp"}}` 并重启 WorkBuddy 后，它确实读写了这个文件（把自带的 `connector-proxy` 端口从 49413 改写成 52059，同时保留了新增条目），但 `~/Library/Logs/WorkBuddy/main.log` 里它传给 Agent 引擎的 `--mcp-config` 参数**只含 `connector-proxy`，没有 taskboard**。也就是说 `.mcp.json` 是 WorkBuddy 自己写出来的镜像，不是用户注册入口；真正的注册路径应该是它的「专家·技能·连接器」界面（未验证）。顺带发现它传的是 `--mcp-config` 和 `--strict-mcp-config`，这是 Claude Code CLI 的参数形态，工具名形如 `mcp__agent-mail__upload_attachment`。

作为验证前提，另做了一个零依赖的 MCP Streamable HTTP 原型（`/tmp/mcp-taskboard/server.mjs`，监听 47900，代理到看板 REST），并用 curl 完成 `initialize` → `notifications/initialized` → `tools/list` → `tools/call` 全流程，拿到真实看板数据、成功写入一条评论。**协议层没问题，问题在 WorkBuddy 不消费这个配置。**

**shell 通道可用，但只在「代码开发」模式下。** 在该模式下发「请用命令行执行 pwd 并告诉我结果」，WorkBuddy 回复「已完成 5s / 当前工作目录是：`/Users/jim-forest/WorkBuddy/2026-08-11-22-40-37`」。注意工作目录是**每会话一个沙箱目录**，不是项目 checkout，想让 Agent 在仓库里干活必须用「选择工作空间」指定文件夹。

**真正的阻塞：网关拒绝含本地 URL 的内容。** 只要这一轮的内容里出现 `http://127.0.0.1:<port>`，请求就被服务端以 `11133 请求信息无效` 拒绝，四次不同措辞全部复现（含 curl 命令的两种写法、不含 URL 但在错误模式下的一次、以及用绝对路径调 `taskctl` 的一次）。最后那次尤其说明问题：请求本身通过了校验，Agent 也进入了「运行命令 / 深度思考 / List projects using taskctl CLI」，但紧接着仍报 11133——因为 `taskctl` 的报错输出里带着 `http://127.0.0.1:47823`，工具输出回灌进下一轮请求时又撞上同一个过滤器。

这条阻塞的含义是：**不能把看板地址写进任务描述，也不能让回调工具的输出里出现本地 URL。** 可能的破法有三条，都未验证：走它的连接器界面正式注册 MCP（绕开提示词与工具输出）；让 `taskctl` 在这种场景下不打印 URL；或者用非 URL 形式承载地址（如工作空间内的配置文件）。

必须接受的差异是执行模型不同。Codex 和 Claude Code 有 `codex exec`、`claude -p --output-format stream-json` 这类无头模式，所以 `server/agents/` 能在服务端直接 spawn 进程、解析流式事件、完整托管一轮对话。WorkBuddy 和 TraeWork CN 都没有等价能力，只能走「驱动 GUI」这条路。这意味着它们在看板里的 Agent 语义更接近仓库现有的「本机 Codex 原生任务启动」，而不是 `server/agents/` 的无头执行。Agent 注册表需要能表达这个区别：一类是服务端可托管的执行器，一类是只能唤起宿主会话的启动器。

## 已落地的 WorkBuddy 集成

验证结论确认后，WorkBuddy 已作为一等 Agent 接入，形状对齐 Codex 的原生任务启动。

### 能力表而不是名称分支

`shared/agents.mjs` 的每个条目多了 `capabilities`：`headless` 表示看板能自己跑一轮并解析事件流，`hostLaunch` 表示只能在对方客户端里唤起会话，`boardAccess` 表示它从自己那侧怎么读写看板。Codex 是 `headless + hostLaunch + taskctl`，Claude 是 `headless + taskctl`，WorkBuddy 是 `hostLaunch + mcp`。调用点问能力而不问名字：`agents.getHeadless()` 是 AI 对话的入口闸门，非无头 Agent 走到那里会得到可读的 409 而不是 `undefined is not a function`。WorkBuddy 的 `sessionEnvVar` 是 `null`，因为它没有 CLI，永远不会通过环境变量宣告会话，`taskctl` 侧改用 `SESSION_ENV_VARS` 过滤空值。

### 新增模块

| 文件 | 职责 |
| --- | --- |
| `server/mcp.mjs` | 看板自己的 MCP Streamable HTTP 服务，四个工具 `list_tasks` / `get_task` / `add_comment` / `move_task`，挂在 `POST /mcp` |
| `server/workbuddy-desktop-controller.mjs` | CDP 层：新建会话、预填、回车提交、按 id 重开、判断是否运行中 |
| `server/workbuddy-task-launch.mjs` | 编排层：版本与负责人校验、去重、绑定会话、生成启动指令 |
| `server/workbuddy-host-setup.mjs` | 宿主接入：注册 MCP 到 `~/.workbuddy/mcp.json`、同步 skill 到 `~/.workbuddy/skills/` |
| `server/agents/workbuddy.mjs` | 注册表适配器，无头入口显式抛可读错误 |
| `inject/workbuddy-taskboard.user.js` | 面板入口注入脚本 |

路由：`POST /api/local/workbuddy/tasks/:id/launch` 手动或自动唤起，`POST /api/local/workbuddy/sessions/:id/open` 按会话 id 重新打开。`/api/meta` 的 `capabilities.workbuddyTaskLaunch` 报告客户端是否可达。把任务移到 `in_progress` 时，`startAssignedAgentOnTransition` 按能力分派：无头 Agent 建 AI 对话，只能宿主唤起的 Agent 交给启动器。

### 一份 skill，两种操作层

没有为 WorkBuddy 做 skill 变体。`skills/manage-taskboard/SKILL.md` 开头改成按能力选择操作层：有 `taskboard_*` MCP 工具时全程用工具，否则用 `taskctl`；后文的 `issue brief` / `issue move` / `comment add` 分别对应 `get_task` / `move_task` / `add_comment`。流程规则只有一份，不会分裂漂移。

### 端到端实测结果

用真实 WorkBuddy 跑通了：新建任务并指派给 WorkBuddy → 移到 `in_progress` → 看板自动唤起会话 → 会话 id 绑定回任务（`agentStart: {status: "started", agentKind: "workbuddy", sessionId: "0fa06b43-…"}`，`agentSessions` 里有对应记录）→ Agent 读取任务、写交付评论、把任务移到 `in_review`。

第一次跑通时暴露了一个必须修的问题：**Agent 没走 MCP，而是在文件系统里找到了本仓库的 `taskctl` 并运行它**，于是评论被记在 `claude-agent` 名下、`threadId` 是当时环境里的 `CLAUDE_CODE_SESSION_ID`。归属完全错了。原因有两层：skill 的 frontmatter description 当时写着「通过 taskctl CLI 管理」，而 `references/cli.md` 就在旁边；启动指令也只是「建议」用工具。修法是把 description 改成操作层中立、在 SKILL.md 的 MCP 分支里明确禁止读 `cli.md` 和运行命令行，并让启动指令点名工具全称、显式禁止查找命令行工具。

这条经验值得记住：**给宿主 Agent 的指令必须点名操作通道并排除其他通道**，否则它会自己找路，而找到的那条路会带上错误的身份。

### 一次性人工授权

写入 `~/.workbuddy/mcp.json` 不等于工具立刻可用。服务器要在「专家·技能·连接器 → 连接器 → MCP 服务管理」里处于启用状态，`~/.workbuddy/mcp-approvals.json` 记录用户的授权，键是 `<哈希>::<服务器名>`。

这里踩过一次误判，值得写下来。改完注册地址后有一轮跑失败，Agent 报告「没有连接 taskboard 服务器」，当时判断成授权失效。**真实原因是看板服务在 WorkBuddy 加载配置之后又重启了两次**，代理那次连接被掐断且没有重试。后来看板保持稳定、WorkBuddy 重启一次，同一条链路立刻恢复正常。

判据也错了：**WorkBuddy 的代理是懒连接、调用完即断**，用 `lsof` 看有没有到看板的 TCP 连接完全抓不到它，空闲的套接字不能证明链路坏了。唯一诚实的前置条件是配置本身是否启用。

看板不该伪造这个信任决定，所以 `ensureWorkbuddyBoardAccess` 在配置发生变化时返回 `requiresApproval` 和 `approvalHint`，由调用方提示用户点一次。看板端口稳定后这是一次性动作。

还有一条更根本的：**不要覆盖用户已经配好并授权的条目**。看板最初无条件改写 `taskboard` 条目的 URL，结果把一份正在工作的授权配置改废了——工具从 Agent 的视野里消失，它转而去满文件系统找 `taskctl`，最后以错误身份写回看板。现在的规则是：已有条目仍然响应就原样保留（返回 `keptExisting`），只有缺失或已失效才写入。已授权且可用的配置，价值高于看板自己的猜测。

还有一条是不要在服务被停用时白跑一轮。启动前读一次注册状态，`disabled` 为真就以 `WORKBUDDY_BOARD_ACCESS_DISABLED` 拒绝并指路，不创建会话、不消耗额度。没有这道守卫时，Agent 会花掉一整轮去满文件系统找 `taskctl`，最后回一句「没有读取任务的方法」。

守卫只看配置，不看连接活跃度——后者是上面那个误判的来源。

### 看板侧 MCP 的独立验证

不依赖 WorkBuddy 也能验证 MCP 层。直连看板 `POST /mcp`：`get_task` 返回真实任务与评论；`add_comment` 写入成功且作者记为 `workbuddy-agent`（`authorType: agent`），证明归属记账正确；`move_task` 带正确 `expectedVersion` 时把任务推进到 `in_review`；带过期版本时返回 `isError: true`、`VERSION_CONFLICT`、`details.actualVersion` 和重新读取的提示。

## 对架构的影响

1. **多宿主可行，成本主要在适配层。** 三项硬性前提都过了，剩下的是每个宿主一份薄注入脚本。上游的 WorkBuddy 脚本 139 行，对比 Codex 脚本 1560 行，差距说明「纯看板入口」远比「深度宿主集成」便宜。
2. **独立窗口应当是默认形态。** 注入需要启动器独占宿主进程的启动权，这对「用户已经打开着应用」的日常场景不友好。独立窗口没有这个约束，宿主投放作为增强能力更合理。
3. **能力分层不能按宿主名硬编码。** Codex 有 host binding、原生任务启动、配额策略；WorkBuddy 和 TraeWork 目前只能做到「面板可见可用」。需要一张宿主能力表，缺失能力降级而不是报错。
4. **唤起会话统一走 CDP `Input` 域，不要碰宿主内部接口。** `Input.insertText` 加回车这条路不依赖任何宿主私有 API，跨宿主可复用，也不会因为宿主换了发送按钮的实现而失效。相比之下 Codex 现有实现依赖 `electronBridge.sendMessageFromView`，是宿主专属的。
5. **宿主发现要认多个标识。** 包名、bundle id、product.json 名称三者可能不一致，TraeWork CN 就是例子。
6. **停止宿主必须走应用自己的退出流程。** 直接发信号会触发崩溃弹窗或退出确认死锁，反而让宿主既关不掉也用不了。

## 未验证与风险

- **WorkBuddy 的回调通道没有真正打通。** shell 工具可用，但含本地 URL 的内容会被网关拒绝；正式的 MCP 注册路径（「专家·技能·连接器」界面）未验证。这是闭环上唯一实质性的阻塞。
- TraeWork CN 的按 id 重开会话、运行状态可观察性、回调通道都未验证。已知 `.task-list-row-wrapper` 的 JS click 无效，重开会话需要另找办法（真实鼠标事件或别的元素）。
- TraeWork CN 的 Work 与 Design 模式未验证，本次只在 Code 模式下做的。
- 未验证 WorkBuddy 的「选择工作空间」如何程序化设置。不设置的话 Agent 的工作目录是每会话一个沙箱（`~/WorkBuddy/<时间戳>`），不是项目 checkout，无法在仓库里干活。
- 未验证长列表下按 id 重开会话：虚拟滚动会让滚出视口的会话行不在 DOM 里。
- 未验证改状态的回写路径。看板的 `PATCH /api/tasks/:id`、`move`、`archive` 都要带正确 `version`，不匹配返回 409；只有 `POST /api/tasks/:id/comments` 不需要 version，是最安全的回写通道。
- 未测试注入面板的布局融合，截图中 iframe 是覆盖式浮层，尺寸与宿主栅格的贴合还没做。
- 宿主自动更新后 DOM 结构和 CSP 都可能变化。WorkBuddy 的界面外壳虽是本地文件，内容却来自 `https://docs.qq.com`，第三方随时可改。注入脚本需要锚点缺失时的显式失败与降级。
- 调试端口一旦打开，本机任何进程都能通过它完全控制该宿主。生产实现应参考上游的私有管道方案（`--remote-debugging-pipe`），不要长期暴露 TCP 端口。注意这与仓库现有的 `server/codex-desktop-controller.mjs` 冲突——后者靠扫描 TCP 端口连接，改用管道后需要同步改造。

## 复现方式

```bash
node server/index.mjs
```

```bash
WORKBUDDY_REMOTE_DEBUGGING_PORT=9240 /Applications/WorkBuddy.app/Contents/MacOS/Electron
```

```bash
"/Applications/TRAE SOLO CN.app/Contents/MacOS/Electron" --remote-debugging-port=9242
```

拿到端口后用 `http://127.0.0.1:<port>/json/list` 找到 `type: "page"` 的目标，连上它的 `webSocketDebuggerUrl`，再用 `Runtime.evaluate` 注入 iframe、`Page.captureScreenshot` 取证。CDP 客户端直接用 `shared/codex-cdp.mjs` 的 `CdpConnection`。

验证渲染时不要只看 iframe 的 `load` 事件，要么在渲染进程里 `fetch` 面板地址检查响应体，要么截图确认。

会话唤起按上文四步走：`Runtime.evaluate` 点新建、`Input.dispatchMouseEvent` 聚焦、`Input.insertText` 预填、`Input.dispatchKeyEvent` 回车。等待 10 秒以上再取判据，宿主要往返一次服务端才会建出会话。注意每次验证都会在账号里真实创建会话并消耗额度，提示词尽量短。
