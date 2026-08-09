# 设计：让 Agent 干活更省、评论更像人话

状态：**已实施——第一、第二阶段及 `issue list` 默认精简索引均已落地；真实 Codex/Claude 客户端烟测与上线后的评论观察窗口待完成。P2-6 已移出本方案。**
日期：2026-08-09（第十稿。第九稿实施后按实际使用边界补充，修订记录见最后一节）

---

## 1. 一句话

Agent 每接一个任务，开工前要装进约 8,000 token 的上下文，其中约 **2,200–2,400** 属于可避免的固定开销——白背的命令手册（≈1,565）和接口返回里 Agent 用不上的字段（≈606–790）。同时能省掉一次模型—工具往返。评论那边则有一条长尾特别臃肿，把探索过程整段摊开了。这份文档要收掉这两笔，分两个阶段走。

两点用词上的克制：

- 不是「这 8,000 里只有一小部分有用」。任务描述、评论、协作规则都有用，可避免的是**冗余字段**和**白背的手册**，不是内容本身。
- **「每轮返工都要重读」不计入可避免开销。** 任务正文和新增反馈本来就必须读，重复只是让上面那 2,200–2,400 的收益**发生多次**，不会让内容消失。
- **总 token 收益暂不可测**，原因见第 9 节。

## 2. 先说清楚：有三种运行方式，不是一种

**这一节是后面所有分析的地基，前几稿把三种混成了一条流程，结论跟着全错。**

| 触发方式 | 谁改的状态 | Agent 要不要认领 | 会话 |
|---|---|---|---|
| **你把任务拖进「进行中」** | 你已经改好了 | **不用**。状态已经是 `in_progress` 了 | 每次都是**全新会话** |
| **定时任务轮询**（每 5–60 分钟） | 没人改，任务还在 `todo` | **要**，而且必须用 `--if-version` 原子认领，防止多个 Agent 抢同一个 | 每次都是**全新会话** |
| **你在 AI 面板里继续聊** | 不涉及 | 不涉及 | **唯一会续写旧会话的场景** |

第一种下 Agent 如果多此一举再认领一次，不是无害的：`moveTask` 无条件 `version = version + 1`（`server/database.mjs`），没有同状态短路。所以那一下会白写一次、把 version 顶掉、还把卡片挪到该列末尾。

### 2.1 最重要的一条：每轮返工都是全新会话

- Codex：协调器每次调用都跑一遍 `createTask`，在客户端里**新建一个原生任务**，然后替换任务上的 session 绑定（`server/codex-desktop-controller.mjs`）。
- Claude：每次都 `aiChat.createThread()`，**新建线程**，不是复用（`server/app.mjs`）。
- 数据库：`task_agent_sessions` 用 `ON CONFLICT DO UPDATE`，每个任务每个 Agent **只留最新一条**绑定（`server/database.mjs`）。
- `--resume` 只在 `thread.agentSessionId` 已存在时才触发（`server/ai-chat.mjs`），也就是只有 AI 面板续聊才走。

**这件事有两个后果，贯穿全文：**

1. 「搞清楚要干什么」那 8,000 token 每轮返工都要**重新查一遍**——两次串行读取一次不少地重跑。所以**精简读取的收益会在每一轮重复发生**，这是做 P1-1 的主要理由。
   （前稿写「冷启动一定比 resume 更贵」，**收回**。冷启动要重跑工具，resume 则可能拖着更长的历史；谁更贵取决于历史长度、缓存命中和计费方式，没有证据支持一概而论。这里只主张「收益会重复发生」，不主张「总成本更高」。）
2. **评论是跨轮次的主要交接材料。** 准确说：它是**唯一按轮追加、且下一轮默认必读**的 Taskboard 文本载体。任务描述、代码、测试、状态和附件当然也持久化，但它们要么不按轮追加、要么不在默认读取链上。所以上一轮的诊断结论、关键取舍、约束条件如果只留在实时流里，下一轮的新会话就读不到，只能从头再查。这直接约束了第二阶段能删什么。

### 2.2 两个 Agent 的载体差别

| | Codex | Claude |
|---|---|---|
| 任务自动启动 | 服务通过 CDP 连上本机运行中的 Codex 客户端，直接在里面建一个原生任务 | 服务后台起一个 `claude -p` 子进程 |
| 客户端里能实时看到吗 | 能，它本来就是客户端的任务 | 不能。默认只在看板 AI 面板里看；点「在 Claude Code 中打开」才往桌面端**导入一份副本** |
| 看板 AI 对话面板 | 走 `codex exec` 子进程 | 走 `claude -p` 子进程 |
| 为什么 Claude 不用 CDP | — | 桌面端主进程启动就校验 CDP 签名，注入不进去，该方向已放弃（`document/updates/2026-08.md` 08-07） |

所以 `codex exec` 并没有退场，只是不再负责任务自动启动。

还有一个差别，第一阶段的 P1-2 会用到：

- **Codex** 收到的指令里带 `[$manage-taskboard](绝对路径)`，是显式引用，客户端会去读那个文件。
- **Claude** 收到的只是一句白话：`Use the manage-taskboard skill for every taskboard read or write in this turn.`（`server/agents/claude.mjs`）。不用 `/skill` 是因为 Claude Code 把开头的斜杠当命令，会吞掉整个 prompt——代码 270–273 行的注释就是解释这个。代价是**读不读由模型自己决定，不保证**。

## 3. 现在一个任务是怎么跑起来的

以「你拖进进行中 + Codex」为例：

1. 你拖动卡片。
2. 服务往 Codex 客户端输入框里打一句话并提交：
   ```
   [$manage-taskboard](.../SKILL.md) e-taskboard Address task 7627EC6179C0-5
   ```
3. Agent 落地，自己找信息：读 `AGENTS.md` → 读 `SKILL.md` → 读 `references/cli.md` → 跑 `taskctl issue get` → 跑 `taskctl comment list`。
4. 写代码、跑验证。
5. 跑 `taskctl comment add` → 跑 `taskctl issue move --status in_review`。

**第 2 步这句话里除了任务号什么都没有。** 但服务端在发出它的那一刻已经知道项目 ID、工作区路径、任务状态、version、负责人了——`resolveWorkspace()` 刚算过。它就是没往下传。

于是第 3 步里那两次 `taskctl` 读取是**串行**的：每一次都要「模型输出命令 → 等结果 → 再想下一步」，一次就是一整轮模型调用。

（**基线是两次读取，不是三次。** 前稿把 `context current` 也算进来了，不对——`issue get <任务号>` 直接吃标识符，执行既有任务根本不需要先定位项目。`context current` 属于建新任务前查重、或者要选项目的场景。）

## 4. 钱花在哪

Agent 开工前确实必须知道这些，这没问题：

| 它要知道什么 | 从哪来 | 大小 |
|---|---|---|
| 这个任务要做什么 | 标题 + 描述 + 历史评论 | ≈4,160 token |
| 这个项目怎么协作 | `AGENTS.md` | ≈878 token |
| 怎么操作看板 | `SKILL.md` + `references/cli.md` | ≈2,897 token |
| **合计** | | **≈8,000 token** |

其中**可避免的固定开销约 2,200–2,400**：

| 来源 | 可省 |
|---|---|
| 命令手册白背的部分 | ≈1,565 |
| 接口返回里用不上的字段（`issue brief` 模拟差额） | ≈606–790 |
| **合计** | **≈2,171–2,355** |

剩下的是任务内容和协作规则本身，该给还得给。**跨轮次重复读取不计入这张表**——正文和新增反馈本来就必须读，重复只是让这笔收益发生多次。

问题不在「给不给」，在**怎么给**：

**一、两次串行读取本可以并成一次。** 拿到任务正文和评论需要 `issue get` + `comment list` 两条命令，每条都是一整轮模型调用。合成一次能省一轮。

（**这里要跟「服务端已知项目 ID / 工作区」区分开。** 那些信息确实白攥着没往下传，但它们**替代不了**读描述和评论——Agent 买的是任务内容，不是项目坐标。而且 Codex 客户端的工作目录已经由 `electron-set-active-workspace-root` 设好了，工作区路径对 Agent 是冗余的。真正把 2→1 做掉的是 `issue brief`，不是「指令里带上下文」。）

