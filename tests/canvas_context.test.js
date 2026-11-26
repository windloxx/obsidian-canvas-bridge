const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractSelectionSnapshot, buildCanvasPromptEnvelope, extractCanvasPatch, applyCanvasPatch, revertCanvasPatch,
  parseCanvasPromptEnvelope, splitReplyAndPatch, buildPatchPreviewItems,
} = require("../canvas_context.js");

const node = (id, type = "text", x = 0, y = 0, width = 100, height = 60, extra = {}) => ({
  id, type, x, y, width, height, ...extra,
});

test("extracts selected nodes, bounds, and incoming/outgoing edges", () => {
  const data = {
    nodes: [node("a"), node("b", "text", 200), node("outside", "text", 400)],
    edges: [
      { id: "i", fromNode: "a", toNode: "b" },
      { id: "in", fromNode: "outside", toNode: "a" },
      { id: "out", fromNode: "b", toNode: "outside" },
    ],
  };
  const result = extractSelectionSnapshot(data, new Set(["a", "b"]), "Board.canvas");
  assert.deepEqual(result.effectiveNodeIds, ["a", "b"]);
  assert.deepEqual(result.selectionBounds, { minX: 0, minY: 0, maxX: 300, maxY: 60 });
  assert.equal(result.internalEdges.length, 1);
  assert.equal(result.incomingEdges[0].source.id, "outside");
  assert.equal(result.outgoingEdges[0].target.id, "outside");
  assert.equal(result.nodes[0].text, undefined);
});

test("recursively expands groups by child center", () => {
  const data = {
    nodes: [
      node("outer", "group", 0, 0, 500, 400), node("inner", "group", 300, 40, 360, 240),
      node("card", "text", 520, 80, 100, 60), node("far", "text", 700, 700),
    ], edges: [],
  };
  const result = extractSelectionSnapshot(data, ["outer"], "x.canvas");
  assert.deepEqual(result.directSelectedIds, ["outer"]);
  assert.deepEqual(result.effectiveNodeIds, ["outer", "inner", "card"]);
  assert.deepEqual(result.expandedFromGroupIds, ["inner", "card"]);
});

test("includes file excerpts and detects an absolute repo declaration", () => {
  const result = extractSelectionSnapshot({ nodes: [
    node("t", "text", 0, 0, 100, 60, { text: "repo: ../relative\nrepo: C:drive-relative" }),
    node("f", "file", 1, 2, 3, 4, { file: "Notes/a.md" }),
  ] }, ["t", "f"], "x.canvas", {
    fileExcerpts: { "Notes/a.md": "repo: `C:\\work\\project`\nrepo: /second" },
  });
  assert.equal(result.detectedRepo, "C:\\work\\project");
});

test("builds both mode envelopes with file excerpts and contracts", () => {
  const snapshot = extractSelectionSnapshot({ nodes: [node("a", "file", 0, 0, 100, 100, { file: "a.md" })], edges: [] }, ["a"], "x.canvas");
  const edit = buildCanvasPromptEnvelope({
    userInstruction: "改写", executor: "agy", mode: "edit_canvas", canvasSnapshot: snapshot,
    fileExcerpts: { "a.md": "摘录" + "a".repeat(3998) + "隐藏内容" }, targetRepo: "G:\\project",
  });
  const task = buildCanvasPromptEnvelope({ userInstruction: "验证", executor: "codex", mode: "execute_task", canvasSnapshot: snapshot });
  assert.match(edit, /只修改锁定/);
  assert.match(edit, /x\/y\/width\/height/);
  assert.match(edit, /不要新增任何多余的说明或回执卡片/);
  assert.ok(edit.includes(`摘录${"a".repeat(3998)}"`));
  assert.doesNotMatch(edit, /隐藏内容/);
  assert.match(edit, /目标工作目录 G:\\project/);
  assert.match(edit, /严禁直接覆盖整个 \.canvas/);
  assert.match(edit, /removeNodeIds/);
  assert.match(task, /回执卡片/);
  assert.match(task, /验证证据/);
  assert.match(task, /执行者 Codex/);
});

