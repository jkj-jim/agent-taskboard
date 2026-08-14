import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  AI_CHAT_SKILL_MARKER,
  buildTurnInput,
  chatPrimaryAction,
  filterVisibleAiEvents,
  isAiChatCapabilityAvailable,
  normalizeChatSelection,
  parseAiChatComposerFragment,
  routeChatState,
  shouldRefreshAiSnapshot,
} from "../web/src/aiChatState.ts";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const chatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);

const models = [
  {
    slug: "codex-real-model",
    displayName: "Codex Real Model",
    description: "Host model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["medium", "high"],
    serviceTiers: [{ id: "priority", name: "Priority" }],
  },
  {
    slug: "codex-fast-model",
    displayName: "Codex Fast Model",
    description: "Fast host model",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low"],
    serviceTiers: [],
  },
];

test("model and effort selections are normalized exclusively against the real catalog", () => {
  assert.deepEqual(normalizeChatSelection(models, "codex-real-model", "medium"), {
    model: "codex-real-model",
    reasoningEffort: "medium",
  });
  assert.deepEqual(normalizeChatSelection(models, "codex-real-model", "fake-effort"), {
    model: "codex-real-model",
    reasoningEffort: "high",
  });
  assert.deepEqual(normalizeChatSelection(models, "missing-model", "high"), {
    model: "codex-real-model",
    reasoningEffort: "high",
  });
  assert.equal(normalizeChatSelection([], "missing-model", "high"), null);
});

test("@ skill insertion uses the selected real skill id while keeping the mention visible", () => {
  const message = `请用 ${AI_CHAT_SKILL_MARKER} 检查`;
  assert.deepEqual(
    parseAiChatComposerFragment(JSON.stringify({ message, skillIds: ["cloudflare"] }), ["cloudflare"]),
    { message, skillIds: ["cloudflare"] },
  );
});

test("turn input contains only visible user content and real skill ids", () => {
  assert.deepEqual(buildTurnInput("检查 LOCAL-103", ["cloudflare"]), {
    message: "检查 LOCAL-103",
    skillIds: ["cloudflare"],
  });
  assert.equal(JSON.stringify(buildTurnInput("hello", [])).includes("workspacePath"), false);
  assert.equal(JSON.stringify(buildTurnInput("hello", [])).includes("manage-taskboard"), false);
});

test("running threads expose stop and SSE is a refresh hint", () => {
  assert.equal(chatPrimaryAction("running", "hello"), "stop");
  assert.equal(chatPrimaryAction("idle", "hello"), "send");
  assert.equal(chatPrimaryAction("idle", "  "), "disabled");
  assert.equal(shouldRefreshAiSnapshot("ai.event"), true);
  assert.equal(shouldRefreshAiSnapshot("ai.run"), true);
  assert.equal(shouldRefreshAiSnapshot("unrelated"), false);
});

test("reasoning and raw JSONL events never enter the visible activity timeline", () => {
  const events = filterVisibleAiEvents([
    { id: "1", type: "agent_message", role: "assistant", content: "公开回复" },
    { id: "2", type: "reasoning", role: "activity", content: "private chain of thought" },
    { id: "3", type: "raw_jsonl", role: "activity", content: "{\"secret\":true}" },
    { id: "4", type: "command", role: "activity", content: "npm test" },
  ]);
  assert.deepEqual(events.map((event) => event.id), ["1", "4"]);
});

test("the conversation opens from a task session, not from a global launcher", () => {
  assert.match(appSource, /<AiChat threadId=\{openChatThreadId\} onClose=/);
  assert.match(appSource, /onOpenChat=\{localAiChatAvailable \? setOpenChatThreadId : null\}/);
  assert.match(chatSource, /className="ai-chat-panel/);
  // The launcher, the thread list and the new-conversation entry are gone: a
  // conversation exists because a task was dispatched to an agent.
  assert.doesNotMatch(chatSource, /ai-chat-launcher/);
  assert.doesNotMatch(chatSource, /ai-chat-history/);
  assert.doesNotMatch(chatSource, /beginNewConversation/);
  // The sandbox tier is the server's to pick, so no picker reaches the client.
  assert.doesNotMatch(chatSource, /ai-chat-permission-trigger/);
  assert.doesNotMatch(apiSource, /sandbox/);
  // Only a board-run session carries a transcript to open.
  assert.match(detailSource, /chatThreadId && onOpenChat/);
});

test("AI chat API uses the stable local contract and never sends cwd or hidden prompt fields", () => {
  assert.match(apiSource, /\/api\/local\/ai\/catalog\?projectId=/);
  assert.match(apiSource, /\/api\/local\/ai\/threads/);
  assert.match(apiSource, /\/turns/);
  assert.match(apiSource, /\/interrupt/);
  assert.match(apiSource, /new EventSource\(`\/api\/local\/ai\/threads\//);
  assert.doesNotMatch(apiSource, /hiddenPrompt|workspacePath:\s*input|argv|cwd/);
});

test("panel is a viewport-clamped overlay driven by custom menus", () => {
  // Exact px sizing is design, not contract: assert only that the panel is a
  // fixed overlay that can never exceed the viewport in either axis.
  assert.match(styles, /\.ai-chat-panel\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(styles, /\.ai-chat-panel\s*\{[\s\S]*?max-width:\s*calc\(100vw[^)]*\);/);
  assert.match(styles, /\.ai-chat-panel\s*\{[\s\S]*?max-height:\s*calc\(100vh[^)]*\);/);
  assert.match(styles, /@media \(max-width:\s*719px\)/);
  // Every picker is a custom menu, so option rows can carry rich content.
  assert.doesNotMatch(chatSource, /<select/);
});

test("chat renders Markdown and never renders host-only fields", () => {
  assert.match(chatSource, /ReactMarkdown/);
  assert.match(chatSource, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(chatSource, /aria-label="停止生成"/);
  assert.match(chatSource, /aria-label="发送消息"/);
  assert.doesNotMatch(chatSource, /origin\.workspacePath/);
  assert.doesNotMatch(chatSource, /codexThreadId/);
  assert.doesNotMatch(chatSource, /manageTaskboardSkillPath/);
});

test("composer does not submit during IME composition", () => {
  // An IME commit fires Enter; the guard must run before any Enter branch, or
  // typing Chinese would send the message mid-composition.
  const composingGuard = chatSource.indexOf("event.nativeEvent.isComposing");
  const firstEnterBranch = chatSource.indexOf('event.key === "Enter"');
  assert.ok(composingGuard > 0);
  assert.ok(firstEnterBranch > 0);
  assert.ok(composingGuard < firstEnterBranch);
});

test("composer and Enter submission stay disabled while a snapshot is loading", () => {
  assert.match(chatSource, /const sendBlocked = loading/);
  assert.match(chatSource, /contentEditable=\{Boolean\(snapshot\)\}/);
  assert.match(chatSource, /if \(sendBlocked\) return;/);
  assert.match(chatSource, /chatPrimaryAction\([\s\S]*?sendBlocked/);
});

test("quiet refreshes preserve action errors and a failed PATCH restores the shown settings", () => {
  assert.match(chatSource, /if \(!quiet\) setError\(null\);/);
  assert.match(chatSource, /patchAiChatSnapshot\(current,\s*previousThread\.id,\s*thread\)/);
  assert.match(chatSource, /setDraftModel\(previousThread\.model\)/);
});

test("SSE hints are coalesced into one snapshot refresh per thread", () => {
  assert.match(chatSource, /createAiSnapshotRefreshQueue/);
  assert.match(chatSource, /selectedHintRefreshQueue\.request\(selectedThreadId\)/);
});

