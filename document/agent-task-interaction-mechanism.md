# Agent 任务运行机制

本文说明用户从看板派发任务后，Codex / Claude Code 如何读取上下文、执行、回写和交付。它面向日后回顾产品逻辑，不替代 API、CLI 或开发设计文档。

## 1. 核心原则

- 用户是任务管理者，不需要监督 Agent 的逐步探索。
- 任务描述、评论、状态、负责人、附件和开发上下文共同构成任务事实。
- 列表只用于选择候选任务；选中后再读取完整上下文。
- 评论是跨轮次的精炼交接，不是实时执行日志。
- Agent 完成并自验后只能送到 `in_review`；只有用户明确验收才进入 `done`。

## 2. 三种运行方式

| 方式 | 触发 | 会话 | 任务认领 |
|---|---|---|---|
| 用户派发 | 用户把已分配给 Agent 的任务移入 `in_progress`，或在 `in_progress` 改派 Agent | 每次自动启动一个新会话 | 用户已经完成状态变更，Agent 不重复 `move in_progress` |
| 在对话中打开 | 用户在任务详情或菜单中主动点击 | 只打开新会话输入框并预填可编辑指令；用户确认后自行发送 | 未发送前不产生正式会话 ID，也不提前绑定任务 |
| 定时认领 | Codex 自动化定期查看项目的 `todo` | 每次运行按自动化规则执行 | 先选一个候选，再用最新 `version` 原子认领；冲突就跳过 |
| 看板 AI 面板 | 用户在看板内新建或继续 Codex / Claude 对话 | 同一面板任务可续写原会话 | 只有明确绑定某个看板任务时才操作其状态 |

用户派发的主路径：

```text
用户描述任务并指定 Agent
→ 用户移入进行中
→ 服务启动对应 Agent 会话
→ Agent 用 issue brief 读取完整上下文
→ 修改和验证项目
→ 写一条交付评论
→ 移入审核中
→ 用户验收后才完成
```

## 3. 状态与负责人

主生命周期是：

```text
backlog → todo → in_progress → in_review → done
```

- `blocked` 表示暂时无法继续。
- `canceled` 表示不再继续。
- 负责人决定由用户、Codex Agent 还是 Claude Agent 承接。
- 已经处于 `in_progress` 且负责人就是当前 Agent 时，直接开工。重复移动会无意义地增加 `version` 并改变卡片排序。

## 4. 列表只提供候选索引

`taskctl issue list --project <project-id> --json` 默认不批量返回完整任务对象，只列出活动任务：

```text
backlog、todo、in_progress、in_review、blocked
```

默认排除 `done`、`canceled`。每条只保留：

- `identifier`
- `title`
- `descriptionPreview`：折叠空白后的前 50 个 Unicode 字符
- `descriptionTruncated`
- `status`、`priority`、`labels`
- 负责人的 `type`、`id`、`name`
- `version`

列表的作用是判断下一步要读哪条，不足以直接执行任务。发现候选后使用 `issue brief`：

```bash
taskctl issue brief TASK-123 --json
```

明确查看历史或完整数据时再使用：

```bash
taskctl issue list --project PROJECT_ID --status done --json
taskctl issue list --project PROJECT_ID --all-statuses --full --json
```

`issue list` 当前输出契约为 `schemaVersion: 3`。`--all-statuses` 控制状态范围，`--full` 控制字段完整度；两者都不包含归档任务。

## 5. `issue brief` 是开工入口

`issue brief` 在 CLI 内并行读取三个现有接口，对 Agent 仍表现为一次工具调用：

```text
任务本身
全部评论（含评论附件）
任务附件
```

它保留执行和交接需要的描述、状态、负责人、`version`、关系、开发上下文、评论正文和非空业务字段，删除头像、排序值、重复时间等展示或管道元数据。

这样既不会截断跨轮次要求，又把原来的 `issue get + comment list` 两次串行工具往返合成一次。

## 6. 原生 Codex 如何拿到命令

原生 Codex 是已经运行的客户端，不继承 Taskboard 服务后来设置的环境变量，也不能保证从 `PATH` 找到 `taskctl`。因此服务会：

1. 在实际监听端口确定后保存当前服务 origin。
2. 懒创建一份服务实例唯一的 `.data/bin/taskctl` shim。
3. 在 shim 中写入 Node、CLI 和当前服务地址的绝对值，并强制覆盖遗留的 `CODEX_TASKBOARD_URL`。
4. 打开原生 Codex 输入框前确保 shim 已就绪。
5. 在单行指令中要求整轮 Taskboard 操作都使用该 shim，并先运行 `issue brief`。

用户主动点击“在对话中打开”时，Taskboard 只切换到新的 Codex 输入框并插入真实 Skill mention 和指令，不点击发送。用户可以补充或修改提示词，再自行发送。等待输入框、Skill 菜单和 mention 就绪时会有很短的技术等待，但没有产品倒计时。

状态变更触发的后台派发属于自动执行路径：验证提示词后立即发送，捕获新会话 ID、绑定任务，再恢复用户之前所在的 Codex 页面。两条路径共用相同的 shim 和任务指令，但只有后台派发自动发送。

