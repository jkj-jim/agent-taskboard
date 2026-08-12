import path from "node:path";

import {
  CdpConnection,
  DEFAULT_CODEX_DEBUGGING_PORT,
  codexDebuggingPorts,
  codexTargets,
} from "../shared/codex-cdp.mjs";
import { ApiError } from "./database.mjs";
import { shellQuote } from "./agents/taskctl-bin.mjs";

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INJECTION_KEY = "__codexTaskboardInjection__";
const HOST_BINDING = "__codexTaskboardHostV1";
const HOST_HEARTBEAT = "__codexTaskboardHostHeartbeatV1";

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizedThreadId(value) {
  return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
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
      || "Codex renderer evaluation failed",
    );
  }
  return result.result?.value;
}

const CAPABILITY_EXPRESSION = `(() => {
  const api = window.${INJECTION_KEY};
  const heartbeat = Number(window.${HOST_HEARTBEAT});
  const heartbeatAgeMs = Number.isFinite(heartbeat) ? Date.now() - heartbeat : null;
  const apiReady = Boolean(
    api
    && typeof api.beginNativeTaskLaunch === 'function'
    && typeof api.endNativeTaskLaunch === 'function'
    && typeof api.prefillNativeTask === 'function'
  );
  const hostBindingReady = typeof window.${HOST_BINDING} === 'function';
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= 8000;
  const bridgeReady = Boolean(
    window.electronBridge
    && typeof window.electronBridge.sendMessageFromView === 'function'
  );
  const sidebarReady = Boolean(document.querySelector('[data-app-shell-sidebar-trigger="true"]'));
  const composerReady = Boolean(document.querySelector('[data-codex-composer-root]'));
  const activeRow = document.querySelector(
    '[data-app-action-sidebar-thread-active="true"],'
    + '[data-app-action-sidebar-thread-selected="true"],'
    + '[data-app-action-sidebar-thread-id][aria-current="page"]'
  );
  const normalize = (value) => String(value || '').trim().replace(/^(?:local|cloud):/i, '');
  const rowThreadId = (row) => {
    const exposed = normalize(row?.getAttribute('data-app-action-sidebar-thread-id'));
    if (/^[0-9a-f-]{36}$/i.test(exposed)) return exposed;
    const fiberKey = Object.getOwnPropertyNames(row || {})
      .find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
        const conversationId = normalize(props?.conversationId);
        if (/^[0-9a-f-]{36}$/i.test(conversationId)) return conversationId;
        const tooltipConversationId = normalize(
          props?.tooltipContent?.props?.children?.props?.conversationId
        );
        if (/^[0-9a-f-]{36}$/i.test(tooltipConversationId)) return tooltipConversationId;
      }
    }
    return exposed;
  };
  return {
    compatible: apiReady && hostBindingReady && heartbeatFresh && bridgeReady && sidebarReady,
    apiReady,
    hostBindingReady,
    heartbeatFresh,
    bridgeReady,
    sidebarReady,
    composerReady,
    heartbeatAgeMs,
    activeThreadId: rowThreadId(activeRow),
    taskboardOpen: document.documentElement.getAttribute('data-codex-taskboard-open') === 'true',
    sidebarRowIds: Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
      .map((row) => normalize(row.getAttribute('data-app-action-sidebar-thread-id')))
      .filter(Boolean),
    threadIds: Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
      .map(rowThreadId)
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
  };
})()`;

function capabilityFailureReason(capability) {
  if (!capability?.apiReady) return "Codex 中没有加载兼容的 Taskboard 注入器";
  if (!capability.hostBindingReady) return "Taskboard 注入器缺少本机桥接，请重新启动注入器";
  if (!capability.heartbeatFresh) {
    const age = Number.isFinite(capability.heartbeatAgeMs)
      ? `（已停止 ${Math.max(1, Math.round(capability.heartbeatAgeMs / 1000))} 秒）`
      : "";
    return `Taskboard 注入器心跳已停止${age}，请重新运行 codex:inject`;
  }
  if (!capability.bridgeReady) return "当前 Codex 客户端没有提供原生任务桥接";
  if (!capability.sidebarReady) return "Codex 侧栏尚未就绪，请稍后重试";
  return "Codex 客户端、注入器或原生页面结构未就绪";
}

