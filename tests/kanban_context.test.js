const test = require("node:test");
const assert = require("node:assert/strict");
const kanban = require("../kanban_context.js");

test("normalizes note properties and detects initial and in-progress statuses", () => {
  assert.equal(kanban.stripNotePrefix("note.状态"), "状态");
  assert.equal(kanban.stripNotePrefix("formula.status"), "formula.status");
  assert.equal(kanban.todayLocalYmd(new Date(2026, 0, 4, 23)), "2026-01-04");
  assert.equal(kanban.inferInProgressStatus(["todo", "DOING", "进行中"]), "DOING");
  assert.equal(kanban.inferInProgressStatus(["一", "二"]), "二");
  assert.equal(kanban.inferInProgressStatus(["待办"]), "");
  for (const status of [undefined, " ", " 待办 ", "TODO", "TO DO", "BACKLOG", "未开始", "新建"]) {
    assert.equal(kanban.isInitialStatus(status, ["新建", "开发中"]), true);
  }
  assert.equal(kanban.isInitialStatus("已完成", ["待办", "进行中", "已完成"]), false);
  assert.equal(kanban.isInitialStatus("开发中", ["开发中"]), false);
});

test("prefers a valid frontmatter repo and supports Windows, UNC, and POSIX declarations", () => {
  assert.equal(kanban.detectRepoFromCard({ frontmatter: { repo: "F:\\Project" }, excerpt: "repo: /other" }), "F:\\Project");
  assert.equal(kanban.detectRepoFromCard({ frontmatter: { repo: "C:\\bad?" }, excerpt: '- `repo: "/srv/project with spaces"`' }), "/srv/project with spaces");
  assert.equal(kanban.detectRepoFromCard({ excerpt: "REPO: \\bad\nrepo: \\\\server\\share\\Project" }), "\\\\server\\share\\Project");
  for (const repo of ["../relative", "C:relative", "\\root", "/bad\0value", "//incomplete", ["/bad"]]) {
    assert.equal(kanban.detectRepoFromCard({ frontmatter: { repo } }), "");
  }
});