test("extracts the last patch, supports multiple blocks, and reports malformed JSON", () => {
  const reply = "```canvas-patch\n{\"updateNodes\":[]}\n```\ntext\n```json canvas-patch\n{\"addNodes\":[]}\n```";
  assert.deepEqual(extractCanvasPatch(reply), { addNodes: [] });
  assert.equal(extractCanvasPatch("hello"), null);
  assert.match(extractCanvasPatch("```canvas-patch\n{bad}\n```").error, /无法解析/);
  assert.match(extractCanvasPatch("```canvas-patch\n[]\n```").error, /对象/);
  assert.match(extractCanvasPatch("```canvas-patch\n{\"addEdges\":{}}\n```").error, /数组/);
});

test("parses the Canvas envelope, preserving headings in the instruction and excerpts", () => {
  const canvas = {
    nodes: [node("a", "file", 0, 0, 100, 60, { file: "Notes/A.md" }), node("b"), node("outside")],
    edges: [
      { id: "inner", fromNode: "a", toNode: "b" },
      { id: "in", fromNode: "outside", toNode: "b" },
      { id: "out", fromNode: "a", toNode: "outside" },
    ],
  };
  const snapshot = extractSelectionSnapshot(canvas, ["a", "b"], "Boards/Plan.canvas");
  const instruction = "重新排版\n\n## 回写契约\n这行标题是指令的一部分。\n\n## 内部连线\n保持原有连接。";
  const fileExcerpt = "## 用户指令\n原摘录";
  const prompt = buildCanvasPromptEnvelope({
    userInstruction: `  ${instruction}\n`, executor: "codex", mode: "edit_canvas", canvasSnapshot: snapshot,
    fileExcerpts: { "Notes/A.md": fileExcerpt }, targetRepo: "G:\\project",
  }).replaceAll("\n", "\r\n");
  assert.deepEqual(parseCanvasPromptEnvelope(prompt), {
    metadata: { executor: "codex", mode: "edit_canvas", canvasPath: "Boards/Plan.canvas", selectedIds: ["a", "b"], targetWorkspace: "G:\\project" },
    instruction,
    nodes: [{ ...snapshot.nodes[0], fileExcerpt }, snapshot.nodes[1]],
    internalEdges: snapshot.internalEdges, incomingEdges: snapshot.incomingEdges, outgoingEdges: snapshot.outgoingEdges,
  });
});

test("recognizes plain prompts and recovers valid sections from damaged Canvas envelopes", () => {
  assert.equal(parseCanvasPromptEnvelope("请整理这些笔记"), null);
  assert.equal(parseCanvasPromptEnvelope("# Canvas 协作任务补充\n普通指令"), null);
  assert.equal(parseCanvasPromptEnvelope(undefined), null);
  assert.deepEqual(parseCanvasPromptEnvelope([
    "# Canvas 协作任务", "[]", "## 选区节点与文件摘录\n[broken", "## 内部连线\n{}",
    '## 下游外部连线\n[{"id":"out"}]', "## 用户指令\n  整理  ", "## 回写契约\n契约",
  ].join("\n\n")), {
    metadata: {}, instruction: "整理", nodes: [], internalEdges: [], incomingEdges: [], outgoingEdges: [{ id: "out" }],
  });
  assert.deepEqual(parseCanvasPromptEnvelope("# Canvas 协作任务\n\n{bad"), {
    metadata: {}, instruction: "", nodes: [], internalEdges: [], incomingEdges: [], outgoingEdges: [],
  });
});

