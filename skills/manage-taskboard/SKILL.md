---
name: manage-taskboard
description: Manage taskboard projects, issues, issue relations, and comments through the taskctl CLI. Use when the agent needs to track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Taskboard

Use `taskctl` for every project, issue, and comment operation. The common execution commands are:

```bash
taskctl issue list --project PROJECT_ID [--status STATUS | --all-statuses] [--full] --json
taskctl issue brief ISSUE_ID --json
taskctl issue move ISSUE_ID --status STATUS --if-version N --json
taskctl comment add ISSUE_ID --body TEXT --json
```

Read [references/cli.md](references/cli.md) only when you need another command or an option not shown here. If the launch instruction gives an absolute `taskctl` shim path, use that path for every Taskboard command in the turn, not only the first read.

## Workflow

1. Search active issues before creating one. Use `context current`, then run the default `issue list` for that project. Its concise index omits `done` and `canceled` issues and exposes only a 50-character `descriptionPreview`; compare identifiers, titles, previews, and status. Do not load completed work for routine duplicate checks. If an active candidate looks related or ambiguous, run `issue brief` for that candidate before deciding.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
   - Use `--status done` for an explicit historical lookup. Reserve `--all-statuses --full` for statistics, export, or diagnosis; never use it for routine execution or duplicate checks.
2. Before executing an issue, run `issue brief` once to read the latest issue content, all comments, relations, and non-empty attachments. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to the running agent (Codex Agent or Claude Agent) by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current conversation. It reads `CODEX_THREAD_ID` inside Codex and `CLAUDE_CODE_SESSION_ID` inside Claude Code. Outside both, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. If this claim reports a version conflict or a new read shows that its status changed, skip the issue and do not implement it. If the issue is already `in_progress` and assigned to the running agent, start work without moving it to `in_progress` again.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before requesting review, verify the requested work and acceptance criteria.
8. Write comments as concise handoffs, not progress logs. These are maxima, not quotas: at most one `用户反馈：` comment per new feedback round, one `交付：` comment per delivery, and one `需决策：` or `阻塞：` comment when needed. The initial round usually needs only the delivery comment. Aim for about 300 Chinese characters, but exceed that when the next session needs the detail. Keep root causes, decisions, constraints, and ruled-out directions that prevent repeated work; omit raw logs, step-by-step exploration, failed-attempt details, and file-by-file diffs. Omit empty sections and add a new comment for a new round instead of rewriting an old one. After implementation and self-verification, add the `交付：` comment and move the issue to `in_review`. Never move it directly to `done`.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Agent self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
