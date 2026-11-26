const { randomBytes } = require("node:crypto");
const path = require("node:path");

const CONTENT_FIELDS = ["text", "label", "color", "file", "subpath", "url"];
const GEOMETRY_FIELDS = ["x", "y", "width", "height"];
const NODE_FIELDS = ["id", "type", ...GEOMETRY_FIELDS, ...CONTENT_FIELDS];
const PATCH_FIELDS = ["updateNodes", "addNodes", "addEdges", "updateEdges", "removeNodeIds", "removeEdgeIds"];
const EDGE_FIELDS = ["fromEnd", "toEnd", "color", "label"];
const NODE_TYPES = new Set(["text", "file", "link", "group"]);
const SIDES = new Set(["left", "right", "top", "bottom"]);
const EXCERPT_LIMIT = 4000;
const GAP = 28;
const PROMPT_TITLE = "# Canvas 协作任务";
const PROMPT_SECTIONS = {
  nodes: "## 选区节点与文件摘录",
  internalEdges: "## 内部连线",
  incomingEdges: "## 上游外部连线",
  outgoingEdges: "## 下游外部连线",
  instruction: "## 用户指令",
  contract: "## 回写契约",
};

function pick(source, fields) {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(source, field))
    .map(field => [field, source[field]]));
}

function boundsOf(node) {
  const { x, y, width, height } = node;
  const maxX = x + width;
  const maxY = y + height;
  if (![x, y, width, height, maxX, maxY].every(Number.isFinite) || width < 0 || height < 0) return null;
  return { minX: x, minY: y, maxX, maxY };
}

function unionBounds(boxes) {
  let bounds = null;
  for (const box of boxes) {
    if (!box) continue;
    bounds = bounds ? {
      minX: Math.min(bounds.minX, box.minX), minY: Math.min(bounds.minY, box.minY),
      maxX: Math.max(bounds.maxX, box.maxX), maxY: Math.max(bounds.maxY, box.maxY),
    } : box;
  }
  return bounds;
}

function expandGroups(nodes, directIds, byId, boxes) {
  const effectiveIds = new Set(directIds);
  const groups = directIds.filter(id => byId.get(id).type === "group");
  for (const id of groups) {
    const group = boxes.get(id);
    if (!group) continue;
    for (const node of nodes) {
      if (effectiveIds.has(node.id)) continue;
      const box = boxes.get(node.id);
      if (!box) continue;
      const x = box.minX + node.width / 2;
      const y = box.minY + node.height / 2;
      if (x < group.minX || x > group.maxX || y < group.minY || y > group.maxY) continue;
      effectiveIds.add(node.id);
      if (node.type === "group") groups.push(node.id);
    }
  }
  return [...effectiveIds];
}

function excerpt(excerpts, file) {
  if (!Object.hasOwn(excerpts, file) || typeof excerpts[file] !== "string") return "";
  return excerpts[file].slice(0, EXCERPT_LIMIT);
}

