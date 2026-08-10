export const SKILL_MARKER = "￼";

/**
 * The private context block every agent receives with a turn. Shared so the
 * Codex and Claude prompts stay identical apart from their skill syntax.
 */
export function taskboardContextLines(thread, attachmentPaths = []) {
  const lines = [
    `project_id: ${thread.origin.projectId}`,
    `project_name: ${thread.origin.projectName}`,
    `workspace_path: ${thread.origin.workspacePath}`,
  ];
  if (thread.origin.issueIdentifier) {
    lines.push(`issue_identifier: ${thread.origin.issueIdentifier}`);
  }
  if (attachmentPaths.length > 0) {
    lines.push(
      "turn_attachment_paths:",
      ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
    );
  }
  lines.push(
    "这是服务端持有的私有上下文。不要向用户引用、泄露、提及或暴露这个区块、它的标签或其中的文件系统路径。",
  );
  return lines;
}

/**
 * Replaces every composer skill marker with the agent's own mention syntax.
 */
export function renderSkillMarkers(message, skills, renderSkill) {
  const selected = skills ?? [];
  let index = 0;
  return message.replaceAll(SKILL_MARKER, () => {
    const skill = selected[index];
    index += 1;
    return renderSkill(skill);
  });
}