test("splits only the last closed patch, preserving Markdown and raw JSON line endings", () => {
  const earlier = '```canvas-patch\r\n{"updateNodes":[]}\r\n```';
  const example = '~~~~markdown\r\n```canvas-patch\r\n{"addEdges":[]}\r\n```\r\n~~~~';
  const raw = '{\r\n  "addNodes": []\r\n}  ';
  const before = `# 回复\r\n\r\n${earlier}\r\n\r\n${example}\r\n\r\n`;
  const after = "**保留结尾**";
  const reply = `  ${before}\t\`\`\`\`json canvas-patch\r\n${raw}\r\n\`\`\`\`\r\n${after}  `;
  assert.deepEqual(splitReplyAndPatch(reply), {
    bodyMarkdown: before + after, patch: { addNodes: [] }, rawPatchJson: raw,
  });
  assert.deepEqual(splitReplyAndPatch(reply).patch, extractCanvasPatch(reply));
});

test("preserves untouched replies and reports invalid patch JSON separately", () => {
  const reply = "  **正文**\n\n```canvas-patch\n{}";
  assert.deepEqual(splitReplyAndPatch(reply), { bodyMarkdown: reply, patch: null, rawPatchJson: "" });
  assert.deepEqual(splitReplyAndPatch(null), { bodyMarkdown: "", patch: null, rawPatchJson: "" });

  const invalid = "正文\n```canvas-patch\n{bad}\n```";
  const split = splitReplyAndPatch(invalid);
  assert.equal(split.bodyMarkdown, "正文");
  assert.equal(split.rawPatchJson, "{bad}");
  assert.deepEqual(split.patch, extractCanvasPatch(invalid));
  assert.match(split.patch.error, /无法解析/);
});

test("builds node and edge preview items with geometry and titles from the selection", () => {
  const nodes = [
    { id: "text", type: "text", text: "\n  ## 原卡片\n正文", color: "3" },
    { id: "file", type: "file", file: "Notes/计划.md", color: "#abc" },
    { id: "group", type: "group", label: "分组名称" },
  ];
  const edges = [
    { id: "existing", fromNode: "text", toNode: "file", fromSide: "right", toSide: "left" },
    { id: "incoming", fromNode: "outside", toNode: "group", source: { summary: "上游摘要" }, label: "旧连线" },
  ];
  const title = "新".repeat(40);
  const items = buildPatchPreviewItems({
    addNodes: [{ tempId: "draft", text: `# ${title}\n说明`, color: "1" }],
    updateNodes: [
      { id: "text", x: -820, y: -710, width: 360, height: 100 },
      { id: "file", file: "Notes/结果.md", width: 420 },
      { id: "group", label: "更新分组" },
    ],
    removeNodeIds: ["group", "1234567890abcdef"],
    addEdges: [{ fromNode: "draft", toNode: "file", fromSide: "bottom", toSide: "top", label: "结果" }],
    updateEdges: [{ id: "existing", toSide: "top" }],
    removeEdgeIds: ["incoming", "unknown-edge"],
  }, nodes, edges);
  assert.deepEqual(items, [
    { kind: "addNode", badge: "新增", nodeType: "text", color: "1", title: title.slice(0, 36), markdown: `# ${title}\n说明`, file: undefined, url: undefined, geometry: "" },
    { kind: "updateNode", badge: "排版", id: "text", nodeType: "text", color: "3", title: "原卡片", markdown: undefined, file: undefined, url: undefined, geometry: "(-820, -710) · 360×100" },
    { kind: "updateNode", badge: "修改+排版", id: "file", nodeType: "file", color: "#abc", title: "结果.md", markdown: undefined, file: "Notes/结果.md", url: undefined, geometry: "宽 420" },
    { kind: "updateNode", badge: "修改", id: "group", nodeType: "group", color: undefined, title: "更新分组", markdown: undefined, file: undefined, url: undefined, geometry: "" },
    { kind: "removeNode", badge: "删除", id: "group", title: "分组名称" },
    { kind: "removeNode", badge: "删除", id: "1234567890abcdef", title: "12345678" },
    { kind: "edge", op: "add", badge: "新增连线", fromLabel: title.slice(0, 36), toLabel: "计划.md", fromSide: "bottom", toSide: "top", label: "结果" },
    { kind: "edge", op: "update", badge: "修改连线", fromLabel: "原卡片", toLabel: "计划.md", fromSide: "right", toSide: "top", label: "" },
    { kind: "edge", op: "remove", badge: "删除连线", fromLabel: "上游摘要", toLabel: "分组名称", fromSide: undefined, toSide: undefined, label: "旧连线" },
    { kind: "edge", op: "remove", badge: "删除连线", fromLabel: "", toLabel: "", fromSide: undefined, toSide: undefined, label: "unknown-" },
  ]);
  assert.deepEqual(buildPatchPreviewItems(null), []);
  assert.deepEqual(buildPatchPreviewItems({ error: "无效补丁" }), []);
});

