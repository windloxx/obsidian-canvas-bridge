const path = require("node:path");

const PROMPT_TITLE = "# Kanban 协作任务";
const EXCERPT_LIMIT = 8000;

function stripNotePrefix(property) {
  return String(property || "").replace(/^note\./, "");
}

function todayLocalYmd(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = number => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function inferInProgressStatus(statusOptions) {
  const options = Array.isArray(statusOptions) ? statusOptions : [];
  const aliases = new Set(["进行中", "in progress", "doing", "active", "wip"]);
  return options.find(option => aliases.has(normalized(option)))
    || (options.length >= 2 ? options[1] : "");
}

function isInitialStatus(status, statusOptions) {
  const value = normalized(status);
  if (!value) return true;
  if (new Set(["待办", "todo", "to do", "backlog", "未开始"]).has(value)) return true;
  return Array.isArray(statusOptions) && statusOptions.length >= 2 && value === normalized(statusOptions[0]);
}

function validRepo(candidate) {
  if (typeof candidate !== "string") return "";
  const value = candidate.replace(/^[\s`'“”‘’"]+|[\s`'“”‘’"]+$/g, "");
  if (/^[a-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+/i.test(value)) {
    return !/[<>:"|?*\x00-\x1f]/.test(value.slice(2)) ? value : "";
  }
  if (path.posix.isAbsolute(value) && !/^[\\/]{2}/.test(value) && !value.includes("\0")) return value;
  return "";
}

function detectRepoFromCard(card) {
  const direct = validRepo(card?.frontmatter?.repo);
  if (direct) return direct;
  const excerpt = typeof card?.excerpt === "string" ? card.excerpt : "";
  for (const match of excerpt.matchAll(/^[ \t]*(?:[-*+]\s+)?(?:`)?repo:[ \t]*(.+)$/gim)) {
    const candidate = validRepo(match[1]);
    if (candidate) return candidate;
  }
  return "";
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function buildKanbanPromptEnvelope({ userInstruction, executor, mode, kanbanSnapshot, targetRepo = "" }) {
  const snapshot = kanbanSnapshot || {};
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  const cardPaths = cards.map(card => card.path).filter(Boolean);
  const metadata = {
    kind: "kanban", executor, mode,
    boardPath: snapshot.boardPath || "", viewName: snapshot.viewName || "",
    statusProperty: snapshot.statusProperty || "status",
    statusOptions: Array.isArray(snapshot.statusOptions) ? snapshot.statusOptions : [],
    cardPaths, targetWorkspace: targetRepo || snapshot.targetWorkspace || "",
  };
  const selected = cards.map(card => ({
    path: card.path || "", title: card.title || "", column: card.column || "",
    status: card.status || "", frontmatter: card.frontmatter || {},
    excerpt: String(card.excerpt || "").slice(0, EXCERPT_LIMIT),
  }));
  return [
    `${PROMPT_TITLE}\n${JSON.stringify(metadata)}`,
    "## 选中的看板卡片",
    json(selected),
    "## 看板列配置",
    json({ boardPath: metadata.boardPath, viewName: metadata.viewName, groupBy: snapshot.groupBy || "", groupOrder: snapshot.groupOrder || [], statusProperty: metadata.statusProperty, statusOptions: metadata.statusOptions }),
    "## 用户指令",
    String(userInstruction || ""),
    "## 回写契约",
    [
      "完成任务后，如果需要更新卡片状态、属性、进展或子任务，请在回复末尾输出一个 kanban-patch JSON 代码块，由用户在 Obsidian 中应用。",
      "file 必须是锁定的 cardPaths 白名单中的卡片相对路径，status 优先使用 statusOptions 中的值。",
      '```kanban-patch\n{"updates":[{"file":"卡片相对路径","status":"新状态","properties":{},"appendProgress":"进展记录一行","checkTasks":["要勾选的子任务文本"]}]}\n```',
    ].join("\n"),
  ].join("\n\n");
}

function readJsonBlock(text, fallback) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function parseKanbanPromptEnvelope(promptText) {
  if (typeof promptText !== "string") return null;
  const lines = promptText.split(/\r?\n/);
  if (lines[0] !== PROMPT_TITLE) return null;
  const metadata = readJsonBlock(lines[1] || "", {});
  if (metadata.kind !== "kanban") return null;
  const cardsStart = lines.indexOf("## 选中的看板卡片");
  const columnsStart = lines.indexOf("## 看板列配置");
  const instructionStart = lines.indexOf("## 用户指令");
  const contractStart = lines.lastIndexOf("## 回写契约");
  const cards = cardsStart >= 0 && columnsStart > cardsStart
    ? readJsonBlock(lines.slice(cardsStart + 1, columnsStart).join("\n"), []).filter(card => typeof card?.path === "string") : [];
  const instruction = instructionStart >= 0 && contractStart > instructionStart
    ? lines.slice(instructionStart + 1, contractStart).join("\n").trim() : "";
  return { metadata, cards, instruction };
}

function fenceOf(line) {
  return /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
}

function closesFence(fence, candidate) {
  return candidate && candidate[1][0] === fence[1][0] && candidate[1].length >= fence[1].length && !candidate[2];
}

function findPatchBlock(text) {
  let fence = null;
  let openPatch = null;
  let last = null;
  for (const { 0: line, index } of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const candidate = fenceOf(line);
    if (fence) {
      if (closesFence(fence, candidate)) {
        if (openPatch) last = { ...openPatch, close: index, end: index + line.length };
        fence = null;
        openPatch = null;
      }
    } else if (candidate) {
      fence = candidate;
      if (candidate[1][0] === "`" && /^(?:json\s+)?kanban-patch$/i.test(candidate[2].trim())) {
        openPatch = { start: index, contentStart: index + line.length };
      }
    }
  }
  return last;
}

function parsePatchJson(rawPatchJson) {
  try {
    const patch = JSON.parse(rawPatchJson);
    return patch && typeof patch === "object" && !Array.isArray(patch) && Array.isArray(patch.updates)
      ? patch : { error: "Kanban Patch 必须是包含 updates 数组的 JSON 对象。" };
  } catch (error) {
    return { error: `Kanban Patch JSON 无法解析：${error.message}` };
  }
}

function splitReplyAndKanbanPatch(replyText) {
  const text = String(replyText || "");
  const block = findPatchBlock(text);
  if (!block) return { bodyMarkdown: text, patch: null, rawPatchJson: "" };
  const rawPatchJson = text.slice(block.contentStart, block.close).trim();
  return { bodyMarkdown: (text.slice(0, block.start) + text.slice(block.end)).trim(), patch: parsePatchJson(rawPatchJson), rawPatchJson };
}

function extractKanbanPatch(replyText) {
  return splitReplyAndKanbanPatch(replyText).patch;
}

function isKanbanProperty(name) {
  return typeof name === "string" && Boolean(name.trim()) && !["__proto__", "constructor", "prototype"].includes(name);
}

function validateKanbanPatch(patch, { allowedCardPaths, statusOptions, statusProperty = "status" } = {}) {
  const allowed = allowedCardPaths == null ? null : new Set(allowedCardPaths);
  const statuses = Array.isArray(statusOptions) && statusOptions.length ? statusOptions : null;
  const operations = [];
  const updates = patch && Array.isArray(patch.updates) ? patch.updates : [];
  let skipped = 0;
  for (const update of updates) {
    if (!update || typeof update.file !== "string" || !update.file.trim()
        || /^(?:[\\/]|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(update.file)
        || !/\.md$/i.test(update.file) || (allowed && !allowed.has(update.file))) { skipped++; continue; }
    const operation = { file: update.file };
    const properties = update.properties && typeof update.properties === "object" && !Array.isArray(update.properties)
      ? Object.entries(update.properties).filter(([name]) => isKanbanProperty(name)) : [];
    const status = update.status ?? properties.find(([name]) => name === statusProperty)?.[1];
    if (typeof status === "string" && status.trim()) {
      const canonical = statuses ? statuses.find(value => normalized(value) === normalized(status)) : status.trim();
      if (canonical) operation.status = canonical;
    }
    const editable = properties.filter(([name]) => name !== statusProperty);
    if (editable.length) operation.properties = Object.fromEntries(editable);
    if (typeof update.appendProgress === "string" && update.appendProgress.trim()) operation.appendProgress = update.appendProgress.trim();
    for (const key of ["checkTasks", "uncheckTasks"]) {
      const tasks = Array.isArray(update[key]) ? update[key].filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
      if (tasks.length) operation[key] = tasks;
    }
    if (Object.keys(operation).length === 1) { skipped++; continue; }
    operations.push(operation);
  }
  return { operations, summary: { updated: operations.length, skipped } };
}

function buildKanbanPatchPreviewItems(patch, referenceCards = [], statusProperty = "status") {
  const cards = new Map(referenceCards.map(card => [card.path, card]));
  return validateKanbanPatch(patch, { statusProperty }).operations.map(update => {
    const reference = cards.get(update.file) || {};
    const propertyChanges = { ...(update.properties || {}) };
    return {
      kind: "kanbanUpdate", badge: "更新卡片", file: update.file,
      title: reference.title || path.basename(update.file || ""), fromStatus: reference.status || "",
      toStatus: update.status || reference.status || "", propertyChanges,
      appendProgress: update.appendProgress || "", checkTasks: update.checkTasks || [], uncheckTasks: update.uncheckTasks || [],
    };
  });
}

function applyKanbanBodyEdits(markdownText, update) {
  const original = String(markdownText || "");
  const prefix = /^(?:\uFEFF)?---[ \t]*\r?\n(?:[^\n]*\n)*?---[ \t]*(?:\r?\n|$)/.exec(original)?.[0] || "";
  const newline = original.match(/\r?\n/)?.[0] || "\n";
  const lines = original.slice(prefix.length).match(/[^\n]*\n|[^\n]+$/g) || [];
  let fence = null;
  let sectionStart = -1;
  let sectionEnd = lines.length;
  const matches = (tasks, text) => Array.isArray(tasks) && tasks.some(task => typeof task === "string" && task.trim() && text.includes(task.trim()));
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const candidate = fenceOf(line);
    if (fence) {
      if (closesFence(fence, candidate)) fence = null;
      continue;
    }
    if (candidate) { fence = candidate; continue; }
    if (sectionStart === -1 && /^ {0,3}##[ \t]+实时进展与记录(?:[ \t]+#+)?$/.test(line.trimEnd())) sectionStart = index;
    else if (sectionStart >= 0 && sectionEnd === lines.length && /^ {0,3}#{1,2}[ \t]/.test(line)) sectionEnd = index;
    const task = /^([ \t]*-[ \t]+\[)([ xX])(\][ \t]+)(.*)/.exec(line);
    if (!task) continue;
    const text = task[4].trim();
    const marker = matches(update?.uncheckTasks, text) ? " " : matches(update?.checkTasks, text) ? "x" : task[2];
    lines[index] = task[1] + marker + line.slice(task[1].length + 1);
  }
  if (typeof update?.appendProgress === "string" && update.appendProgress.trim()) {
    const progress = `- ${update.appendProgress.trim().replace(/\r?\n/g, `${newline}  `)}${newline}`;
    if (sectionStart >= 0) {
      let insertAt = sectionEnd;
      while (insertAt > sectionStart + 1 && !lines[insertAt - 1].trim()) insertAt--;
      if (insertAt > sectionStart + 1 && /^[ \t]*关联：/.test(lines[insertAt - 1])) insertAt--;
      if (!lines[insertAt - 1].endsWith("\n")) lines[insertAt - 1] += newline;
      lines.splice(insertAt, 0, progress);
    } else {
      const body = lines.join("");
      const end = prefix + body;
      const separator = body.trim() && !/\n[ \t]*\r?\n$/.test(end) ? (end.endsWith("\n") ? newline : newline + newline)
        : end && !end.endsWith("\n") ? newline : "";
      return end + separator + `## 实时进展与记录${newline}${progress}`;
    }
  }
  return prefix + lines.join("");
}

module.exports = {
  stripNotePrefix, todayLocalYmd, inferInProgressStatus, isInitialStatus, detectRepoFromCard,
  buildKanbanPromptEnvelope, parseKanbanPromptEnvelope, extractKanbanPatch, splitReplyAndKanbanPatch,
  validateKanbanPatch, buildKanbanPatchPreviewItems, applyKanbanBodyEdits, isKanbanProperty,
};
