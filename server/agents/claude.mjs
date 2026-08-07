import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "../database.mjs";
import { agentByKind } from "../../shared/agents.mjs";
import {
  SKILL_MARKER,
  renderSkillMarkers,
  taskboardContextLines,
} from "./prompt.mjs";

const execFileAsync = promisify(execFile);
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_MAX_BUFFER = 2 * 1024 * 1024;
const FRONTMATTER_LIMIT = 8 * 1024;

const definition = agentByKind("claude");

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Claude Code has no `codex debug models` equivalent, so the catalog is a
 * static table. Keep every model fact in this one place.
 */
const CLAUDE_MODELS = [
  { slug: "claude-opus-5", displayName: "Opus 5", description: "最强推理能力" },
  { slug: "claude-sonnet-5", displayName: "Sonnet 5", description: "速度与能力均衡" },
  { slug: "claude-fable-5", displayName: "Fable 5", description: "面向创意与写作" },
  { slug: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "最快、最省" },
];

/**
 * Claude Code has no OS-level workspace sandbox, and headless `acceptEdits`
 * approves edits but denies every Bash call, which strands the agent. So
 * `workspace-write` runs unsandboxed too; the catalog says so out loud.
 */
const PERMISSION_MODES = {
  "read-only": "plan",
  "workspace-write": "bypassPermissions",
  "danger-full-access": "bypassPermissions",
};

const SANDBOX_NOTES = {
  "workspace-write": "Claude Code 没有 OS 级沙箱：该档位等同全放行，命令不会逐条审批。",
  "danger-full-access": "与 workspace-write 相同：Claude Code 无沙箱隔离。",
};

function cappedText(value, limit = 65_536) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function detailText(value) {
  if (value === undefined || value === null) return "";
  try {
    return cappedText(JSON.stringify(value));
  } catch {
    return "";
  }
}

