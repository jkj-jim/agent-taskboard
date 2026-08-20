// Automation instruction renderer（document/design/desktop-app-packaging.md §10）。
//
// 自动认领的提示词正文只在这里成形。它留在 shared/ 是因为注入脚本与浏览器侧
// 也要用同一份，但正文本身不再散落在调用点。

export function buildTaskboardAutomationPrompt(request) {
  return [
    `[$manage-taskboard](${request.skillPath}) e-taskboard 每 ${request.intervalMinutes} 分钟检查任务面板中的「${request.projectName}」项目（项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}）。`,
    `每次仅处理一个 todo：先用 issue list --project ${request.taskboardProjectId} --status todo --json 查看精简候选，只选一个；再用 issue brief 一次读取所选任务、全部评论与附件，确认是否包含已完成后被打回的返工要求。`,
    "认领时使用最新 version 将任务移动到 in_progress；若发生版本冲突或最新状态已变化，立即跳过，避免多个 Agent 抢同一任务。",
    "若任务已绑定 branch 或 worktree，必须在该任务绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
    "执行完成并验证后，最多写一条以「交付：」开头的总结评论，通常控制在 300 字内；保留关键改动、验证结论、交付结果与剩余风险，省略原始日志、探索过程和逐文件清单。随后读取最新 version 并移动到 in_review；不要直接标记为 done。",
  ].join("\n");
}
