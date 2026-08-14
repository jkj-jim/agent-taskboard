import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getAiChatCatalog,
  getAiChatThread,
  interruptAiChatRun,
  startAiChatTurn,
  subscribeAiChatThread,
  updateAiChatThread,
} from "../api";
import {
  AI_CHAT_SKILL_MARKER,
  aiChatEventStatus,
  buildTurnInput,
  chatPrimaryAction,
  createAiSnapshotRefreshQueue,
  filterVisibleAiEvents,
  normalizeChatSelection,
  parseAiChatComposerFragment,
  patchAiChatSnapshot,
  reasoningEffortForModel,
} from "../aiChatState";
import type {
  AiChatCatalog,
  AiChatEvent,
  AiChatAttachmentInput,
  AiChatModel,
  AiChatRun,
  AiChatSkill,
  AiChatThread,
  AiChatThreadSnapshot,
} from "../types";
import { LinearIcon, type LinearIconName } from "./LinearIcon";
import { agentLabel } from "../agents";

/**
 * The transcript of one board-run agent turn, opened from the task that owns it.
 *
 * There is no conversation to start here and no list to browse: a thread exists
 * because a task was dispatched to an agent the board can run, and this is where
 * that run is watched and answered.
 */
interface AiChatProps {
  threadId: string;
  onClose: () => void;
}

type MenuName = "model" | "model-list" | "effort-list" | null;
type ComposerAttachment = AiChatAttachmentInput & {
  id: string;
  previewUrl?: string;
};
type ComposerSkillToken = {
  key: string;
  id: string;
  element: HTMLSpanElement;
};
type ComposerSkillQuery = {
  query: string;
};
type ComposerBeforeInput = {
  container: Node;
  offset: number;
  text: string;
};
type PanelResizeEdge = "top" | "left" | "top-left";
type PanelGeometry = {
  width: number;
  height: number;
};
type PanelResizeSession = {
  edge: PanelResizeEdge;
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  geometry: PanelGeometry;
  captureTarget: HTMLElement;
};

const PANEL_GEOMETRY_KEY = "taskboard.aiChat.panelGeometry";
const PANEL_EDGE_GAP = 8;
const PANEL_MIN_WIDTH = 420;
const PANEL_MAX_WIDTH = 960;
const PANEL_MIN_HEIGHT = 360;
const PANEL_DEFAULT_GEOMETRY: PanelGeometry = {
  width: 420,
  height: 700,
};
const SKILL_MARKER = AI_CHAT_SKILL_MARKER;
const SKILL_LINK_PREFIX = "#ai-chat-skill-";
const COMPOSER_FRAGMENT_MIME = "application/x-codex-taskboard-composer-fragment";
const COMPOSER_HTML_BLOCKS = new Set([
  "ADDRESS",
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
  "SECTION",
]);
const COMPOSER_HTML_IGNORED = new Set(["SCRIPT", "STYLE", "SVG"]);
function clampPanelGeometry(geometry: PanelGeometry): PanelGeometry {
  const maxWidth = Math.min(
    PANEL_MAX_WIDTH,
    window.innerWidth - PANEL_EDGE_GAP * 2,
  );
  const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
  const maxHeight = window.innerHeight - PANEL_EDGE_GAP * 2;
  const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, geometry.width)),
    height: Math.min(maxHeight, Math.max(minHeight, geometry.height)),
  };
}

function loadPanelGeometry(): PanelGeometry {
  const stored = window.localStorage.getItem(PANEL_GEOMETRY_KEY);
  if (!stored) return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
  try {
    const geometry = JSON.parse(stored) as PanelGeometry;
    if (
      !Number.isFinite(geometry.width)
      || !Number.isFinite(geometry.height)
    ) {
      return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
    }
    return clampPanelGeometry(geometry);
  } catch {
    return clampPanelGeometry(PANEL_DEFAULT_GEOMETRY);
  }
}

const EFFORT_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极高",
};

function modelDisplayName(value: string): string {
  return value.replace(/^GPT-/i, "").replaceAll("-", " ");
}

const SKILL_ACRONYMS = new Map([
  ["ai", "AI"],
  ["api", "API"],
  ["cli", "CLI"],
  ["mcp", "MCP"],
  ["sdk", "SDK"],
  ["ui", "UI"],
]);