`codex:inject` watcher 每两秒续一次本机桥心跳，并检查注入脚本的内容哈希。它只连接 Codex 主窗口，过滤带 `initialRoute` 的头像浮层、语音输入等辅助页面；心跳请求在 1.5 秒内无响应时丢弃该 CDP 连接，下一轮自动重连，避免 watcher 进程存活却心跳循环被永久卡住。脚本变化时由同一个 watcher 关闭旧 CDP 连接并重新挂载当前源码；`npm run build` 只刷新 iframe，不终止或替换前台 watcher。原生启动的前置检查不要求当前页面已经存在新对话输入框，导航完成后再单独等待它；心跳、桥接或侧栏缺失时返回具体原因，不再统一报“injector or native DOM”。

任务面板挂载到当前可见的 Codex 主内容布局，同时支持站点、插件等页面使用的 `default` 布局和 session 页使用的 `thread-edge-scroll` 布局；它不依赖全局第一个 `<main>` 或标题栏坐标，避免被不可见的 webview 容器干扰。

AI 面板、Codex 子进程和 Claude 子进程共享同一份 memoized shim 初始化，避免并发覆盖或出现半截文件。随机端口和非默认端口也会连接当前服务，而不是回退到 47823。

### 1,024 字符限制是谁的

这是 Taskboard 自己设置的防御性协议限制，不是已知的 Codex 客户端上限：

- `scripts/codex-injector-runtime.mjs` 的 host 请求解析把 `instruction` 限制为不超过 1,024 个 JavaScript 字符。
- `server/codex-desktop-controller.mjs` 在发请求前做同样的预检，以便给出明确错误。
- 对应测试锁住了这两个边界。

它可以修改，但必须同步调整以上校验和测试；同时整个 host payload 目前还有 4,096 字符上限。启动指令只放任务号、shim 路径和第一条 `issue brief`，主要任务内容继续走 Taskboard 数据读取，避免把启动协议变成第二份上下文。

## 7. Claude Code 的差异

- Claude 自动启动继续走本地 CLI 适配器，不经过 Codex CDP 注入。
- Claude prompt 本身带有服务端生成的 `<taskboard_context>`，不需要复制 Codex 启动指令。
- Claude 子进程同样从共享 runtime 获得正确的 `taskctl`、`PATH` 和服务地址。
- Codex 和 Claude 共用 `AGENTS.md` 与 `manage-taskboard` Skill；共享逻辑不按 Agent 名称分叉，单端能力只放在对应适配器中。

## 8. 评论如何交接

评论按轮次写，以下都是上限而不是配额：

- 每轮新增用户反馈最多一条：`用户反馈：`
- 每轮交付最多一条：`交付：`
- 需要用户拍板时一条：`需决策：`
- 无法继续时一条：`阻塞：`

初始轮通常只需要一条交付评论。默认目标约 300 个中文字符，但不是硬上限。

必须保留会影响下一轮的根因、取舍、约束和已经排除的方向；省略原始日志、逐步探索、失败尝试细节和逐文件 diff。判断标准是：下一轮读不到这句话，是否会重走弯路。

## 9. 并发与回写

- 每次写任务前使用最新读取到的 `version` 和 `--if-version`。
- 定时认领发生版本冲突或状态已变化时立即跳过，避免多个 Agent 抢同一任务。
- 会话绑定可能更新任务版本，因此启动指令不携带容易立即过期的 `version`。
- 手动预填阶段没有正式会话 ID，不更新任务版本或会话绑定；用户发送后，Agent 首次通过 `taskctl` 写评论或任务时会记录当前会话。
- 新一轮返工写新评论，不覆盖旧轮次交接。
- Agent 自验后写交付评论，再读取最新版本并移动到 `in_review`。

## 10. 定时自动化

每次定时运行只处理一个任务：

```text
issue list --status todo（精简候选）
→ 选一个
→ issue brief（完整上下文）
→ 用最新 version 认领
→ 执行与验证
→ 一条交付评论
→ in_review
```

自动化提示是服务生成的受控模板。项目加载、切换或用户手动调整自动化时会 reconcile；模板变化会更新已有 automation，但不会在后台无条件热更新。

## 11. 不在本机制里的内容

- Web 看板仍通过 HTTP API 获取完整任务对象；CLI 的列表投影不改变 Web、数据库或 API 契约。
- 状态变更活动时间线是独立产品需求，不属于本次 Agent 交互效率机制。
- 统计和导出不是默认 Agent 执行路径，使用显式的 `--all-statuses --full`。

## 12. 相关入口

- 协作入口：[`../AGENTS.md`](../AGENTS.md)
- Taskboard Skill：[`../skills/manage-taskboard/SKILL.md`](../skills/manage-taskboard/SKILL.md)
- CLI 手册：[`../skills/manage-taskboard/references/cli.md`](../skills/manage-taskboard/references/cli.md)
- 设计与取舍：[`design/agent-interaction-efficiency.md`](design/agent-interaction-efficiency.md)
- 月度最终更新：[`updates/2026-08.md`](updates/2026-08.md)