**二、买回来的东西带着一层包装纸。** 任务 `-2` 的 9 条评论，正文 1,825 字符，接口连带返回 3,463 字符的管道字段。

**但这里要说清楚，前几稿在这一点上吹大了。** 前稿说「65% 是包装纸」，那是把所有非正文字段都算成可扔。实际过一遍才发现大部分必须留：评论的 `id` 和 `version`（要改评论就得有）、`authorType`、作者名、时间，任务的 `version`、负责人 `id`、关系类型、非空附件、非空业务字段。

**真正能扔的只剩每条约 88 token**：`taskId`（Agent 早知道）、`threadId`（用不上）、`authorId`、`authorAvatarUrl: null`（永远是 null）、空的 `attachments: []`、跟 `createdAt` 一模一样的 `updatedAt`。任务级另有 `creator` 那一组、`sortOrder` 等。

按补全后的必留字段，在两个真实任务的实际数据上**模拟计算** `issue brief` 的输出（命令尚未实现，所以是估算不是实测）：

| 任务 | 现状 `issue get` + `comment list` | `issue brief` | 降幅 |
|---|---|---|---|
| `-5`（7 条评论，正文 5,055 字符） | ≈4,231 token | ≈3,625 token | **14%** |
| `-2`（9 条评论，正文 1,825 字符） | ≈2,690 token | ≈1,900 token | **29%** |

**评论正文越长，相对收益越低**——因为省的是固定的每条元数据，正文一分不动。所以 P1-1 的主要价值是**把两次工具往返合成一次**（少一整轮模型调用），载荷只是顺带省一点。

**三、这笔钱每轮返工都要重付。** 见 2.1，每轮都是全新会话，得从零再读一遍。

**四、命令手册基本白背。** `references/cli.md` 有 1,957 token，`SKILL.md` 第 8 行还要求「选命令前必读」。但一次任务执行实际只用四条命令，剩下八成篇幅（建项目、云登录、任务关系、归档恢复、周期任务、附件下载）纯属白背。

## 5. 评论的真实情况

前几稿说「平均 700–1,200 字」，那是从任务 `-5` 一个样本里抽的，**不对**。全库 34 条的真实分布：

| 指标 | 数值 |
|---|---|
| 中位数 | **256 字** |
| 平均 | 414 字 |
| 最长 | 2,057 字 |
| ≤300 字的 | **18 条（52%）** |
| >800 字的 | **4 条（11%），但占了全部字符的 38%** |

**所以问题不是普遍太长，是长尾。** 一半评论已经达标，硬砍 300 字对它们毫无意义。要治的是那 4 条——典型样本是任务 `-5` 里连着的三条：994 字分析 app-server 能力、推断会话归档原因；750 字「修正上一条的推断」；657 字「用户进一步明确期望」。这些是**探索过程**，不是**结论**。

条数上也要修正预期。任务 `-2` 的 9 条是「交付、反馈、交付、反馈…」五轮交付加四轮反馈——**对五轮返工来说这个条数已经是最少的了**，压不到 2–3 条。

还有一个之前没注意的机制细节：**那 9 条全是 `codex-agent` 写的，用户一条都没直接写过。** 「用户审查反馈：…」是 Agent 把对话里的口头反馈转录进看板的。结合 2.1（每轮新会话），这份转录就是下一轮默认读取链里能拿到的用户要求，**动不得**。

它们出现在评论里的根子，是**评论是 Agent 唯一能往看板上追加文字的地方**——`web/src/components/TaskDetail.tsx` 的活动流只有「创建任务」和「评论」两种条目。

## 6. 分两个阶段

前几稿把四组改动并列，其中有的是纯增量、有的会动契约，混在一起风险不好评估。改成分阶段：

- **第一阶段**只做**不动公共契约**的改动——不改 HTTP 接口、不改数据库、不改界面、不改 CLI 已有命令的默认输出。做完就能独立验收。
  **注意这不等于「不改变任何行为」**（前稿的说法过强）。第一阶段确实会改变：Agent 读不读完整 CLI 手册、Codex 启动提示和它执行的命令、定时自动化的读取方式、Claude 入口软链。变的是 Agent 的行为，不变的是对外契约。
- **第二阶段**调评论规则，靠软约束，随时可退。
- **单独评估**的是会动 CLI 输出契约的部分。

---

## 第一阶段：安全增量

### P1-1 新增 `taskctl issue brief <任务号>`

一次拿全：任务本身 + 全部评论 + 任务附件。实现上是在 CLI 里把**三个**现有请求并行发出去再挑着输出——对模型来说仍然只是**一次**工具调用。**不加服务端接口、不改数据库、不动任何老命令。**

三个请求：

- `GET /api/tasks/:id`
- `GET /api/tasks/:id/comments`（评论附件随这个一起回来）
- `GET /api/tasks/:id/attachments` ← **前稿漏了这个**。任务详情里的普通附件走独立接口（`server/app.mjs`），只合并前两个，「一次拿全」和「非空附件不能丢」就只覆盖了评论附件

**必须留下的字段**：

- 任务：任务号、标题、描述、状态、优先级、标签、`version`、项目 ID、开发上下文
- 负责人：`type` + `id` + `name`。**只留名字不够**——Agent 要用 `id` 判断「这个任务是不是派给我的」
- 关联任务：**必须带关系类型**（`parent` / `subIssues` / `blockedBy` / `blocks` / `related`），不能拍平成一组任务；每条留任务号 + 标题 + 状态
- 评论：`id`、`version`、`authorType`、作者名、时间、正文
  - `version` 是前稿最硬的一处漏：`comment update` 必须带最新 version（`skills/manage-taskboard/references/cli.md`）。留了 `id` 却丢 `version`，等于留了个改不了的把手，纯浪费字节
  - `authorType` 留着，但**别指望它能区分「用户要求」和「Agent 自己的判断」**——当前样本里那些「用户审查反馈：…」也全是 `agent`（见第 5 节）。真要区分得靠第二阶段约定的内容意图标签
- 非空的附件（任务级和评论级都算）：ID、文件名、类型、大小
- 非空的业务字段：`dueDate`、`recurrence`、`workflowId` 不能静默丢

**可以扔的**：`taskId`（Agent 早知道）、`threadId`、`authorId`、`authorAvatarUrl`、空的 `attachments`、`creator` 那一整组、`sortOrder`、值为 null 的 `archivedAt`/`recurrence`/`workflowId`、跟 `createdAt` 相同的 `updatedAt`。

**不提供 `--comments N`。** 前稿留了这个开关，但正常执行任务本来就要求读全部评论（它是跨轮次的主要交接材料，见 2.1），截断读只会让 Agent 漏掉用户要求。而且「取最新 N 条还是最早 N 条」本身也没定义清楚。**先不做**；将来真要做，必须同时返回总条数和 `truncated` 标志，并且明确禁止 Agent 拿截断结果直接执行任务。

**收益要说实话**（前稿这里吹大了）：

- **主要价值：两次串行读取合成一次**，少一整轮模型调用。基线是 2→1，不是 3→1。
- **载荷只降 14–29%**（见第 4 节的模拟估算，不是命令实测），不是前稿说的 64%。评论正文越长，相对收益越低。

前稿的「≈4,160 降到 ≈1,500」建立在「65% 是包装纸」上，而补全必留字段后大部分包装纸其实必须留。**这个数字撤销。**

### P1-2 `cli.md` 改成按需读

前稿说「同一套规则写了三遍」，**这话夸张了**。`AGENTS.md` 第 8 行已经明写「状态、version、并发认领、branch/worktree 和评论规则按需从该 skill 加载，本文件不重复维护」——它本来就把操作细节委托出去了。真正重叠的只有执行闭环第 1、5 两条，约 150 token。

所以这一项的收益**几乎全部来自 `cli.md`**（1,957 token），跟 `AGENTS.md` 去重没什么关系：

- `SKILL.md` 第 8 行的「选命令前必读 `references/cli.md`」改成「用到手册里其它命令时再查」。
- `SKILL.md` 里**直接写上四条高频命令的用法**（`issue brief`、`issue move`、`comment add`、`issue list`），常规任务根本不用翻手册。
- `references/cli.md` 删掉第 89 行那段和 SKILL.md 重复的流程说明，只留命令怎么用。
- **补一条新规则：任务已经是 `in_progress` 且负责人就是自己时，直接开工，不要再调 `issue move in_progress`。** 第 2 节说过 `moveTask` 无条件涨 version 还会把卡片挪到列尾，这一下是纯浪费。前稿只在说明里写了这个发现，没落成规则，等于没闭环。配一条测试卡住这句话。

