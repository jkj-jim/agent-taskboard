import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CdpConnection } from "../shared/codex-cdp.mjs";
import { ApiError } from "./database.mjs";

/**
 * Drives the WorkBuddy desktop client so the board can wake a native session for
 * a task, the same role `codex-desktop-controller.mjs` plays for Codex.
 *
 * The context of a session — which folder it runs in, which skills it may use —
 * is set through WorkBuddy's own `workbuddy://task` deep link rather than by
 * driving the composer's controls. That is the client's supported entry point,
 * it replaces the draft instead of appending to it, and a `cwd` it has never
 * seen becomes a workspace on the spot. Its documented contract is to stop at a
 * filled-in draft without sending, so submitting is still ours to do.
 *
 * What is left of the CDP work is what the client actually answers to:
 *   - a deep link leaves the composer focused but without a caret, so Enter
 *     reaches nothing until a real click places one.
 *   - pressing Enter submits. The round send control is a `DIV`, not a button,
 *     and clicking it adds nothing once the model holds text.
 *   - a turn is running exactly while the input status control is absent.
 */

export const DEFAULT_WORKBUDDY_DEBUGGING_PORT = 9240;

const COMPOSER_SELECTOR = "[data-slate-editor]";
const CONVERSATION_SELECTOR = "[data-conversation-id]";
const INPUT_STATUS_SELECTOR = '[data-track-id="agent_session_input_status"]';
/** WorkBuddy renders its shell from a local file, never a remote page. */
const RENDERER_URL_FRAGMENT = "renderer/index.html";

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Builds the deep link that opens a new task with its context already applied.
 *
 * `connectorIds` is deliberately absent. WorkBuddy holds a named connector that
 * it cannot authorise in a preselected set and then blocks sending until the
 * person clears it, so naming one the client does not recognise turns every
 * launch into a stuck draft. The board's MCP server is enabled by the user once
 * and is already in scope without being asked for.
 *
 * Encoding is `encodeURIComponent`, not `URLSearchParams`: the latter writes
 * spaces as `+`, which only survives if the client parses the query the same
 * way, and instructions are mostly prose.
 */
export function workbuddyTaskDeeplink({ instruction, workspacePath, skillName }) {
  const query = [`action=start`, `prompt=${encodeURIComponent(instruction)}`];
  if (workspacePath) query.push(`cwd=${encodeURIComponent(workspacePath)}`);
  if (skillName) query.push(`skills=${encodeURIComponent(skillName)}`);
  return `workbuddy://task?${query.join("&")}`;
}

const openWithDesktop = promisify(execFile);

export function workbuddyDebuggingPorts(preferredPort = DEFAULT_WORKBUDDY_DEBUGGING_PORT) {
  // The port arrives through WORKBUDDY_REMOTE_DEBUGGING_PORT, so it never shows
  // up in the process arguments the way Codex's does. Only the agreed port and
  // the client's own default are worth probing.
  return [...new Set([preferredPort, DEFAULT_WORKBUDDY_DEBUGGING_PORT])];
}

async function fetchJson(url, fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation(url, { signal: AbortSignal.timeout(1_500) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

export async function workbuddyTargets(port, fetchImplementation = globalThis.fetch) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, fetchImplementation);
  return targets.filter(
    (target) =>
      target.type === "page"
      && target.webSocketDebuggerUrl
      && String(target.url ?? "").includes(RENDERER_URL_FRAGMENT),
  );
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "WorkBuddy renderer evaluation failed",
    );
  }
  return result.result?.value;
}