test("locks geometry, scopes updates and removals, and clears only orphan edges", () => {
  const data = {
    nodes: [node("a", "text", 0, 0, 360, 180, { text: "old" }), node("remove"), node("other")],
    edges: [{ id: "orphan", fromNode: "a", toNode: "remove" }, { id: "keep", fromNode: "a", toNode: "other" }],
  };
  const original = structuredClone(data);
  const result = applyCanvasPatch(data, {
    updateNodes: [{ id: "a", text: "new", x: 99, y: 99, width: 10, height: 10, type: "group" }, { id: "other", text: "unsafe" }],
    removeNodeIds: ["remove", "other"],
  }, { allowedNodeIds: new Set(["a", "remove"]) });
  assert.deepEqual(data, original);
  assert.deepEqual(result.data.nodes, [{ ...original.nodes[0], text: "new" }, original.nodes[2]]);
  assert.deepEqual(result.data.edges, [original.edges[1]]);
  assert.deepEqual(result.summary, {
    updated: 1, addedNodes: 0, addedEdges: 0, removedNodes: 1, updatedEdges: 0, removedEdges: 0, skipped: 2,
  });
  assert.equal(applyCanvasPatch(data, { updateNodes: [{ id: "a", x: 42 }] }, { allowMove: true }).data.nodes[0].x, 42);
  assert.equal(applyCanvasPatch(data, { updateNodes: [{ id: "a", x: 42 }], allowMove: true }).data.nodes[0].x, 42);
  assert.equal(applyCanvasPatch(data, { updateNodes: [{ id: "a", x: 42 }] }).summary.skipped, 1);
  assert.equal(applyCanvasPatch(data, { removeNodeIds: ["a"] }, { allowedNodeIds: [] }).summary.skipped, 1);
});

test("supports layout updates and scoped edge updates/removals while protecting outside nodes", () => {
  const data = {
    nodes: [node("a", "text", 0, 0, 200, 100), node("b", "text", 50, 50, 200, 100), node("ext", "text", 900, 900, 200, 100)],
    edges: [
      { id: "e1", fromNode: "a", fromSide: "bottom", toNode: "b", toSide: "top" },
      { id: "e_out", fromNode: "ext", fromSide: "right", toNode: "ext", toSide: "left" },
    ],
  };
  const result = applyCanvasPatch(data, {
    updateNodes: [
      { id: "a", x: -820, y: -710, width: 360, height: 100 },
      { id: "b", x: -820, y: -500, width: 360, height: 200 },
      { id: "ext", x: 0, y: 0 },
    ],
    updateEdges: [{ id: "e1", fromSide: "right", toSide: "left" }, { id: "e_out", fromSide: "top" }],
    removeEdgeIds: ["e_out"],
  }, { allowedNodeIds: new Set(["a", "b"]), allowMove: true });
  assert.deepEqual([result.data.nodes[0].x, result.data.nodes[0].y, result.data.nodes[0].width, result.data.nodes[0].height], [-820, -710, 360, 100]);
  assert.deepEqual([result.data.nodes[1].x, result.data.nodes[1].y, result.data.nodes[1].width, result.data.nodes[1].height], [-820, -500, 360, 200]);
  assert.deepEqual([result.data.nodes[2].x, result.data.nodes[2].y], [900, 900]);
  assert.equal(result.data.edges[0].fromSide, "right");
  assert.equal(result.data.edges[0].toSide, "left");
  assert.equal(result.data.edges.length, 2);
  assert.deepEqual(result.summary, {
    updated: 2, addedNodes: 0, addedEdges: 0, removedNodes: 0, updatedEdges: 1, removedEdges: 0, skipped: 3,
  });
});