**`AGENTS.md` 不做大幅删除。** 前稿想把安全底线搬进 `AGENTS.md` 当兜底，前提是「它必然加载」——但 `CLAUDE.md` 当时是**提交进 Git 的绝对路径软链**，换个目录就是断链，兜底本身有洞。已改成相对软链（`ln -sfn AGENTS.md CLAUDE.md`），前提才成立。即便如此也只做微调，不大动。

### P1-3 给原生 Codex 一条**确定能跑通**的命令

**这一节的目的收窄了。** 前稿叫「启动指令带上上下文」，但上一节说清了：项目 ID、工作区路径这些对 Agent 是冗余的（工作目录已由 `electron-set-active-workspace-root` 设好），真正把 2→1 做掉的是 `issue brief`。所以这一节只解决一件事：**让原生 Codex 能真的把那条命令跑起来。**

要跑通得同时满足三个条件，前几稿一次只解决一个。

**条件一：能找到 `taskctl`。** 已在真实 Codex 原生会话核对：PATH 里解析不到 `taskctl`，`.data/bin/taskctl` shim 存在，`CODEX_THREAD_ID` 存在。所以必须给绝对路径。

**条件二：能找到 `node`。** 前稿写 `node <路径>/cli/taskctl.mjs`——两层错：`<工作区>/cli/taskctl.mjs` 只对本仓库成立（管别的项目时那儿没有 CLI）；就算换成服务端的 `taskctlCliPath`，`node` 本身也未必解析得到（从 Finder 启动的客户端不一定继承 NVM 的 PATH）。

**用 shim 一次解决前两条**，因为 node 绝对路径已经焊在里面了：

```sh
#!/bin/sh
exec '/Users/…/.nvm/versions/node/v24.11.0/bin/node' '/Users/…/agent-taskboard/cli/taskctl.mjs' "$@"
```

**条件三：能连对服务地址。这是前稿完全漏掉的，也是最可能真的搞坏使用的一处。**

`taskctl` 从 `CODEX_TASKBOARD_URL` 读服务地址，读不到就默认 `http://127.0.0.1:47823`（`cli/taskctl.mjs`）。而端口是**可配置**的——`resolvePort()` 读 `CODEX_TASKBOARD_PORT`（`server/app.mjs`）。

服务只给**自己起的子进程**注入这个环境变量（`server/ai-chat.mjs` 里 `{...processEnv, CODEX_TASKBOARD_URL: taskboardUrl}`）。原生 Codex 是**已经在跑的客户端**，服务端补不进环境变量。**shim 里也没有这个地址。**

所以在非默认端口下会出现这种情况：Codex 任务正常建起来、shim 也能执行、但 `issue brief` 连到 47823 拿不到任务——**看起来像 Agent 不干活，实际是连错了端口。**

**修法：把地址焊进 shim。**

之所以不选「写进启动指令」，不只是省几十个字符：Agent 后面还要跑 `comment add`、`issue move`，如果地址只加在第一次 `issue brief` 前面，**后续命令照样连错端口**——而且是在活都干完之后才失败，比一开始就失败更难受。shim 能一次覆盖整轮任务里的所有 Taskboard 操作。

```sh
#!/bin/sh
CODEX_TASKBOARD_URL='<当前服务 origin，经 shellQuote>' exec '<node>' '<cli>' "$@"
```

**用强制覆盖，不要 `${CODEX_TASKBOARD_URL:-…}`。** 前稿写的是保留旧值优先，那样如果 Codex 客户端恰好继承了一个过期的 `CODEX_TASKBOARD_URL`，shim 还是会连到旧看板去。而且现有 AI 子进程本来就是强制覆盖的语义——`server/ai-chat.mjs` 里 `{...processEnv, CODEX_TASKBOARD_URL: taskboardUrl}` 是先展开再赋值，旧值一定被盖掉。服务生成的 Agent 专用 shim 应该保持同一套语义。

想手工连别的看板，用全局 `taskctl`（`npm link`）或显式调 CLI，不该让看板自己启动的 Agent 被一个遗留环境变量带跑。

**三个实现约束，每一个照着前稿写都会出事：**

1. **不要改 `ensureTaskctlBin()` 的返回值。** 前稿的待办写「返回 shim 文件路径」——**这会打断现有功能**。当前返回的是 bin 目录，`server/ai-chat.mjs` 直接把它交给 `withTaskctlOnPath(env, binDirectory)` 拼进 PATH。改成文件路径就等于往 PATH 里塞了个文件，AI 面板、`codex exec` 和 Claude 子进程里的裸 `taskctl` 会一起失效。
   正确做法是调用点自己拼：
   ```js
   const binDirectory = await ensureTaskctlBin(...);
   const shimPath = path.join(binDirectory, "taskctl");
   ```
   （要改成返回 `{ binDirectory, shimPath }` 也行，但必须同步改所有调用方。）

2. **必须收敛成唯一一个 memoized ready 入口，整个服务实例只有一处真正写 shim。**

   `server/ai-chat.mjs` 现在调 `ensureTaskctlBin({binDirectory, cliPath})` 是**不带地址**的。加了地址之后如果两边各调各的，后调的会把 shim 覆盖回没有地址的版本。

   **「保证两边传参一致」不算解法。** 就算参数完全相同，`ensureTaskctlBin` 里是 `writeFile`（`'w'` 模式，会先 truncate），两次独立写入仍可能撞在一起：一个刚写完另一个又 truncate，而原生 Agent 恰好在这个窗口执行 shim，拿到的就是空文件或半截内容。而且「参数一致」这种约定会随后续改代码漂移，建立不起单一所有权。

   推荐形状：

   ```js
   let taskctlBinReady;
   function ensureTaskctlReady() {
     taskctlBinReady ??= ensureTaskctlBin({ binDirectory, cliPath, taskboardUrl });
     return taskctlBinReady;
   }
   ```

   AI 面板拿返回的 bin 目录拼 PATH，原生协调器 `path.join(binDirectory, "taskctl")`，写入只发生一次。

3. **服务地址要在 `listen()` 之后从真实绑定端口取，而且只取一次。**

   现在 `taskboardUrl` 是在**构造时**算的：`server/app.mjs` 里 `http://127.0.0.1:${resolvePort()}`。但 `listen({host, port})` 允许传任意端口——**测试就是用 `listen({port: 0})` 绑随机端口的**（`test/server.test.mjs`、`test/ai-chat-server.test.mjs` 等）。这种情况下 `taskboardUrl` 说的是 47823，服务实际在别的端口上。

   这是个**已经存在**的偏差（AI 面板子进程拿到的 `CODEX_TASKBOARD_URL` 也是错的），只是目前没人真的从子进程回连所以没暴露。但一旦把地址焊进 shim，这个偏差就会变成「Agent 连错端口」——正是这一节要消灭的故障。

   **光说「listen 后注入」还不够**，因为 `AiChatService` 现在是在**构造函数里**就把地址固化进 `this.processEnv` 的（`{...processEnv, CODEX_TASKBOARD_URL: taskboardUrl}`）。只把注入时机往后挪，值还是会被冻住一次。要写成 provider：

   - `createTaskboardServer` 持有**唯一**的 runtime origin。
   - `listen()` 拿到真实 `address.port` 之后、返回之前完成初始化。
   - `AiChatService.#turnEnv()` **每次**从这个 provider 取 URL，不在构造时固化进 `processEnv`。
   - `ensureTaskctlReady()` 也从同一个 provider 取。
   - **origin 还没初始化就被调用，要明确报错，不许悄悄回退到 47823。** 静默回退正是这类故障最难查的原因。

   这样「单一 origin + 单一 shim 写入者」才是同一个闭环，而不是两条各自正确、合起来仍可能不一致的路径。

4. **`shellQuote` 现在是私有函数**（`server/agents/taskctl-bin.mjs` 只导出了 `ensureTaskctlBin` 和 `withTaskctlOnPath`），要复用得先导出。服务地址也要过它。