async function defaultConnect({
  preferredPort = DEFAULT_CODEX_DEBUGGING_PORT,
  fetchImplementation = globalThis.fetch,
  createConnection = (url) => new CdpConnection(url),
} = {}) {
  let lastError = null;
  for (const port of codexDebuggingPorts(preferredPort)) {
    let targets;
    try {
      targets = await codexTargets(port, fetchImplementation);
    } catch (error) {
      lastError = error;
      continue;
    }
    for (const target of targets) {
      const cdp = createConnection(target.webSocketDebuggerUrl);
      try {
        await cdp.open();
        await cdp.send("Runtime.enable");
        const capability = await evaluate(cdp, CAPABILITY_EXPRESSION);
        if (capability?.compatible) return { cdp, capability, port, target };
        lastError = new Error(capabilityFailureReason(capability));
      } catch (error) {
        lastError = error;
      }
      cdp.close();
    }
  }
  throw lastError ?? new Error("No debuggable Codex client is running");
}

async function waitForValue(read, predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await pause(80);
  }
  throw new Error(message);
}

async function navigate(cdp, route) {
  await evaluate(cdp, `(() => {
    window.postMessage({
      type: 'navigate-to-route',
      path: ${JSON.stringify(route)},
      state: { focusComposerNonce: Date.now() },
    }, window.location.origin);
    return true;
  })()`);
}

/**
 * Expands the sidebar's projects section, since a collapsed one has no rows.
 *
 * A collapsed section cannot be recognised by the rows it holds, so it is found
 * by its heading instead — matching any section with a heading would just as
 * happily expand the tasks list.
 */
