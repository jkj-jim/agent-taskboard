import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ensureMcpRegistration,
  verifyMcpEndpoint,
  workbuddyMcpConfigPath,
  workbuddyServerNameForProfile,
} from "../server/workbuddy-host-setup.mjs";

test("each profile gets its own MCP name so approvals never cross", () => {
  assert.equal(workbuddyServerNameForProfile("production"), "agent-taskboard");
  assert.equal(workbuddyServerNameForProfile("beta"), "agent-taskboard-beta");
  assert.notEqual(
    workbuddyServerNameForProfile("production"),
    workbuddyServerNameForProfile("beta"),
  );
});

test("writing the registration backs up the previous config and never loses other servers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "workbuddy-home-"));
  try {
    const configPath = workbuddyMcpConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: { "someone-elses": { url: "http://127.0.0.1:9/mcp" } },
    }), "utf8");

    const result = await ensureMcpRegistration({
      origin: "http://127.0.0.1:47824",
      serverName: "agent-taskboard",
      homeDirectory: home,
      probeEndpoint: async () => false,
    });

    assert.equal(result.changed, true);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(written.mcpServers["agent-taskboard"].url, "http://127.0.0.1:47824/mcp");
    assert.ok(written.mcpServers["someone-elses"], "an unrelated server must survive");

    const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
    assert.equal(backup.mcpServers["agent-taskboard"], undefined);
    assert.ok(backup.mcpServers["someone-elses"]);

    // 没有半截的临时文件残留
    await assert.rejects(readFile(`${configPath}.taskboard-tmp`, "utf8"), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the handshake only reports ready when the board tools are actually listed", async () => {
  // 真实响应是 SSE 帧，工具名是服务端注册的原名（客户端看到的
  // `<serverName>_get_task` 前缀是它自己加的），所以不能按前缀匹配。
  const sse = (body) => new Response(
    `event: message\ndata: ${JSON.stringify(body)}\n\n`,
    { status: 200 },
  );

  const listed = await verifyMcpEndpoint("http://127.0.0.1/mcp", async () => sse({
    result: { tools: [{ name: "list_tasks" }, { name: "get_task" }] },
  }));
  assert.equal(listed.ok, true);
  assert.equal(listed.tools, 2);

  const empty = await verifyMcpEndpoint("http://127.0.0.1/mcp", async () => sse({
    result: { tools: [] },
  }));
  assert.equal(empty.ok, false);
  assert.match(empty.detail, /没有列出看板工具/);

  const refused = await verifyMcpEndpoint("http://127.0.0.1/mcp", async () => {
    throw new Error("connect ECONNREFUSED");
  });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /握手失败/);
});

test("the WorkBuddy instruction derives its tool names from the MCP server name", async () => {
  const { renderWorkbuddyTaskInstruction } = await import("../server/agents/task-instruction.mjs");

  const current = renderWorkbuddyTaskInstruction({ identifier: "T-1" });
  assert.match(current, /taskboard_get_task、taskboard_add_comment、taskboard_move_task/);

  // 改名后工具名必须跟着变，否则整段提示词指向不存在的工具
  const renamed = renderWorkbuddyTaskInstruction({
    identifier: "T-1",
    mcpServerName: "agent-taskboard",
  });
  assert.match(renamed, /agent-taskboard_get_task/);
  assert.doesNotMatch(renamed, /(?<!agent-)taskboard_get_task/);
  assert.doesNotMatch(renamed, /taskctl/);
});

test("the MCP approval navigation encodes what the live client actually needs", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(path.join(root, "server", "workbuddy-desktop-controller.mjs"), "utf8");

  // 四步路径与顺序（实测：连接器是二级菜单父项，管理连接器在它的子菜单里）
  assert.match(source, /MCP_PANEL_STEPS = \["连接器", "管理连接器", "自定义连接器"\]/);
  // 「更多操作」是图标按钮，textContent 为空，只能按 aria-label 找
  assert.match(source, /aria-label/);
  // 菜单是 toggle：已经能看到「信任」就不再点，否则会把面板关掉
  assert.match(source, /if \(await trustVisible\(\)\) return true;/);
  // 向上找菜单行时必须排除 *Label*，否则会停在 _itemLabel_ 上
  assert.match(source, /!\/Label\/i\.test\(cls\)/);
  // 授权是用户的决定：只导航，不代点「信任」
  assert.doesNotMatch(source, /clickPoint\([^)]*MCP_TRUST_BUTTON_SELECTOR/);
});