**还有一个前提**：shim 是**懒创建**的——`taskctlBinReady ??= ensureTaskctlBin(...)` 只在 `#turnEnv()` 里跑，而 `#turnEnv()` 只在 AI 对话轮次启动时才调。服务起来后一次 AI 对话都没跑过的话，shim 根本不存在。**在启动原生 Codex 任务前 await 一次 shim 就绪**即可，比改服务启动流程侵入小。

（所以准确说法是「首次 Agent 使用或原生任务启动前重写」，不是「每次服务启动都重写」——前稿那句不准。）

**指令必须交代「整轮都用它」，不能只交代第一条命令。**

`SKILL.md` 第 8 行写的是「Use `taskctl` for every project, issue, and comment operation」——**裸命令**。原生 Codex 的 PATH 里找不到 `taskctl`，所以只保证第一次 `issue brief` 能跑是不够的：活全干完之后的 `comment add` 和 `issue move` 照样会失败，而且失败在最后一步，代价最大。

启动指令要写成大致这样（仍是一行）：

> 本任务所有 Taskboard 操作都用 `<shim绝对路径>`；先执行 `<shim> issue brief <任务号> --json`。

**六条硬约束**：

1. **必须是一行。** 这句话是真被打进 Codex 输入框的，提交前用 `editor.textContent.includes(instruction)` 校验。输入框是 contenteditable，换行会被拆成 div，拼回来没有 `\n`，校验就过不了。
2. **不超过 1,024 字符。** 这是本项目在 `scripts/codex-injector-runtime.mjs` 自设的防御性 host 协议校验，不是已知的 Codex 客户端上限；服务端协调器镜像预检该值。它可以调整，但要同步桥接校验、服务端预检和测试，并注意整个 host payload 另有 4,096 字符上限。
3. **路径要做完整的 shell 引用**，处理所有特殊字符，不只是空格。
4. **不要把 version 塞进指令。** 启动之后 session 绑定还会让任务 version 再涨，指令里那个立刻就过期了。
5. **先确保 shim 存在**，否则指令指向一个不存在的文件。
6. **必须声明整轮任务都用这个绝对路径**，否则收尾的写操作会失败。

**项目名不进指令。** 协调器的入参里本来就没有项目名（只有 `{desktopController, loadTask, bindSession, resolveWorkspace, skillPath, codexActorId}`），而且按本节开头的结论它对 Agent 也没用。前稿声称「项目名服务端已知可直接取」，不准确。

**Claude 这边不改。** Claude 的 prompt 里本来就有 `<taskboard_context>` 块，项目 ID、项目名、工作区路径、任务号全在（`server/agents/prompt.mjs` 生成，任务号由 `server/ai-chat.mjs` 建线程时写入）。照抄过去等于同一份信息写两遍，正是这次要消灭的毛病。

### P1-4 同步定时认领的提示语

`shared/taskboard-automation.mjs` 的 `buildTaskboardAutomationPrompt` 里硬编码了 `issue get + comment list` 的读法和旧的评论格式要求（「记录关键改动、验证结果、执行结果和剩余风险」）。P1-1 和第二阶段生效时**必须同步改这里**，否则定时路径还在按老规矩跑。对应测试也要跟着改。

（前稿的 D-5 写成「无需改动」，是错的。）

**验收要多测一步**：`automationMatchesSpec` 是把 `spec` 的每个字段（含 `prompt`）逐个比对的，所以 prompt 一变，已有 automation 在下次 reconcile 时会走 `automation-update`。

**但它不会在后台自动热更新**——reconcile 发生在下次项目加载、切换或手动操作时（`web/src/App.tsx` 里有个跟着 `selectedProjectId` 走的 effect，对已存配置的项目发 `apply-policy`）。所以正在跑的 automation 在你重新打开那个项目之前，还在用旧 prompt。

验收不能只测「新建的 automation 带了新 prompt」，还要测**已有的 active automation 重新 reconcile 后确实被更新了**。

### P1-5 `CLAUDE.md` 改相对软链

**已完成。** 原来是 `CLAUDE.md -> /Users/jim-forest/Desktop/个人/agent-taskboard/AGENTS.md`（绝对路径，且 mode `120000` 提交进了 Git），换目录就断。现在是 `CLAUDE.md -> AGENTS.md`。

注意这跟 `~/.claude/skills/manage-taskboard` 那个软链**不是一回事**——那个在仓库外，没法用相对路径解决，本轮不处理。

---

## 第二阶段：评论规则

改 `skills/manage-taskboard/SKILL.md` 第 8 条。**软约束，不写代码去卡。**

### 发几条

按轮次走，且都是**上限**而不是配额——**没有的就不发，不要为了凑格式而复述任务**：

- **每次用户反馈**：最多转录一条，写清这轮新增或变更的要求（Agent 转录，因为用户通常在对话里说）。
- **每次交付**：最多一条交付总结。
- **初始轮通常只有一条交付评论**，没有反馈可转录就别发。
- **被阻塞或需要拍板**：一条决策/阻塞说明。
- **不发进度播报**：「我开始了」「正在查」「准备验证」一律不发。
- 返工**另发一条，不改老评论**。你需要看到打回前后的对比。

按这个规则，任务 `-2` 的 9 条基本原样保留（它本来就是这个形状），任务 `-5` 里连着的两条诊断加修正应该并成一条。

### 开头标注意图

`authorType` 区分不了「Agent 转录的用户反馈」和「Agent 自己的判断」（当前样本里两者都是 `agent`，见第 5 节）。用自然语言前缀标注即可，**不新增数据库字段**：

- `用户反馈：` —— 转录用户这一轮提的要求
- `交付：` —— 这一轮做完了什么
- `需决策：` —— 要用户拍板才能继续
- `阻塞：` —— 卡住了，说明卡在哪

下一轮的新会话扫一眼前缀就知道哪些是必须满足的要求、哪些是上一轮的自述。

### 写多长

**300 字是默认目标，不是硬上限。** 一半评论本来就在这个数以下；真需要展开决策依据时可以超。

参考形状（**开头带上意图前缀；没有的字段就省掉，别写「待定：无」，那样反而不像人话**）：

```
交付：<一句话结论>

- 改动：…（只说行为变了什么，不列文件清单）
- 验证：…（跑了什么，结果如何）
- 待定：…（要你决定的点）
```

转录用户反馈时同理：

```
用户反馈：<这一轮新增或变更的要求>
```

### 什么留、什么删

这是第二阶段最要紧的一条，因为 2.1 说了**每轮返工都是新会话，而评论是唯一按轮追加、下一轮又默认必读的载体**：

**必须留**：会影响后续返工的根因、关键取舍、约束条件、已经排除的方向（以及为什么排除）。

**可以删**：原始日志、逐步的探索过程、失败尝试的细节、文件级 diff 说明。

判断标准很简单：**下一轮的新会话如果读不到这句话，会不会重新走一遍弯路？** 会就留，不会就删。

前几稿写的「诊断推演一律不写评论」**是错的**——那正好会让下一轮重新调查。

---

## 补充实施：`issue list` 默认就是候选任务索引

前稿把 `issue list` 当成「完整任务对象的批量导出」，再考虑用 `--compact` 补救。这个抽象不符合实际任务流：看板当前以人工创建、人工派发为主；Agent 执行已知任务直接用 `issue brief`，定时认领只需要从 `todo` 里选一个候选。列表的职责不是让 Agent 读完所有任务，而是用最低成本决定**下一条要不要读、读哪一条**。

实际场景与信息需要：

| 场景 | 是否需要已完成任务 | 列表阶段需要什么 |
|---|---:|---|
| 定时认领一个 `todo` | 否 | 任务号、标题、预览、优先级、负责人、`version` |
| Agent 偶尔代建任务前查重 | 否 | 活动任务的任务号、标题、短描述、状态、标签；疑似重复时再 `issue brief` |
| 查看项目当前工作、选择关联任务 | 否 | 任务号、标题、状态、优先级、负责人 |
| 执行一个已知任务 | 不使用 list | 直接 `issue brief` |
| 历史回顾 | 是，显式查询 | 指定 `--status done` 或 `--status canceled` |
| 统计、导出、诊断 | 是，显式查询 | `--all-statuses --full` |

所以不新增 `--compact`，直接把默认契约改成精简索引：