function skillDisplayName(skill: Pick<AiChatSkill, "id" | "label">): string {
  const rawLabel = skill.label === skill.id && skill.id.includes(":")
    ? skill.id.slice(skill.id.lastIndexOf(":") + 1)
    : skill.label;
  return rawLabel
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (
      SKILL_ACRONYMS.get(word.toLocaleLowerCase())
      ?? (/^[A-Z][A-Za-z0-9]*$/.test(word)
        ? word
        : `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    ))
    .join(" ");
}

function eventSkillIds(event: AiChatEvent): string[] {
  const values = event.data?.skillIds;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function eventHasAttachments(event: AiChatEvent): boolean {
  return Array.isArray(event.data?.attachments) && event.data.attachments.length > 0;
}

function serializeComposer(root: HTMLElement): { message: string; skillIds: string[] } {
  let message = "";
  const skillIds: string[] = [];
  const appendText = (value: string) => {
    message += value.replaceAll("\u200B", "");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const skillId = node.dataset.skillId;
    if (skillId) {
      message += SKILL_MARKER;
      skillIds.push(skillId);
      return;
    }
    if (node.tagName === "BR") {
      message += "\n";
      return;
    }
    const isBlock = node.tagName === "DIV" || node.tagName === "P";
    if (isBlock && message && !message.endsWith("\n")) message += "\n";
    for (const child of node.childNodes) visit(child);
    if (isBlock && node.nextSibling && !message.endsWith("\n")) message += "\n";
  };
  for (const child of root.childNodes) visit(child);
  return { message, skillIds };
}

function selectedComposerFragment(root: HTMLElement): {
  message: string;
  skillIds: string[];
  range: Range;
} | null {
  const selection = root.ownerDocument.getSelection();
  const selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (
    !selection
    || selection.isCollapsed
    || !selectionRange
    || !root.contains(selectionRange.commonAncestorContainer)
  ) {
    return null;
  }
  const skillReferenceAt = (node: Node): HTMLElement | null => {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const composerToken = element?.closest<HTMLElement>(".ai-chat-composer-skill-token") ?? null;
    if (composerToken && root.contains(composerToken)) return composerToken;
    const reference = element?.closest<HTMLElement>("[data-skill-id]") ?? null;
    return reference && root.contains(reference) ? reference : null;
  };
  const copyRange = selectionRange.cloneRange();
  const startSkill = skillReferenceAt(copyRange.startContainer);
  const endSkill = skillReferenceAt(copyRange.endContainer);
  if (startSkill) copyRange.setStartBefore(startSkill);
  if (endSkill) copyRange.setEndAfter(endSkill);
  const wrapper = root.ownerDocument.createElement("div");
  wrapper.append(copyRange.cloneContents());
  const fragment = serializeComposer(wrapper);
  return fragment.message ? { ...fragment, range: copyRange } : null;
}

function composerMarkerCount(message: string): number {
  return message.split(SKILL_MARKER).length - 1;
}

function canonicalComposerFragment(
  fragment: { message: string; skillIds: string[] },
  skillsById: Map<string, AiChatSkill>,
): string {
  let index = 0;
  return fragment.message.replaceAll(SKILL_MARKER, () => {
    const skillId = fragment.skillIds[index] ?? "";
    index += 1;
    const skill = skillsById.get(skillId);
    return skill ? `[$${skill.id}](${skill.path})` : SKILL_MARKER;
  });
}

function composerFragmentHtml(
  fragment: { message: string; skillIds: string[] },
  skillsById: Map<string, AiChatSkill>,
  document: Document,
): string {
  const wrapper = document.createElement("div");
  const parts = fragment.message.split(SKILL_MARKER);
  parts.forEach((part, index) => {
    if (index > 0) {
      const skill = skillsById.get(fragment.skillIds[index - 1] ?? "");
      if (skill) {
        const link = document.createElement("a");
        link.setAttribute("href", skill.path);
        link.textContent = skillDisplayName(skill);
        wrapper.append(link);
      } else {
        wrapper.append(SKILL_MARKER);
      }
    }
    const lines = part.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) wrapper.append(document.createElement("br"));
      wrapper.append(line);
    });
  });
  return wrapper.innerHTML;
}

function writeSkillFragmentToClipboard(
  event: ReactClipboardEvent<HTMLElement>,
  fragment: { message: string; skillIds: string[] },
  skillsById: Map<string, AiChatSkill>,
): boolean {
  if (
    fragment.skillIds.length === 0
    || !fragment.skillIds.every((skillId) => skillsById.has(skillId))
  ) {
    return false;
  }
  event.preventDefault();
  event.clipboardData.setData(COMPOSER_FRAGMENT_MIME, JSON.stringify({
    message: fragment.message,
    skillIds: fragment.skillIds,
  }));
  event.clipboardData.setData("text/plain", canonicalComposerFragment(fragment, skillsById));
  event.clipboardData.setData(
    "text/html",
    composerFragmentHtml(fragment, skillsById, event.currentTarget.ownerDocument),
  );
  return true;
}

function decodedSkillPath(href: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("file:")) return decodeURIComponent(new URL(raw).pathname);
    if (!raw.startsWith("/")) return null;
    return decodeURIComponent(raw.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
}

function composerFragmentFromHtml(
  html: string,
  skills: AiChatSkill[],
): { message: string; skillIds: string[] } | null {
  if (!html || skills.length === 0) return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const skillsByPath = new Map(skills.map((skill) => [skill.path, skill]));
  const skillIds: string[] = [];
  let message = "";
  let matchedSkill = false;
  const appendText = (value: string) => {
    message += value.replaceAll(SKILL_MARKER, "\uFFFD");
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (COMPOSER_HTML_IGNORED.has(element.tagName)) return;
    if (element.tagName === "A") {
      const path = decodedSkillPath(element.getAttribute("href") ?? "");
      const skill = path?.endsWith("/SKILL.md") ? skillsByPath.get(path) : null;
      if (skill) {
        message += SKILL_MARKER;
        skillIds.push(skill.id);
        matchedSkill = true;
        return;
      }
    }
    if (element.tagName === "BR") {
      message += "\n";
      return;
    }
    const isBlock = COMPOSER_HTML_BLOCKS.has(element.tagName);
    if (isBlock && message && !message.endsWith("\n")) message += "\n";
    for (const child of element.childNodes) visit(child);
    if (isBlock && element.nextSibling && !message.endsWith("\n")) message += "\n";
  };
  for (const child of document.body.childNodes) visit(child);
  return matchedSkill ? { message, skillIds } : null;
}

function composerFragmentFromPlainText(
  text: string,
  skills: AiChatSkill[],
): { message: string; skillIds: string[] } | null {
  if (!text || skills.length === 0) return null;
  const skillsByPath = new Map(skills.map((skill) => [skill.path, skill]));
  const skillIds: string[] = [];
  let message = "";
  let cursor = 0;
  const referencePattern = /\[\$([^\]\r\n]+)\]\((\/[^)\r\n]*\/SKILL\.md)\)/g;
  for (const match of text.matchAll(referencePattern)) {
    const path = decodedSkillPath(match[2]);
    const skill = path ? skillsByPath.get(path) : null;
    if (!skill || skill.id !== match[1]) continue;
    message += text.slice(cursor, match.index).replaceAll(SKILL_MARKER, "\uFFFD");
    message += SKILL_MARKER;
    skillIds.push(skill.id);
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (skillIds.length === 0) return null;
  message += text.slice(cursor).replaceAll(SKILL_MARKER, "\uFFFD");
  return { message, skillIds };
}

function composerSkillQueryAt(
  root: HTMLElement,
  focusNode: Text,
  focusOffset: number,
): { query: string; range: Range } | null {
  if (!root.contains(focusNode)) return null;
  const rawPrefix = (focusNode.textContent ?? "").slice(0, focusOffset);
  const prefix = rawPrefix.replaceAll("\u200B", "");
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match) return null;
  const at = rawPrefix.lastIndexOf("@");
  const range = root.ownerDocument.createRange();
  range.setStart(focusNode, at);
  range.setEnd(focusNode, focusOffset);
  return { query: match[1].toLocaleLowerCase(), range };
}

function composerSkillQuery(root: HTMLElement): { query: string; range: Range } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || selection.focusNode?.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  return composerSkillQueryAt(root, selection.focusNode as Text, selection.focusOffset);
}

function composerSkillQueryAfterInput(
  root: HTMLElement,
  beforeInput: ComposerBeforeInput,
): { query: string; range: Range } | null {
  if (beforeInput.container.nodeType === Node.TEXT_NODE) {
    const textNode = beforeInput.container as Text;
    return composerSkillQueryAt(
      root,
      textNode,
      Math.min(beforeInput.offset + beforeInput.text.length, textNode.length),
    );
  }
  if (!(beforeInput.container instanceof HTMLElement) || !root.contains(beforeInput.container)) {
    return null;
  }
  const insertedNode = beforeInput.container.childNodes[beforeInput.offset];
  if (insertedNode?.nodeType !== Node.TEXT_NODE) return null;
  return composerSkillQueryAt(
    root,
    insertedNode as Text,
    Math.min(beforeInput.text.length, insertedNode.textContent?.length ?? 0),
  );
}

function tokenBeforeComposerCaret(root: HTMLElement): HTMLElement | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.isCollapsed || !selection.focusNode) return null;
  const focusNode = selection.focusNode;
  let candidate: ChildNode | null = null;
  if (focusNode.nodeType === Node.TEXT_NODE) {
    const prefix = (focusNode.textContent ?? "").slice(0, selection.focusOffset);
    if (prefix.replaceAll("\u200B", "").length > 0) return null;
    candidate = focusNode.previousSibling;
  } else if (focusNode instanceof HTMLElement) {
    candidate = focusNode.childNodes[selection.focusOffset - 1] ?? null;
  }
  while (
    candidate?.nodeType === Node.TEXT_NODE
    && !(candidate.textContent ?? "").replaceAll("\u200B", "")
  ) {
    candidate = candidate.previousSibling;
  }
  return candidate instanceof HTMLElement && candidate.dataset.skillId ? candidate : null;
}

function skillMarkdown(
  content: string,
  skillIds: string[],
  skillsById: Map<string, AiChatSkill>,
): string {
  let index = 0;
  return content.replaceAll(SKILL_MARKER, () => {
    const skillId = skillIds[index] ?? "";
    index += 1;
    const skill = skillsById.get(skillId);
    const label = skill
      ? skillDisplayName(skill)
      : skillDisplayName({ id: skillId, label: skillId });
    return `[${label.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${SKILL_LINK_PREFIX}${encodeURIComponent(skillId)})`;
  });
}

function SkillReference({
  skill,
  skillId,
}: {
  skill?: AiChatSkill;
  skillId: string;
}) {
  return (
    <span
      className="ai-chat-skill-reference"
      data-skill-id={skillId || undefined}
    >
      <LinearIcon name="project" />
      <span>{skill ? skillDisplayName(skill) : skillDisplayName({ id: skillId, label: skillId })}</span>
    </span>
  );
}

const ACTIVITY_LABELS: Record<string, string> = {
  plan: "执行计划",
  todo: "任务进度",
  todo_list: "任务进度",
  command: "运行命令",
  command_execution: "运行命令",
  file: "文件修改",
  file_change: "文件修改",
  mcp: "调用 MCP",
  mcp_tool_call: "调用 MCP",
  skill: "调用 Skill",
  web: "搜索资料",
  web_search: "搜索资料",
  error: "执行失败",
  "turn.failed": "执行失败",
};

const ACTIVITY_ICONS: Record<string, LinearIconName> = {
  plan: "write",
  todo: "status",
  todo_list: "status",
  command: "terminal",
  command_execution: "terminal",
  file: "file",
  file_change: "file",
  mcp: "link",
  mcp_tool_call: "link",
  skill: "project",
  web: "search",
  web_search: "search",
  error: "alert",
  "turn.failed": "alert",
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "AI 对话暂时不可用";
}

type ThinkingActivityDetail =
  | { kind: "lines"; summary: string; value: string[] }
  | { kind: "pre"; summary: string; value: string };

function parsedTodoLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const items = JSON.parse(value);
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" && text.trim() ? [text] : [];
    });
  } catch {
    return [];
  }
}

function activityDetail(event: AiChatEvent): ThinkingActivityDetail | null {
  const files = event.data?.files;
  if (Array.isArray(files)) {
    const visibleFiles = files.filter((value): value is string => typeof value === "string");
    if (visibleFiles.length > 0) {
      return { kind: "lines", summary: "查看文件", value: visibleFiles };
    }
  }
  if (event.type === "todo" || event.type === "todo_list") {
    const lines = parsedTodoLines(event.data?.detail);
    if (lines.length > 0) {
      return { kind: "lines", summary: "查看任务", value: lines };
    }
  }
  for (const key of ["output", "command", "detail", "path"]) {
    const value = event.data?.[key];
    if (typeof value === "string" && value.trim()) {
      return {
        kind: "pre",
        summary: activityDetailSummary(event),
        value,
      };
    }
  }
  return null;
}

function activityDetailSummary(event: AiChatEvent): string {
  if (typeof event.data?.output === "string" && event.data.output.trim()) return "查看输出";
  if (typeof event.data?.command === "string" && event.data.command.trim()) return "查看命令";
  if (typeof event.data?.detail === "string" && event.data.detail.trim()) return "查看详情";
  if (typeof event.data?.path === "string" && event.data.path.trim()) return "查看路径";
  if (Array.isArray(event.data?.files)) return "查看文件";
  return "查看详情";
}

function MarkdownMessage({
  children,
  skillsById,
}: {
  children: string;
  skillsById?: Map<string, AiChatSkill>;
}) {
  return (
    <div className="ai-chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            if (href?.startsWith(SKILL_LINK_PREFIX)) {
              const skillId = decodeURIComponent(href.slice(SKILL_LINK_PREFIX.length));
              return <SkillReference skill={skillsById?.get(skillId)} skillId={skillId} />;
            }
            return <a {...props} href={href} target="_blank" rel="noreferrer" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingStepDetail({
  detail,
}: {
  detail: ThinkingActivityDetail;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={`ai-chat-thinking-detail${isOpen ? " is-open" : ""}`}>
      <button
        aria-expanded={isOpen}
        className="ai-chat-thinking-detail-trigger"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span>{detail.summary}</span>
        <LinearIcon name="chevronRight" />
      </button>
      <div
        aria-hidden={!isOpen}
        className="ai-chat-thinking-detail-panel"
        inert={!isOpen}
      >
        <div className="ai-chat-thinking-detail-panel-inner">
          {detail.kind === "lines" ? (
            <div className="ai-chat-thinking-detail-lines">
              {detail.value.map((line, index) => (
                <span key={`${line}-${index}`}>{line}</span>
              ))}
            </div>
          ) : (
            <pre><code>{detail.value}</code></pre>
          )}
        </div>
      </div>
    </div>
  );
}

function ThinkingSteps({
  events,
  active,
}: {
  events: AiChatEvent[];
  active: boolean;
}) {
  const statuses = events.map(aiChatEventStatus);
  const status = statuses.includes("running")
    ? "running"
    : statuses.includes("failed") ? "failed" : "completed";
  const [isOpen, setIsOpen] = useState(active);
  const previousActiveRef = useRef(active);

  useEffect(() => {
    if (previousActiveRef.current === active) return;
    previousActiveRef.current = active;
    setIsOpen(active);
  }, [active]);

  const statusLabel = status === "running"
    ? "思考中"
    : status === "failed" ? "思考中断" : "已思考";

  return (
    <section className={`ai-chat-thinking-steps is-${status}`}>
      <button
        aria-expanded={isOpen}
        className="ai-chat-thinking-header"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span className="ai-chat-thinking-label">{statusLabel}</span>
        <LinearIcon className="ai-chat-thinking-chevron" name="chevronRight" />
      </button>
      <div
        aria-hidden={!isOpen}
        className={`ai-chat-thinking-panel${isOpen ? " is-open" : ""}`}
        inert={!isOpen}
      >
        <div className="ai-chat-thinking-panel-clip">
          <div className="ai-chat-thinking-list">
            {events.map((event, index) => {
              const eventStatus = aiChatEventStatus(event);
              const detail = activityDetail(event);
              const content = detail?.kind === "lines"
                && (event.type === "file" || event.type === "file_change")
                ? `${detail.value.length} 个文件`
                : detail?.kind === "lines"
                  && (event.type === "todo" || event.type === "todo_list")
                  ? `${detail.value.length} 项任务`
                  : event.content.trim();
              return (
                <div
                  className="ai-chat-thinking-step-entry"
                  key={typeof event.data?.itemId === "string" && event.data.itemId
                    ? event.data.itemId
                    : event.id}
                  style={{ animationDelay: `${Math.min(index * 40, 240)}ms` }}
                >
                  <div className={`ai-chat-thinking-step is-${eventStatus}${index === events.length - 1 ? " is-last" : ""}`}>
                    <span className="ai-chat-thinking-step-rail" aria-hidden="true">
                      <span className="ai-chat-thinking-step-icon">
                        <LinearIcon name={eventStatus === "failed" ? "alert" : ACTIVITY_ICONS[event.type] ?? "statusTodo"} />
                      </span>
                      {index !== events.length - 1 && (
                        <span className="ai-chat-thinking-step-connector" />
                      )}
                    </span>
                    <div className="ai-chat-thinking-step-content">
                      <div className="ai-chat-thinking-step-heading">
                        <span className="ai-chat-thinking-step-label">
                          {ACTIVITY_LABELS[event.type] ?? "执行活动"}
                          {eventStatus === "running" && <span aria-hidden="true">…</span>}
                        </span>
                        {content && (
                          <span className="ai-chat-thinking-step-description">
                            {content}
                          </span>
                        )}
                      </div>
                      {detail && (
                        <ThinkingStepDetail detail={detail} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function EventAttachments({ event }: { event: AiChatEvent }) {
  const rawAttachments = event.data?.attachments;
  if (!Array.isArray(rawAttachments)) return null;
  const attachments = rawAttachments.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const attachment = value as Record<string, unknown>;
    if (
      typeof attachment.filename !== "string"
      || typeof attachment.contentType !== "string"
      || typeof attachment.size !== "number"
    ) return [];
    return [{
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
    }];
  });
  if (attachments.length === 0) return null;
  return (
    <div className="ai-chat-event-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.filename}-${index}`}>
          <LinearIcon name="attachment" />
          <span>{attachment.filename}</span>
        </span>
      ))}
    </div>
  );
}