test("round trips a Kanban envelope with locked paths, canonical status options and capped excerpts", () => {
  const card = { path: "Tasks/任务.md", title: "任务", column: "本周", status: "待办", frontmatter: { repo: "/repo" }, excerpt: "x".repeat(9000) };
  const instruction = "执行\n\n## 回写契约\n保留用户自己的标题\n\n## 看板列配置\n用户指令继续";
  const prompt = kanban.buildKanbanPromptEnvelope({
    userInstruction: instruction, executor: "codex", mode: "execute_task", targetRepo: "/repo",
    kanbanSnapshot: { boardPath: "Boards/Tasks.base", viewName: "本周", groupBy: "week", groupOrder: ["本周"], statusProperty: "状态", statusOptions: ["待办", "进行中"], cards: [card] },
  });
  assert.equal(prompt.split("\n")[0], "# Kanban 协作任务");
  assert.deepEqual(JSON.parse(prompt.split("\n")[1]), {
    kind: "kanban", executor: "codex", mode: "execute_task", boardPath: "Boards/Tasks.base", viewName: "本周",
    statusProperty: "状态", statusOptions: ["待办", "进行中"], cardPaths: [card.path], targetWorkspace: "/repo",
  });
  assert.match(prompt, /## 看板列配置\s+\{/);
  assert.match(prompt, /cardPaths 白名单/);
  const parsed = kanban.parseKanbanPromptEnvelope(prompt.replaceAll("\n", "\r\n"));
  assert.equal(parsed.instruction, instruction);
  assert.deepEqual(parsed.cards, [{ ...card, excerpt: card.excerpt.slice(0, 8000) }]);
  assert.equal(kanban.parseKanbanPromptEnvelope("# Kanban 协作任务\n{}"), null);
  assert.equal(kanban.parseKanbanPromptEnvelope("普通任务"), null);
});

test("extracts only the last closed Kanban fence and reports invalid JSON or shape", () => {
  const raw = '{\r\n  "updates": [{"file":"Task.md","status":"已完成"}]\r\n}';
  const example = '````markdown\n```kanban-patch\n{"updates":[]}\n```\n````';
  const first = '```kanban-patch\n{"updates":[]}\n```';
  const tail = "```kanban-patch\n{";
  const text = `${example}\n${first}\n正文\r\n\x60\x60\x60json kanban-patch\r\n${raw}\r\n\x60\x60\x60\r\n${tail}`;
  const patch = JSON.parse(raw);
  const expected = { bodyMarkdown: `${example}\n${first}\n正文\r\n${tail}`, patch, rawPatchJson: raw };
  assert.deepEqual(kanban.extractKanbanPatch(text), patch);
  assert.deepEqual(kanban.splitReplyAndKanbanPatch(text), expected);
  assert.equal(kanban.extractKanbanPatch(example), null);
  assert.equal(kanban.extractKanbanPatch(tail), null);
  assert.match(kanban.extractKanbanPatch("```kanban-patch\n{}\n```").error, /updates/);
  assert.match(kanban.extractKanbanPatch("```kanban-patch\n{bad}\n```").error, /无法解析/);
});

test("validates locked relative Markdown paths and filters invalid or empty changes", () => {
  const input = { updates: [
    null, { file: "Outside.md", status: "Done" }, { file: "A.md", status: "unrecognized" },
    { file: "A.md", properties: {}, checkTasks: [null, " "] }, { file: "../A.md", appendProgress: "nested" },
    { file: "A.md", status: " done ", properties: JSON.parse('{"status":"ignored","priority":2,"__proto__":0}'), checkTasks: [" Task ", false], uncheckTasks: ["Other"], appendProgress: " note " },
    { file: "A.md", properties: { status: "Done" } },
  ] };
  const result = kanban.validateKanbanPatch(input, { allowedCardPaths: new Set(["A.md", "../A.md"]), statusOptions: ["Todo", "Done"] });
  assert.deepEqual(result, { operations: [
    { file: "A.md", status: "Done", properties: { priority: 2 }, checkTasks: ["Task"], uncheckTasks: ["Other"], appendProgress: "note" },
    { file: "A.md", status: "Done" },
  ], summary: { updated: 2, skipped: 5 } });
  assert.equal(kanban.validateKanbanPatch(input, { allowedCardPaths: [] }).operations.length, 0);
  const [preview] = kanban.buildKanbanPatchPreviewItems({ updates: result.operations }, [{ path: "A.md", title: "标题", status: "Todo" }]);
  assert.deepEqual(preview, { kind: "kanbanUpdate", badge: "更新卡片", file: "A.md", title: "标题", fromStatus: "Todo", toStatus: "Done",
    propertyChanges: { priority: 2 }, appendProgress: "note", checkTasks: ["Task"], uncheckTasks: ["Other"] });
});

test("preserves frontmatter, fenced examples, and CRLF while editing tasks and the progress section", () => {
  const before = ["\uFEFF---", "example: |", "  - [ ] Create", "---", "# Title", "- [ ] Create something", "  - [X] Other task",
    "Other [ ] task", "```md", "- [ ] Create", "```", "## 实时进展与记录", "", "- old", "关联：[[Link]]", "", "## Another", "- untouched", ""].join("\r\n");
  const after = kanban.applyKanbanBodyEdits(before, { checkTasks: [" Create "], uncheckTasks: ["Other task"], appendProgress: "new" });
  assert.equal(after, before.replace("- [ ] Create something", "- [x] Create something")
    .replace("- [X] Other task", "- [ ] Other task").replace("关联：", "- new\r\n关联："));
  assert.equal(kanban.applyKanbanBodyEdits("---\n---\n- [ ] Task", { appendProgress: "new" }), "---\n---\n- [ ] Task\n\n## 实时进展与记录\n- new\n");
  assert.equal(kanban.applyKanbanBodyEdits("## 实时进展与记录\n- old\n\n## Next", { appendProgress: "new" }), "## 实时进展与记录\n- old\n- new\n\n## Next");
  assert.equal(kanban.applyKanbanBodyEdits("## 实时进展与记录", { appendProgress: "new" }), "## 实时进展与记录\n- new\n");
  assert.equal(kanban.applyKanbanBodyEdits("---\n---", { appendProgress: "new" }), "---\n---\n## 实时进展与记录\n- new\n");
});