```json
{
  "tasks": [{
    "identifier": "PROJECT-21",
    "title": "优化 Agent 评论机制",
    "descriptionPreview": "控制评论频率，只传递有效交接信息",
    "descriptionTruncated": false,
    "status": "todo",
    "priority": "medium",
    "labels": ["agent"],
    "assignee": { "type": "agent", "id": "codex-agent", "name": "Codex Agent" },
    "version": 4
  }],
  "schemaVersion": 3
}
```

描述预览规则：先把换行和连续空白折叠成一个空格并去掉首尾空白，再按 Unicode code point 取前 **50 个字符**；原文更长时返回 `descriptionTruncated: true`。字段名必须是 `descriptionPreview`，不能伪装成完整 `description`。候选任务一旦要执行、修改或进一步判断，统一用 `issue brief` 读完整描述、评论、附件、关系和开发上下文。

默认不返回 `done`、`canceled`，只留 `backlog`、`todo`、`in_progress`、`in_review`、`blocked`。人工要延续旧任务时会先把它移回活动状态；历史查询仍可显式 `--status done`。查询轴与字段轴分开：

```bash
taskctl issue list --project PROJECT_ID --json
taskctl issue list --project PROJECT_ID --status done --json
taskctl issue list --project PROJECT_ID --all-statuses --json
taskctl issue list --project PROJECT_ID --all-statuses --full --json
```

`--all-statuses` 只改变状态范围，`--full` 只恢复服务端完整任务对象。两者都不包含已归档任务。默认结构是有意调整的公共契约，因此 `schemaVersion` 从 2 升到 3，而不是假装兼容。仓库内目前只有测试消费该输出；Web 看板继续走原 HTTP API，不受 CLI 投影影响。云模式使用同一份 CLI，也获得相同的精简输出。

---

## 7. 待办清单

### 第一阶段

- [x] ~~P1-0（卡口）确认 Codex 原生环境能否解析 `taskctl`~~ **已确认：不能。** 原生会话里 PATH 解析不到 `taskctl`，`.data/bin/taskctl` shim 存在，`CODEX_THREAD_ID` 存在。不再是架构卡口，改由 P1-3 用 shim 绝对路径解决，P1-3h 保留烟测。
- [x] P1-1a `cli/taskctl.mjs`：加 `issue brief` 命令，注册进 `COMMAND_OPTIONS`（只要 `--json`，**不做 `--comments N`**），**并行**发三个请求（task / comments / task attachments）并按上面的字段清单输出。
- [x] P1-1b `test/cli.test.mjs`：补输出契约测试——必留字段一个不少（尤其评论的 `version` 和 `authorType`）、关系类型不被拍平、任务级和评论级的非空附件都在、非空业务字段不丢。
- [x] P1-1c `skills/manage-taskboard/references/cli.md` 补 `issue brief` 用法；`SKILL.md` 第 2 步改用 `issue brief`。
- [x] P1-2a `SKILL.md`：第 8 行「必读手册」改按需读；把四条高频命令写进去。
- [x] P1-2b `references/cli.md`：删第 89 行那段流程说明。
- [x] P1-2c `AGENTS.md`：只做微调，对齐措辞，不大幅删除。
- [x] P1-2d `SKILL.md` 补规则：**任务已是 `in_progress` 且负责人是自己 → 直接开工，不再调 `issue move in_progress`**；配一条测试卡住这句话。
- [x] P1-3a `server/agents/taskctl-bin.mjs`：shim 里加上 `CODEX_TASKBOARD_URL='<服务 origin>'`（**强制覆盖，不用 `${VAR:-…}`**，与 `#turnEnv()` 的语义一致）；`ensureTaskctlBin` 接收服务 origin，**返回值保持 bin 目录不变**（改成文件路径会打断 `withTaskctlOnPath` 拼 PATH，见 P1-3 正文）；导出 `shellQuote` 并用它引用服务地址。
- [x] P1-3b `server/app.mjs`：把 origin 做成 **runtime provider**——`createTaskboardServer` 持有唯一实例，`listen()` 拿到真实 `address.port` 后初始化，`AiChatService.#turnEnv()` 和 `ensureTaskctlReady()` **每次现取**（不在构造时固化进 `processEnv`），未初始化就调用要**明确报错**而不是回退 47823。
- [x] P1-3c **收敛成唯一一个 memoized ready 入口**（不是「或者保证传参一致」）：整个服务实例里只能有一处真正写 shim，AI 面板和原生协调器都从它拿结果。
- [x] P1-3d `server/codex-desktop-controller.mjs`：**启动原生 Codex 任务前 await 一次 shim 就绪**；`createCodexTaskLaunchCoordinator` 增加 shim 路径入参（调用点用 `path.join(binDirectory, "taskctl")` 自己拼）；指令声明**整轮任务都用这个绝对路径**，并给出第一条 `issue brief`；不放 version、不放项目名。
- [x] P1-3e 校验指令长度 ≤1,024 字符，并补一条测试卡住这个上限。
- [x] P1-3f `test/ai-chat-server.test.mjs:252` 里写死了 `e-taskboard Address task ${任务号}`，跟着改。全仓库只此一处。
- [x] P1-3g **shim 契约测试**（这组是本阶段最该守住的回归面）：
  1. **随机监听端口下地址仍然对**——这条才是守住 P1-3b 的那条：
     ```js
     const address = await app.listen({ port: 0 });
     ```
     断言 shim 里写的是 `address.port`、`issue brief` 真的连到这个随机端口，**而不是构造时 `resolvePort()` 的结果**。
     （只改 `CODEX_TASKBOARD_PORT` **抓不到这个 bug**：构造和 `listen()` 读的是同一个环境变量，两边会一起变，旧实现照样通过。那个可以留作第二个用例，但它守不住 P1-3b。）
  2. 即使客户端继承了一个**错误的** `CODEX_TASKBOARD_URL`，服务生成的 shim 仍连当前看板（验证强制覆盖生效）。
  3. 后续的 `comment add`、`issue move` 走同一个 shim 也成功，不只是第一条 `issue brief`。
  4. **AI 面板和 Claude 子进程里的裸 `taskctl` 仍能从 PATH 解析**——确认 `ensureTaskctlBin()` 的返回值没被改成文件路径。
  5. **并发断言：两条路径同时请求 shim 时，底层写入只执行一次。** 前四条测的是结果对不对，这条才直接守住「唯一写入者」。
- [ ] P1-3h 在真实 Codex 客户端跑一次烟测：确认中文、括号、路径没把 `textContent.includes` 校验搞坏，shim 能跑起来、连得对，任务能正常建起来。
- [x] P1-4a `shared/taskboard-automation.mjs`：`buildTaskboardAutomationPrompt` 改用 `issue brief`。
- [x] P1-4b `test/taskboard-automation.test.mjs`：同步更新，**并补一条「已有 active automation 重新 reconcile 后 prompt 被更新」**，不能只测新建的。
- [x] P1-5 `CLAUDE.md` 改相对软链。**已完成。**
- [ ] P1-6 回归确认 Claude 没受影响：自动化回归已确认拖入「进行中」仍会启动 Claude 并绑定会话；真实 Claude 客户端上下文烟测待执行。

### 第二阶段

- [x] P2-1 `SKILL.md` 第 8 条重写为「按轮次发评论（都是上限不是配额）+ 开头标 `用户反馈：`/`交付：`/`需决策：`/`阻塞：` + 300 字为目标非上限 + 留根因取舍约束、删日志和探索过程 + 空字段省略」。
- [x] P2-2 `test/manage-taskboard-skill.test.mjs:18` 里写死了第 8 条现在的措辞，按新规则重写。
- [x] P2-3 `shared/taskboard-automation.mjs` 的评论格式要求同步改（跟 P1-4a 是同一个函数，可以合并做）。
- [x] P2-4 `AGENTS.md` 执行闭环第 5 条跟新规则对齐。
- [x] P2-5 已确认 `~/.claude/skills/manage-taskboard` 软链到本仓库的用户级 skill；新规则会统一影响本机 Claude Code 会话。
- P2-6 已移出：状态变更活动流属于独立产品需求，后续单独设计，不计入本方案待办。

### `issue list` 默认索引