function parseFrontmatter(source) {
  if (!source.startsWith("---")) return null;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return null;
  const fields = {};
  for (const line of source.slice(3, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

async function readSkillDirectory(directory, scope) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(directory, entry.name, "SKILL.md");
    let source;
    try {
      if (!(await stat(skillPath)).isFile()) continue;
      const handle = await readFile(skillPath, "utf8");
      source = handle.slice(0, FRONTMATTER_LIMIT);
    } catch {
      continue;
    }
    const fields = parseFrontmatter(source);
    if (!fields) continue;
    const id = (fields.name || entry.name).trim();
    if (!id) continue;
    skills.push({
      id,
      label: id,
      description: fields.description ?? "",
      path: skillPath,
      scope,
    });
  }
  return skills;
}

export function createClaudeAgent(config) {
  const {
    executable = "claude",
    claudeHome,
    database,
    processEnv = process.env,
    skillName = "manage-taskboard",
    deviceWorkspaces,
    runCommand = execFileAsync,
  } = config;

  const discoverWorkspaces = deviceWorkspaces;

  async function resolveWorkspace(projectId) {
    const project = await database.getProject(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const workspaces = await discoverWorkspaces();
    const workspacePath = workspaces.get(projectId);
    if (!workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_UNAVAILABLE",
        `Project '${projectId}' has no available device workspace`,
      );
    }
    return {
      workspacePath,
      addDirectories: [...new Set(workspaces.values())]
        .filter((candidate) => candidate !== workspacePath),
      project,
    };
  }

  async function listSkills(workspacePath) {
    const [userSkills, repoSkills] = await Promise.all([
      readSkillDirectory(path.join(claudeHome, "skills"), "user"),
      readSkillDirectory(path.join(workspacePath, ".claude", "skills"), "repo"),
    ]);
    const unique = new Map();
    for (const skill of [...repoSkills, ...userSkills]) {
      if (!unique.has(skill.id)) unique.set(skill.id, skill);
    }
    return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  return {
    id: definition.kind,
    label: definition.label,
    actor: definition.actor,
    assigneeTarget: definition.assigneeTarget,
    executable,
    /** `--session-id` lets the board own the id before the first turn runs. */
    preassignsSessionId: true,
    createSessionId: randomUUID,

    /**
     * `--resume` only works once a transcript exists. Project directories are
     * named after a lossy slug of the workspace path, so look the session up by
     * its file name instead of recomputing that slug.
     */
    async sessionExists(sessionId) {
      if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
      const root = path.join(claudeHome, "projects");
      let directories;
      try {
        directories = await readdir(root, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        try {
          if ((await stat(path.join(root, directory.name, `${sessionId}.jsonl`))).isFile()) {
            return true;
          }
        } catch {}
      }
      return false;
    },

    resolveWorkspace,

    /**
     * The CLI keeps its own login, separate from the Claude desktop app, so a
     * signed-in desktop does not imply a usable `claude -p`.
     */
    async status() {
      // `claude auth status` exits 1 while logged out but still prints its
      // JSON verdict, so read stdout from both the success and failure paths.
      let stdout;
      try {
        ({ stdout } = await runCommand(executable, ["auth", "status"], {
          env: processEnv,
          encoding: "utf8",
          timeout: CATALOG_TIMEOUT_MS,
          maxBuffer: CATALOG_MAX_BUFFER,
        }));
      } catch (error) {
        stdout = error?.stdout;
        if (typeof stdout !== "string" || stdout.trim() === "") {
          return {
            available: false,
            authenticated: false,
            detail: `无法运行 ${executable}：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return { available: true, authenticated: null, detail: "" };
      }
      return {
        available: true,
        authenticated: parsed?.loggedIn === true,
        detail: parsed?.loggedIn === true
          ? ""
          : "Claude Code CLI 未登录，请在终端运行 claude auth login",
      };
    },

    async catalog(projectId) {
      const { workspacePath } = await resolveWorkspace(projectId);
      return {
        models: CLAUDE_MODELS.map((model) => ({
          ...model,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: REASONING_EFFORTS,
          serviceTiers: [],
        })),
        skills: await listSkills(workspacePath),
        sandboxes: ["read-only", "workspace-write", "danger-full-access"],
        sandboxNotes: SANDBOX_NOTES,
      };
    },

    resumeLink(sessionId) {
      return `claude://resume?session=${encodeURIComponent(sessionId)}`;
    },

    newSessionLink({ prompt, workspacePath }) {
      const query = new URLSearchParams();
      query.set("q", prompt);
      if (workspacePath) query.append("folder", workspacePath);
      return `claude://code/new?${query.toString().replace(/\+/g, "%20")}`;
    },

    buildTurn({ thread, addDirectories, attachmentPaths, message, skills, sessionId, resuming }) {
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (thread.model) args.push("--model", thread.model);
      if (thread.reasoningEffort) args.push("--effort", thread.reasoningEffort);
      for (const directory of addDirectories) args.push("--add-dir", directory);
      args.push("--permission-mode", PERMISSION_MODES[thread.sandbox] ?? "acceptEdits");
      if (resuming) args.push("--resume", sessionId);
      else args.push("--session-id", sessionId);

      // Never lead with `/skill`: Claude Code treats a leading slash as a
      // command, so an uninstalled skill would swallow the whole prompt and
      // the turn would report success without doing anything. Naming the skill
      // in prose triggers it the same way and degrades gracefully.
      const userMessage = renderSkillMarkers(
        message,
        skills,
        (skill) => `the ${skill.id} skill`,
      );
      const prompt = [
        `Use the ${skillName} skill for every taskboard read or write in this turn.`,
        "",
        "<taskboard_context>",
        ...taskboardContextLines(thread, attachmentPaths),
        "</taskboard_context>",
        "",
        "<user_message>",
        userMessage,
        "</user_message>",
      ].join("\n");

      return { args, cwd: thread.origin.workspacePath, prompt };
    },

    createDecoder() {
      return createClaudeDecoder();
    },
  };
}

function toolResultText(content) {
  if (typeof content === "string") return cappedText(content);
  if (!Array.isArray(content)) return detailText(content);
  return cappedText(
    content
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n"),
  );
}

/**
 * Maps one Claude Code `stream-json` line onto the taskboard's shared event
 * model. Tool results arrive in a later message, so the decoder remembers each
 * `tool_use` id until its result shows up.
 */
export function createClaudeDecoder() {
  const pending = new Map();

  function fromToolUse(block) {
    const itemId = cappedText(block.id);
    const input = block.input ?? {};
    const base = { itemId, status: "in_progress" };

    if (block.name === "Bash") {
      const command = cappedText(input.command);
      return {
        type: "command_execution",
        role: "activity",
        content: command,
        data: { ...base, command },
      };
    }
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name)) {
      const file = cappedText(input.file_path ?? input.notebook_path);
      return {
        type: "file_change",
        role: "activity",
        content: file,
        data: { ...base, files: file ? [file] : [] },
      };
    }
    if (typeof block.name === "string" && block.name.startsWith("mcp__")) {
      const [, server = "", tool = ""] = block.name.split("__");
      return {
        type: "mcp_tool_call",
        role: "activity",
        content: [server, tool].filter(Boolean).join("."),
        data: {
          ...base,
          ...(server ? { server } : {}),
          ...(tool ? { tool } : {}),
          ...(Object.keys(input).length > 0 ? { detail: detailText({ arguments: input }) } : {}),
        },
      };
    }
    if (block.name === "WebSearch" || block.name === "WebFetch") {
      const query = cappedText(input.query ?? input.url);
      return {
        type: "web_search",
        role: "activity",
        content: query,
        data: { ...base, ...(query ? { query } : {}) },
      };
    }
    if (block.name === "TodoWrite") {
      const items = Array.isArray(input.todos)
        ? input.todos.flatMap((todo) => {
          const text = cappedText(todo?.content ?? todo?.text);
          return text ? [{ text, completed: todo?.status === "completed" }] : [];
        })
        : [];
      return {
        type: "todo_list",
        role: "activity",
        content: items.map((item) => item.text).join("\n"),
        data: {
          ...base,
          ...(items.length > 0 ? { detail: detailText(items) } : {}),
        },
      };
    }
    return null;
  }

  return function decode(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];

    if (raw.type === "system" && raw.subtype === "init") {
      const sessionId = raw.session_id;
      if (
        typeof sessionId !== "string"
        || sessionId.length === 0
        || sessionId.length > 256
        || sessionId.includes("\0")
      ) {
        return [];
      }
      return [{ kind: "thread.started", threadId: sessionId }];
    }

    if (raw.type === "assistant" && Array.isArray(raw.message?.content)) {
      const events = [];
      for (const [index, block] of raw.message.content.entries()) {
        if (block?.type === "text" && cappedText(block.text).trim()) {
          events.push({
            kind: "event",
            type: "agent_message",
            role: "assistant",
            content: cappedText(block.text),
            data: {
              status: "completed",
              itemId: `${cappedText(raw.message.id) || "message"}:${index}`,
            },
          });
          continue;
        }
        if (block?.type !== "tool_use") continue;
        const normalized = fromToolUse(block);
        if (!normalized) continue;
        pending.set(block.id, normalized);
        events.push({ kind: "event", ...normalized });
      }
      return events;
    }

    if (raw.type === "user" && Array.isArray(raw.message?.content)) {
      const events = [];
      for (const block of raw.message.content) {
        if (block?.type !== "tool_result") continue;
        const started = pending.get(block.tool_use_id);
        if (!started) continue;
        pending.delete(block.tool_use_id);
        const failed = block.is_error === true;
        const output = toolResultText(block.content);
        events.push({
          kind: "event",
          type: started.type,
          role: failed ? "error" : started.role,
          content: started.content,
          data: {
            ...started.data,
            status: failed ? "failed" : "completed",
            ...(started.type === "command_execution" && output ? { output } : {}),
          },
        });
      }
      return events;
    }

    if (raw.type === "result") {
      if (raw.is_error === true || raw.subtype !== "success") {
        return [{
          kind: "event",
          type: "turn.failed",
          terminal: "failed",
          role: "error",
          content: cappedText(raw.result ?? raw.error ?? raw.subtype),
          data: { status: "failed" },
        }];
      }
      const usage = {};
      if (Number.isFinite(raw.usage?.input_tokens)) usage.input_tokens = raw.usage.input_tokens;
      if (Number.isFinite(raw.usage?.cache_read_input_tokens)) {
        usage.cached_input_tokens = raw.usage.cache_read_input_tokens;
      }
      if (Number.isFinite(raw.usage?.output_tokens)) usage.output_tokens = raw.usage.output_tokens;
      return [{
        kind: "event",
        type: "turn.completed",
        terminal: "completed",
        role: "activity",
        content: "",
        data: {
          status: "completed",
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        },
      }];
    }

    if (raw.type === "error") {
      return [{
        kind: "event",
        type: "error",
        terminal: "failed",
        role: "error",
        content: cappedText(raw.message ?? raw.error),
        data: { status: "failed" },
      }];
    }

    return [];
  };
}
