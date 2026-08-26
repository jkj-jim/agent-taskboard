---
name: manage-taskboard
description: 管理 Taskboard 的项目、任务、任务关系和评论，操作层用当前可用的 taskboard MCP 工具或 taskctl CLI。需要开始执行某个任务、读取任务详情和评论、更新任务状态、记录交付结果、跟踪新需求、创建或更新任务、关联依赖工作或协调并发更新时使用。
---

# 管理 Taskboard

本文件规定流程规则。**操作层用哪一种，取决于当前可用的能力**：

- 如果能调用看板的 MCP 工具，**全程只用这些工具**：不要查找、安装或运行任何命令行工具，也不要读取 [references/cli.md](references/cli.md)（它只描述命令行）。改状态的 `move_task` 必须带 `expectedVersion`，值取自最近一次 `get_task`。

  工具名是「MCP 服务名 + 下划线 + 操作」，例如服务名为 `agent-taskboard` 时是 `agent-taskboard_get_task`。**服务名按这个顺序确定，不要凭工具名眼熟就选**：

  1. 启动指令里点名的服务名。有它就只用它。
  2. 没有启动指令时用 `agent-taskboard`，那是安装版正式看板。
  3. 只有在前两条都不可用时，才考虑别的看板服务；`agent-taskboard-beta` 是预发布版，`taskboard` 是开发实例，两者的数据都不是正式数据。

  同一个客户端里可能同时注册着这三个看板，它们的数据各自独立。选错服务名不会报错，只会把工作写进另一块看板。
- 否则使用 `taskctl` 命令行。常用命令如下：

```bash
taskctl issue list --project PROJECT_ID [--status STATUS | --all-statuses] [--full] --json
taskctl issue brief ISSUE_ID --json
taskctl issue move ISSUE_ID --status STATUS --if-version N --json
taskctl comment add ISSUE_ID --body TEXT --json
```

只有需要此处未列出的命令或选项时，才读取 [references/cli.md](references/cli.md)。

**按这个顺序确定用哪个 `taskctl`，选定后本轮每一次 Taskboard 操作都用同一个，不只是首次读取：**

1. 启动指令里给出的绝对路径 shim。有它就只用它——它已经钉住了派发这次任务的那块看板。
2. `PATH` 上的 `taskctl`。
3. 都没有时，用安装版自带的：

   ```bash
   ~/Library/Application\ Support/io.github.jkj-jim.agenttaskboard/profiles/production/bin/taskctl
   ```

   这个路径在安装版首次运行后就存在，指向正式看板。

同一台机器上可能同时跑着多块看板（安装版、预发布版、开发实例），它们的数据各自独立。**不要自己设 `AGENT_TASKBOARD_URL` 去猜**：按上面的顺序选，选出来的就是对的那块。三条都不满足说明看板没装或没启动，如实报告，不要改用别的地址。

下文提到 `issue brief` 时，MCP 侧的等价操作是 `get_task`；提到 `issue move` 时等价于 `move_task`；提到 `comment add` 时等价于 `add_comment`。

下面各节按场景组织，按当前场景取用对应的一节，不必从头依次执行。已经拿到任务标识时，直接看「执行一个已有任务」，不要先查重或创建任务。

## 执行一个已有任务

- 先运行一次 `issue brief`，读取最新任务内容、全部评论、关系和非空附件。评论是当前要求的一部分，尤其是已交付工作被退回修改时。
  - 描述或评论中的 `![alt](/api/attachments/<id>/content)` 表示位于该段文字准确位置的行内图片。
  - 如果理解该图片是完成任务的必要条件，使用 `attachment download` 保存到本地，再用可用的图片查看工具检查。
- 认领 `todo` 任务时，开始实施前使用最新读取结果中的版本号，通过 `--if-version` 将它移至 `in_progress`。如果认领时报版本冲突，或重新读取后发现状态已经变化，跳过该任务，不要实施。如果任务已经是 `in_progress` 且负责人是当前 Agent，直接开始工作，不要再次移至 `in_progress`。
- 请求审核前，验证要求的工作和验收标准。
- 实现和自检完成后，添加 `交付：` 评论并把任务移至 `in_review`，绝不能直接移至 `done`。
- 只有用户明确确认验收，或明确要求标记完成时，才能把任务从 `in_review` 移至 `done`。Agent 自检不能替代用户验收。
- 无法继续的工作移至 `blocked`，不再继续的工作移至 `canceled`。

## 写评论

评论应是精炼的交接信息，不是过程日志。以下是上限，不是数量要求：每轮新反馈至多一条 `用户反馈：` 评论，每次交付一条 `交付：` 评论，需要时一条 `需决策：` 或 `阻塞：` 评论。首轮通常只需交付评论。目标长度约 300 个中文字符，但如果下一次会话需要更多细节，可以超过。保留能避免重复工作的根因、决策、约束和已排除方向；省略原始日志、逐步探索过程、失败尝试细节和逐文件 diff。省略空章节；新一轮写新评论，不要改写旧评论。

## 记录一个新需求

创建任务前先搜索活跃任务。先运行 `context current`，再对该项目运行默认的 `issue list`。该精简索引不返回 `done` 和 `canceled` 任务，只提供 50 个字符的 `descriptionPreview`；通过标识、标题、预览和状态判断是否重复。常规查重时不要加载已完成工作。如果某个活跃候选看起来相关或无法确定，先对它运行 `issue brief`，再作判断。

- 如果已有任务跟踪同一需求，把新需求或验收细节追加到原任务，不要丢弃其现有范围。
- 如果当前工作依赖、阻塞、受阻塞于其他任务，或与其他任务紧密相关，添加对应的任务关系。
- 当一个需求是更大任务中包含的一部分时，使用父任务/子任务关系。一个子任务只能有一个父任务，一个父任务可以有多个子任务。
- 只有没有现有任务能够合理承载该需求时，才创建新任务。
- 对不值得长期跟踪的细小或琐碎请求，不要创建任务，也不要追加或关联。
- 明确查询历史记录时使用 `--status done`。`--all-statuses --full` 只用于统计、导出或诊断，常规执行和查重不得使用。

## 所有写操作通用

- 使用 CLI 创建或更新任务，并读取它输出的 JSON。通过 `taskctl` 创建的任务默认分配给当前运行的 Agent（Codex Agent 或 Claude Agent）。之后的 CLI 更新不会改变负责人。
- 让 `taskctl` 把每一次任务、关系或评论变更归因到当前会话。Codex 中读取 `CODEX_THREAD_ID`，Claude Code 中读取 `CLAUDE_CODE_SESSION_ID`；如果不在这两种环境中，使用 `--thread-id` 传入准确的会话 ID。
- 每一次并发更新都带上 `--if-version <version>`，版本号取自最近一次读取。如果初次认领之外的写操作发生版本冲突，重新读取任务，协调更新后的状态，再使用当前版本重试。