const EXPAND_PROJECT_SECTION_EXPRESSION = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const section = Array.from(document.querySelectorAll('[data-app-action-sidebar-section]'))
    .find((candidate) => {
      if (candidate.querySelector('[data-app-action-sidebar-project-row]')) return true;
      const heading = candidate.querySelector('[data-app-action-sidebar-section-heading]');
      const label = normalize(
        heading?.getAttribute('data-app-action-sidebar-section-heading') || heading?.textContent,
      );
      return label === 'projects' || label === '项目';
    });
  if (section?.getAttribute('data-app-action-sidebar-section-collapsed') === 'true') {
    section.querySelector('[data-app-action-sidebar-section-toggle]')?.click();
  }
  return Boolean(section);
})()`;

function projectRowExpression(projectId, body) {
  return `(() => {
    const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-project-row]'))
      .find((candidate) => (
        candidate.getAttribute('data-app-action-sidebar-project-id') === ${JSON.stringify(projectId)}
      ));
    ${body}
  })()`;
}

/**
 * Files the new thread under the task's project.
 *
 * The workspace root only decides which folder the session may touch; which
 * project a thread belongs to is separate, sticky state. Without this step a
 * launched task inherits whatever project was chosen last — and stays
 * projectless when that was nothing.
 *
 * A project the board knows but Codex does not simply has no row; that is data,
 * not a broken client, so the launch goes on with the workspace root alone. A
 * row that refuses to become current is a real failure and says so.
 */
async function selectProject(cdp, projectId, timeoutMs) {
  if (!projectId) return false;
  await evaluate(cdp, EXPAND_PROJECT_SECTION_EXPRESSION);
  const clicked = await evaluate(cdp, projectRowExpression(projectId, `
    if (!row) return false;
    if (row.getAttribute('aria-current') !== 'page') {
      row.querySelector('[data-app-action-sidebar-select-project]')?.click();
    }
    return true;
  `));
  if (!clicked) return false;
  await waitForValue(
    () => evaluate(cdp, projectRowExpression(projectId, "return row?.getAttribute('aria-current') === 'page';")),
    Boolean,
    `Codex 没有选中任务所属的项目（${projectId}）`,
    timeoutMs,
  );
  return true;
}

/**
 * Which project the sidebar is currently showing.
 *
 * Opening a conversation moves `aria-current` onto the thread row, so the
 * project cannot be read off the project rows alone. The open thread's own
 * position in the tree is the reliable answer, with the project rows as a
 * fallback for when nothing is open.
 */
function currentProjectId(cdp) {
  return evaluate(cdp, `(() => {
    const thread = document.querySelector(
      '[data-app-action-sidebar-thread-active="true"],'
      + '[data-app-action-sidebar-thread-id][aria-current="page"]'
    );
    const list = thread?.closest?.('[data-app-action-sidebar-project-list-id]');
    if (list) return list.getAttribute('data-app-action-sidebar-project-list-id') || '';
    const row = thread?.closest?.('[data-app-action-sidebar-project-row]')
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    return row?.getAttribute('data-app-action-sidebar-project-id') || '';
  })()`);
}

/**
 * Restoring the view is cosmetic, and it happens before the launch can answer
 * the browser, so its budget is what the person waits for when it cannot
 * succeed. A conversation that is going to come back does so in well under a
 * second; anything longer is a restore that will not happen at all, and holding
 * the response for it just turns a finished launch into a slow one.
 */
const RESTORE_TIMEOUT_MS = 2_000;

async function restoreRoute(cdp, threadId) {
  // A sidebar row can expose a placeholder like `client-new-thread:<uuid>` for a
  // conversation the client has not committed yet, and the fiber walk that
  // usually resolves the real id comes back empty for it. Routing to one makes
  // the client reject it — `invalid session id` — so anything that is not a
  // conversation id sends the view home instead of nowhere.
  const target = CODEX_THREAD_ID.test(threadId) ? threadId : "";
  await navigate(cdp, target ? `/local/${encodeURIComponent(target)}` : "/");
  if (!target) return;
  await waitForValue(
    () => evaluate(cdp, `(() => {
      const row = document.querySelector(
        '[data-app-action-sidebar-thread-active="true"],'
        + '[data-app-action-sidebar-thread-selected="true"],'
        + '[data-app-action-sidebar-thread-id][aria-current="page"]'
      );
      const normalize = (value) => String(value || '').trim().replace(/^(?:local|cloud):/i, '');
      const exposed = normalize(row?.getAttribute('data-app-action-sidebar-thread-id'));
      if (/^[0-9a-f-]{36}$/i.test(exposed)) return exposed;
      const fiberKey = Object.getOwnPropertyNames(row || {})
        .find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? row[fiberKey] : null;
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
          const conversationId = normalize(props?.conversationId);
          if (/^[0-9a-f-]{36}$/i.test(conversationId)) return conversationId;
        }
      }
      return exposed;
    })()`),
    (value) => value === target,
    "Codex did not restore the previous task",
    RESTORE_TIMEOUT_MS,
  );
}

/**
 * Puts the client back where the person left it.
 *
 * The project has to come first: selecting the task's project narrows the
 * sidebar to that project's threads, and a conversation from anywhere else
 * cannot be reopened until the previous one is back — the client answers such a
 * route with 「未找到对话」.
 */
async function restoreView(cdp, projectId, threadId) {
  if (projectId) await selectProject(cdp, projectId, RESTORE_TIMEOUT_MS);
  await restoreRoute(cdp, threadId);
}

async function renameNativeThread(cdp, threadId, title) {
  const escapedThreadId = JSON.stringify(threadId);
  const escapedTitle = JSON.stringify(title);
  await waitForValue(
    () => evaluate(cdp, `(() => {
      const normalize = (value) => String(value || '').trim().replace(/^(?:local|cloud):/i, '');
      const conversationId = (row) => {
        const exposed = normalize(row?.getAttribute('data-app-action-sidebar-thread-id'));
        if (/^[0-9a-f-]{36}$/i.test(exposed)) return exposed;
        const fiberKey = Object.getOwnPropertyNames(row || {})
          .find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? row[fiberKey] : null;
        for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
          for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
            const direct = normalize(props?.conversationId);
            if (/^[0-9a-f-]{36}$/i.test(direct)) return direct;
            const tooltip = normalize(props?.tooltipContent?.props?.children?.props?.conversationId);
            if (/^[0-9a-f-]{36}$/i.test(tooltip)) return tooltip;
          }
        }
        return exposed;
      };
      const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
        .find((candidate) => conversationId(candidate) === ${escapedThreadId});
      const titleTarget = row?.querySelector('[data-thread-title]');
      if (!row || !titleTarget) return false;
      const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? row[fiberKey] : null;
      for (let depth = 0; fiber && depth < 8; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (typeof props?.onDoubleClick !== 'function') continue;
        props.onDoubleClick({
          currentTarget: row,
          target: titleTarget,
          defaultPrevented: false,
          detail: 2,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
        });
        return true;
      }
      return false;
    })()`),
    Boolean,
    "Codex did not expose the native chat rename action",
  );
  await waitForValue(
    () => evaluate(cdp, `Boolean(document.querySelector(
      'input[aria-label="聊天标题"], input[aria-label="Chat title"]'
    ))`),
    Boolean,
    "Codex native chat rename dialog did not become ready",
  );
  const filled = await evaluate(cdp, `(() => {
    const input = document.querySelector(
      'input[aria-label="聊天标题"], input[aria-label="Chat title"]'
    );
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${escapedTitle});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!filled) throw new Error("Codex native chat title could not be entered");
  await waitForValue(
    () => evaluate(cdp, `Boolean(Array.from(document.querySelectorAll('button')).find((button) => {
      const label = String(button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase();
      return !button.disabled
        && button.getClientRects().length > 0
        && (label === '保存' || label === 'save');
    }))`),
    Boolean,
    "Codex native chat title was not accepted",
  );
  const saved = await evaluate(cdp, `(() => {
    const save = Array.from(document.querySelectorAll('button')).find((button) => {
      const label = String(button.getAttribute('aria-label') || button.textContent || '').trim().toLowerCase();
      return !button.disabled
        && button.getClientRects().length > 0
        && (label === '保存' || label === 'save');
    });
    if (!save) return false;
    save.click();
    return true;
  })()`);
  if (!saved) throw new Error("Codex native chat rename could not be saved");
  await waitForValue(
    () => evaluate(cdp, `(() => {
      const normalize = (value) => String(value || '').trim().replace(/^(?:local|cloud):/i, '');
      const conversationId = (row) => {
        const exposed = normalize(row?.getAttribute('data-app-action-sidebar-thread-id'));
        if (/^[0-9a-f-]{36}$/i.test(exposed)) return exposed;
        const fiberKey = Object.getOwnPropertyNames(row || {})
          .find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? row[fiberKey] : null;
        for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
          for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
            const direct = normalize(props?.conversationId);
            if (/^[0-9a-f-]{36}$/i.test(direct)) return direct;
            const tooltip = normalize(props?.tooltipContent?.props?.children?.props?.conversationId);
            if (/^[0-9a-f-]{36}$/i.test(tooltip)) return tooltip;
          }
        }
        return exposed;
      };
      const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
        .find((candidate) => conversationId(candidate) === ${escapedThreadId});
      return row?.getAttribute('data-app-action-sidebar-thread-title') === ${escapedTitle};
    })()`),
    Boolean,
    "Codex did not apply the native chat title",
  );
}