- [x] L-1 `cli/taskctl.mjs`：默认排除 `done` / `canceled`，投影为候选任务索引，描述归一化后最多 50 个 Unicode 字符。
- [x] L-2 新增 `--all-statuses` 和 `--full`；禁止 `--status` 与 `--all-statuses` 同时使用，不新增 `--compact`。
- [x] L-3 默认输出契约升为 `schemaVersion: 3`，同步 CLI 手册与测试。
- [x] L-4 `SKILL.md`：活动任务精简列表只用于选候选，疑似相关或准备执行时用 `issue brief`；默认不查已完成任务。
- [x] L-5 定时认领提示明确 `issue list --status todo` 选一个，再用 `issue brief` 读取完整上下文。
- [x] L-6 覆盖活动状态过滤、显式历史查询、全状态完整输出、空白归一化、Unicode 截断和 50 字边界测试。

### 收尾

- [x] E-1 `npm run typecheck`、`npm run build:web`、`npm test` 全绿（399 个测试）。
- [ ] E-2 已完成两条存量任务的 `issue brief` 真实输出字节测量（`6752 → 5198`、`2643 → 1695`）及当前项目 `issue list` 测量（全状态完整 `24603 → 3707` 字节，约减少 85%）；真实客户端读取耗时和上线后新增评论的观察窗口仍待积累。
- [x] E-3 按 `document/updates/RULES.md` 把最终机制写进 `document/updates/2026-08.md`。

## 8. 会不会影响现在的正常使用

| 改动 | 谁会察觉 | 会不会弄坏东西 |
|---|---|---|
| P1-1 加 `issue brief` | 没人 | **不会。** 纯新增命令，`issue get` / `comment list` 一个字不动 |
| P1-2 手册改按需读、补不重复认领规则 | Agent 少读一份手册、不再重复 move | **不会。** 文档改动，最坏是 Agent 少了点提示 |
| P1-3 Codex 指令变长、shim 带上服务地址、启动原生任务前确保 shim 就绪 | 你会在 Codex 输入框里看到更长的一行；`.data/bin/taskctl` 内容变了 | **这是本阶段唯一有真实回归面的一项，要实测七件事**：① `textContent.includes` 会不会被中文和括号搞坏；② 有没有超 1,024 字符；③ shell 引用对不对；④ shim 在启动 Codex 前确实存在；⑤ **shim 里的服务地址对不对**（非默认端口、以及客户端继承了错误 `CODEX_TASKBOARD_URL` 的情况）；⑥ **收尾的 `comment add` / `issue move` 也走通**，不只是第一条 `issue brief`；⑦ **只有一个写入者**，AI 面板和原生协调器不会互相覆盖 shim。前四件失败表现是启动报错、任务停在「进行中」，不丢数据；⑤⑥ 会让 Agent 看起来在干活但写不回看板；⑦ 是间歇性的，最难查 |
| P1-4 同步定时提示 | 定时任务的行为跟着变 | **不会坏**，但必须跟 P1-1 同时上，否则定时路径按老规矩跑 |
| P1-5 相对软链 | 没人 | **已完成**，`CLAUDE.md` 内容照常读到 |
| P2 评论规则 | 看板上评论变短、长尾消失 | **不会。** 纯文档，随时可退。但影响本机所有 Claude 会话（P2-5） |
| `issue list` 默认精简索引 | CLI 用户和 Agent | **有意改变 CLI 契约。** 默认不再返回已完成任务或完整任务对象，`schemaVersion` 升到 3；统计、导出和诊断须显式使用 `--all-statuses --full`。HTTP API、Web 看板和数据库不变 |

**要说清楚的几处措辞**（前稿这里写得太绝对）：

- **看板界面**：不受影响。接口响应结构一个字不改。
- **数据库**：不受影响。schema 不动，历史评论不动。
- **AI 对话面板和 `codex exec`**：**传输代码不变，但行为会变**——它们读同一份 `SKILL.md`、调同一个 CLI。说"完全不受影响"是不准确的。
- **云模式**：`cloud login/status/logout` 不受影响；issue/comment 命令走同一份 CLI，因此 `issue list` 默认索引和本地保持一致。
- **Claude 的任务自动启动**：代码路径不改（P1-3 只改 Codex），但 `SKILL.md` 一改，行为跟着变。

## 9. 怎么验收（不承诺 token 数）

前稿写「9,000 → 3,000 token」，**这个承诺撤销**：原生 Codex 路径压根没有事件流进看板，采不到 usage（`normalizeCodexEvent` 里那套 `input_tokens`/`output_tokens` 只对 `codex exec` 有效）。没有测量手段就不该承诺数字。

改成量这几个可测的：

| 指标 | 怎么测 | 目标 |
|---|---|---|
| **工具往返次数** | 数一次执行里干活前的 `taskctl` 调用数 | **从 2 次降到 1 次**（不是 3→1，见第 3 节） |
| **载荷字节** | 实现后用 `wc -c` 比 `issue brief` 和 `issue get`+`comment list` 的**真实输出字节** | **记录实测值，不预设比例**（第 4 节的 14–29% 是 token 模拟，口径不同，别拿来当字节目标） |
| **上下文读取耗时** | 从任务启动到**第一次非 Taskboard 工具调用**的时间 | 用同一个基准任务重复几次取中位数 |
| **评论长尾** | **只统计上线后新增的评论**，观察至少 10–20 条 | >800 字的比例下降；对仍然超 800 字的**人工判断**是不是含必要交接信息，不追求机械归零 |
| **评论条数形状** | 每次用户反馈 / 每次交付分别产生几条 | 各不超过一条；初始轮只有交付评论 |

**关于那个 14–29%**：第 4 节的数字是**按字段清单模拟计算**出来的 token 估算（CJK 按 1 token/字符、ASCII 按 0.28），不是跑 `issue brief` 量出来的——这条命令还没实现。所以它只能当**实现前的参考区间**。实现后要用 `wc -c` 量真实字节，两套口径不要混着报。

**两条关于测量方法的提醒：**

- **历史评论不会被改写**，所以「11% / 38% 降下来」不能当成上线后的即时验收指标。必须划一个观察窗口，只看新增的。
- **不要用「拖入进行中到第一次代码改动」**——它受任务复杂度和模型波动影响太大。改测「启动到第一次非 Taskboard 工具调用」，并且固定同一个基准任务重复几次。

如果确实要拿 token 数，得先补测量手段——Codex 原生路径目前没有采集点，这本身是另一件事。

行为不能回退的部分：

- Claude 照样拿到上下文、正常干活（P1-6）。
- 已有 active automation 重新 reconcile 后 prompt 确实被更新（P1-4b）。
- `npm test` 全绿，看板界面行为无变化。

## 10. 明确不做

- **不改接口响应。** 只动 CLI 打印。
- **不加服务端接口。** `issue brief` 在 CLI 里合并现有请求就够。
- **不新增 `--compact`。** `issue list` 的正式默认语义就是活动任务精简索引；完整对象走 `--full`。
- **不写代码卡评论字数。** 软约束就够，硬卡会在真需要展开时误伤。
- **不动数据库。**
- **不改月度更新机制**（那是任务 `7627EC6179C0-2`）。
- **不解决 `~/.claude/skills` 手工软链的问题**（已确认本轮不考虑）。
- **不新增 `issue queue` 之类的命令**（超出当前范围，可留作后续）。

## 11. 风险

- **启动指令当前有 1,024 字符的项目内协议上限。** 这个值可调整，不是 Codex 的已知硬限制；但启动指令仍应只负责寻址，任务内容走 `issue brief`，避免维护第二份上下文。
- **Claude 的 skill 触发是概率性的**（模型自己决定读不读），且靠仓库外的手工软链安装。`CLAUDE.md` 改相对软链后，`AGENTS.md` 这条必达通道稳了，但 skill 那条仍然不稳。所以 P1-2 只做「手册改按需读」，不往下删 `AGENTS.md`。
- **第二阶段靠 Agent 自觉**，没有程序保证。先看实际表现。
- **第二阶段在云模式下会削弱远端协作者的上下文。** 实时流存在本机 SQLite，云看板的协作者看不到。现在是单机用，这条还没兑现，将来多人协作要重新掂量。
- **状态变更活动流已移出本方案。** 它是独立产品需求，不作为本次效率改造的未完成项。

## 12. 修订记录