function detectRepo(nodes, excerpts) {
  for (const node of nodes) {
    const contents = [node.text];
    if (node.type === "file" && Object.hasOwn(excerpts, node.file)) contents.push(excerpts[node.file]);
    for (const content of contents) {
      if (typeof content !== "string") continue;
      for (const match of content.matchAll(/^[ \t]*(?:[-*+]\s+)?(?:`)?repo:[ \t]*(.+)$/gim)) {
        const candidate = match[1].replace(/^[\s`'“”‘’"]+|[\s`'“”‘’"]+$/g, "");
        if (/^[a-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+/i.test(candidate)) {
          if (!/[<>:"|?*\x00-\x1f]/.test(candidate.slice(2))) return candidate;
        } else if (path.posix.isAbsolute(candidate) && !/^[\\/]{2}/.test(candidate) && !candidate.includes("\0")) {
          return candidate;
        }
      }
    }
  }
  return "";
}

function externalNode(id, byId) {
  const node = byId.get(id) || {};
  const description = [node.text, node.label, node.file, node.url].find(value => typeof value === "string" && value.trim()) || "";
  return { id, type: node.type || "unknown", summary: description.replace(/\s+/g, " ").trim().slice(0, 200) };
}

function extractSelectionSnapshot(canvasData, selectedIds, canvasPath, options = {}) {
  const nodes = canvasData.nodes || [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const boxes = new Map(nodes.map(node => [node.id, boundsOf(node)]));
  const directSelectedIds = [...new Set(selectedIds)].filter(id => byId.has(id));
  const effectiveNodeIds = expandGroups(nodes, directSelectedIds, byId, boxes);
  const effective = new Set(effectiveNodeIds);
  const selectedNodes = effectiveNodeIds.map(id => pick(byId.get(id), NODE_FIELDS));
  const internalEdges = [], incomingEdges = [], outgoingEdges = [];
  for (const edge of canvasData.edges || []) {
    const from = effective.has(edge.fromNode);
    const to = effective.has(edge.toNode);
    if (from && to) internalEdges.push({ ...edge });
    else if (to) incomingEdges.push({ ...edge, source: externalNode(edge.fromNode, byId) });
    else if (from) outgoingEdges.push({ ...edge, target: externalNode(edge.toNode, byId) });
  }
  return {
    canvasPath, directSelectedIds, effectiveNodeIds, nodes: selectedNodes,
    expandedFromGroupIds: effectiveNodeIds.slice(directSelectedIds.length),
    internalEdges, incomingEdges, outgoingEdges,
    selectionBounds: unionBounds(effectiveNodeIds.map(id => boxes.get(id))),
    detectedRepo: detectRepo(selectedNodes, options.fileExcerpts || {}),
  };
}

function buildCanvasPromptEnvelope({ userInstruction, executor, mode, canvasSnapshot, fileExcerpts = {}, targetRepo = "" }) {
  const { canvasPath, effectiveNodeIds, nodes, internalEdges, incomingEdges, outgoingEdges } = canvasSnapshot;
  const workingDirectory = targetRepo || canvasSnapshot.detectedRepo || "";
  const metadata = { executor, mode, canvasPath, selectedIds: effectiveNodeIds, targetWorkspace: workingDirectory };
  const selection = nodes.map(node => node.type === "file"
    ? { ...node, fileExcerpt: excerpt(fileExcerpts, node.file) } : node);
  const json = value => JSON.stringify(value, null, 2);
  const editContract = [
    "只修改锁定 node.id 白名单内的节点，支持修改内容字段（text/label/color/file/subpath/url）以及排版坐标尺寸（x/y/width/height）；支持 updateEdges 调整连线方向（fromSide/toSide）或 removeEdgeIds 删除关联内部边，也可新增相连节点，删除范围限于锁定的 ID。",
    "如果用户只要求排版、移动、缩放或修改已有卡片，不要新增任何多余的说明或回执卡片（addNodes 留空或省略）；只有在用户要求拆分或新增卡片时才使用 addNodes。",
    "在回复末尾输出一个 canvas-patch JSON 代码块，支持 updateNodes、addNodes、addEdges、updateEdges、removeNodeIds、removeEdgeIds。",
    '```canvas-patch\n{"updateNodes":[{"id":"锁定的节点 ID","x":0,"y":0,"width":360,"height":180}],"updateEdges":[{"id":"已有连线 ID","fromSide":"right","toSide":"left"}],"addNodes":[],"addEdges":[],"removeNodeIds":[],"removeEdgeIds":[]}\n```',
  ];
  const receiptContract = [
    "如果用户指令实质上是排版或修改选中画布卡片，请直接通过 updateNodes（支持 x/y/width/height）更新锁定节点，不要只新增一张说明卡片；仅在执行外部仓库开发或分析任务需要留档验证结果时，才在回复末尾附上一个 canvas-patch JSON 代码块，在选区旁新增一张回执卡片写入结果摘要与验证证据并连到源节点。",
    '```canvas-patch\n{"addNodes":[{"tempId":"receipt","type":"text","text":"结果摘要与验证证据"}],"addEdges":[{"fromNode":"源节点的锁定 ID","toNode":"receipt"}]}\n```',
  ];
  return [
    PROMPT_TITLE, JSON.stringify(metadata),
    `执行者 ${executor === "codex" ? "Codex" : "AGY"} · 模式 ${mode === "edit_canvas" ? "改选区画布" : "执行任务"}`,
    `画布 ${canvasPath}\n目标工作目录 ${workingDirectory || "当前 Vault"}\n锁定节点 ID 白名单 ${JSON.stringify(effectiveNodeIds)}`,
    `${PROMPT_SECTIONS.nodes}\n${json(selection)}`,
    `${PROMPT_SECTIONS.internalEdges}\n${json(internalEdges)}`,
    `${PROMPT_SECTIONS.incomingEdges}\n${json(incomingEdges)}`,
    `${PROMPT_SECTIONS.outgoingEdges}\n${json(outgoingEdges)}`,
    `${PROMPT_SECTIONS.instruction}\n${userInstruction}`,
    `${PROMPT_SECTIONS.contract}\n严禁直接覆盖整个 .canvas 磁盘文件。由用户在 Obsidian 侧栏应用补丁。新增节点可用 tempId 供 addEdges 引用。`,
    ...(mode === "edit_canvas" ? editContract : receiptContract),
  ].join("\n\n");
}

function readPromptJson(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseCanvasPromptEnvelope(promptText) {
  if (typeof promptText !== "string") return null;
  const lines = promptText.split(/\r?\n/);
  if (lines[0] !== PROMPT_TITLE) return null;

  const headings = Object.values(PROMPT_SECTIONS);
  const instructionStart = lines.indexOf(PROMPT_SECTIONS.instruction);
  const contractStart = lines.lastIndexOf(PROMPT_SECTIONS.contract);
  const contentEnd = [instructionStart, contractStart].find(index => index >= 0) ?? lines.length;
  const metadata = readPromptJson(lines.slice(1).find(line => line.trim()), {});
  const sections = {};
  for (const field of ["nodes", "internalEdges", "incomingEdges", "outgoingEdges"]) {
    const start = lines.indexOf(PROMPT_SECTIONS[field]);
    const end = lines.findIndex((line, index) => index > start && headings.includes(line));
    sections[field] = start >= 0 && start < contentEnd
      ? readPromptJson(lines.slice(start + 1, end < 0 ? contentEnd : end).join("\n"), []) : [];
  }
  const instruction = instructionStart >= 0 && contractStart > instructionStart
    ? lines.slice(instructionStart + 1, contractStart).join("\n").trim() : "";
  return { metadata, instruction, ...sections };
}

function patchError(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !PATCH_FIELDS.some(key => Object.hasOwn(patch, key))) {
    return "Canvas Patch 必须是包含至少一个操作字段的 JSON 对象。";
  }
  for (const field of PATCH_FIELDS) {
    if (Object.hasOwn(patch, field) && !Array.isArray(patch[field])) return `Canvas Patch 的 ${field} 必须是数组。`;
  }
  if (Object.hasOwn(patch, "allowMove") && typeof patch.allowMove !== "boolean") {
    return "Canvas Patch 的 allowMove 必须是布尔值。";
  }
  return "";
}

function findPatchBlock(text) {
  let fence = null;
  let lastBlock = null;
  for (const { 0: rawLine, index } of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const line = rawLine.replace(/\r?\n$/, "");
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) {
        if (fence.patch) lastBlock = { ...fence, close: index, end: index + rawLine.length };
        fence = null;
      }
    } else if (match) {
      fence = {
        marker: match[1], patch: match[1][0] === "`" && /^(?:json\s+)?canvas-patch$/i.test(match[2].trim()),
        start: index, contentStart: index + rawLine.length,
      };
    }
  }
  return lastBlock;
}

function parsePatchJson(rawPatchJson) {
  try {
    const patch = JSON.parse(rawPatchJson.replace(/\r\n/g, "\n"));
    const error = patchError(patch);
    return error ? { error } : patch;
  } catch (error) {
    return { error: `Canvas Patch JSON 无法解析：${error.message}` };
  }
}

function patchBlockContent(text, block) {
  return text.slice(block.contentStart, block.close).replace(/\r?\n$/, "");
}

function extractCanvasPatch(replyText) {
  if (typeof replyText !== "string") return null;
  const block = findPatchBlock(replyText);
  return block ? parsePatchJson(patchBlockContent(replyText, block)) : null;
}

function splitReplyAndPatch(replyText) {
  const text = String(replyText || "");
  const block = findPatchBlock(text);
  if (!block) return { bodyMarkdown: text, patch: null, rawPatchJson: "" };
  const rawPatchJson = patchBlockContent(text, block);
  return {
    bodyMarkdown: (text.slice(0, block.start) + text.slice(block.end)).trim(),
    patch: parsePatchJson(rawPatchJson),
    rawPatchJson,
  };
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : "";
}

function nodeTitle(node) {
  const text = typeof node.text === "string" ? node.text.split(/\r?\n/).find(line => line.trim()) : "";
  const file = typeof node.file === "string" ? path.win32.basename(node.file) : "";
  const title = [text?.trim().replace(/^#+\s*/, ""), node.label, file, node.url]
    .find(value => typeof value === "string" && value.trim());
  return Array.from(title?.trim() || "").slice(0, 36).join("");
}

function geometryPair(first, second, firstLabel, secondLabel, format) {
  if (Number.isFinite(first) && Number.isFinite(second)) return format(first, second);
  if (Number.isFinite(first)) return `${firstLabel} ${first}`;
  if (Number.isFinite(second)) return `${secondLabel} ${second}`;
  return "";
}

function nodeGeometry({ x, y, width, height }) {
  return [geometryPair(x, y, "x", "y", (a, b) => `(${a}, ${b})`),
    geometryPair(width, height, "宽", "高", (a, b) => `${a}×${b}`)].filter(Boolean).join(" · ");
}

function nodePreview(node, reference, title) {
  return {
    nodeType: node.type ?? reference?.type ?? "text", color: node.color ?? reference?.color,
    title, markdown: node.text, file: node.file, url: node.url, geometry: nodeGeometry(node),
  };
}

function edgePreview(op, edge, titleFor) {
  return {
    kind: "edge", op, badge: { add: "新增连线", update: "修改连线", remove: "删除连线" }[op],
    fromLabel: titleFor(edge.fromNode, edge.source?.summary), toLabel: titleFor(edge.toNode, edge.target?.summary),
    fromSide: edge.fromSide, toSide: edge.toSide,
    label: edge.label ?? (edge.fromNode || edge.toNode ? "" : shortId(edge.id)),
  };
}

function buildPatchPreviewItems(patch, referenceNodes = [], referenceEdges = []) {
  if (patchError(patch)) return [];
  const additions = (patch.addNodes || []).filter(node => node && typeof node === "object" && !Array.isArray(node));
  const nodes = new Map(referenceNodes.filter(node => node?.id).map(node => [node.id, node]));
  const titles = new Map([...nodes].map(([id, node]) => [id, nodeTitle(node)]));
  for (const node of additions) {
    for (const id of [node.id, node.tempId]) {
      if (typeof id === "string" && !titles.has(id)) titles.set(id, nodeTitle(node));
    }
  }
  const titleFor = (id, summary) => titles.get(id) || nodeTitle({ text: summary }) || shortId(id);
  const edges = new Map(referenceEdges.filter(edge => edge?.id).map(edge => [edge.id, edge]));
  const items = additions.map(node => ({
    kind: "addNode", badge: "新增", ...nodePreview(node, null, nodeTitle(node) || shortId(node.tempId ?? node.id)),
  }));
  for (const node of patch.updateNodes || []) {
    if (typeof node?.id !== "string") continue;
    const preview = nodePreview(node, nodes.get(node.id), nodeTitle(node) || titleFor(node.id));
    const hasContent = CONTENT_FIELDS.some(field => typeof node[field] === "string");
    const badge = preview.geometry ? (hasContent ? "修改+排版" : "排版") : "修改";
    items.push({ kind: "updateNode", badge, id: node.id, ...preview });
  }
  for (const id of patch.removeNodeIds || []) {
    if (typeof id === "string") items.push({ kind: "removeNode", badge: "删除", id, title: titleFor(id) });
  }
  for (const edge of patch.addEdges || []) {
    if (typeof edge?.fromNode === "string" && typeof edge.toNode === "string") items.push(edgePreview("add", edge, titleFor));
  }
  for (const edge of patch.updateEdges || []) {
    if (typeof edge?.id === "string") items.push(edgePreview("update", { ...edges.get(edge.id), ...edge }, titleFor));
  }
  for (const id of patch.removeEdgeIds || []) {
    if (typeof id === "string") items.push(edgePreview("remove", edges.get(id) || { id }, titleFor));
  }
  return items;
}

function newId(usedIds, generate) {
  for (let attempt = 0; ; attempt++) {
    const candidate = generate && attempt < 16 ? generate() : randomBytes(8).toString("hex");
    if (typeof candidate !== "string" || !/^[0-9a-f]{16}$/i.test(candidate)) continue;
    const id = candidate.toLowerCase();
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    return id;
  }
}

function overlaps(first, second) {
  return first.minX < second.maxX && first.maxX > second.minX
    && first.minY < second.maxY && first.maxY > second.minY;
}

function placeNode(node, requested, occupied, column) {
  node.x = requested.x;
  node.y = requested.y;
  const requestedBox = boundsOf(node);
  if (requestedBox && !occupied.some(box => overlaps(box, requestedBox))) return requestedBox;

  node.x = column.x;
  node.y = column.y;
  for (;;) {
    const box = boundsOf(node);
    if (!box) throw new RangeError("Canvas 新增节点的布局超出坐标范围。");
    const collisions = occupied.filter(other => overlaps(box, other));
    if (!collisions.length) {
      column.y = box.maxY + GAP;
      return box;
    }
    const nextY = collisions.reduce((y, other) => Math.max(y, other.maxY + GAP), node.y);
    if (nextY <= node.y) throw new RangeError("Canvas 新增节点无法避让现有节点。");
    node.y = nextY;
  }
}

function updateNodes(nodes, updates, permitted, allowMove, summary, restoreNodes) {
  for (const update of updates) {
    const node = nodes.get(update?.id);
    if (!node || !permitted(update.id)) { summary.skipped++; continue; }
    const fields = CONTENT_FIELDS.filter(field => typeof update[field] === "string");
    if (allowMove) {
      fields.push(...GEOMETRY_FIELDS.filter(field => Number.isFinite(update[field])
        && (field === "x" || field === "y" || update[field] > 0)));
    }
    if (!fields.length) { summary.skipped++; continue; }
    if (restoreNodes && !restoreNodes.has(node.id)) restoreNodes.set(node.id, { ...node });
    Object.assign(node, pick(update, fields));
    summary.updated++;
  }
}

function addNodes(nodes, additions, options, allocateId, summary, addedNodeIds) {
  const occupied = [...nodes.values()].map(boundsOf).filter(Boolean);
  const bounds = options.selectionBounds ?? unionBounds(occupied);
  const column = bounds ? { x: bounds.maxX + 60, y: bounds.minY } : { x: 0, y: 0 };
  const temporary = new Map();
  for (const input of additions) {
    const type = input?.type ?? "text";
    const tempId = input?.tempId;
    if (!input || typeof input !== "object" || Array.isArray(input) || !NODE_TYPES.has(type)
        || (type === "file" && (typeof input.file !== "string" || !input.file))
        || (type === "link" && (typeof input.url !== "string" || !input.url))
        || (tempId != null && (typeof tempId !== "string" || !tempId || nodes.has(tempId) || temporary.has(tempId)))) {
      summary.skipped++;
      continue;
    }
    const node = { id: allocateId(), type };
    if (type === "text") node.text = "";
    for (const field of CONTENT_FIELDS) {
      if (typeof input[field] === "string") node[field] = input[field];
    }
    node.width = Number.isFinite(input.width) && input.width > 0 ? input.width : 360;
    node.height = Number.isFinite(input.height) && input.height > 0 ? input.height : 180;
    occupied.push(placeNode(node, input, occupied, column));
    nodes.set(node.id, node);
    if (addedNodeIds) addedNodeIds.push(node.id);
    if (tempId) temporary.set(tempId, node.id);
    summary.addedNodes++;
  }
  return temporary;
}

function updateEdges(edges, updates, permitted, summary, restoreEdges) {
  const byId = new Map(edges.map(edge => [edge.id, edge]));
  for (const update of updates) {
    const edge = byId.get(update?.id);
    if (!edge || (!permitted(edge.fromNode) && !permitted(edge.toNode))) { summary.skipped++; continue; }
    const next = {};
    let changed = false;
    for (const side of ["fromSide", "toSide"]) {
      if (SIDES.has(update[side])) { next[side] = update[side]; changed = true; }
    }
    for (const field of EDGE_FIELDS) {
      if (typeof update[field] === "string") { next[field] = update[field]; changed = true; }
    }
    if (!changed) { summary.skipped++; continue; }
    if (restoreEdges && !restoreEdges.has(edge.id)) restoreEdges.set(edge.id, { ...edge });
    Object.assign(edge, next);
    summary.updatedEdges++;
  }
}

function addEdges(edges, additions, nodes, temporary, allocateId, summary, addedEdgeIds) {
  const edgeKey = (from, to) => JSON.stringify([from, to]);
  const connections = new Set(edges.map(edge => edgeKey(edge.fromNode, edge.toNode)));
  for (const input of additions) {
    const fromNode = temporary.get(input?.fromNode) ?? input?.fromNode;
    const toNode = temporary.get(input?.toNode) ?? input?.toNode;
    const key = edgeKey(fromNode, toNode);
    if (!nodes.has(fromNode) || !nodes.has(toNode) || connections.has(key)) { summary.skipped++; continue; }
    const edge = {
      ...pick(input, EDGE_FIELDS), id: allocateId(), fromNode, toNode,
      fromSide: SIDES.has(input.fromSide) ? input.fromSide : "right",
      toSide: SIDES.has(input.toSide) ? input.toSide : "left",
    };
    edges.push(edge);
    if (addedEdgeIds) addedEdgeIds.push(edge.id);
    connections.add(key);
    summary.addedEdges++;
  }
}

function applyCanvasPatch(canvasData, patch, options = {}) {
  const error = patchError(patch);
  if (error) throw new TypeError(error);
  const summary = {
    updated: 0, addedNodes: 0, addedEdges: 0, removedNodes: 0, updatedEdges: 0, removedEdges: 0, skipped: 0,
  };
  const nodes = new Map((canvasData.nodes || []).map(node => [node.id, { ...node }]));
  const originalEdges = canvasData.edges || [];
  const usedIds = new Set([...nodes.keys(), ...originalEdges.map(edge => edge.id)].map(id => String(id).toLowerCase()));
  const allocateId = () => newId(usedIds, options.idGenerator);
  const allowed = options.allowedNodeIds == null ? null : new Set(options.allowedNodeIds);
  const permitted = id => !allowed || allowed.has(id);
  const allowMove = options.allowMove === true || patch.allowMove === true;
  const restoreNodes = new Map();
  const restoreEdges = new Map();
  const addedNodeIds = [];
  const addedEdgeIds = [];

  updateNodes(nodes, patch.updateNodes || [], permitted, allowMove, summary, restoreNodes);
  const removed = new Set();
  for (const id of patch.removeNodeIds || []) {
    const existing = nodes.get(id);
    if (!permitted(id) || !existing) { summary.skipped++; continue; }
    if (!restoreNodes.has(id)) restoreNodes.set(id, { ...existing });
    nodes.delete(id);
    removed.add(id);
    summary.removedNodes++;
  }
  const removeEdges = new Set();
  const edgeById = new Map(originalEdges.map(edge => [edge.id, edge]));
  for (const edgeId of patch.removeEdgeIds || []) {
    const edge = edgeById.get(edgeId);
    if (!edge || (!permitted(edge.fromNode) && !permitted(edge.toNode))) { summary.skipped++; continue; }
    if (!restoreEdges.has(edgeId)) restoreEdges.set(edgeId, { ...edge });
    removeEdges.add(edgeId);
    summary.removedEdges++;
  }
  const edges = [];
  for (const edge of originalEdges) {
    if (removed.has(edge.fromNode) || removed.has(edge.toNode) || removeEdges.has(edge.id)) {
      if (!restoreEdges.has(edge.id)) restoreEdges.set(edge.id, { ...edge });
      continue;
    }
    edges.push({ ...edge });
  }
  updateEdges(edges, patch.updateEdges || [], permitted, summary, restoreEdges);
  const temporary = addNodes(nodes, patch.addNodes || [], options, allocateId, summary, addedNodeIds);
  addEdges(edges, patch.addEdges || [], nodes, temporary, allocateId, summary, addedEdgeIds);
  return {
    data: { nodes: [...nodes.values()], edges },
    summary,
    undo: {
      restoreNodes: [...restoreNodes.values()],
      removeNodeIds: addedNodeIds,
      restoreEdges: [...restoreEdges.values()],
      removeEdgeIds: addedEdgeIds,
    },
  };
}

function revertCanvasPatch(canvasData, undo) {
  if (!undo || typeof undo !== "object" || Array.isArray(undo)) {
    throw new TypeError("Canvas 撤销快照无效。");
  }
  const removeNodeIds = new Set(Array.isArray(undo.removeNodeIds) ? undo.removeNodeIds : []);
  const removeEdgeIds = new Set(Array.isArray(undo.removeEdgeIds) ? undo.removeEdgeIds : []);
  const nodes = new Map((canvasData.nodes || []).map(node => [node.id, { ...node }]));
  const summary = { restoredNodes: 0, removedNodes: 0, restoredEdges: 0, removedEdges: 0 };

  for (const id of removeNodeIds) {
    if (nodes.delete(id)) summary.removedNodes++;
  }
  for (const orig of undo.restoreNodes || []) {
    if (!orig || typeof orig.id !== "string") continue;
    nodes.set(orig.id, { ...orig });
    summary.restoredNodes++;
  }

  const edges = [];
  for (const edge of canvasData.edges || []) {
    if (removeEdgeIds.has(edge.id) || removeNodeIds.has(edge.fromNode) || removeNodeIds.has(edge.toNode)) {
      summary.removedEdges++;
      continue;
    }
    edges.push({ ...edge });
  }

  const edgeIndexById = new Map(edges.map((edge, idx) => [edge.id, idx]));
  const edgeKey = (from, to) => JSON.stringify([from, to]);
  const connections = new Set(edges.map(edge => edgeKey(edge.fromNode, edge.toNode)));
  for (const origEdge of undo.restoreEdges || []) {
    if (!origEdge || typeof origEdge.id !== "string") continue;
    if (!nodes.has(origEdge.fromNode) || !nodes.has(origEdge.toNode)) continue;
    const existingIdx = edgeIndexById.get(origEdge.id);
    if (existingIdx !== undefined) {
      edges[existingIdx] = { ...origEdge };
      summary.restoredEdges++;
      continue;
    }
    const key = edgeKey(origEdge.fromNode, origEdge.toNode);
    if (connections.has(key)) continue;
    edgeIndexById.set(origEdge.id, edges.length);
    connections.add(key);
    edges.push({ ...origEdge });
    summary.restoredEdges++;
  }

  return { data: { nodes: [...nodes.values()], edges }, summary };
}

module.exports = {
  extractSelectionSnapshot, buildCanvasPromptEnvelope, extractCanvasPatch, applyCanvasPatch, revertCanvasPatch,
  parseCanvasPromptEnvelope, splitReplyAndPatch, buildPatchPreviewItems,
};