export function createCodexDesktopController(options = {}) {
  const connect = options.connect ?? (() => defaultConnect(options));

  async function inspect() {
    let connected;
    try {
      connected = await connect();
      const capability = connected.capability ?? await evaluate(connected.cdp, CAPABILITY_EXPRESSION);
      return {
        available: capability?.compatible === true,
        ...(capability?.compatible ? {} : { reason: "Codex 客户端、注入器或原生页面结构未就绪" }),
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "Codex 客户端未就绪",
      };
    } finally {
      connected?.cdp?.close();
    }
  }

  async function createTask({ workspacePath, projectId, instruction, skillPath, presentation, title }) {
    if (!path.isAbsolute(workspacePath)) {
      throw new Error("Codex workspace path must be absolute");
    }
    const connected = await connect();
    const { cdp } = connected;
    let snapshot = connected.capability ?? null;
    let began = false;
    let success = false;
    // Read before anything is touched, so the view can be put back afterwards.
    let previousProjectId = "";
    try {
      previousProjectId = await currentProjectId(cdp);
      snapshot = await evaluate(cdp, CAPABILITY_EXPRESSION);
      if (!snapshot?.compatible) {
        throw new Error(capabilityFailureReason(snapshot));
      }
      const beginSnapshot = await evaluate(cdp, `window.${INJECTION_KEY}.beginNativeTaskLaunch(${JSON.stringify(presentation)})`);
      began = true;
      snapshot = {
        ...snapshot,
        activeThreadId: normalizedThreadId(beginSnapshot?.activeThreadId || snapshot.activeThreadId),
        taskboardOpen: beginSnapshot?.taskboardOpen === true,
      };

      const expandedSnapshot = await waitForValue(
        () => evaluate(cdp, CAPABILITY_EXPRESSION),
        (value) => value?.threadIds?.length > 0,
        "Codex sidebar tasks did not become ready",
      );
      snapshot = {
        ...snapshot,
        activeThreadId: normalizedThreadId(
          expandedSnapshot.activeThreadId || snapshot.activeThreadId,
        ),
        sidebarRowIds: expandedSnapshot.sidebarRowIds,
        threadIds: expandedSnapshot.threadIds,
      };

      await evaluate(cdp, `(async () => {
        await window.electronBridge.sendMessageFromView({
          type: 'electron-set-active-workspace-root',
          root: ${JSON.stringify(workspacePath)},
        });
        return true;
      })()`, { awaitPromise: true });
      await selectProject(cdp, projectId);
      await navigate(cdp, "/");

      await waitForValue(
        () => evaluate(cdp, `Boolean(Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0))`),
        Boolean,
        "Codex new-task composer did not become ready",
      );

      const planWasActive = await evaluate(cdp, `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const root = document.querySelector('[data-codex-composer-root]');
        const plan = Array.from(root?.querySelectorAll('button') || []).find((button) => {
          const label = normalize(button.getAttribute('aria-label') || button.textContent);
          return (label === 'plan' || label === '计划') && button.getClientRects().length > 0;
        });
        plan?.click();
        return Boolean(plan);
      })()`);
      if (planWasActive) {
        await waitForValue(
          () => evaluate(cdp, `(() => {
            const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            const root = document.querySelector('[data-codex-composer-root]');
            return !Array.from(root?.querySelectorAll('button') || []).some((button) => {
              const label = normalize(button.getAttribute('aria-label') || button.textContent);
              return (label === 'plan' || label === '计划') && button.getClientRects().length > 0;
            });
          })()`),
          Boolean,
          "Codex remained in Plan mode",
        );
      }

      await evaluate(cdp, `window.${INJECTION_KEY}.prefillNativeTask(${JSON.stringify({
        instruction,
        skillName: "manage-taskboard",
        skillPath,
      })})`, { awaitPromise: true });

      if (presentation === "foreground") {
        success = true;
        return { status: "prepared" };
      }

      const submitted = await evaluate(cdp, `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillPath = ${JSON.stringify(skillPath)};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const mention = editor && Array.from(editor.querySelectorAll('[skill-mention-name]'))
          .find((candidate) => (
            candidate.getAttribute('skill-mention-name') === 'manage-taskboard'
            && candidate.getAttribute('skill-mention-path') === skillPath
          ));
        const root = editor?.closest('[data-codex-composer-root]')
          || document.querySelector('[data-codex-composer-root]');
        const submit = Array.from(root?.querySelectorAll('button') || []).find((button) => {
          const label = normalize(button.getAttribute('aria-label'));
          return !button.disabled
            && button.getClientRects().length > 0
            && (label === 'send' || label === '发送');
        });
        if (!mention || !(editor.textContent || '').includes(instruction) || !submit) return false;
        submit.click();
        return true;
      })()`);
      if (!submitted) throw new Error("Codex native submit control or prepared prompt is incompatible");

      const knownSidebarRowIds = new Set(snapshot.sidebarRowIds ?? []);
      const createdSidebarRowId = await waitForValue(
        () => evaluate(cdp, `(() => {
          const known = new Set(${JSON.stringify([...knownSidebarRowIds])});
          const normalize = (value) => String(value || '').trim().replace(/^(?:local|cloud):/i, '');
          const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
            .find((candidate) => !known.has(normalize(
              candidate.getAttribute('data-app-action-sidebar-thread-id')
            )));
          if (!row) return '';
          if (
            row.getAttribute('data-app-action-sidebar-thread-active') !== 'true'
            && row.getAttribute('aria-current') !== 'page'
          ) row.click();
          return normalize(row.getAttribute('data-app-action-sidebar-thread-id'));
        })()`),
        Boolean,
        "Codex did not expose a new native task sidebar row",
        30_000,
      );

      const knownThreadIds = new Set(snapshot.threadIds ?? []);
      const sessionId = await waitForValue(
        () => evaluate(cdp, `(() => {
          const normalize = (value) => String(value || '').trim().replace(/^(?:local|cloud):/i, '');
          const createdSidebarRowId = ${JSON.stringify(createdSidebarRowId)};
          const row = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-id]'))
            .find((candidate) => normalize(
              candidate.getAttribute('data-app-action-sidebar-thread-id')
            ) === createdSidebarRowId);
          if (
            !row
            || (
              row.getAttribute('data-app-action-sidebar-thread-active') !== 'true'
              && row.getAttribute('data-app-action-sidebar-thread-selected') !== 'true'
              && row.getAttribute('aria-current') !== 'page'
            )
          ) return '';
          const exposed = normalize(row?.getAttribute('data-app-action-sidebar-thread-id'));
          if (/^[0-9a-f-]{36}$/i.test(exposed)) return exposed;
          const fiberKey = Object.getOwnPropertyNames(row || {})
            .find((key) => key.startsWith('__reactFiber$'));
          let fiber = fiberKey ? row[fiberKey] : null;
          for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
            for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
              const conversationId = normalize(props?.conversationId);
              if (/^[0-9a-f-]{36}$/i.test(conversationId)) return conversationId;
              const tooltipConversationId = normalize(
                props?.tooltipContent?.props?.children?.props?.conversationId
              );
              if (/^[0-9a-f-]{36}$/i.test(tooltipConversationId)) {
                return tooltipConversationId;
              }
            }
          }
          return exposed;
        })()`),
        (value) => CODEX_THREAD_ID.test(value) && !knownThreadIds.has(value),
        "Codex did not expose a new active native task id",
        30_000,
      );

      await renameNativeThread(cdp, sessionId, title);
      // The task exists and is named from here on, and the board is about to
      // bind it. Putting the view back is housekeeping: a client that will not
      // navigate is not a reason to throw away a launch that succeeded, which
      // would leave a live session attached to no task at all.
      success = true;
      try {
        await restoreView(cdp, previousProjectId, snapshot.activeThreadId);
      } catch {}
      return { status: "started", sessionId };
    } finally {
      if (began) {
        if (!success) {
          try {
            await restoreView(cdp, previousProjectId, snapshot?.activeThreadId || "");
          } catch {}
        }
        try {
          await evaluate(cdp, `window.${INJECTION_KEY}?.endNativeTaskLaunch(${success})`);
        } catch {}
      }
      cdp.close();
    }
  }

  return { inspect, createTask };
}