function MessageTimeline({
  activeRunId,
  events,
  skills,
}: {
  activeRunId: string | null;
  events: AiChatEvent[];
  skills: AiChatSkill[];
}) {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const handleSkillFragmentCopy = (event: ReactClipboardEvent<HTMLElement>) => {
    const fragment = selectedComposerFragment(event.currentTarget);
    if (fragment) writeSkillFragmentToClipboard(event, fragment, skillsById);
  };
  const timeline = filterVisibleAiEvents(events).reduce<Array<AiChatEvent | AiChatEvent[]>>(
    (items, event) => {
      const isMessage = event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
        || event.role === "assistant"
        || event.type === "assistant"
        || event.type === "agent_message";
      if (isMessage) {
        items.push(event);
        return items;
      }
      const previous = items[items.length - 1];
      if (Array.isArray(previous)) previous.push(event);
      else items.push([event]);
      return items;
    },
    [],
  );
  return (
    <>
      {timeline.map((entry) => {
        if (Array.isArray(entry)) {
          return (
            <ThinkingSteps
              active={Boolean(
                activeRunId
                && entry.some((event) => event.runId === activeRunId),
              )}
              events={entry}
              key={`activity-${
                typeof entry[0]?.data?.itemId === "string" && entry[0].data.itemId
                  ? entry[0].data.itemId
                  : entry[0]?.id ?? "empty"
              }`}
            />
          );
        }
        const event = entry;
        if (event.role === "user" || event.type === "user" || event.type === "user_message") {
          return (
            <article
              className="ai-chat-user-message"
              key={event.id}
              onCopy={handleSkillFragmentCopy}
            >
              <MarkdownMessage skillsById={skillsById}>
                {skillMarkdown(event.content, eventSkillIds(event), skillsById)}
              </MarkdownMessage>
              <EventAttachments event={event} />
            </article>
          );
        }
        if (event.role === "assistant" || event.type === "assistant" || event.type === "agent_message") {
          return (
            <article className="ai-chat-assistant-message" key={event.id}>
              <MarkdownMessage>{event.content}</MarkdownMessage>
            </article>
          );
        }
        return null;
      })}
    </>
  );
}

function OptionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ai-chat-option-menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

export function AiChat({ threadId, onClose }: AiChatProps) {
  const selectedThreadId = threadId;
  const [menu, setMenu] = useState<MenuName>(null);
  const [snapshot, setSnapshot] = useState<AiChatThreadSnapshot | null>(null);
  const [catalog, setCatalog] = useState<AiChatCatalog | null>(null);
  const [catalogLoadedProjectId, setCatalogLoadedProjectId] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillMention, setSkillMention] = useState<ComposerSkillQuery | null>(null);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [composerSkillTokens, setComposerSkillTokens] = useState<ComposerSkillToken[]>([]);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [panelGeometry, setPanelGeometry] = useState<PanelGeometry | null>(
    () => window.innerWidth <= 719 ? null : loadPanelGeometry(),
  );
  const [panelResizeEdge, setPanelResizeEdge] = useState<PanelResizeEdge | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const skillMentionRangeRef = useRef<Range | null>(null);
  const composerBeforeInputRef = useRef<ComposerBeforeInput | null>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelResizeSessionRef = useRef<PanelResizeSession | null>(null);
  const snapshotRequestRef = useRef(0);
  const snapshotLoadingRequestRef = useRef(0);

  useEffect(() => {
    function finishPanelResize(pointerId?: number) {
      const session = panelResizeSessionRef.current;
      if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
      if (session.captureTarget.hasPointerCapture(session.pointerId)) {
        session.captureTarget.releasePointerCapture(session.pointerId);
      }
      if (window.innerWidth > 719) {
        window.localStorage.setItem(
          PANEL_GEOMETRY_KEY,
          JSON.stringify(session.geometry),
        );
      }
      panelResizeSessionRef.current = null;
      setPanelResizeEdge(null);
    }

    function resizePanel(event: PointerEvent) {
      const session = panelResizeSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();

      const maxWidth = Math.min(
        PANEL_MAX_WIDTH,
        window.innerWidth - PANEL_EDGE_GAP * 2,
      );
      const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
      const maxHeight = window.innerHeight - PANEL_EDGE_GAP * 2;
      const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
      const resizeWidth = session.edge === "left" || session.edge === "top-left";
      const resizeHeight = session.edge === "top" || session.edge === "top-left";
      const width = resizeWidth
        ? Math.min(
            maxWidth,
            Math.max(minWidth, session.startWidth - (event.clientX - session.startX)),
          )
        : session.startWidth;
      const height = resizeHeight
        ? Math.min(
            maxHeight,
            Math.max(minHeight, session.startHeight - (event.clientY - session.startY)),
          )
        : session.startHeight;
      session.geometry = { width, height };
      setPanelGeometry(session.geometry);
    }

    function handlePointerEnd(event: PointerEvent) {
      finishPanelResize(event.pointerId);
    }

    function handleWindowBlur() {
      finishPanelResize();
    }

    function handleWindowResize() {
      finishPanelResize();
      if (window.innerWidth <= 719) {
        setPanelGeometry(null);
        return;
      }

      setPanelGeometry(loadPanelGeometry());
    }

    window.addEventListener("pointermove", resizePanel, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("pointermove", resizePanel);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  function startPanelResize(
    event: ReactPointerEvent<HTMLDivElement>,
    edge: PanelResizeEdge,
  ) {
    if (window.innerWidth <= 719) return;
    const panel = panelRef.current;
    if (!panel) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeSessionRef.current = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      geometry: {
        width: rect.width,
        height: rect.height,
      },
      captureTarget: event.currentTarget,
    };
    setPanelGeometry({
      width: rect.width,
      height: rect.height,
    });
    setPanelResizeEdge(edge);
  }

  const loadSnapshot = useCallback(async (threadId: string, quiet = false) => {
    const requestId = ++snapshotRequestRef.current;
    if (!quiet) {
      snapshotLoadingRequestRef.current = requestId;
      setLoading(true);
    }
    try {
      const next = await getAiChatThread(threadId);
      if (requestId !== snapshotRequestRef.current) return;
      setSnapshot(next);
      if (!quiet) setError(null);
    } catch (nextError) {
      if (!quiet && requestId === snapshotRequestRef.current) setError(messageFor(nextError));
    } finally {
      if (!quiet && requestId === snapshotLoadingRequestRef.current) setLoading(false);
    }
  }, []);

  const selectedHintRefreshQueue = useMemo(
    () => createAiSnapshotRefreshQueue((threadId) => loadSnapshot(threadId, true)),
    [loadSnapshot],
  );
  useEffect(() => () => selectedHintRefreshQueue.clear(), [selectedHintRefreshQueue]);

  useEffect(() => {
    setSnapshot(null);
    if (!selectedThreadId) return;
    let initialPending = true;
    let refreshQueued = false;
    let disposed = false;
    void loadSnapshot(selectedThreadId).finally(() => {
      initialPending = false;
      if (refreshQueued && !disposed) {
        void selectedHintRefreshQueue.request(selectedThreadId);
      }
    });
    const unsubscribe = subscribeAiChatThread(
      selectedThreadId,
      () => {
        if (initialPending) refreshQueued = true;
        else void selectedHintRefreshQueue.request(selectedThreadId);
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [loadSnapshot, selectedHintRefreshQueue, selectedThreadId]);

  const catalogProjectId = snapshot?.thread.origin.projectId ?? null;
  const activeCatalog = catalogLoadedProjectId === catalogProjectId ? catalog : null;
  useEffect(() => {
    if (!catalogProjectId) {
      setCatalog(null);
      setCatalogLoadedProjectId(null);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    setCatalog(null);
    setCatalogLoadedProjectId(null);
    setCatalogError(null);
    void getAiChatCatalog(catalogProjectId, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setCatalogLoadedProjectId(catalogProjectId);
        setCatalogError(null);
      },
      (nextError) => {
        if (controller.signal.aborted) return;
        if ((nextError as Error).name !== "AbortError") {
          setCatalog(null);
          setCatalogLoadedProjectId(null);
          setCatalogError(messageFor(nextError));
        }
      },
    );
    return () => controller.abort();
  }, [catalogProjectId]);

  useEffect(() => {
    const thread = snapshot?.thread;
    if (!thread) return;
    setDraftModel(thread.model);
    setDraftEffort(thread.reasoningEffort);
  }, [snapshot?.thread.id, snapshot?.thread.model, snapshot?.thread.reasoningEffort]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [snapshot?.events.length, snapshot?.thread.status]);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      if (skillMention) setSkillMention(null);
      else if (menu) setMenu(null);
      else onClose();
    }
    document.addEventListener("keydown", closeWithEscape, true);
    return () => document.removeEventListener("keydown", closeWithEscape, true);
  }, [menu, onClose, skillMention]);

  const visibleSkills = useMemo(
    () => (activeCatalog?.skills ?? []).filter((skill) => (
      skill.id !== "manage-taskboard"
      && !skill.id.endsWith(":manage-taskboard")
      && (
        !skillMention?.query
        || skill.label.toLocaleLowerCase().includes(skillMention.query)
        || skill.id.toLocaleLowerCase().includes(skillMention.query)
        || skill.description.toLocaleLowerCase().includes(skillMention.query)
        || skill.path.toLocaleLowerCase().includes(skillMention.query)
      )
    )),
    [activeCatalog?.skills, skillMention?.query],
  );
  const selectedModel = activeCatalog?.models.find((model) => model.slug === draftModel) ?? null;
  const currentRun = snapshot?.thread.currentRun
    ?? snapshot?.runs.find((run) => run.status === "running")
    ?? null;
  const sendBlocked = loading || settingsSaving || !snapshot;
  const threadSettingsBlocked = loading || !snapshot;
  const attachmentBlocked = !snapshot;
  const primaryAction = chatPrimaryAction(
    snapshot?.thread.status ?? "idle",
    draft,
    sendBlocked,
    attachments.length > 0,
  );
  const lastUserEvent = snapshot?.thread.status === "failed"
    ? [...snapshot.events].reverse().find((event) => (
        event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
      )) ?? null
    : null;
  const retryableUserEvent = lastUserEvent && !eventHasAttachments(lastUserEvent)
    ? lastUserEvent
    : null;

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [skillMention?.query]);

  useEffect(() => {
    setSelectedSkillIndex((current) => (
      visibleSkills.length === 0 ? 0 : Math.min(current, visibleSkills.length - 1)
    ));
  }, [visibleSkills.length]);

  useEffect(() => {
    const option = skillMenuRef.current?.querySelector<HTMLElement>(
      `[data-skill-index="${selectedSkillIndex}"]`,
    );
    option?.scrollIntoView({ block: "nearest" });
  }, [selectedSkillIndex, skillMention?.query, visibleSkills.length]);

  useEffect(() => {
    if (attachmentBlocked) setAttachmentDragActive(false);
  }, [attachmentBlocked]);

  function resetComposer() {
    editorRef.current?.replaceChildren();
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setDraft("");
    setAttachments([]);
    setSkillIds([]);
    setComposerSkillTokens([]);
    setSkillMention(null);
    setAttachmentDragActive(false);
    skillMentionRangeRef.current = null;
  }

  async function saveThreadSettings(changes: {
    model?: string;
    reasoningEffort?: string;
  }) {
    const previousThread = snapshot?.thread;
    if (!previousThread) return;
    setSettingsSaving(true);
    try {
      const thread = await updateAiChatThread(previousThread.id, changes);
      setSnapshot((current) => patchAiChatSnapshot(current, previousThread.id, thread));
      setError(null);
    } catch (nextError) {
      setDraftModel(previousThread.model);
      setDraftEffort(previousThread.reasoningEffort);
      setError(messageFor(nextError));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function chooseModel(model: AiChatModel) {
    const reasoningEffort = reasoningEffortForModel(model, draftEffort);
    setMenu(null);
    setDraftModel(model.slug);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({
      model: model.slug,
      reasoningEffort,
    });
  }

  async function chooseEffort(reasoningEffort: string) {
    setMenu(null);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({ reasoningEffort });
  }

  function syncComposerState() {
    const editor = editorRef.current;
    if (!editor) return;
    const next = serializeComposer(editor);
    setDraft(next.message);
    setSkillIds(next.skillIds);
    setComposerSkillTokens((current) => current.filter((token) => editor.contains(token.element)));
    if (!next.message && editor.childNodes.length > 0) editor.replaceChildren();
  }

  function rememberComposerBeforeInput(event: InputEvent) {
    const editor = editorRef.current;
    const selection = editor?.ownerDocument.getSelection();
    if (
      !editor
      || !selection
      || !selection.isCollapsed
      || !selection.focusNode
      || !editor.contains(selection.focusNode)
      || event.inputType !== "insertText"
      || event.data === null
    ) {
      composerBeforeInputRef.current = null;
      return;
    }
    composerBeforeInputRef.current = {
      container: selection.focusNode,
      offset: selection.focusOffset,
      text: event.data,
    };
  }

  function updateComposerSkillQuery(fromInput = false) {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.ownerDocument.activeElement !== editor) {
      composerBeforeInputRef.current = null;
      skillMentionRangeRef.current = null;
      setSkillMention(null);
      return;
    }
    const beforeInput = fromInput ? composerBeforeInputRef.current : null;
    const next = (
      beforeInput ? composerSkillQueryAfterInput(editor, beforeInput) : null
    ) ?? composerSkillQuery(editor);
    composerBeforeInputRef.current = null;
    skillMentionRangeRef.current = next?.range ?? null;
    setSkillMention(next ? { query: next.query } : null);
  }

  function removeComposerSkillToken(element: HTMLElement) {
    const editor = editorRef.current;
    const parent = element.parentNode;
    if (!editor || !parent) return;
    const nextSibling = element.nextSibling;
    const childIndex = Array.prototype.indexOf.call(parent.childNodes, element) as number;
    if (nextSibling?.nodeType === Node.TEXT_NODE && nextSibling.textContent?.startsWith("\u200B")) {
      nextSibling.textContent = nextSibling.textContent.slice(1);
    }
    element.remove();
    setComposerSkillTokens((current) => current.filter((token) => token.element !== element));
    const selection = editor.ownerDocument.getSelection();
    const range = editor.ownerDocument.createRange();
    if (nextSibling?.isConnected && nextSibling.nodeType === Node.TEXT_NODE) {
      range.setStart(nextSibling, 0);
    } else {
      range.setStart(parent, Math.min(childIndex, parent.childNodes.length));
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncComposerState();
    editor.focus();
  }

  function insertComposerFragment(
    fragment: { message: string; skillIds: string[] },
    targetRange?: Range,
  ): boolean {
    const editor = editorRef.current;
    if (!editor || composerMarkerCount(fragment.message) !== fragment.skillIds.length) return false;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    if (!fragment.skillIds.every((skillId) => skillsById.has(skillId))) return false;
    const selection = editor.ownerDocument.getSelection();
    const range = targetRange ?? (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!range || !editor.contains(range.commonAncestorContainer)) return false;

    const content = editor.ownerDocument.createDocumentFragment();
    const newTokens: ComposerSkillToken[] = [];
    let messageOffset = 0;
    let skillIndex = 0;
    for (
      let markerOffset = fragment.message.indexOf(SKILL_MARKER);
      markerOffset >= 0;
      markerOffset = fragment.message.indexOf(SKILL_MARKER, messageOffset)
    ) {
      if (markerOffset > messageOffset) {
        content.append(editor.ownerDocument.createTextNode(
          fragment.message.slice(messageOffset, markerOffset),
        ));
      }
      const skillId = fragment.skillIds[skillIndex];
      const skill = skillsById.get(skillId);
      if (!skill) return false;
      const tokenElement = editor.ownerDocument.createElement("span");
      tokenElement.className = "ai-chat-composer-skill-token";
      tokenElement.dataset.skillId = skill.id;
      tokenElement.contentEditable = "false";
      tokenElement.title = skillDisplayName(skill);
      content.append(tokenElement, editor.ownerDocument.createTextNode("\u200B"));
      newTokens.push({ key: crypto.randomUUID(), id: skill.id, element: tokenElement });
      skillIndex += 1;
      messageOffset = markerOffset + SKILL_MARKER.length;
    }
    if (messageOffset < fragment.message.length) {
      content.append(editor.ownerDocument.createTextNode(fragment.message.slice(messageOffset)));
    }
    if (!content.lastChild) return false;

    const lastNode = content.lastChild;
    range.deleteContents();
    range.insertNode(content);
    if (lastNode.nodeType === Node.TEXT_NODE) {
      range.setStart(lastNode, lastNode.textContent?.length ?? 0);
    } else {
      range.setStartAfter(lastNode);
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    syncComposerState();
    setComposerSkillTokens((current) => [...current, ...newTokens]);
    setSkillMention(null);
    skillMentionRangeRef.current = null;
    editor.focus();
    return true;
  }

  function selectSkill(skill: AiChatSkill) {
    const editor = editorRef.current;
    const range = skillMentionRangeRef.current;
    if (!skillMention || !editor || !range) return;
    insertComposerFragment({ message: SKILL_MARKER, skillIds: [skill.id] }, range);
  }

  function realSkillIdsForMessage(): string[] {
    return skillIds;
  }

  async function startMessage(
    message: string,
    dangerConfirmed: boolean,
    boundSkillIds?: string[],
    clearSubmittedDraft = true,
    boundAttachments?: AiChatAttachmentInput[],
  ) {
    if (sendBlocked) return;
    const trimmed = message.trim();
    const submittedSkillIds = boundSkillIds ?? [...realSkillIdsForMessage()];
    const messageAttachments = boundAttachments ?? attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      dataBase64: attachment.dataBase64,
    }));
    if (!trimmed && messageAttachments.length === 0) return;
    const thread = snapshot?.thread ?? null;
    if (!thread) return;
    const messageSkillIds = (
      boundSkillIds !== undefined || catalogLoadedProjectId === thread.origin.projectId
    ) ? submittedSkillIds : [];
    setError(null);
    try {
      const turnInput = buildTurnInput(trimmed, messageSkillIds, messageAttachments);
      if (clearSubmittedDraft) resetComposer();
      const run = await startAiChatTurn(thread.id, turnInput);
      setSnapshot((current) => current?.thread.id === thread.id ? {
          ...current,
          thread: { ...current.thread, status: "running", currentRun: run },
          runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
        } : current);
      void selectedHintRefreshQueue.request(thread.id);
    } catch (nextError) {
      setError(messageFor(nextError));
      void selectedHintRefreshQueue.request(thread.id);
    }
  }

  function attachmentFiles(files: FileList | File[]): File[] {
    return Array.from(files);
  }

  async function addAttachments(files: File[]) {
    if (attachmentBlocked) return;
    const acceptedFiles = attachmentFiles(files);
    if (acceptedFiles.length === 0) return;
    try {
      const nextAttachments = await Promise.all(acceptedFiles.map((file, index) => (
        new Promise<ComposerAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result !== "string") {
              reject(new Error(`无法读取附件 ${file.name}`));
              return;
            }
            const separator = reader.result.indexOf(",");
            resolve({
              id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
              filename: file.name,
              contentType: file.type || "application/octet-stream",
              dataBase64: reader.result.slice(separator + 1),
              ...(file.type.startsWith("image/") ? { previewUrl: reader.result } : {}),
            });
          };
          reader.onerror = () => reject(new Error(`无法读取附件 ${file.name}`));
          reader.readAsDataURL(file);
        })
      )));
      setAttachments((current) => [...current, ...nextAttachments]);
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = attachmentFiles(event.target.files ?? []);
    event.target.value = "";
    await addAttachments(files);
  }

  function hasDraggedFile(event: ReactDragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.items).some((item) => (
      item.kind === "file"
    )) || event.dataTransfer.files.length > 0;
  }

  function handleAttachmentDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFile(event)) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    setAttachmentDragActive(true);
  }

  function handleAttachmentDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!attachmentDragActive && !hasDraggedFile(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentBlocked ? "none" : "copy";
  }

  function handleAttachmentDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setAttachmentDragActive(false);
  }

  function handleAttachmentDrop(event: ReactDragEvent<HTMLDivElement>) {
    setAttachmentDragActive(false);
    const files = attachmentFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    void addAttachments(files);
  }

  function handleComposerCopy(event: ReactClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const fragment = selectedComposerFragment(editor);
    if (!fragment) return;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    writeSkillFragmentToClipboard(event, fragment, skillsById);
  }

  function handleComposerCut(event: ReactClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    const fragment = selectedComposerFragment(editor);
    if (!fragment) return;
    const skillsById = new Map((activeCatalog?.skills ?? []).map((skill) => [skill.id, skill]));
    if (!writeSkillFragmentToClipboard(event, fragment, skillsById)) return;

    const range = fragment.range;
    range.deleteContents();
    range.collapse(true);
    const { startContainer, startOffset } = range;
    let sentinel: Text | null = null;
    let sentinelOffset = 0;
    if (startContainer.nodeType === Node.TEXT_NODE) {
      const text = startContainer as Text;
      if (text.data[startOffset] === "\u200B") {
        sentinel = text;
        sentinelOffset = startOffset;
      } else if (
        startOffset === text.length
        && text.nextSibling?.nodeType === Node.TEXT_NODE
        && (text.nextSibling as Text).data.startsWith("\u200B")
      ) {
        sentinel = text.nextSibling as Text;
      }
    } else if (
      startContainer.nodeType === Node.ELEMENT_NODE
      && startContainer.childNodes[startOffset]?.nodeType === Node.TEXT_NODE
      && (startContainer.childNodes[startOffset] as Text).data.startsWith("\u200B")
    ) {
      sentinel = startContainer.childNodes[startOffset] as Text;
    }
    if (sentinel) {
      sentinel.deleteData(sentinelOffset, 1);
      if (!sentinel.data && sentinel !== startContainer) sentinel.remove();
    }

    syncComposerState();
    const selection = editor.ownerDocument.getSelection();
    selection?.removeAllRanges();
    if (range.startContainer === editor || editor.contains(range.startContainer)) {
      selection?.addRange(range);
    } else {
      const caret = editor.ownerDocument.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(false);
      selection?.addRange(caret);
    }
    setSkillMention(null);
    skillMentionRangeRef.current = null;
    editor.focus();
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLDivElement>) {
    if (attachmentBlocked) return;
    const files = attachmentFiles(event.clipboardData.files);
    event.preventDefault();
    if (files.length > 0) {
      void addAttachments(files);
      return;
    }
    const skills = activeCatalog?.skills ?? [];
    const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
    const internalFragment = parseAiChatComposerFragment(
      event.clipboardData.getData(COMPOSER_FRAGMENT_MIME),
      skillsById.keys(),
    );
    if (internalFragment && insertComposerFragment(internalFragment)) return;
    const htmlFragment = composerFragmentFromHtml(
      event.clipboardData.getData("text/html"),
      skills,
    );
    if (htmlFragment && insertComposerFragment(htmlFragment)) return;
    const clipboardText = event.clipboardData.getData("text/plain");
    const plainFragment = composerFragmentFromPlainText(clipboardText, skills);
    if (plainFragment && insertComposerFragment(plainFragment)) return;
    const plainText = clipboardText.replaceAll(SKILL_MARKER, "\uFFFD");
    if (plainText) insertComposerFragment({ message: plainText, skillIds: [] });
  }

  async function stopRun(run: AiChatRun | null) {
    if (!run) return;
    try {
      await interruptAiChatRun(run.id);
      void selectedHintRefreshQueue.request(run.threadId);
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && event.shiftKey) return;
    if (event.key === "Backspace") {
      const token = editorRef.current ? tokenBeforeComposerCaret(editorRef.current) : null;
      if (token) {
        event.preventDefault();
        removeComposerSkillToken(token);
        return;
      }
    }
    if (skillMention && visibleSkills.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedSkillIndex((current) => (current + 1) % visibleSkills.length);
      return;
    }
    if (skillMention && visibleSkills.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedSkillIndex((current) => (
        (current - 1 + visibleSkills.length) % visibleSkills.length
      ));
      return;
    }
    if (event.key === "Enter" && skillMention && visibleSkills[selectedSkillIndex]) {
      event.preventDefault();
      selectSkill(visibleSkills[selectedSkillIndex]);
      return;
    }
    if (event.key === "Enter") {
      if (primaryAction === "stop") return;
      event.preventDefault();
      if (primaryAction === "send") void startMessage(draft, false);
    }
  }

  return (
    <div
      className="ai-chat-root"
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest(".ai-chat-menu-wrap")) setMenu(null);
      }}
    >
      {(
        <section
          ref={panelRef}
          className={`ai-chat-panel${panelResizeEdge ? ` is-resizing-${panelResizeEdge}` : ""}`}
          style={panelGeometry ?? undefined}
          aria-label={`${snapshot?.thread.title ?? "任务"} 的对话记录`}
          data-screen-label="任务对话记录"
        >
          <div
            className="ai-chat-resize-handle is-top"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "top")}
          />
          <div
            className="ai-chat-resize-handle is-left"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "left")}
          />
          <div
            className="ai-chat-resize-handle is-top-left"
            aria-hidden="true"
            onPointerDown={(event) => startPanelResize(event, "top-left")}
          />
          <header className="ai-chat-panel-header">
            <div className="ai-chat-panel-title">
              <strong>{snapshot?.thread.title ?? "对话"}</strong>
              <span>
                {snapshot ? `${agentLabel(snapshot.thread.agentKind)} · ${snapshot.thread.origin.projectName}` : "正在打开…"}
              </span>
            </div>
            <button
              type="button"
              aria-label="关闭对话"
              title="关闭"
              onClick={onClose}
            >
              <LinearIcon name="close" />
            </button>
          </header>

          <div
            className="ai-chat-messages"
            ref={messagesRef}
            aria-busy={loading}
            aria-live="polite"
          >
            {loading && !snapshot ? (
              <div className="ai-chat-empty"><span className="ai-chat-spinner" />正在恢复对话…</div>
            ) : snapshot ? (
              <>
                <MessageTimeline
                  activeRunId={currentRun?.id ?? null}
                  events={snapshot.events}
                  skills={activeCatalog?.skills ?? []}
                />
                {snapshot.thread.status === "running" && (
                  <div className="ai-chat-running" role="status">
                    <span className="ai-chat-spinner" />
                    {agentLabel(snapshot.thread.agentKind)} 正在处理
                  </div>
                )}
                {retryableUserEvent && (
                  <button
                    className="ai-chat-retry"
                    type="button"
                    onClick={() => {
                      void startMessage(
                        retryableUserEvent.content,
                        false,
                        eventSkillIds(retryableUserEvent),
                        false,
                        [],
                      );
                    }}
                  >
                    <LinearIcon name="recurrence" />
                    重试上一条消息
                  </button>
                )}
              </>
            ) : (
              <div className="ai-chat-empty">
                <LinearIcon name="conversation" />
                <strong>这个对话打不开</strong>
                <p>它可能已经被删除。</p>
              </div>
            )}
          </div>

          {(error || catalogError) && (
            <div className="ai-chat-error" role="alert">
              <LinearIcon name="alert" />
              <span>{error ?? catalogError}</span>
            </div>
          )}

          <div
            className={`ai-chat-composer${attachmentDragActive ? " is-attachment-drag-active" : ""}`}
            onDragEnter={handleAttachmentDragEnter}
            onDragOver={handleAttachmentDragOver}
            onDragLeave={handleAttachmentDragLeave}
            onDrop={handleAttachmentDrop}
          >
            {attachmentDragActive && (
              <div className="ai-chat-attachment-drop-hint" aria-hidden="true">
                松开添加文件
              </div>
            )}
            <div className="ai-chat-input-wrap">
              {attachments.length > 0 && (
                <div className="ai-chat-composer-attachments">
                  {attachments.map((attachment) => (
                    <div
                      className={`ai-chat-composer-attachment${attachment.previewUrl ? "" : " is-file"}`}
                      key={attachment.id}
                    >
                      {attachment.previewUrl
                        ? <img src={attachment.previewUrl} alt="" />
                        : (
                          <span className="ai-chat-composer-file">
                            <LinearIcon name="file" />
                            <span>{attachment.filename}</span>
                          </span>
                        )}
                      <button
                        type="button"
                        aria-label={`移除附件 ${attachment.filename}`}
                        title="移除附件"
                        onClick={() => {
                          setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        }}
                      >
                        <LinearIcon name="close" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div
                ref={editorRef}
                className="ai-chat-composer-editor"
                contentEditable={Boolean(snapshot)}
                data-placeholder={`回复 ${snapshot ? agentLabel(snapshot.thread.agentKind) : "Agent"}`}
                role="textbox"
                aria-label={`发送给 ${snapshot ? agentLabel(snapshot.thread.agentKind) : "Agent"}的消息`}
                aria-multiline="true"
                suppressContentEditableWarning
                onBeforeInput={(event) => rememberComposerBeforeInput(event.nativeEvent as InputEvent)}
                onInput={() => {
                  syncComposerState();
                  updateComposerSkillQuery(true);
                }}
                onClick={(event) => {
                  const token = (event.target as HTMLElement).closest<HTMLElement>(
                    ".ai-chat-composer-skill-token",
                  );
                  if (token && event.currentTarget.contains(token)) {
                    removeComposerSkillToken(token);
                    return;
                  }
                  updateComposerSkillQuery();
                }}
                onKeyDown={handleComposerKeyDown}
                onKeyUp={(event) => {
                  if (
                    event.key === "ArrowLeft"
                    || event.key === "ArrowRight"
                    || event.key === "Home"
                    || event.key === "End"
                    || (!skillMention && (
                      event.key === "ArrowUp"
                      || event.key === "ArrowDown"
                    ))
                  ) updateComposerSkillQuery();
                }}
                onCompositionEnd={() => updateComposerSkillQuery()}
                onBlur={() => setSkillMention(null)}
                onCopy={handleComposerCopy}
                onCut={handleComposerCut}
                onPaste={handleComposerPaste}
              />
              {composerSkillTokens.map((token) => {
                const skill = activeCatalog?.skills.find((candidate) => candidate.id === token.id);
                return createPortal(
                  <button
                    type="button"
                    aria-label={`移除 Skill ${skill ? skillDisplayName(skill) : token.id}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => removeComposerSkillToken(token.element)}
                  >
                    <SkillReference skill={skill} skillId={token.id} />
                  </button>,
                  token.element,
                  token.key,
                );
              })}
              {skillMention && visibleSkills.length > 0 && (
                <div
                  ref={skillMenuRef}
                  className="ai-chat-skill-menu"
                  role="listbox"
                  aria-label="可用 Skill"
                >
                  {visibleSkills.map((skill, index) => (
                    <button
                      className={index === selectedSkillIndex ? "is-selected" : undefined}
                      type="button"
                      role="option"
                      aria-selected={index === selectedSkillIndex}
                      data-skill-index={index}
                      key={skill.id}
                      onPointerDown={(event) => event.preventDefault()}
                      onPointerEnter={() => setSelectedSkillIndex(index)}
                      onClick={() => selectSkill(skill)}
                    >
                      <LinearIcon name="project" />
                      <span>
                        <strong>{skillDisplayName(skill)}</strong>
                        {skill.description && <small>{skill.description}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="ai-chat-composer-toolbar">
              <input
                ref={attachmentInputRef}
                className="ai-chat-attachment-input"
                type="file"
                multiple
                tabIndex={-1}
                onChange={(event) => void handleAttachmentSelection(event)}
              />
              <button
                className="ai-chat-attachment-button"
                type="button"
                aria-label="添加附件"
                title="添加附件"
                disabled={attachmentBlocked}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <LinearIcon name="plus" />
              </button>
              <span className="ai-chat-toolbar-spacer" />
              <div className="ai-chat-menu-wrap ai-chat-model-menu-wrap">
                <button
                  className="ai-chat-model-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "model" || menu === "model-list" || menu === "effort-list"}
                  disabled={
                    !activeCatalog
                    || snapshot?.thread.status === "running"
                    || settingsSaving
                    || threadSettingsBlocked
                  }
                  onClick={() => setMenu((current) => (
                    current === "model" || current === "model-list" || current === "effort-list"
                      ? null
                      : "model"
                  ))}
                >
                  <span>{modelDisplayName(selectedModel?.displayName ?? (draftModel || "模型"))}</span>
                  <span className="ai-chat-model-effort">
                    {EFFORT_LABELS[draftEffort] ?? (draftEffort || "推理")}
                  </span>
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "model" && (
                  <div className="ai-chat-option-menu ai-chat-config-menu" role="menu" aria-label="模型与推理强度">
                    <button type="button" onClick={() => setMenu("model-list")}>
                      <span>模型</span>
                      <strong>{modelDisplayName(selectedModel?.displayName ?? draftModel)}</strong>
                      <LinearIcon name="chevronRight" />
                    </button>
                    <button type="button" onClick={() => setMenu("effort-list")}>
                      <span>推理强度</span>
                      <strong>{EFFORT_LABELS[draftEffort] ?? draftEffort}</strong>
                      <LinearIcon name="chevronRight" />
                    </button>
                  </div>
                )}
                {menu === "model-list" && (
                  <div className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu ai-chat-model-list" role="menu" aria-label="选择模型">
                    <header>
                      <button type="button" aria-label="返回模型与推理强度" onClick={() => setMenu("model")}>
                        <LinearIcon name="chevronLeft" />
                      </button>
                      <strong>模型</strong>
                    </header>
                    {(activeCatalog?.models ?? []).map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.slug === draftModel}
                        key={model.slug}
                        onClick={() => void chooseModel(model)}
                      >
                        <span>
                          <strong>{modelDisplayName(model.displayName)}</strong>
                        </span>
                        {model.slug === draftModel && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
                {menu === "effort-list" && selectedModel && (
                  <div className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu" role="menu" aria-label="选择推理强度">
                    <header>
                      <button type="button" aria-label="返回模型与推理强度" onClick={() => setMenu("model")}>
                        <LinearIcon name="chevronLeft" />
                      </button>
                      <strong>推理强度</strong>
                    </header>
                    {selectedModel.supportedReasoningEfforts.map((effort) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={effort === draftEffort}
                        key={effort}
                        onClick={() => void chooseEffort(effort)}
                      >
                        <span>{EFFORT_LABELS[effort] ?? effort}</span>
                        {effort === draftEffort && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {primaryAction === "stop" ? (
                <button
                  className="ai-chat-send-button is-stop"
                  type="button"
                  aria-label="停止生成"
                  title="停止"
                  onClick={() => void stopRun(currentRun)}
                >
                  <span className="ai-chat-stop-mark" aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="ai-chat-send-button"
                  type="button"
                  aria-label="发送消息"
                  title="发送"
                  disabled={
                    primaryAction === "disabled"
                    || loading
                    || settingsSaving
                    || Boolean(catalogError)
                  }
                  onClick={() => void startMessage(draft, false)}
                >
                  <LinearIcon name="send" />
                </button>
              )}
            </div>
          </div>

        </section>
      )}
    </div>
  );
}