**第二稿**：撤销「Claude 同步改启动措辞」（它本来就有 `<taskboard_context>`）；加 A0 卡口（`taskctl` 不在客户端 PATH 里）；收窄 C 组；补 `--resume`、返工评论边界、云模式风险。

**第三稿**：全文改通俗，去掉「投影」等术语；新增「两个 Agent 跑法差别」一节；新增「会不会影响正常使用」一节；修正 D-1 被夸大的收益。

**第四稿（本稿，同事只读审查后大改）**：

1. **改掉核心误判：返工不续写会话。** 前稿以为每轮返工 `--resume` 重放同一段 8,000 token，实际是 Codex 每次 `createTask` 新建原生任务、Claude 每次 `createThread` 新建线程、数据库每任务每 Agent 只留最新一条绑定，`--resume` 只在 AI 面板续聊时走。改为**每轮冷启动**——结论方向不变（A 组更该做），但机制和推算全部重写。
2. **新增「三种运行方式」一节。** 前稿把「用户拖入」「定时认领」「面板续写」混成一条流程。补充：用户拖入后 Agent 不该再认领，因为 `moveTask` 无条件涨 version，会白写一次还把卡片挪到列尾。
3. **重写评论规则的依据。** 真实分布是中位数 256 字、52% 已达标、只有 4 条 >800 字却占 38% 字符——是长尾问题不是普遍问题，硬上限不合适。另外发现那些「用户审查反馈」评论**全是 Agent 转录的**，结合每轮新会话，它们是唯一的跨轮交接材料，**动不得**。前稿「诊断推演一律不写评论」是错的，会让下一轮重新调查。
4. **补齐 `issue brief` 的字段。** 前稿留了评论 `id` 却丢 `version`，而 `comment update` 必须带 version，等于留了个改不了的把手。另补 `authorType`、`assignee.id`、非空附件、非空业务字段、`--comments N` 的 `truncated` 标志。
5. **修正 Codex 指令的 CLI 路径来源。** 前稿的 `node <工作区>/cli/taskctl.mjs` 只对本仓库成立，管别的项目时那儿没有 CLI。改用服务端的 `taskctlCliPath`。同时补上三条漏掉的硬约束：1,024 字符上限、空格引用、不放 version；并指出协调器目前**没有项目名**这个输入缺口。
6. **D 组降级为 `--compact` opt-in。** 理由不是「现有脚本会坏」（实测仓库内只有测试消费），而是 `schemaVersion: 2` 是声明过的契约，以及 `issue list` 砍描述会削弱建任务前的查重能力。
7. **纠正 C 组的夸张。** `AGENTS.md` 第 8 行本来就写了「不重复维护」，重叠只有约 150 token；收益几乎全在 `cli.md` 改按需读。
8. **补 `CLAUDE.md` 相对软链**（已执行）。原来是提交进 Git 的绝对路径软链，换目录就断，前稿「AGENTS.md 必然加载」的兜底论证因此有洞。
9. **补同步定时认领提示语**。前稿 D-5 写「无需改动」是错的。
10. **撤销 token 数承诺**，改成可测的工具往返次数、输出字节、评论长尾占比、端到端延迟；并指出原生 Codex 路径目前没有 usage 采集点。
11. **软化「不受影响」的措辞**：AI 面板和 `codex exec` 只是传输代码不变，行为会跟着 `SKILL.md` 变；云模式 issue/comment 命令也走同一份 CLI。
12. **改成分两阶段 + 单独评估**，而不是四组并列。

**第五稿（第二轮审查后修订）**：

1. **撤销 `issue brief` 被夸大的收益。** 前稿说载荷从 ≈4,160 降到 ≈1,500（约 64%），依据是「65% 是包装纸」。但按补全后的必留字段、基于两个真实任务的实际数据模拟计算，**只降 14–29%**——因为大部分「包装纸」（评论的 `id`/`version`/`authorType`、任务的关系类型、非空附件等）其实必须留，真正能扔的只剩每条约 88 token。**P1-1 的主要价值改为「两次往返合成一次」，载荷是顺带。**
2. **补上任务级附件。** `GET /api/tasks/:id/attachments` 是独立接口，前稿只合并 task 和 comments，「一次拿全」只覆盖了评论附件。改为并行发三个请求，模型侧仍是一次工具调用。
3. **修正基线 2 而非 3。** 执行既有任务不需要 `context current`（`issue get <任务号>` 直接吃标识符），它属于建任务查重路径。第 3 节的流程、第 4 节的成本表、第 9 节的验收目标一并改。
4. **收回「冷启动一定比 resume 更贵」。** 没有证据；谁更贵取决于历史长度、缓存命中和计费方式。只主张「精简读取的收益会每轮重复发生」。
5. **重写开头那句「真正有用的不到 400」。** 这是个没定义的价值判断，且与「任务内容 ≈4,160」自相矛盾。改成「其中约多少属于可避免的字段冗余和白背手册」（具体数字在第六稿又修正了一次）。
6. **Codex 的确定性命令改用 shim 绝对路径。** 前稿的 `node <路径>` 还依赖客户端能解析 `node`——从 Finder 启动的客户端未必继承 NVM PATH。而 `.data/bin/taskctl` 这个 shim 里**已经焊死了 node 绝对路径**，直接用它一次解决两个问题。同时补上前稿漏的前提：shim 是懒创建的，必须在服务启动时确保存在。引用要求也从「含空格」放宽成「所有 shell 特殊字符」。
7. **P1-0 降级。** 已在真实 Codex 原生会话确认：`taskctl` 解析不到、shim 存在、`CODEX_THREAD_ID` 存在。不再是架构卡口，保留一次烟测。
8. **`moveTask` 的发现补上行动项。** 前稿只在说明里写了「同状态 move 会白涨 version 并挪到列尾」，没落成规则。新增 P1-2d：任务已是 `in_progress` 且负责人是自己就直接开工，配测试。
9. **去掉 `--comments N`。** 正常执行本来就要读全部评论（它是跨轮次唯一交接材料），截断读只会漏掉用户要求；而且「最新 N 条还是最早 N 条」也没定义。
10. **`authorType` 的局限写明。** 它区分不了「Agent 转录的用户反馈」和「Agent 自己的判断」——当前样本里两者都是 `agent`。真要区分得靠第二阶段的内容意图标签。
11. **关联任务必须保留关系类型**，不能拍平成一组任务。
12. **改掉「第一阶段不改变任何现有行为」。** 它确实会改 Agent 行为（手册读取、Codex 指令、定时读取方式、软链），不改的是公共 API、数据库、界面和旧 CLI 默认输出契约。
13. **状态从「未实施」改为「部分实施：仅 P1-5」**，因为 `CLAUDE.md` 已经真改了。
14. **验收指标加观察窗口。** 历史评论不会被改写，所以「11%/38% 降下来」不能当即时指标，必须只统计上线后新增的、观察 10–20 条，且对超长评论人工判断而非机械归零。端到端延迟改测「启动到第一次非 Taskboard 工具调用」，固定基准任务重复几次。
15. **定时提示的验收加一条**：已有 active automation 重新 reconcile 后 prompt 确实被更新，不能只测新建的。

**第六稿（第三轮审查后修订）**：

