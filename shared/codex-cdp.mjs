import { spawnSync } from "node:child_process";

export const DEFAULT_CODEX_DEBUGGING_PORT = 9229;

async function fetchJson(url, fetchImplementation = globalThis.fetch) {
  const response = await fetchImplementation(url, { signal: AbortSignal.timeout(1_500) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

export class CdpConnection {
  constructor(url, WebSocketImplementation = globalThis.WebSocket) {
    this.socket = new WebSocketImplementation(url);
    this.sequence = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        const waiters = this.eventWaiters.get(message.method) || [];
        this.eventWaiters.delete(message.method);
        waiters.forEach((waiter) => waiter.resolve(message.params));
        const handlers = this.eventHandlers.get(message.method) || [];
        handlers.forEach((handler) => {
          try {
            Promise.resolve(handler(message.params)).catch((error) => {
              console.error(`CDP ${message.method} handler failed: ${error.message}`);
            });
          } catch (error) {
            console.error(`CDP ${message.method} handler failed: ${error.message}`);
          }
        });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.eventWaiters.clear();
      this.eventHandlers.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      const timeout = setTimeout(() => {
        this.eventWaiters.set(
          method,
          (this.eventWaiters.get(method) || []).filter((waiter) => waiter.resolve !== wrappedResolve),
        );
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiters.push({ resolve: wrappedResolve, reject });
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      this.eventHandlers.set(
        method,
        (this.eventHandlers.get(method) || []).filter((candidate) => candidate !== handler),
      );
    };
  }

  close() {
    this.socket.close();
  }
}

export async function codexTargets(port, fetchImplementation = globalThis.fetch) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, fetchImplementation);
  return targets.filter(
    (target) =>
      target.type === "page"
      && target.webSocketDebuggerUrl
      && !target.url?.includes("initialRoute=")
      && (target.url?.startsWith("app://") || target.title === "Codex"),
  );
}

export function codexDebuggingPorts(
  preferredPort = DEFAULT_CODEX_DEBUGGING_PORT,
  processList = null,
) {
  const ports = new Set([preferredPort]);
  const processes = processList === null
    ? spawnSync("/bin/ps", ["-axo", "command="], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
    : { status: 0, stdout: processList };
  if (processes.status !== 0) return [...ports];

  for (const command of processes.stdout.split("\n")) {
    if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
    const match = command.match(/--remote-debugging-port=(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}