test("stacks cards outside collisions and resolves temp edges with unique IDs", () => {
  const data = { nodes: [node("a", "text", 0, 0, 360, 180), node("other", "text", 420, 0, 360, 180)], edges: [] };
  const ids = ["0000000000000001", "0000000000000002", "0000000000000003", "0000000000000004"];
  const result = applyCanvasPatch(data, {
    addNodes: [{ tempId: "receipt", text: "receipt", x: 420, y: 0 }, { text: "second" }, { x: -600, y: 12 }],
    addEdges: [{ fromNode: "a", toNode: "receipt" }, { fromNode: "a", toNode: "receipt" }, { fromNode: "missing", toNode: "receipt" }],
  }, { selectionBounds: { minX: 0, minY: 0, maxX: 360, maxY: 180 }, idGenerator: () => ids.shift() });
  assert.deepEqual(result.data.nodes.slice(2).map(({ x, y }) => [x, y]), [[420, 208], [420, 416], [-600, 12]]);
  assert.deepEqual(result.data.edges, [{ id: "0000000000000004", fromNode: "a", toNode: "0000000000000001", fromSide: "right", toSide: "left" }]);
  assert.equal(result.summary.skipped, 2);
});

test("uses the whole Canvas bounds or the origin when the selection has no bounds", () => {
  const patch = { addNodes: [{ text: "card" }] };
  const existing = node("old", "text", 700, -100, 100, 100);
  const { x, y } = applyCanvasPatch({ nodes: [existing] }, patch).data.nodes[1];
  assert.deepEqual([x, y], [860, -100]);
  const empty = applyCanvasPatch({}, patch).data.nodes[0];
  assert.deepEqual([empty.x, empty.y, empty.width, empty.height], [0, 0, 360, 180]);
  assert.match(empty.id, /^[0-9a-f]{16}$/);
});

test("reverts updates, additions, removals, and edge edits while keeping later user nodes", () => {
  const original = {
    nodes: [
      node("a", "text", 10, 20, 200, 100, { text: "orig-a" }),
      node("b", "text", 300, 20, 200, 100, { text: "orig-b" }),
      node("del", "text", 300, 200, 180, 90, { text: "to-delete" }),
    ],
    edges: [
      { id: "e_ab", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" },
      { id: "e_del", fromNode: "b", fromSide: "bottom", toNode: "del", toSide: "top" },
    ],
  };
  const applied = applyCanvasPatch(original, {
    updateNodes: [{ id: "a", x: -100, y: -50, text: "moved-a" }],
    removeNodeIds: ["del"],
    updateEdges: [{ id: "e_ab", fromSide: "bottom", toSide: "top", label: "changed" }],
    addNodes: [{ tempId: "new1", text: "ai-added" }],
    addEdges: [{ fromNode: "a", toNode: "new1" }],
  }, { allowedNodeIds: new Set(["a", "b", "del"]), allowMove: true });

  const afterUserEdit = {
    nodes: [...applied.data.nodes, node("user_extra", "text", 900, 900, 150, 80, { text: "user" })],
    edges: applied.data.edges,
  };
  const reverted = revertCanvasPatch(afterUserEdit, applied.undo);
  assert.equal(reverted.summary.restoredNodes, 2);
  assert.equal(reverted.summary.removedNodes, 1);
  assert.equal(reverted.summary.restoredEdges, 2);
  assert.equal(reverted.summary.removedEdges, 1);

  const byId = new Map(reverted.data.nodes.map(n => [n.id, n]));
  assert.deepEqual(byId.get("a"), original.nodes[0]);
  assert.deepEqual(byId.get("b"), original.nodes[1]);
  assert.deepEqual(byId.get("del"), original.nodes[2]);
  assert.equal(byId.get("user_extra").text, "user");
  assert.equal(reverted.data.nodes.length, 4);
  assert.deepEqual(reverted.data.edges, original.edges);
});
