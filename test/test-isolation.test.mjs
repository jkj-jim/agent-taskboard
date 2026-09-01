import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/** 递归收集测试文件：test/slow 之类的子目录不能成为守卫的盲区。 */
async function testFiles(root = testDirectory, prefix = "") {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...await testFiles(path.join(root, entry.name), relative));
    } else if (entry.name.endsWith(".test.mjs")) {
      found.push(relative);
    }
  }
  return found;
}


test("every server fixture pins the agent runtime instead of probing this machine", async () => {
  // Agent 是否可分配、以及能选哪条 transport，默认都来自对本机的真实探测。
  // 用例不注入存根时，本机装了 Codex 就通过、CI 上没装就 409/无 sessionId——
  // 同一份用例在两处结论不同，而且只有发版时才会暴露。
  //
  // `codexBridge` 同理：它默认会看 ChatGPT.app 在不在、注入器随没随包，
  // 真机上两者都在，`/api/meta` 的 nativeCodexTaskLaunch 就成了 true。
  const self = path.basename(fileURLToPath(import.meta.url));
  const files = (await testFiles()).filter((name) => name !== self);
  const leaking = [];

  for (const name of files) {
    const source = await readFile(path.join(testDirectory, name), "utf8");
    if (!source.includes("createTaskboardServer({")) continue;
    const sites = source.split("createTaskboardServer({").length - 1;
    for (const injected of ["agentRuntimeStatuses", "codexBridge"]) {
      const pinned = source.split(injected).length - 1;
      if (pinned < sites) {
        leaking.push(`${name}：${sites} 处构造，${injected} 只有 ${pinned} 处注入`);
      }
    }
  }

  assert.deepEqual(leaking, []);
});

test("no test waits by counting attempts instead of by deadline", async () => {
  // 固定次数不等于限时：实际时限是「次数 ×（每次请求耗时 + 间隔）」，机器一忙就漂移。
  // 更坑的是循环条件容易和断言错位——ai-chat-server 里那次就是：循环等到「会话行出现」
  // 就退出，断言却要「会话已绑定对话记录」，而这是两次独立写入，中间那个窗口一命中
  // 就立刻失败，预算还剩一大半。改用 test/helpers/wait-for.mjs 的墙钟等待。
  const self = path.basename(fileURLToPath(import.meta.url));
  const files = (await testFiles()).filter((name) => name !== self);
  const offenders = [];

  for (const name of files) {
    const source = await readFile(path.join(testDirectory, name), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (/for\s*\(let\s+attempts?\s*=\s*0;\s*attempts?\s*<\s*\d+/.test(line)) {
        offenders.push(`${name}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