1. **补上服务地址这个致命缺口。** 前稿用 shim 绝对路径解决了 `taskctl` 和 `node` 的解析，但 shim 里**没有服务地址**。`taskctl` 从 `CODEX_TASKBOARD_URL` 读，读不到就默认 47823；而端口可以用 `CODEX_TASKBOARD_PORT` 改。服务只给自己起的子进程注入这个变量，原生 Codex 是已经在跑的客户端，注入不进去。**非默认端口下会出现「任务建起来了、shim 也能跑、但连错端口拿不到任务」——看起来像 Agent 不干活。** 改法是把地址焊进 shim。加了非默认端口测试。
2. **「约 4,000 可避免」改成 2,200–2,400。** 按文档自己的数字：手册 ≈1,565 + `issue brief` 差额 ≈606–790 = ≈2,171–2,355。前稿把「每轮重复读取」也算进可避免开销，不对——正文和新增反馈本来就必须读，重复只是让收益发生多次。
3. **收窄 P1-3 的目标。** 前稿叫「启动指令带上上下文」，但项目 ID 和工作区路径对 Agent 是冗余的（工作目录已由 `electron-set-active-workspace-root` 设好），也替代不了读描述和评论。这一节只解决「让命令能跑通」，项目名不进指令。真正把 2→1 做掉的是 `issue brief`。
4. **补齐实现细节。** `ensureTaskctlBin()` 返回的是**目录**不是 shim 路径；`shellQuote` 是**私有函数**要先导出；shim 就绪改成「启动 Codex 任务前 await」而不是「服务启动时或启动前二选一」。
5. **定义内容意图标签。** 前稿在 P1-1 引用了「第二阶段的内容意图标签」，但第二阶段从没定义过。现在明确用自然语言前缀 `用户反馈：`/`交付：`/`需决策：`/`阻塞：`，不新增数据库字段。
6. **改掉「交付 1 条 + 反馈 1 条」。** 那是配额式表述，会诱导 Agent 在没有新反馈时也硬凑一条。改成「都是上限不是配额」「初始轮通常只有交付评论」。
7. **统一验收口径。** 14–29% 是**按字段清单模拟计算**的 token 估算，不是命令实测（`issue brief` 还没实现）。标明它只是实现前的参考区间，实现后用 `wc -c` 量真实字节，两套口径不混报。
8. **删掉自相矛盾的风险第 1 条**（还写着 P1-0 没确认，与前文「已确认」冲突）。
9. **修正 reconcile 的说法。** 不只是用户显式触发——`web/src/App.tsx` 里有个跟着 `selectedProjectId` 走的 effect，项目加载/切换时会发 `apply-policy`。准确说法是「不会后台热更新，但下次项目加载、切换或手动操作时更新」。
10. **软化「唯一交接材料 / 唯一输出通道」。** 改成「唯一按轮追加、且下一轮默认必读的 Taskboard 文本载体」——描述、代码、测试、状态、附件也持久化，只是不按轮追加或不在默认读取链上。

**第七稿（第四轮审查后修订）——都是 shim 契约的细节，没有结构性改动**：

1. **shim 里的地址改成强制覆盖。** 前稿写 `${CODEX_TASKBOARD_URL:-…}` 想保留显式覆盖的余地，但那样客户端一旦继承了过期的 `CODEX_TASKBOARD_URL`，shim 还是会连到旧看板。而且现有 `#turnEnv()` 本来就是强制覆盖（`{...processEnv, CODEX_TASKBOARD_URL: taskboardUrl}` 先展开再赋值），服务生成的 Agent 专用 shim 应保持同一语义。想连别的看板用全局 `taskctl`。
2. **撤销「`ensureTaskctlBin()` 返回 shim 文件路径」——这条照做会打断现有功能。** 当前返回值直接进 `withTaskctlOnPath(env, binDirectory)` 拼 PATH，改成文件路径等于往 PATH 塞了个文件，AI 面板、`codex exec`、Claude 子进程里的裸 `taskctl` 会一起失效。改成调用点自己 `path.join(binDirectory, "taskctl")`。（前稿正文其实已经这么写了，是待办清单跟正文自相矛盾。）
3. **补上「两个调用点共用同一份 shim」。** `server/ai-chat.mjs` 现在调 `ensureTaskctlBin` 是不带地址的；加了地址后若两边各调各的，后调的会把 shim 覆盖回无地址版本。
4. **指令必须声明整轮任务都用绝对 shim。** `SKILL.md` 第 8 行写的是裸 `taskctl`，只保证第一条 `issue brief` 能跑的话，收尾的 `comment add` / `issue move` 照样失败——而且失败在活干完之后，代价最大。
5. **修正「shim 每次服务启动都重写」**，实际是懒创建，准确说法是「首次 Agent 使用或原生任务启动前重写」。
6. **评论模板补上意图前缀示范**（`交付：<一句话结论>`），前稿定义了前缀却没在模板里体现。
7. **验收表的字节指标改成「记录实测值，不预设比例」**，不再拿 token 模拟出来的 14–29% 当字节目标；正文第 185 行的「实测」也改成「模拟估算」。
8. **P1-3 的测试扩成四条**：非默认端口、错误环境变量下仍连对、后续写操作同样走通、裸 `taskctl` 在 PATH 上仍可解析。

**第八稿（第五轮审查后修订）——只剩收尾，无结构性改动**：

1. **P1-3b 从「二选一」收敛成「只允许唯一 memoized ready 入口」。** 前稿写「共享 ready promise，或保证两边传参一致」，后半句要删：`ensureTaskctlBin` 用的是 `writeFile`（`'w'` 会先 truncate），就算参数完全相同，两次独立写入仍可能撞出瞬时空文件或半截内容，而原生 Agent 恰好在那个窗口执行 shim 就会失败。而且「参数一致」这种约定会随后续改代码漂移。写法收敛成一个 memoized `ensureTaskctlReady()`。
2. **补一条并发断言测试**：两条路径同时请求 shim 时底层只写一次。原来那四条测的是结果正确性，没有直接守住「唯一写入者」。
3. **新增独立待办：服务 origin 要在 `listen()` 之后从真实绑定端口取，且只取一次。** 顺着审查意见查下去发现问题比预想的大——`taskboardUrl` 现在是**构造时**用 `resolvePort()` 算的，而 `listen({host, port})` 允许传任意端口，**测试就在用 `listen({port: 0})` 绑随机端口**。也就是说这个偏差**已经存在**（AI 面板子进程拿到的地址就是错的），只是没人真从子进程回连所以没暴露。一旦把地址焊进 shim，它就会变成「Agent 连错端口」——正好是这一节要消灭的故障。
4. **待办编号修掉重复的 `P1-3c`**，后续顺延为 d/e/f/g。
5. **兼容性表把 P1-3 那行从「四件事」补到七件**，加上服务地址、唯一写入者、收尾写操作，并区分了三类失败的表现（启动报错 / 写不回看板 / 间歇性）。
6. **`--compact` 的措辞**从「对 Agent 路径零损失」改成「对**默认路径**零影响」——用错场景当然会少字段，所以由 `SKILL.md` 说明什么时候该用。

**第九稿（本稿，第六轮审查后修订）——收尾，审查到此结束**：

1. **端口测试换成 `listen({port: 0})`。** 前稿写的是改 `CODEX_TASKBOARD_PORT`，但那**抓不到刚发现的 bug**——构造和 `listen()` 读同一个环境变量，两边会一起变，构造时固化地址的旧实现照样通过。只有随机监听端口能证明「shim 里写的是真实绑定端口」。环境变量那条降为第二用例。
2. **origin 写成 runtime provider，不只是「listen 后注入」。** `AiChatService` 现在是在构造函数里把地址固化进 `processEnv` 的，光挪注入时机，值照样被冻一次。明确成：唯一 provider、`listen()` 后初始化、`#turnEnv()` 和 `ensureTaskctlReady()` 每次现取、**未初始化就调用要报错不许回退 47823**。
3. **待办编号顺延**，`P1-3a2` 这种别扭写法去掉，改成连续的 a–h。
4. **兼容性表**「shim 提前创建」改成「启动原生任务前确保就绪」，跟懒创建机制的说法一致。
5. **修订记录里残留的「实测 14–29%」**改成「基于真实任务数据模拟计算」，避免被单独摘出去时误解成命令实测。

**第十稿（第九稿实施后的产品边界修订）**：

1. **撤销 `--compact`。** 列表本来就应是候选任务索引，不应默认批量导出完整对象，再依赖 Agent 记得精简。
2. **默认排除终态。** 人工创建和派发为主，日常查重、盘点不读取 `done` / `canceled`；历史回顾显式指定状态。
3. **描述改 50 字预览。** 列表只负责选择下一条读取，完整要求由选中后的 `issue brief` 提供；预览使用独立字段和截断标志，避免被误认为全文。
4. **保留显式完整出口。** `--all-statuses` 控制范围，`--full` 控制字段，统计、导出和诊断使用两者组合。
5. **正面升级契约。** 默认输出改变，`schemaVersion` 升到 3；HTTP API、Web 看板和数据库保持不变。
6. **P2-6 移出。** 状态变更活动流是独立产品需求，不再挂在本效率方案的未完成项里。
7. **澄清 1,024 字符上限。** 它是本项目 host 桥接协议自设的防御性限制，不是 Codex 的已知上限；完整运行逻辑另行沉淀为长期说明并从 README 链接。
