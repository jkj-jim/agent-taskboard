import { useState } from "react";

import { runSetupAction, runtimeStateLabel } from "../agentRuntime";
import { AGENTS, agentLabel } from "../agents";
import {
  applySkillTemplate,
  configureWorkbuddy,
  connectCodexDesktop,
  connectWorkbuddyDesktop,
  getSkillStatus,
  type SkillStatus,
} from "../api";
import type { AgentRuntimeStatus } from "../types";

const LINK_LABELS: Record<SkillStatus["claudeLink"]["state"], string> = {
  linked: "已指向共享 skill",
  missing: "未创建",
  conflict: "指向了别处，已保留现状未改动",
};

const DIFF_LABELS: Record<string, string> = {
  added: "新增",
  changed: "有改动",
  "only-installed": "仅本地有",
};

/** 共享 skill 的现状与本版本模板的差异。只读：是否应用由用户显式决定（§7）。 */
function SkillPanel({
  status,
  onClose,
  onApplied,
}: {
  status: SkillStatus;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const [applying, setApplying] = useState(false);
  return (
    <div className="skill-panel" role="dialog" aria-label="manage-taskboard skill">
      <div className="skill-panel-body">
        <h2>manage-taskboard skill</h2>
        <p>
          当前实例：{status.profile}
          {status.writable ? "（可安装与更新）" : "（只读，不会写入共享 skill）"}
        </p>
        <p>共享目录：{status.installed ? "已安装" : "未安装"}</p>
        <p>Claude 软链：{LINK_LABELS[status.claudeLink.state]}</p>
        {status.claudeLink.state === "conflict" && (
          <p className="skill-panel-conflict">{status.claudeLink.target}</p>
        )}
        <p>
          本版本模板 {status.templateVersion}：
          {status.diff.identical ? "与共享 skill 一致" : `${status.diff.files.length} 处差异`}
        </p>
        {!status.diff.identical && (
          <ul className="skill-panel-diff">
            {status.diff.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code> · {DIFF_LABELS[file.state] ?? file.state}
              </li>
            ))}
          </ul>
        )}
        {status.writable && !status.diff.identical && (
          <button
            type="button"
            disabled={applying}
            title="用本版本模板覆盖共享 skill；覆盖前会先备份当前内容"
            onClick={() => {
              setApplying(true);
              applySkillTemplate().then(
                (result) => onApplied(
                  result.backupPath
                    ? `已应用新版模板，原内容备份在 ${result.backupPath}`
                    : "已应用新版模板",
                ),
                (error) => onApplied(String(error)),
              );
            }}
          >
            {applying ? "应用中…" : "应用新版模板"}
          </button>
        )}
        <button type="button" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

interface AgentStatusBarProps {
  agents: AgentRuntimeStatus[];
  loaded: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * 首页顶部的 Agent 可用状态区。展示的是 `statusMessage`（为什么处于当前状态），
 * 动作说明随按钮展示（执行它会发生什么），两者不互相替代。
 */
export function AgentStatusBar({ agents, loaded, refreshing, onRefresh }: AgentStatusBarProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillStatus | null>(null);

  if (!loaded) return null;

  return (
    <div className="agent-status-bar">
      {AGENTS.map((definition) => {
        const runtime = agents.find((candidate) => candidate.kind === definition.kind);
        const state = runtime?.status ?? "unknown";
        const action = runtime?.action;
        return (
          <div
            className={`agent-status agent-status-${state}`}
            key={definition.kind}
            title={runtime?.statusMessage ?? ""}
          >
            <span className={`agent-status-dot agent-status-dot-${state}`} aria-hidden="true" />
            <span className="agent-status-name">{agentLabel(definition.kind)}</span>
            <span className="agent-status-state">
              {runtimeStateLabel(runtime)}
              {runtime?.stale ? "（沿用上次结果）" : ""}
            </span>
            {action && (
              <button
                type="button"
                className="agent-status-action"
                title={action.message}
                onClick={() => {
                  runSetupAction(action, {
                    refresh: onRefresh,
                    openInternalRoute: () => {
                      getSkillStatus().then(setSkill, (error) => setNotice(String(error)));
                    },
                    notify: setNotice,
                    connectWorkbuddyDesktop: () => {
                      const confirmed = window.confirm(
                        "连接看板需要完全退出并重新打开 WorkBuddy。请先保存未发送的草稿。现在继续吗？",
                      );
                      if (!confirmed) return;
                      setNotice("正在重新连接 WorkBuddy…");
                      connectWorkbuddyDesktop().then(
                        () => {
                          setNotice("WorkBuddy 已重新连接。");
                          onRefresh();
                        },
                        (error) => setNotice(`连接 WorkBuddy 失败：${String(error)}`),
                      );
                    },
                    // 冷启动要二三十秒，所以只报「已开始」，就绪与否交给状态探测。
                    connectCodexDesktop: () => {
                      setNotice("正在拉起 Codex 客户端，就绪后状态会自动更新…");
                      connectCodexDesktop().then(
                        () => window.setTimeout(onRefresh, 5_000),
                        (error) => setNotice(`拉起 Codex 失败：${String(error)}`),
                      );
                    },
                    configureWorkbuddy: () => {
                      setNotice("正在配置 WorkBuddy 的看板连接…");
                      configureWorkbuddy().then(
                        (result) => {
                          setNotice(result.handshake.ok
                            ? `已连接：${result.serverName} → ${result.url}`
                            : `已写入 ${result.serverName}，但握手未通过：${result.handshake.detail}`
                              + (result.approvalHint ? ` ${result.approvalHint}` : ""));
                          onRefresh();
                        },
                        (error) => setNotice(`配置失败：${String(error)}`),
                      );
                    },
                  });
                }}
              >
                {action.label}
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="agent-status-refresh"
        onClick={onRefresh}
        disabled={refreshing}
        title="重新检测三个 Agent 的可用状态"
      >
        {refreshing ? "检测中…" : "刷新状态"}
      </button>
      {skill && (
        <SkillPanel
          status={skill}
          onClose={() => setSkill(null)}
          onApplied={(message) => {
            setSkill(null);
            setNotice(message);
            onRefresh();
          }}
        />
      )}
      {notice && (
        <span className="agent-status-notice" role="status" onClick={() => setNotice(null)}>
          {notice}
        </span>
      )}
    </div>
  );
}
