import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");

test("issue title and description keep Linear-style inline editing when focused", () => {
  assert.match(
    styles,
    /\.issue-title-input:focus:not\(:disabled\),\s*\.issue-title-input:focus-visible:not\(:disabled\),\s*\.issue-description-input:focus:not\(:disabled\),\s*\.issue-description-input:focus-visible:not\(:disabled\),\s*\.issue-description-read:focus-visible\s*\{[^}]*border-color:\s*transparent;[^}]*outline:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
  );
  assert.match(
    styles,
    /:where\([\s\S]*?input:not\(\[type="checkbox"\]\)[\s\S]*?textarea,[\s\S]*?select,[\s\S]*?\[contenteditable="true"\],[\s\S]*?\[contenteditable="plaintext-only"\][\s\S]*?\):is\(:focus, :focus-visible\)\s*\{\s*outline:\s*0;/,
  );
  assert.doesNotMatch(styles, /textarea:focus-visible:not\(/);
});

test("editing and composing comments do not add focus chrome", () => {
  // The two paths no longer share a class: editing is a plain textarea, and
  // composing is a rich contenteditable. Assert the invariant itself — neither
  // grows a ring or border on focus — instead of counting a shared class name.
  assert.match(detailSource, /className="comment-input"/);
  assert.match(detailSource, /className="comment-inline-media"/);
  assert.doesNotMatch(styles, /\.comment-composer:focus-within\s*\{/);
  assert.doesNotMatch(styles, /\.comment-input:focus/);
  assert.doesNotMatch(styles, /\.comment-inline-media:focus/);
});