async function clickPoint(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function pressEnter(cdp) {
  const key = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyDown", text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
}

const SNAPSHOT_EXPRESSION = `(() => {
  const composer = [...document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)})].pop();
  const composerRect = composer?.getBoundingClientRect();
  return {
    composerReady: Boolean(composer),
    composerCenter: composerRect
      ? {
          x: Math.round(composerRect.x + composerRect.width / 2),
          y: Math.round(composerRect.y + composerRect.height / 2),
        }
      : null,
    // Slate keeps a placeholder node while its model is empty, which is the
    // only trustworthy signal that prefilled text really landed.
    composerText: [...(composer?.querySelectorAll('[data-slate-string="true"]') ?? [])]
      .map((node) => node.textContent)
      .join(''),
    conversationIds: [...document.querySelectorAll(${JSON.stringify(CONVERSATION_SELECTOR)})]
      .map((node) => node.getAttribute('data-conversation-id'))
      .filter(Boolean),
    running: !document.querySelector(${JSON.stringify(INPUT_STATUS_SELECTOR)}),
    // A connector the client has not been authorised for holds the turn back at
    // send time, with no sign of it anywhere near the composer.
    pendingConnectorAuth: (() => {
      const dialog = document.querySelector('.wb-modal--confirm[role="dialog"]');
      const text = dialog?.textContent || '';
      return /连接器/.test(text) && /授权/.test(text);
    })(),
  };
})()`;

/** Expands collapsed task groups so conversation ids are present in the DOM. */
const EXPAND_EXPRESSION = `(() => {
  const collapsed = [...document.querySelectorAll('[aria-expanded="false"]')]
    .filter((node) => /任务|会话/.test(node.textContent || ''));
  collapsed.forEach((node) => node.click());
  return collapsed.length;
})()`;

/**
 * Answers the one question a deep link can stop on.
 *
 * An unsent draft in the composer makes WorkBuddy ask 「覆盖当前草稿？」 before it
 * applies the new task, and until someone answers, nothing arrives. The board
 * only opens a task because a person asked it to, so the answer is yes — but
 * only to this dialog, recognised by its own confirm role and wording, never to
 * whatever modal happens to be on screen.
 */
const CONFIRM_DRAFT_OVERWRITE_EXPRESSION = `(() => {
  const dialog = document.querySelector('.wb-modal--confirm[role="dialog"]');
  if (!dialog) return false;
  const confirm = dialog.querySelector('.wb-modal__footer .wb-button--primary');
  // Every confirmation in the client shares these classes — the connector
  // authorisation one puts 「去连接」 in the very same place — so the wording of
  // the button being pressed has to be the thing that identifies it.
  if (!confirm || (confirm.innerText || '').trim() !== '覆盖') return false;
  confirm.click();
  return true;
})()`;

export function createWorkbuddyDesktopController(options = {}) {
  const {
    preferredPort = DEFAULT_WORKBUDDY_DEBUGGING_PORT,
    fetchImplementation = globalThis.fetch,
    connect = (url) => new CdpConnection(url),
    // Handing the URL to the desktop is what routes it to the running client,
    // and launches one when there is none.
    openUrl = (url) => openWithDesktop("open", [url]),
    settleMs = 900,
    submitTimeoutMs = 30_000,
    // A deep link travels through the desktop and the client's main process
    // before the renderer sees it, and starts the client when it is not running.
    prefillTimeoutMs = 25_000,
  } = options;

  async function findTarget() {
    const errors = [];
    for (const port of workbuddyDebuggingPorts(preferredPort)) {
      try {
        const [target] = await workbuddyTargets(port, fetchImplementation);
        if (target) return { target, port };
      } catch (error) {
        errors.push(`${port}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { target: null, port: null, detail: errors.join("; ") };
  }

  async function withRenderer(run) {
    const { target, port, detail } = await findTarget();
    if (!target) {
      throw new ApiError(
        409,
        "WORKBUDDY_UNAVAILABLE",
        "无法连接 WorkBuddy 调试端口。请用 "
        + `WORKBUDDY_REMOTE_DEBUGGING_PORT=${preferredPort} 启动 WorkBuddy。`
        + (detail ? `（${detail}）` : ""),
      );
    }
    const cdp = connect(target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      return await run(cdp, port);
    } finally {
      cdp.close();
    }
  }

  async function snapshot(cdp) {
    return evaluate(cdp, SNAPSHOT_EXPRESSION);
  }

  async function waitFor(cdp, predicate, timeoutMs, description, beforeEach = null) {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      if (beforeEach) await evaluate(cdp, beforeEach);
      latest = await snapshot(cdp);
      if (predicate(latest)) return latest;
      await pause(400);
    }
    // The conversation list runs to dozens of ids and buries everything that
    // says why the wait failed, so it is reported by size only.
    const reported = latest
      ? { ...latest, conversationIds: latest.conversationIds?.length ?? 0 }
      : latest;
    throw new Error(`WorkBuddy ${description}（最后状态：${JSON.stringify(reported)}）`);
  }

  return {
    /**
     * Deliberately cheap: only asks whether a debuggable renderer answers, so
     * `/api/meta` stays fast. Whether the UI is far enough along to accept a
     * task is checked at launch time, where a failure can say what is missing.
     */
    async inspect() {
      const { target, port, detail } = await findTarget();
      return {
        available: Boolean(target),
        port: target ? port : null,
        detail: target ? "" : detail,
      };
    },

    /**
     * Opens a new task carrying the instruction, its workspace and its skill.
     * `submit: false` leaves the draft editable so a person can review it.
     */
    async createTask({ instruction, workspacePath, skillName, submit = true }) {
      if (typeof instruction !== "string" || instruction.trim().length === 0) {
        throw new ApiError(400, "INVALID_FIELD", "instruction is required");
      }
      await openUrl(workbuddyTaskDeeplink({ instruction, workspacePath, skillName }));
      return withRenderer(async (cdp) => {
        await evaluate(cdp, EXPAND_EXPRESSION);
        // The deep link replaces the draft, so seeing the instruction in the
        // composer is what proves the client consumed this launch rather than
        // still showing whatever was there before.
        const filled = await waitFor(
          cdp,
          (state) => Boolean(
            state?.composerReady
            && state.composerCenter
            && state.composerText.includes(instruction.slice(0, 24)),
          ),
          prefillTimeoutMs,
          "深链没有把任务内容填进输入框",
          CONFIRM_DRAFT_OVERWRITE_EXPRESSION,
        );
        if (!submit) {
          return { status: "prepared", sessionId: null, conversationIds: filled.conversationIds };
        }

        const known = new Set(filled.conversationIds);
        await clickPoint(cdp, filled.composerCenter.x, filled.composerCenter.y);
        await pause(300);
        await pressEnter(cdp);
        const submitted = await waitFor(
          cdp,
          (state) => (
            state.pendingConnectorAuth
            || state.conversationIds.some((id) => !known.has(id))
          ),
          submitTimeoutMs,
          "提交后没有出现新的会话",
        );
        if (submitted.pendingConnectorAuth) {
          // Waiting out the timeout here would report "nothing was sent", which
          // says nothing about the dialog holding it back.
          throw new ApiError(
            409,
            "WORKBUDDY_CONNECTOR_UNAUTHORIZED",
            "WorkBuddy 正在等待连接器授权，任务发不出去。"
            + "请在它的弹窗中选择「去连接」完成授权，或选择「忽略」后重试。",
          );
        }
        await pause(settleMs);
        const sessionId = submitted.conversationIds.find((id) => !known.has(id));
        return { status: "started", sessionId, conversationIds: submitted.conversationIds };
      });
    },

    /** Brings an existing conversation back to the front, by id only. */
    async openSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
        throw new ApiError(400, "INVALID_FIELD", "sessionId is required");
      }
      return withRenderer(async (cdp) => {
        await evaluate(cdp, EXPAND_EXPRESSION);
        const found = await evaluate(cdp, `(() => {
          const node = document.querySelector('[data-conversation-id=' + ${JSON.stringify(JSON.stringify(sessionId))} + ']');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          return {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          };
        })()`);
        if (!found) {
          // The list is virtualised, so a conversation scrolled out of view has
          // no row to click. Say so instead of reporting a missing session.
          throw new ApiError(
            409,
            "WORKBUDDY_SESSION_NOT_VISIBLE",
            `会话 ${sessionId} 当前不在 WorkBuddy 的列表中，可能被折叠或滚出了可视区`,
          );
        }
        await clickPoint(cdp, found.x, found.y);
        await pause(settleMs);
        return { status: "opened", sessionId };
      });
    },

    /** Whether the client is mid-turn, used to avoid stacking launches. */
    async isBusy() {
      return withRenderer(async (cdp) => (await snapshot(cdp)).running);
    },
  };
}