export function createCodexTaskLaunchCoordinator({
  desktopController,
  loadTask,
  bindSession,
  resolveWorkspace,
  resolveTaskctlShim,
  skillPath,
  codexActorId,
}) {
  let creationQueue = Promise.resolve();
  const launches = new Map();
  const unboundByTask = new Map();

  function serializedCreate(input) {
    const created = creationQueue
      .catch(() => {})
      .then(() => desktopController.createTask(input));
    creationQueue = created;
    return created;
  }

  async function createInput(task, input) {
    const workspacePath = await resolveWorkspace(task, input);
    if (!workspacePath || !path.isAbsolute(workspacePath)) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_UNAVAILABLE",
        `Project '${task.projectId}' has no available device workspace`,
      );
    }
    const taskctlShim = await resolveTaskctlShim();
    const quotedTaskctlShim = shellQuote(taskctlShim);
    const quotedIdentifier = shellQuote(task.identifier);
    const instruction = [
      `执行任务 ${task.identifier}。`,
      `本任务中的每一次 Taskboard 操作都使用 ${quotedTaskctlShim}；`,
      `先运行 ${quotedTaskctlShim} issue brief ${quotedIdentifier} --json。`,
    ].join(" ");
    if (instruction.length > 1_024) {
      throw new ApiError(
        409,
        "CODEX_INSTRUCTION_TOO_LONG",
        "The native Codex task instruction exceeds 1,024 characters",
      );
    }
    return {
      workspacePath,
      // The board and the Codex client key projects by the same id, so the
      // sidebar row is found without a name lookup.
      projectId: task.projectId,
      instruction,
      title: task.title,
      skillPath,
      presentation: input.presentation,
    };
  }

  async function run(input) {
    const task = await loadTask(input.taskId, input);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${input.taskId}' does not exist`);
    if (task.version !== input.expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion: input.expectedVersion,
        actualVersion: task.version,
      });
    }
    if (task.assignee?.type !== "agent" || task.assignee.id !== codexActorId) {
      throw new ApiError(409, "CODEX_NOT_ASSIGNED", "This task is not assigned to Codex");
    }
    if (input.trigger === "status-transition" && task.status !== "in_progress") {
      throw new ApiError(409, "INVALID_AGENT_LAUNCH_STATE", "Codex auto-launch requires an in-progress task");
    }

    if (input.trigger === "manual") {
      const prepared = await serializedCreate(await createInput(task, input));
      if (prepared.status !== "prepared") {
        throw new Error("Codex manual task launch did not leave an editable prompt");
      }
      return {
        status: "prepared",
        agentKind: "codex",
        task,
      };
    }

    let pending = unboundByTask.get(task.id);
    if (pending && pending.previousSessionId !== input.previousSessionId) pending = null;
    if (!pending) {
      const created = await serializedCreate(await createInput(task, input));
      if (created.status !== "started" || !created.sessionId) {
        throw new Error("Codex automatic task launch did not create a session");
      }
      pending = {
        sessionId: created.sessionId,
        previousSessionId: input.previousSessionId,
      };
      unboundByTask.set(task.id, pending);
    }

    const boundTask = await bindSession({
      taskId: task.id,
      agentKind: "codex",
      sessionId: pending.sessionId,
      previousSessionId: pending.previousSessionId,
    }, input);
    unboundByTask.delete(task.id);
    return {
      status: "started",
      agentKind: "codex",
      sessionId: pending.sessionId,
      task: boundTask,
    };
  }

  return {
    launch(input) {
      if (input.trigger === "manual") return run(input);
      const key = `${input.taskId}:${input.expectedVersion}`;
      if (launches.has(key)) return launches.get(key);
      const launch = run(input).catch((error) => {
        launches.delete(key);
        throw error;
      });
      launches.set(key, launch);
      return launch;
    },
  };
}
